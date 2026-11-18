import { describe, expect, it } from 'vitest';
import {
  ALL_SCENARIOS,
  CHECKPOINT_TIMES,
  ENGINE_VERSION,
  enumerateCanonicalAnalysisStates,
  sha256Hex,
} from '@chaos-room/shared';
import {
  BACKEND_LIMITS,
  DEFAULT_LIVE_MODEL_VERSION,
  GEMINI_3_1_FLASH_LITE_PRICING_V1,
  GEMINI_3_5_FLASH_LITE_PRICING_V1,
  LIVE_PRODUCTION_ORIGINS,
  MOCK_PRICING_FIXTURE_V1,
  SECONDARY_LIVE_MODEL_VERSION,
  computeTokenCostMicros,
  deriveWorstCaseReservationMicros,
  resolvePricingForModel,
  validatePricingFixture,
} from '../src/config.js';
import {
  assertSafeLiveExecutionEnvironment,
  assertSafeLocalExecutionEnvironment,
  resolveRuntimeMode,
} from '../src/emulatorGuard.js';
import {
  GeminiModelProvider,
  GeminiProviderError,
  OFFICIAL_GEMINI_COUNT_TOKENS_FIXTURES,
  ZERO_BILLABLE_TOKEN_USAGE,
  buildGeminiGenerateContentRequest,
  computeMockCountTokensBreakdown,
  createMockCountTokensTransport,
  estimateLegacyHeuristicInputTokens,
  parseGeminiResponse,
  prepareGeminiRequest,
  verifyPreGenerationInputTokens,
  type GeminiTransport,
} from '../src/geminiProvider.js';
import { MockModelProvider } from '../src/mockProvider.js';
import { OutputValidationError, validateAndNormalizeProviderOutput } from '../src/outputValidator.js';
import { reconstructCanonicalState } from '../src/reconstruction.js';
import {
  RequestValidationError,
  validateAuthAndAppCheck,
  validatePublicAnalyzeRequest,
} from '../src/requestValidator.js';

describe('Phase 3A configuration and accounting math', () => {
  it('centralizes the exact PRD limits, integer microdollar budget, and labeled mock pricing fixture', () => {
    expect(BACKEND_LIMITS.visitorMaxRequestsPerMinute).toBe(2);
    expect(BACKEND_LIMITS.visitorMaxRequestsPerDay).toBe(12);
    expect(BACKEND_LIMITS.visitorMaxPendingRequests).toBe(1);
    expect(BACKEND_LIMITS.projectMaxRequestsPerMinute).toBe(30);
    expect(BACKEND_LIMITS.maxGenerationAttemptsPerDay).toBe(30);
    expect(BACKEND_LIMITS.maxGenerationAttemptsPerMonth).toBe(600);
    expect(BACKEND_LIMITS.monthlySpendAllowanceMicros).toBe(4_500_000);
    expect(BACKEND_LIMITS.maxInputTokens).toBe(8_000);
    expect(BACKEND_LIMITS.maxOutputThinkingTokens).toBe(2_000);
    expect(BACKEND_LIMITS.providerDeadlineMs).toBe(15_000);
    expect(BACKEND_LIMITS.functionTimeoutSeconds).toBe(25);
    expect(BACKEND_LIMITS.cacheTtlMs).toBe(30 * 24 * 60 * 60 * 1000);

    expect(MOCK_PRICING_FIXTURE_V1.isLiveVerifiedPricing).toBe(false);
    expect(MOCK_PRICING_FIXTURE_V1.fixtureLabel).toBe('MOCK_PHASE3A_FIXTURE_UNVERIFIED');
    expect(
      computeTokenCostMicros(
        { inputTokens: 8_000, outputTokens: 1_500, thinkingTokens: 500 },
        MOCK_PRICING_FIXTURE_V1,
      ),
    ).toEqual({ known: true, costMicros: MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros });

    expect(computeTokenCostMicros(null, MOCK_PRICING_FIXTURE_V1)).toEqual({
      known: false,
      costMicros: null,
    });
    expect(
      computeTokenCostMicros(
        { inputTokens: -1, outputTokens: 100, thinkingTokens: 0 },
        MOCK_PRICING_FIXTURE_V1,
      ),
    ).toEqual({ known: false, costMicros: null });
  });
});

describe('Phase 3A local execution isolation guard', () => {
  it('accepts local demo- project with localhost/127.0.0.1 Firestore emulator and no live secrets', () => {
    expect(
      assertSafeLocalExecutionEnvironment({
        GCLOUD_PROJECT: 'demo-chaos-room',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      }),
    ).toEqual({
      projectId: 'demo-chaos-room',
      firestoreEmulatorHost: '127.0.0.1:8080',
    });
  });

  it('rejects missing emulator host, non-demo project IDs, remote hosts, and live credential env vars', () => {
    expect(() =>
      assertSafeLocalExecutionEnvironment({ GCLOUD_PROJECT: 'demo-chaos-room' }),
    ).toThrow(/FIRESTORE_EMULATOR_HOST/);

    expect(() =>
      assertSafeLocalExecutionEnvironment({
        GCLOUD_PROJECT: 'chaos-room-prod',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      }),
    ).toThrow(/demo-/);

    expect(() =>
      assertSafeLocalExecutionEnvironment({
        GCLOUD_PROJECT: 'demo-chaos-room',
        FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443',
      }),
    ).toThrow(/localhost or 127\.0\.0\.1/);

    for (const secretVar of [
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_API_KEY',
    ]) {
      expect(() =>
        assertSafeLocalExecutionEnvironment({
          GCLOUD_PROJECT: 'demo-chaos-room',
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
          [secretVar]: 'should-not-exist-in-phase3a',
        }),
      ).toThrow(/forbidden live credential\/secret/);
    }
  });
});

