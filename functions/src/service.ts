import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  ALL_SCENARIOS,
  isValidInterventionId,
  sha256Hex,
  stableStringify,
} from '@chaos-room/shared';
import {
  admitRequestTransaction,
  finalizeGenerationTransaction,
  type FinalizeGenerationOutcome,
} from './accountingStore.js';
import {
  BACKEND_LIMITS,
  CURRENT_PROMPT_VERSION,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_LIVE_MODEL_VERSION,
  DEFAULT_MOCK_MODEL_VERSION,
  MOCK_PRICING_FIXTURE_V1,
  computeTokenCostMicros,
  resolvePricingForModel,
  validatePricingFixture,
} from './config.js';
import { GeminiProviderError } from './geminiProvider.js';
import { logSanitizedEvent } from './logger.js';
import { MockModelProvider } from './mockProvider.js';
import { OutputValidationError, validateAndNormalizeProviderOutput } from './outputValidator.js';
import { reconstructCanonicalState } from './reconstruction.js';
import {
  RequestValidationError,
  validateAuthAndAppCheck,
  validatePublicAnalyzeRequest,
} from './requestValidator.js';
import type {
  AnalyzeIncidentResponse,
  CallableAuthContext,
  GenerationLease,
  InternalEvaluationRequest,
  ModelProvider,
  PricingFixture,
  ReconstructedState,
  ServiceClock,
  TokenUsageFixture,
} from './types.js';

export interface AnalyzeServiceDeps {
  db: Firestore;
  provider?: ModelProvider;
  clock?: ServiceClock;
  pricing?: PricingFixture;
  envAiDisabled?: boolean;
  envLiveGenerationDisabled?: boolean;
  modelVersion?: string;
  promptVersion?: string;
  schemaVersion?: string;
  providerDeadlineMs?: number;
  simulateCrashAfterLease?: boolean;
  beforeAdmissionCommitHook?: (attemptNumber: number) => Promise<void> | void;
  onLeaseAcquired?: (lease: GenerationLease, state: ReconstructedState) => Promise<void> | void;
}

const DEFAULT_CLOCK: ServiceClock = {
  nowMs: () => Date.now(),
};

function extractUsageFromError(error: unknown): TokenUsageFixture | null {
  if (typeof error === 'object' && error !== null && 'usage' in error) {
    const candidate = (error as { usage?: unknown }).usage;
    if (candidate && typeof candidate === 'object') {
      return candidate as TokenUsageFixture;
    }
  }
  return null;
}