describe('Request validation and canonical state constraints', () => {
  const validContext = {
    auth: { uid: 'visitor-anon-001' },
    app: { appId: 'appcheck-web-local' },
  };

  it('requires Firebase Auth + App Check context and rejects credential/control claims inside payload', () => {
    expect(() => validateAuthAndAppCheck(null, {})).toThrowError(RequestValidationError);
    expect(() => validateAuthAndAppCheck({ auth: { uid: 'u1' }, app: null }, {})).toThrow(
      /App Check/,
    );
    expect(() => validateAuthAndAppCheck({ auth: null, app: { appId: 'a1' } }, {})).toThrow(
      /Authenticated/,
    );

    expect(() =>
      validateAuthAndAppCheck(validContext, { uid: 'spoofed-user' }),
    ).toThrow(/forbidden/);
    expect(() =>
      validateAuthAndAppCheck(validContext, { appCheckToken: 'spoofed' }),
    ).toThrow(/forbidden/);
  });

  it('accepts all 15 valid canonical request states and rejects unknown fields, oversized input, forged payloads, and cross-scenario actions', () => {
    const states = enumerateCanonicalAnalysisStates(ALL_SCENARIOS);
    expect(states).toHaveLength(15);

    for (const state of states) {
      const outcome = validatePublicAnalyzeRequest({
        incidentId: state.incidentId,
        scenarioVersion: state.scenario.scenarioVersion,
        engineVersion: ENGINE_VERSION,
        checkpoint: state.checkpoint,
        selectedInterventionId: state.selectedInterventionId,
        requestId: `req-${state.incidentId}-${state.checkpoint}`,
      });
      expect(outcome.kind).toBe('valid');
    }

    // Reject unknown fields and caller-supplied telemetry/prompt/control overrides
    expect(() =>
      validatePublicAnalyzeRequest({
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-unknown-01',
        extraField: 'nope',
      }),
    ).toThrow(/Unknown request field/);

    for (const forbidden of [
      { evidence: [] },
      { measures: {} },
      { prompt: 'override' },
      { simTimeSeconds: 999 },
      { bypassCache: true },
      { evaluationMode: true },
      { maxTokens: 99999 },
    ]) {
      expect(() =>
        validatePublicAnalyzeRequest({
          incidentId: 'incident-001',
          scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-forbidden-01',
          ...forbidden,
        }),
      ).toThrow(/forbidden/);
    }

    // Oversized payload
    expect(() =>
      validatePublicAnalyzeRequest({
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'r'.repeat(1200),
      }),
    ).toThrow(/exceeds/);

    // Invalid combinations and cross-scenario intervention IDs
    expect(() =>
      validatePublicAnalyzeRequest({
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: 'rollback-release',
        requestId: 'req-invalid-combo-01',
      }),
    ).toThrow(/requires selectedInterventionId to be null/);

    expect(() =>
      validatePublicAnalyzeRequest({
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'outcome',
        selectedInterventionId: null,
        requestId: 'req-invalid-combo-02',
      }),
    ).toThrow(/is not valid for scenario/);

    // Cross-scenario intervention from incident-002 passed into incident-001
    const s2Intervention = ALL_SCENARIOS[1]!.interventions[0]!.id;
    expect(() =>
      validatePublicAnalyzeRequest({
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'outcome',
        selectedInterventionId: s2Intervention,
        requestId: 'req-cross-scenario-01',
      }),
    ).toThrow(/is not valid for scenario/);

    // Version mismatch returns structured mismatch indicator instead of crashing
    const mismatch = validatePublicAnalyzeRequest({
      incidentId: 'incident-001',
      scenarioVersion: '9.9.9',
      checkpoint: 'alert',
      selectedInterventionId: null,
      requestId: 'req-mismatch-01',
    });
    expect(mismatch.kind).toBe('version_mismatch');
  });

  it('reconstructs exact checkpoint timestamps (180s, 360s, 900s)', () => {
    const scenario = ALL_SCENARIOS[0]!;
    const alertState = reconstructCanonicalState(scenario, 'alert', null);
    const evidenceState = reconstructCanonicalState(scenario, 'evidence', null);
    const outcomeState = reconstructCanonicalState(
      scenario,
      'outcome',
      scenario.interventions[0]!.id,
    );

    expect(alertState.snapshot.simTimeSeconds).toBe(CHECKPOINT_TIMES.alert);
    expect(evidenceState.snapshot.simTimeSeconds).toBe(CHECKPOINT_TIMES.evidence);
    expect(outcomeState.snapshot.simTimeSeconds).toBe(CHECKPOINT_TIMES.outcome);
  });
});