async function executeProviderAndFinalize(params: {
  db: Firestore;
  provider: ModelProvider;
  clock: ServiceClock;
  pricing: PricingFixture;
  lease: GenerationLease;
  state: ReconstructedState;
  providerDeadlineMs: number;
  simulateCrashAfterLease?: boolean;
}): Promise<AnalyzeIncidentResponse> {
  const {
    db,
    provider,
    clock,
    pricing,
    lease,
    state,
    providerDeadlineMs,
    simulateCrashAfterLease,
  } = params;

  if (simulateCrashAfterLease) {
    logSanitizedEvent({
      event: 'simulated_crash_after_lease',
      incidentId: state.scenario.incidentId,
      checkpoint: state.checkpoint,
      selectedInterventionId: state.selectedInterventionId,
      leaseId: lease.leaseId,
      cacheDocId: state.cacheDocId,
      visitorUid: lease.visitorUid,
      isEvaluation: lease.isEvaluation,
    });
    throw new Error(`Simulated process crash while holding lease ${lease.leaseId}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadlinePromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`Model provider exceeded ${providerDeadlineMs}ms deadline.`));
    }, providerDeadlineMs);
    deadlineTimer.unref?.();
  });

  const providerPromise = Promise.resolve().then(() =>
    provider.generateAnalysis(
      state.packet,
      {
        modelVersion: state.modelVersion,
        promptVersion: state.promptVersion,
        schemaVersion: state.schemaVersion,
        maxInputTokens: BACKEND_LIMITS.maxInputTokens,
        maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
        deadlineMs: providerDeadlineMs,
      },
      controller.signal,
    ),
  );
  // Swallow late provider rejections after timeout so Node/Vitest never sees an unhandled rejection.
  providerPromise.catch(() => {});

  const startedAtMs = clock.nowMs();
  let outcome: FinalizeGenerationOutcome;

  try {
    // Provider runs OUTSIDE Firestore transactions with zero automatic retries and an independent timer race.
    const providerResp = await Promise.race([providerPromise, deadlinePromise]);
    if (timedOut) {
      throw new Error(`Model provider exceeded ${providerDeadlineMs}ms deadline.`);
    }

    const costEval = computeTokenCostMicros(providerResp.usage, pricing);
    const completionNowMs = clock.nowMs();

    try {
      const normalized = validateAndNormalizeProviderOutput(providerResp.rawOutput, {
        state,
        generatedAtIso: new Date(completionNowMs).toISOString(),
        isMockProvider: provider.isMock,
      });

      outcome = {
        kind: 'success',
        reasonCode: 'generated_ok',
        message: provider.isMock
          ? 'Generated and validated mocked AI analysis.'
          : 'Generated and validated live Gemini AI analysis.',
        result: normalized,
        usageKnown: costEval.known,
        actualCostMicros: costEval.costMicros,
      };
    } catch (validationErr) {
      const reasonMsg =
        validationErr instanceof OutputValidationError
          ? validationErr.reasons.join('; ')
          : 'Provider output failed schema/citation validation';
      outcome = {
        kind: 'invalid_output',
        reasonCode: 'invalid_output',
        message: reasonMsg,
        usageKnown: costEval.known,
        actualCostMicros: costEval.costMicros,
      };
    }
  } catch (err) {
    const isProviderTimeout =
      timedOut ||
      (err instanceof GeminiProviderError &&
        (err.reasonCode === 'count_tokens_timeout' ||
          err.reasonCode === 'provider_deadline_exceeded'));
    const errUsage = extractUsageFromError(err);
    const costEval = isProviderTimeout
      ? { known: false, costMicros: null }
      : computeTokenCostMicros(errUsage, pricing);

    outcome = isProviderTimeout
      ? {
          kind: 'timeout',
          reasonCode: 'provider_deadline_exceeded',
          message: `Model provider exceeded ${providerDeadlineMs}ms deadline.`,
          usageKnown: false,
          actualCostMicros: null,
        }
      : {
          kind: 'unavailable',
          reasonCode:
            err instanceof GeminiProviderError &&
            err.phase === 'pre_generation' &&
            err.reasonCode
              ? err.reasonCode
              : 'provider_error',
          message: err instanceof Error ? err.message : 'Model provider request failed.',
          usageKnown: costEval.known,
          actualCostMicros: costEval.costMicros,
        };
  } finally {
    clearTimeout(deadlineTimer);
  }

  const finalNowMs = clock.nowMs();
  const finalized = await finalizeGenerationTransaction(db, {
    lease,
    state,
    outcome,
    finalNowMs,
    isMockProvider: provider.isMock,
  });

  logSanitizedEvent({
    event: 'analyze_finalized',
    incidentId: state.scenario.incidentId,
    checkpoint: state.checkpoint,
    selectedInterventionId: state.selectedInterventionId,
    status: finalized.response.status,
    reasonCode: finalized.response.reasonCode,
    cacheDocId: state.cacheDocId,
    leaseId: lease.leaseId,
    visitorUid: lease.visitorUid,
    durationMs: Math.max(0, finalNowMs - startedAtMs),
    chargedMicros: finalized.chargedCostMicros,
    isEvaluation: lease.isEvaluation,
  });

  return finalized.response;
}

/**
 * Orchestrates the public `analyzeIncident` flow:
 * Auth/AppCheck + strict payload validation -> canonical snapshot reconstruction ->
 * atomic Firestore admission/cache/lease/reservation -> single unretried provider call ->
 * strict output validation -> idempotent lease-guarded finalization.
 */
export async function executeAnalyzeIncident(
  rawData: unknown,
  authContext: CallableAuthContext | null | undefined,
  deps: AnalyzeServiceDeps,
): Promise<AnalyzeIncidentResponse> {
  const clock = deps.clock ?? DEFAULT_CLOCK;
  const provider = deps.provider ?? new MockModelProvider();
  const envAiDisabled = deps.envAiDisabled ?? process.env.CHAOS_AI_DISABLED === 'true';
  const envLiveGenerationDisabled =
    deps.envLiveGenerationDisabled ?? process.env.CHAOS_LIVE_GENERATION_DISABLED === 'true';
  const modelVersion =
    deps.modelVersion ?? (provider.isMock ? DEFAULT_MOCK_MODEL_VERSION : DEFAULT_LIVE_MODEL_VERSION);
  const pricing = validatePricingFixture(
    deps.pricing ??
      (provider.isMock ? MOCK_PRICING_FIXTURE_V1 : resolvePricingForModel(modelVersion)),
    { requireLiveVerified: !provider.isMock },
  );
  const promptVersion = deps.promptVersion ?? CURRENT_PROMPT_VERSION;
  const schemaVersion = deps.schemaVersion ?? CURRENT_SCHEMA_VERSION;
  const providerDeadlineMs = deps.providerDeadlineMs ?? BACKEND_LIMITS.providerDeadlineMs;

  const { visitorUid } = validateAuthAndAppCheck(authContext, rawData);
  const parsed = validatePublicAnalyzeRequest(rawData);
  const nowMs = clock.nowMs();

  if (parsed.kind === 'version_mismatch') {
    logSanitizedEvent({
      event: 'analyze_version_mismatch',
      incidentId: parsed.request.incidentId,
      checkpoint: parsed.request.checkpoint,
      selectedInterventionId: parsed.request.selectedInterventionId,
      status: 'version_mismatch',
      visitorUid,
    });
    return {
      status: 'version_mismatch',
      incidentId: parsed.request.incidentId,
      checkpoint: parsed.request.checkpoint,
      selectedInterventionId: parsed.request.selectedInterventionId,
      cacheHit: false,
      isMockProvider: provider.isMock,
      reasonCode: 'version_mismatch',
      message: `Client scenario/engine version mismatch (expected scenario=${parsed.expectedScenarioVersion}, engine=${parsed.expectedEngineVersion}).`,
      expectedScenarioVersion: parsed.expectedScenarioVersion,
      expectedEngineVersion: parsed.expectedEngineVersion,
      serverTimeIso: new Date(nowMs).toISOString(),
    };
  }

  const state = reconstructCanonicalState(
    parsed.scenario,
    parsed.request.checkpoint,
    parsed.request.selectedInterventionId,
    {
      modelVersion,
      promptVersion,
      schemaVersion,
    },
  );

  const requestPayloadHash = sha256Hex(
    stableStringify({
      incidentId: parsed.request.incidentId,
      scenarioVersion: parsed.request.scenarioVersion,
      engineVersion: parsed.request.engineVersion ?? state.snapshot.engineVersion,
      checkpoint: parsed.request.checkpoint,
      selectedInterventionId: parsed.request.selectedInterventionId,
    }),
  );

  const admission = await admitRequestTransaction(deps.db, {
    visitorUid,
    requestId: parsed.request.requestId,
    requestPayloadHash,
    state,
    nowMs,
    leaseId: `lease_${randomUUID()}`,
    isEvaluation: false,
    envAiDisabled,
    envLiveGenerationDisabled,
    isMockProvider: provider.isMock,
    worstCaseReservationMicros: pricing.worstCaseReservationMicros,
    beforeCommitTestHook: deps.beforeAdmissionCommitHook,
  });

  if (admission.decision !== 'generate') {
    logSanitizedEvent({
      event: `analyze_${admission.decision}`,
      incidentId: state.scenario.incidentId,
      checkpoint: state.checkpoint,
      selectedInterventionId: state.selectedInterventionId,
      status: admission.response.status,
      reasonCode: admission.response.reasonCode,
      cacheDocId: state.cacheDocId,
      visitorUid,
    });
    return admission.response;
  }

  if (deps.onLeaseAcquired) {
    await deps.onLeaseAcquired(admission.lease, state);
  }

  return executeProviderAndFinalize({
    db: deps.db,
    provider,
    clock,
    pricing,
    lease: admission.lease,
    state,
    providerDeadlineMs,
    simulateCrashAfterLease: deps.simulateCrashAfterLease,
  });
}

/**
 * Internal owner evaluation path.
 * Bypasses `analysisCache` reads and writes while sharing the exact daily/monthly
 * generation limits, `$4.50/month` spend reservation, kill switch, and output validation.
 * Never exposed as a public callable endpoint.
 */
export async function runInternalEvaluationAnalysis(
  evalRequest: InternalEvaluationRequest,
  deps: AnalyzeServiceDeps,
): Promise<AnalyzeIncidentResponse> {
  const clock = deps.clock ?? DEFAULT_CLOCK;
  const provider = deps.provider ?? new MockModelProvider();
  const envAiDisabled = deps.envAiDisabled ?? process.env.CHAOS_AI_DISABLED === 'true';
  const envLiveGenerationDisabled =
    deps.envLiveGenerationDisabled ?? process.env.CHAOS_LIVE_GENERATION_DISABLED === 'true';
  const modelVersion =
    evalRequest.modelVersion ??
    deps.modelVersion ??
    (provider.isMock ? DEFAULT_MOCK_MODEL_VERSION : DEFAULT_LIVE_MODEL_VERSION);
  const pricing = validatePricingFixture(
    deps.pricing ??
      (provider.isMock ? MOCK_PRICING_FIXTURE_V1 : resolvePricingForModel(modelVersion)),
    { requireLiveVerified: !provider.isMock },
  );
  const promptVersion = evalRequest.promptVersion ?? deps.promptVersion ?? CURRENT_PROMPT_VERSION;
  const schemaVersion = evalRequest.schemaVersion ?? deps.schemaVersion ?? CURRENT_SCHEMA_VERSION;
  const providerDeadlineMs = deps.providerDeadlineMs ?? BACKEND_LIMITS.providerDeadlineMs;

  if (!evalRequest.operatorId.trim() || !evalRequest.evalRunId.trim()) {
    throw new RequestValidationError(
      'INVALID_PAYLOAD',
      'operatorId and evalRunId are required for internal evaluation runs',
    );
  }

  const scenario = ALL_SCENARIOS.find((s) => s.incidentId === evalRequest.incidentId);
  if (!scenario) {
    throw new RequestValidationError(
      'INVALID_SCENARIO',
      `Unsupported incidentId "${evalRequest.incidentId}"`,
    );
  }

  if (evalRequest.checkpoint === 'outcome') {
    if (!isValidInterventionId(scenario, evalRequest.selectedInterventionId)) {
      throw new RequestValidationError(
        'INVALID_INTERVENTION',
        `Invalid intervention "${String(evalRequest.selectedInterventionId)}" for evaluation`,
      );
    }
  } else if (evalRequest.selectedInterventionId !== null) {
    throw new RequestValidationError(
      'INVALID_INTERVENTION',
      `Checkpoint "${evalRequest.checkpoint}" requires selectedInterventionId=null`,
    );
  }

  const state = reconstructCanonicalState(
    scenario,
    evalRequest.checkpoint,
    evalRequest.selectedInterventionId,
    {
      modelVersion,
      promptVersion,
      schemaVersion,
    },
  );

  const nowMs = clock.nowMs();
  const requestId = `eval_${evalRequest.evalRunId}`;
  const requestPayloadHash = sha256Hex(
    stableStringify({
      evalRunId: evalRequest.evalRunId,
      operatorId: evalRequest.operatorId,
      incidentId: state.scenario.incidentId,
      checkpoint: state.checkpoint,
      selectedInterventionId: state.selectedInterventionId,
    }),
  );

  const admission = await admitRequestTransaction(deps.db, {
    visitorUid: `operator:${evalRequest.operatorId}`,
    requestId,
    requestPayloadHash,
    state,
    nowMs,
    leaseId: `eval_lease_${randomUUID()}`,
    isEvaluation: true,
    evalRunId: evalRequest.evalRunId,
    operatorId: evalRequest.operatorId,
    envAiDisabled,
    envLiveGenerationDisabled,
    isMockProvider: provider.isMock,
    worstCaseReservationMicros: pricing.worstCaseReservationMicros,
    beforeCommitTestHook: deps.beforeAdmissionCommitHook,
  });

  if (admission.decision !== 'generate') {
    return admission.response;
  }

  return executeProviderAndFinalize({
    db: deps.db,
    provider,
    clock,
    pricing,
    lease: admission.lease,
    state,
    providerDeadlineMs,
    simulateCrashAfterLease: deps.simulateCrashAfterLease,
  });
}