describe('Output validation and server-owned provenance', () => {
  const scenario = ALL_SCENARIOS[0]!;
  const alertState = reconstructCanonicalState(scenario, 'alert', null);
  const evidenceState = reconstructCanonicalState(scenario, 'evidence', null);

  it('normalizes valid provider output and overwrites any spoofed provenance fields', async () => {
    const provider = new MockModelProvider({ kind: 'invented_provenance' });
    const response = await provider.generateAnalysis(
      evidenceState.packet,
      {
        modelVersion: evidenceState.modelVersion,
        promptVersion: evidenceState.promptVersion,
        schemaVersion: evidenceState.schemaVersion,
        maxInputTokens: BACKEND_LIMITS.maxInputTokens,
        maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
        deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
      },
      new AbortController().signal,
    );

    const validated = validateAndNormalizeProviderOutput(response.rawOutput, {
      state: evidenceState,
      generatedAtIso: '2026-11-14T00:00:00.000Z',
      isMockProvider: true,
    });

    expect(validated.sourceMode).toBe('preview_cached_ai');
    expect(validated.isPreviewMock).toBe(true);
    expect(validated.sourceBadgeLabel).toContain('Mocked');
    expect(validated.modelVersion).toBe(evidenceState.modelVersion);
    expect(validated.generatedAtIso).toBe('2026-11-14T00:00:00.000Z');
  });

  it('rejects malformed, oversized, fabricated citation, alert recommendation, and cross-scenario intervention outputs', async () => {
    const behaviors = [
      'malformed_json',
      'oversized_fields',
      'invalid_citations',
      'cross_scenario_intervention',
    ] as const;

    for (const kind of behaviors) {
      const provider = new MockModelProvider({ kind });
      const raw = await provider.generateAnalysis(
        evidenceState.packet,
        {
          modelVersion: evidenceState.modelVersion,
          promptVersion: evidenceState.promptVersion,
          schemaVersion: evidenceState.schemaVersion,
          maxInputTokens: BACKEND_LIMITS.maxInputTokens,
          maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
          deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
        },
        new AbortController().signal,
      );

      expect(() =>
        validateAndNormalizeProviderOutput(raw.rawOutput, {
          state: evidenceState,
          generatedAtIso: '2026-11-14T00:00:00.000Z',
          isMockProvider: true,
        }),
      ).toThrowError(OutputValidationError);
    }

    const alertProvider = new MockModelProvider({ kind: 'alert_with_recommendations' });
    const alertRaw = await alertProvider.generateAnalysis(
      alertState.packet,
      {
        modelVersion: alertState.modelVersion,
        promptVersion: alertState.promptVersion,
        schemaVersion: alertState.schemaVersion,
        maxInputTokens: BACKEND_LIMITS.maxInputTokens,
        maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
        deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
      },
      new AbortController().signal,
    );

    expect(() =>
      validateAndNormalizeProviderOutput(alertRaw.rawOutput, {
        state: alertState,
        generatedAtIso: '2026-11-14T00:00:00.000Z',
        isMockProvider: true,
      }),
    ).toThrow(/Alert checkpoint/);
  });

  it('supports uncooperative mock provider behaviors ignoring AbortSignal for deadline tests', async () => {
    const controller = new AbortController();
    controller.abort();

    const lateResolve = new MockModelProvider({
      kind: 'ignore_abort_resolve_late',
      delayMs: 10,
    });
    const res = await lateResolve.generateAnalysis(
      evidenceState.packet,
      {
        modelVersion: evidenceState.modelVersion,
        promptVersion: evidenceState.promptVersion,
        schemaVersion: evidenceState.schemaVersion,
        maxInputTokens: BACKEND_LIMITS.maxInputTokens,
        maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
        deadlineMs: 5,
      },
      controller.signal,
    );
    expect(res.modelVersion).toBe(evidenceState.modelVersion);

    const lateReject = new MockModelProvider({
      kind: 'ignore_abort_reject_late',
      delayMs: 10,
      message: 'Unstoppable error',
    });
    await expect(
      lateReject.generateAnalysis(
        evidenceState.packet,
        {
          modelVersion: evidenceState.modelVersion,
          promptVersion: evidenceState.promptVersion,
          schemaVersion: evidenceState.schemaVersion,
          maxInputTokens: BACKEND_LIMITS.maxInputTokens,
          maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
          deadlineMs: 5,
        },
        controller.signal,
      ),
    ).rejects.toThrow(/Unstoppable error/);
  });
});

describe('Phase 3B live pricing derivation, runtime mode guards, and Gemini adapter', () => {
  const scenario = ALL_SCENARIOS[0]!;
  const alertState = reconstructCanonicalState(scenario, 'alert', null, {
    modelVersion: DEFAULT_LIVE_MODEL_VERSION,
  });
  const evidenceState = reconstructCanonicalState(scenario, 'evidence', null, {
    modelVersion: DEFAULT_LIVE_MODEL_VERSION,
  });

  function makeGroundedOutputJson(packet: typeof evidenceState.packet): string {
    const firstEv = packet.visibleEvidence[0]!.id;
    const firstOpt = packet.visibleInterventions[0]?.id;
    return JSON.stringify({
      conciseAssessment: `Grounded telemetry assessment at ${packet.checkpoint} (${packet.simTimeSeconds}s).`,
      observedFacts: [{ text: 'Observed primary metric spike.', citationIds: [firstEv] }],
      rankedHypotheses: [
        {
          rank: 1,
          statement: 'Pool saturation matches observed telemetry.',
          likelihood: 'Primary',
          supportingCitationIds: [firstEv],
        },
      ],
      alternativeExplanations: [],
      missingInformation: ['Confirm post-mitigation latency.'],
      confidence: { level: 'Medium', justification: 'Grounded in visible checkpoint metrics.' },
      recommendedInterventions:
        packet.checkpoint === 'alert' || !firstOpt
          ? []
          : [
              {
                interventionId: firstOpt,
                rationale: 'Addresses bottleneck directly.',
                keyRisk: 'Operational tradeoff exists.',
              },
            ],
      verificationChecks: ['Inspect connection pool saturation after change.'],
      stakeholderUpdate: 'Investigation in progress with grounded telemetry indicators.',
    });
  }

  it('derives server-owned worst-case reservations and accounts for all billable tokens', () => {
    expect(GEMINI_3_5_FLASH_LITE_PRICING_V1.isLiveVerifiedPricing).toBe(true);
    expect(GEMINI_3_5_FLASH_LITE_PRICING_V1.worstCaseReservationMicros).toBe(7_400);
    expect(
      BACKEND_LIMITS.maxGenerationAttemptsPerMonth *
        GEMINI_3_5_FLASH_LITE_PRICING_V1.worstCaseReservationMicros,
    ).toBeLessThanOrEqual(BACKEND_LIMITS.monthlySpendAllowanceMicros);

    expect(
      deriveWorstCaseReservationMicros({
        inputRateMicrosPerMillion: 250_000,
        outputThinkingRateMicrosPerMillion: 1_500_000,
      }),
    ).toBe(GEMINI_3_1_FLASH_LITE_PRICING_V1.worstCaseReservationMicros);

    expect(
      resolvePricingForModel(SECONDARY_LIVE_MODEL_VERSION, { allowMockPricing: false }).fixtureLabel,
    ).toBe(GEMINI_3_1_FLASH_LITE_PRICING_V1.fixtureLabel);

    expect(() => resolvePricingForModel('gemini-unsupported-99')).toThrow(/Unsupported/);
    expect(() =>
      validatePricingFixture(MOCK_PRICING_FIXTURE_V1, { requireLiveVerified: true }),
    ).toThrow(/not verified/);

    // Account conservatively for extra billable tokens reflected in totalTokens
    expect(
      computeTokenCostMicros(
        {
          inputTokens: 1_000,
          outputTokens: 500,
          thinkingTokens: 200,
          totalTokens: 1_800, // +100 extra billable tokens billed at output rate
        },
        GEMINI_3_5_FLASH_LITE_PRICING_V1,
      ),
    ).toEqual({
      known: true,
      costMicros: 300 + 2_000,
    });

    // Inconsistent totalTokens < component sum falls back to unknown so full reservation is kept
    expect(
      computeTokenCostMicros(
        {
          inputTokens: 1_000,
          outputTokens: 500,
          thinkingTokens: 200,
          totalTokens: 1_200,
        },
        GEMINI_3_5_FLASH_LITE_PRICING_V1,
      ),
    ).toEqual({ known: false, costMicros: null });
  });

  it('defaults to emulator_mock and requires explicit opt-in flags + secrets for live_gemini', () => {
    expect(resolveRuntimeMode({})).toBe('emulator_mock');
    expect(resolveRuntimeMode({ CHAOS_BACKEND_MODE: 'emulator_mock' })).toBe('emulator_mock');
    expect(() => resolveRuntimeMode({ CHAOS_BACKEND_MODE: 'invalid_mode' })).toThrow(
      /Unsupported CHAOS_BACKEND_MODE/,
    );

    expect(() =>
      assertSafeLiveExecutionEnvironment(
        { GCLOUD_PROJECT: 'chaos-room-prod', CHAOS_BACKEND_MODE: 'live_gemini' },
        { secretApiKey: 'test-key' },
      ),
    ).toThrow(/CHAOS_LIVE_GEMINI_ENABLED/);

    expect(() =>
      assertSafeLiveExecutionEnvironment(
        {
          GCLOUD_PROJECT: 'demo-chaos-room',
          CHAOS_BACKEND_MODE: 'live_gemini',
          CHAOS_LIVE_GEMINI_ENABLED: 'true',
        },
        { secretApiKey: 'test-key' },
      ),
    ).toThrow(/non-demo/);

    expect(() =>
      assertSafeLiveExecutionEnvironment(
        {
          GCLOUD_PROJECT: 'chaos-room-prod',
          CHAOS_BACKEND_MODE: 'live_gemini',
          CHAOS_LIVE_GEMINI_ENABLED: 'true',
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        },
        { secretApiKey: 'test-key' },
      ),
    ).toThrow(/emulator/);

    expect(() =>
      assertSafeLiveExecutionEnvironment(
        {
          GCLOUD_PROJECT: 'chaos-room-prod',
          CHAOS_BACKEND_MODE: 'live_gemini',
          CHAOS_LIVE_GEMINI_ENABLED: 'true',
        },
        { secretApiKey: '' },
      ),
    ).toThrow(/GEMINI_API_KEY/);

    const liveEnv = assertSafeLiveExecutionEnvironment(
      {
        GCLOUD_PROJECT: 'chaos-room-prod',
        CHAOS_BACKEND_MODE: 'live_gemini',
        CHAOS_LIVE_GEMINI_ENABLED: 'true',
      },
      { secretApiKey: 'secret-value-redacted' },
    );
    expect(liveEnv.modelVersion).toBe(DEFAULT_LIVE_MODEL_VERSION);
    expect(liveEnv.pricing).toEqual(GEMINI_3_5_FLASH_LITE_PRICING_V1);
    expect(liveEnv.allowedOrigins).toEqual(LIVE_PRODUCTION_ORIGINS);
  });

  it('sends only CanonicalAIPacket over matched generateContent + countTokens contract without walkthroughs/debrief, parses usageMetadata, and performs zero retries', async () => {
    const capturedCountTokensUrls: string[] = [];
    const capturedCountTokensHeaders: Record<string, string>[] = [];
    const capturedCountTokensBodies: Record<string, unknown>[] = [];
    const capturedGenerateUrls: string[] = [];
    const capturedGenerateBodies: Record<string, unknown>[] = [];

    const countTokensTransport: GeminiTransport = async (req) => {
      capturedCountTokensUrls.push(req.url);
      capturedCountTokensHeaders.push(req.headers);
      capturedCountTokensBodies.push(req.body);
      return {
        status: 200,
        body: { totalTokens: 3_100 },
      };
    };

    const transport: GeminiTransport = async (req) => {
      capturedGenerateUrls.push(req.url);
      capturedGenerateBodies.push(req.body);
      expect(req.headers['x-goog-api-key']).toBe('unit-secret-key');
      expect(req.headers['X-Chaos-Request-Sha256']).toBeUndefined();
      return {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: makeGroundedOutputJson(evidenceState.packet) }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 3_100,
            candidatesTokenCount: 600,
            thoughtsTokenCount: 250,
            totalTokenCount: 3_950,
          },
        },
      };
    };

    const provider = new GeminiModelProvider({
      apiKey: 'unit-secret-key',
      countTokensTransport,
      transport,
    });
    expect(provider.isMock).toBe(false);

    const response = await provider.generateAnalysis(
      evidenceState.packet,
      {
        modelVersion: DEFAULT_LIVE_MODEL_VERSION,
        promptVersion: evidenceState.promptVersion,
        schemaVersion: evidenceState.schemaVersion,
        maxInputTokens: BACKEND_LIMITS.maxInputTokens,
        maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
        deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
      },
      new AbortController().signal,
    );

    expect(capturedCountTokensUrls).toEqual([
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_LIVE_MODEL_VERSION}:countTokens`,
    ]);
    expect(capturedCountTokensHeaders[0]!['X-Chaos-Request-Sha256']).toBeUndefined();
    expect(capturedGenerateUrls).toEqual([
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_LIVE_MODEL_VERSION}:generateContent`,
    ]);

    expect(capturedGenerateBodies).toHaveLength(1);
    const reqBody = capturedGenerateBodies[0]!;
    const countBody = capturedCountTokensBodies[0] as {
      generateContentRequest: Record<string, unknown>;
    };
    const { model: countedModel, ...countedRest } = countBody.generateContentRequest;
    expect(countedModel).toBe(`models/${DEFAULT_LIVE_MODEL_VERSION}`);
    // CountTokensRequest.generateContentRequest must match the exact GenerateContentRequest sent.
    expect(countedRest).toEqual(reqBody);

    const genConfig = reqBody.generationConfig as {
      responseMimeType: string;
      responseJsonSchema: Record<string, unknown>;
      maxOutputTokens: number;
      thinkingConfig: { thinkingLevel: string };
    };
    expect(genConfig.responseMimeType).toBe('application/json');
    expect(genConfig.maxOutputTokens).toBe(BACKEND_LIMITS.maxOutputThinkingTokens);
    expect(genConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(genConfig.responseJsonSchema).toBeDefined();

    // Verify zero walkthrough / debrief leakage into prompt input or system instructions
    const serializedRequest = JSON.stringify(reqBody);
    expect(serializedRequest).not.toContain(scenario.debrief.actualRootCause);
    expect(serializedRequest).not.toContain(scenario.debrief.technicalTitle);
    expect(serializedRequest).not.toContain(scenario.walkthroughs.evidence.conciseAssessment);

    expect(response.usage).toEqual({
      inputTokens: 3_100,
      outputTokens: 600,
      thinkingTokens: 250,
      totalTokens: 3_950,
    });

    const normalized = validateAndNormalizeProviderOutput(response.rawOutput, {
      state: evidenceState,
      generatedAtIso: '2026-11-14T12:00:00.000Z',
      isMockProvider: provider.isMock,
    });
    expect(normalized.isPreviewMock).toBe(false);
    expect(normalized.sourceBadgeLabel).toBe('AI analysis (generated live)');
    expect(normalized.modelVersion).toBe(DEFAULT_LIVE_MODEL_VERSION);

    // Verify Alert schema constrains recommendedInterventions to maxItems: 0
    const alertReq = buildGeminiGenerateContentRequest({
      packet: alertState.packet,
      options: {
        modelVersion: DEFAULT_LIVE_MODEL_VERSION,
        promptVersion: alertState.promptVersion,
        schemaVersion: alertState.schemaVersion,
        maxInputTokens: BACKEND_LIMITS.maxInputTokens,
        maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
        deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
      },
      apiKey: 'unit-secret-key',
    });
    const alertSchema = alertReq.body.generationConfig.responseJsonSchema as {
      properties: { recommendedInterventions: { maxItems?: number } };
    };
    expect(alertSchema.properties.recommendedInterventions.maxItems).toBe(0);
  });

  it('retains unknown usage on missing metadata, uses preflight count when promptTokenCount is omitted, rejects MAX_TOKENS, and never retries', async () => {
    const baseOptions = {
      modelVersion: DEFAULT_LIVE_MODEL_VERSION,
      promptVersion: evidenceState.promptVersion,
      schemaVersion: evidenceState.schemaVersion,
      maxInputTokens: BACKEND_LIMITS.maxInputTokens,
      maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
      deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
    };

    // Completely missing usageMetadata -> usage: null (retains full worst-case reservation)
    const missingUsage = parseGeminiResponse(
      {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: makeGroundedOutputJson(evidenceState.packet) }],
              },
              finishReason: 'STOP',
            },
          ],
        },
      },
      baseOptions,
    );
    expect(missingUsage.usage).toBeNull();

    // Omitted promptTokenCount inside usageMetadata falls back to verified :countTokens count
    const fallbackProvider = new GeminiModelProvider({
      apiKey: 'unit-secret-key',
      countTokensTransport: async () => ({ status: 200, body: { totalTokens: 3_412 } }),
      transport: async () => ({
        status: 200,
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: makeGroundedOutputJson(evidenceState.packet) }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            candidatesTokenCount: 420,
            thoughtsTokenCount: 80,
          },
        },
      }),
    });
    const fallbackRes = await fallbackProvider.generateAnalysis(
      evidenceState.packet,
      baseOptions,
      new AbortController().signal,
    );
    expect(fallbackRes.usage).toEqual({
      inputTokens: 3_412,
      outputTokens: 420,
      thinkingTokens: 80,
      totalTokens: 3_912,
    });

    // MAX_TOKENS truncation throws GeminiProviderError carrying parsed usage for billing
    expect(() =>
      parseGeminiResponse(
        {
          status: 200,
          body: {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: '{"partial":' }] },
                finishReason: 'MAX_TOKENS',
              },
            ],
            usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 100, thoughtsTokenCount: 50 },
          },
        },
        baseOptions,
      ),
    ).toThrowError(GeminiProviderError);

    // HTTP 503 failure invokes paid transport once (zero automatic retries)
    let calls = 0;
    const failingProvider = new GeminiModelProvider({
      apiKey: 'unit-secret-key',
      countTokensTransport: async () => ({ status: 200, body: { totalTokens: 3_200 } }),
      transport: async () => {
        calls += 1;
        return {
          status: 503,
          body: { error: { message: 'Upstream temporarily unavailable' } },
        };
      },
    });
    await expect(
      failingProvider.generateAnalysis(
        evidenceState.packet,
        baseOptions,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Upstream temporarily unavailable/);
    expect(calls).toBe(1);

    // Rejects unsupported model before invoking transport
    await expect(
      failingProvider.generateAnalysis(
        evidenceState.packet,
        {
          ...baseOptions,
          modelVersion: 'gemini-deprecated-2.0',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Unsupported live Gemini model/);
    expect(calls).toBe(1);
  });

  it('grounds CountTokens contract with official API doc fixtures, covers all components, and checks all 15 canonical states under mocked offline counts', async () => {
    const mockTransport = createMockCountTokensTransport();

    // 1. Official Gemini API documentation fixtures (ai.google.dev/gemini-api/docs/tokens & /api/tokens)
    for (const fixture of OFFICIAL_GEMINI_COUNT_TOKENS_FIXTURES) {
      const resp = await mockTransport({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_LIVE_MODEL_VERSION}:countTokens`,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'unit-secret-key' },
        body: {
          generateContentRequest: {
            model: `models/${DEFAULT_LIVE_MODEL_VERSION}`,
            contents: [{ role: 'user', parts: [{ text: fixture.contentsText }] }],
          },
        },
        abortSignal: new AbortController().signal,
        timeoutMs: BACKEND_LIMITS.providerDeadlineMs,
      });
      expect(resp.status).toBe(200);
      expect(resp.body).toEqual({ totalTokens: fixture.expectedTotalTokens });
    }

    // 2. Component coverage inside CountTokensRequest.generateContentRequest:
    // systemInstruction, contents, and generationConfig.responseJsonSchema
    const baseOptions = {
      modelVersion: DEFAULT_LIVE_MODEL_VERSION,
      promptVersion: alertState.promptVersion,
      schemaVersion: alertState.schemaVersion,
      maxInputTokens: BACKEND_LIMITS.maxInputTokens,
      maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
      deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
    };
    const preparedAlert = prepareGeminiRequest({
      packet: alertState.packet,
      options: baseOptions,
      apiKey: 'unit-secret-key',
    });
    const baseBreakdown = computeMockCountTokensBreakdown(
      preparedAlert.countTokensRequest.body as unknown as Record<string, unknown>,
    )!;
    expect(baseBreakdown.isOfficialDocFixture).toBe(false);
    expect(baseBreakdown.systemInstructionTokens).toBeGreaterThan(0);
    expect(baseBreakdown.contentsTokens).toBeGreaterThan(0);
    expect(baseBreakdown.responseSchemaTokens).toBeGreaterThan(0);
    expect(baseBreakdown.totalTokens).toBe(
      baseBreakdown.systemInstructionTokens +
        baseBreakdown.contentsTokens +
        baseBreakdown.responseSchemaTokens +
        baseBreakdown.envelopeTokens,
    );

    const largerSysBreakdown = computeMockCountTokensBreakdown({
      generateContentRequest: {
        ...preparedAlert.countTokensRequest.body.generateContentRequest,
        systemInstruction: {
          parts: [
            {
              text: `${preparedAlert.systemInstruction} Additional system instruction context tokens.`,
            },
          ],
        },
      },
    })!;
    expect(largerSysBreakdown.systemInstructionTokens).toBeGreaterThan(
      baseBreakdown.systemInstructionTokens,
    );

    const largerContentsBreakdown = computeMockCountTokensBreakdown({
      generateContentRequest: {
        ...preparedAlert.countTokensRequest.body.generateContentRequest,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${preparedAlert.inputPayload} Additional canonical telemetry event tokens.`,
              },
            ],
          },
        ],
      },
    })!;
    expect(largerContentsBreakdown.contentsTokens).toBeGreaterThan(baseBreakdown.contentsTokens);

    const largerSchemaBreakdown = computeMockCountTokensBreakdown({
      generateContentRequest: {
        ...preparedAlert.countTokensRequest.body.generateContentRequest,
        generationConfig: {
          ...preparedAlert.countTokensRequest.body.generateContentRequest.generationConfig,
          responseJsonSchema: buildGeminiGenerateContentRequest({
            packet: evidenceState.packet,
            options: baseOptions,
            apiKey: 'unit-secret-key',
          }).body.generationConfig.responseJsonSchema,
        },
      },
    })!;
    expect(largerSchemaBreakdown.responseSchemaTokens).toBeGreaterThan(
      baseBreakdown.responseSchemaTokens,
    );

    // 3. All 15 canonical states exercised with matched countTokens + generateContent payloads
    const canonicalStates = enumerateCanonicalAnalysisStates(ALL_SCENARIOS);
    expect(canonicalStates).toHaveLength(15);

    const seenDigests = new Set<string>();
    const mockCountsAcross15States: number[] = [];
    const legacyCountsAcross15States: number[] = [];

    for (const item of canonicalStates) {
      const state = reconstructCanonicalState(
        item.scenario,
        item.checkpoint,
        item.selectedInterventionId,
        { modelVersion: DEFAULT_LIVE_MODEL_VERSION },
      );
      const options = {
        modelVersion: DEFAULT_LIVE_MODEL_VERSION,
        promptVersion: state.promptVersion,
        schemaVersion: state.schemaVersion,
        maxInputTokens: BACKEND_LIMITS.maxInputTokens,
        maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
        deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
      };
      const prepared = prepareGeminiRequest({
        packet: state.packet,
        options,
        apiKey: 'unit-secret-key',
      });

      const mockBreakdown = computeMockCountTokensBreakdown(
        prepared.countTokensRequest.body as unknown as Record<string, unknown>,
      )!;
      expect(mockBreakdown.totalTokens).toBeGreaterThan(0);
      expect(mockBreakdown.totalTokens).toBeLessThanOrEqual(BACKEND_LIMITS.maxInputTokens);
      expect(prepared.requestSha256).toBe(sha256Hex(prepared.generateContentRequest.serializedBody));
      expect(JSON.stringify(prepared.countTokensRequest.body)).toContain(
        prepared.responseSchemaJson,
      );
      seenDigests.add(prepared.requestSha256);
      mockCountsAcross15States.push(mockBreakdown.totalTokens);
      legacyCountsAcross15States.push(prepared.legacyHeuristicTokens);

      let checkedJson = '';
      let sentJson = '';
      const provider = new GeminiModelProvider({
        apiKey: 'unit-secret-key',
        countTokensTransport: async (req) => {
          const parsedCount = JSON.parse(req.serializedBody!) as {
            generateContentRequest: { model: string } & Record<string, unknown>;
          };
          const { model: _m, ...withoutModel } = parsedCount.generateContentRequest;
          checkedJson = JSON.stringify(withoutModel);
          return mockTransport(req);
        },
        transport: async (req) => {
          sentJson = req.serializedBody!;
          return {
            status: 200,
            body: {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: makeGroundedOutputJson(state.packet) }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: mockBreakdown.totalTokens,
                candidatesTokenCount: 450,
                thoughtsTokenCount: 150,
                totalTokenCount: mockBreakdown.totalTokens + 600,
              },
            },
          };
        },
      });
      const res = await provider.generateAnalysis(
        state.packet,
        options,
        new AbortController().signal,
      );
      expect(sentJson).toBe(checkedJson);
      expect(res.usage?.inputTokens).toBe(mockBreakdown.totalTokens);
    }

    expect(seenDigests.size).toBe(15);
    // Exact mocked offline fixture totals & legacy byte/3 diagnostic counts (NOT live provider counts):
    expect(Math.min(...mockCountsAcross15States)).toBe(3_108);
    expect(Math.max(...mockCountsAcross15States)).toBe(5_978);
    expect(Math.min(...legacyCountsAcross15States)).toBe(2_418);
    expect(Math.max(...legacyCountsAcross15States)).toBe(4_934);
  });

  it('relies strictly on :countTokens (catching legacy heuristic underestimation on dense ASCII) and enforces exact 8,000 vs 8,001 boundary', async () => {
    const baseOptions = {
      modelVersion: DEFAULT_LIVE_MODEL_VERSION,
      promptVersion: alertState.promptVersion,
      schemaVersion: alertState.schemaVersion,
      maxInputTokens: BACKEND_LIMITS.maxInputTokens,
      maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
      deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
    };

    // Dense ASCII punctuation: legacy byte/3 underestimates (< 8,000), while :countTokens
    // reports 8,450 > 8,000 and blocks paid generation completely.
    const densePacket = structuredClone(alertState.packet);
    densePacket.visibleEvidence[0]!.summary = '{},'.repeat(1_800);
    const densePrepared = prepareGeminiRequest({
      packet: densePacket,
      options: baseOptions,
      apiKey: 'unit-secret-key',
    });
    const legacyEstimate = estimateLegacyHeuristicInputTokens(
      densePrepared.systemInstruction,
      densePrepared.inputPayload,
      densePrepared.responseSchema,
    );
    expect(legacyEstimate).toBeLessThan(BACKEND_LIMITS.maxInputTokens);

    let paidCalls = 0;
    let countCalls = 0;
    let returnedCountTokens = 8_450;

    const provider = new GeminiModelProvider({
      apiKey: 'unit-secret-key',
      countTokensTransport: async () => {
        countCalls += 1;
        return {
          status: 200,
          body: { totalTokens: returnedCountTokens },
        };
      },
      transport: async () => {
        paidCalls += 1;
        return {
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: makeGroundedOutputJson(alertState.packet) }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: returnedCountTokens,
              candidatesTokenCount: 300,
              thoughtsTokenCount: 50,
              totalTokenCount: returnedCountTokens + 350,
            },
          },
        };
      },
    });

    await expect(
      provider.generateAnalysis(densePacket, baseOptions, new AbortController().signal),
    ).rejects.toMatchObject({
      name: 'GeminiProviderError',
      phase: 'pre_generation',
      reasonCode: 'input_token_limit_exceeded',
      usage: ZERO_BILLABLE_TOKEN_USAGE,
    });
    expect(countCalls).toBe(1);
    expect(paidCalls).toBe(0);

    // Exact boundary: 8,000 from :countTokens is permitted and reaches paid generation
    returnedCountTokens = 8_000;
    await expect(
      provider.generateAnalysis(alertState.packet, baseOptions, new AbortController().signal),
    ).resolves.toBeDefined();
    expect(countCalls).toBe(2);
    expect(paidCalls).toBe(1);

    // Oversized by 1 token: 8,001 from :countTokens blocks paid generation
    returnedCountTokens = 8_001;
    await expect(
      provider.generateAnalysis(alertState.packet, baseOptions, new AbortController().signal),
    ).rejects.toMatchObject({
      name: 'GeminiProviderError',
      phase: 'pre_generation',
      reasonCode: 'input_token_limit_exceeded',
      usage: ZERO_BILLABLE_TOKEN_USAGE,
    });
    expect(countCalls).toBe(3);
    expect(paidCalls).toBe(1);
  });

  it('rejects malformed :countTokens responses, HTTP errors, timeouts, and request tampering with paidCalls=0, and preserves overrun usage', async () => {
    const baseOptions = {
      modelVersion: DEFAULT_LIVE_MODEL_VERSION,
      promptVersion: alertState.promptVersion,
      schemaVersion: alertState.schemaVersion,
      maxInputTokens: BACKEND_LIMITS.maxInputTokens,
      maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
      deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
    };

    let paidCalls = 0;
    const paidTransport: GeminiTransport = async () => {
      paidCalls += 1;
      return { status: 200, body: {} };
    };

    // 1. Malformed :countTokens response bodies never invoke paid transport
    const malformedBodies: unknown[] = [
      {},
      { totalTokens: 0 },
      { totalTokens: -1 },
      { totalTokens: 12.5 },
      { totalTokens: '4000' },
      null,
    ];
    for (const malformedBody of malformedBodies) {
      const malformedProvider = new GeminiModelProvider({
        apiKey: 'unit-secret-key',
        countTokensTransport: async () => ({ status: 200, body: malformedBody }),
        transport: paidTransport,
      });
      await expect(
        malformedProvider.generateAnalysis(alertState.packet, baseOptions, new AbortController().signal),
      ).rejects.toMatchObject({
        phase: 'pre_generation',
        reasonCode: 'count_tokens_unverified',
        usage: ZERO_BILLABLE_TOKEN_USAGE,
      });
    }
    expect(paidCalls).toBe(0);

    // 2. countTokens HTTP 503 failure
    const errProvider = new GeminiModelProvider({
      apiKey: 'unit-secret-key',
      countTokensTransport: async () => ({
        status: 503,
        body: { error: { message: 'countTokens down' } },
      }),
      transport: paidTransport,
    });
    await expect(
      errProvider.generateAnalysis(alertState.packet, baseOptions, new AbortController().signal),
    ).rejects.toMatchObject({
      phase: 'pre_generation',
      reasonCode: 'count_tokens_failed',
      usage: ZERO_BILLABLE_TOKEN_USAGE,
    });
    expect(paidCalls).toBe(0);

    // 3. countTokens timeout ignoring AbortSignal never triggers paid transport even after late resolution
    const lateCountProvider = new GeminiModelProvider({
      apiKey: 'unit-secret-key',
      countTokensTransport: async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: 200, body: { totalTokens: 3_000 } }), 120);
        }),
      transport: paidTransport,
    });
    await expect(
      lateCountProvider.generateAnalysis(
        alertState.packet,
        { ...baseOptions, deadlineMs: 25 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      phase: 'pre_generation',
      reasonCode: 'count_tokens_timeout',
      usage: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(paidCalls).toBe(0);

    // 4. Canonical content mutation between counting and paid generation is caught cleanly
    const mutablePacket = structuredClone(alertState.packet);
    const mutatedPacketProvider = new GeminiModelProvider({
      apiKey: 'unit-secret-key',
      countTokensTransport: async () => ({ status: 200, body: { totalTokens: 3_500 } }),
      beforePaidGenerationHook: () => {
        mutablePacket.visibleEvidence[0]!.summary = 'Tampered after countTokens verification';
      },
      transport: paidTransport,
    });
    await expect(
      mutatedPacketProvider.generateAnalysis(mutablePacket, baseOptions, new AbortController().signal),
    ).rejects.toMatchObject({
      phase: 'pre_generation',
      reasonCode: 'request_content_changed',
      usage: ZERO_BILLABLE_TOKEN_USAGE,
    });
    expect(paidCalls).toBe(0);

    // 5. Mutating prepared generateContentRequest payload after counting is caught cleanly
    const mutatedBodyProvider = new GeminiModelProvider({
      apiKey: 'unit-secret-key',
      countTokensTransport: async () => ({ status: 200, body: { totalTokens: 3_500 } }),
      beforePaidGenerationHook: (prepared) => {
        prepared.generateContentRequest.serializedBody = '{"tampered":true}';
      },
      transport: paidTransport,
    });
    await expect(
      mutatedBodyProvider.generateAnalysis(alertState.packet, baseOptions, new AbortController().signal),
    ).rejects.toMatchObject({
      phase: 'pre_generation',
      reasonCode: 'request_content_changed',
      usage: ZERO_BILLABLE_TOKEN_USAGE,
    });
    expect(paidCalls).toBe(0);

    // 6. Unexpected provider usage overrun (> 7,400 worst-case reservation) is preserved unclamped
    let overrunError: GeminiProviderError | null = null;
    try {
      parseGeminiResponse(
        {
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: makeGroundedOutputJson(alertState.packet) }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 10_000,
              candidatesTokenCount: 2_000,
              thoughtsTokenCount: 1_000,
              totalTokenCount: 13_000,
            },
          },
        },
        baseOptions,
      );
    } catch (error) {
      overrunError = error as GeminiProviderError;
    }
    expect(overrunError).toBeInstanceOf(GeminiProviderError);
    expect(
      computeTokenCostMicros(overrunError?.usage, GEMINI_3_5_FLASH_LITE_PRICING_V1),
    ).toEqual({
      known: true,
      costMicros: 10_500, // 10k * $0.30/1M ($0.003) + 3k * $2.50/1M ($0.0075) = $0.0105 > $0.0074 reservation
    });
  });

  it('verifyPreGenerationInputTokens handles official doc example request shapes cleanly', async () => {
    const prepared = prepareGeminiRequest({
      packet: alertState.packet,
      options: {
        modelVersion: DEFAULT_LIVE_MODEL_VERSION,
        promptVersion: alertState.promptVersion,
        schemaVersion: alertState.schemaVersion,
        maxInputTokens: BACKEND_LIMITS.maxInputTokens,
        maxOutputThinkingTokens: BACKEND_LIMITS.maxOutputThinkingTokens,
        deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
      },
      apiKey: 'unit-secret-key',
    });
    const verified = await verifyPreGenerationInputTokens({
      prepared,
      maxInputTokens: BACKEND_LIMITS.maxInputTokens,
      deadlineMs: BACKEND_LIMITS.providerDeadlineMs,
      abortSignal: new AbortController().signal,
      countTokensTransport: async () => ({ status: 200, body: { totalTokens: 4_123 } }),
    });
    expect(verified).toEqual({ verifiedInputTokens: 4_123, reportedCountTokens: 4_123 });
  });
});
