import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { validateAnalysisResult, type AnalysisResult } from '@chaos-room/shared';
import {
  BACKEND_LIMITS,
  FIRESTORE_COLLECTIONS,
  MOCK_PRICING_FIXTURE_V1,
  SYSTEM_CONTROL_DOC_ID,
} from './config.js';
import { RequestValidationError } from './requestValidator.js';
import type {
  AnalyzeIncidentResponse,
  AnalyzeIncidentStatus,
  GenerationLease,
  QuotaReasonCode,
  ReconstructedState,
} from './types.js';

export function getUtcMinuteKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

export function getUtcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

export function getUtcMonthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7); // YYYY-MM
}

interface ActiveLeaseRef {
  leaseId: string;
  requestId: string;
  visitorUid: string;
  acquiredAtMs: number;
  expiresAtMs: number;
}

interface CacheDocData {
  cacheDocId: string;
  cacheKey: string;
  packetSha256?: string;
  modelVersion?: string;
  promptVersion?: string;
  schemaVersion?: string;
  status: 'ready' | 'leased' | 'cooldown';
  result?: AnalysisResult;
  generatedAtMs?: number;
  generatedAtIso?: string;
  expiresAtMs?: number;
  expiresAtIso?: string;
  isMockProvider?: boolean;
  currentLease?: ActiveLeaseRef | null;
  cooldownUntilMs?: number | null;
  lastFailureStatus?: AnalyzeIncidentStatus | null;
  lastFailureReason?: string | null;
}

interface VisitorStateDoc {
  minuteKey?: string;
  minuteCount?: number;
  dayKey?: string;
  dayCount?: number;
  activeLease?: ActiveLeaseRef | null;
}

interface StoredIdentityMeta {
  cacheDocId?: string;
  cacheKey?: string;
  packetSha256?: string;
  modelVersion?: string;
  promptVersion?: string;
  schemaVersion?: string;
  responseGeneratedAtMs?: number;
  responseExpiresAtMs?: number;
}

interface RequestRecordDoc extends StoredIdentityMeta {
  requestId: string;
  visitorUid: string;
  requestPayloadHash: string;
  status: 'in_flight' | 'completed';
  leaseId?: string;
  leaseExpiresAtMs?: number;
  response?: AnalyzeIncidentResponse;
  createdAtMs: number;
  updatedAtMs: number;
}

interface GenerationAttemptDoc extends StoredIdentityMeta {
  leaseId: string;
  requestId: string;
  visitorUid: string;
  cacheDocId: string;
  cacheKey: string;
  isEvaluation: boolean;
  evalRunId?: string;
  operatorId?: string;
  quotaDayKey: string;
  quotaMonthKey: string;
  acquiredAtMs: number;
  expiresAtMs: number;
  reservedCostMicros: number;
  reconciled: boolean;
  status: 'in_flight' | AnalyzeIncidentStatus;
  finalizedAtMs?: number;
  chargedCostMicros?: number;
  refundedCostMicros?: number;
  usageKnown?: boolean;
  staleLeaseIgnored?: boolean;
  finalizedResponse?: AnalyzeIncidentResponse;
}

interface MonthQuotaDoc {
  monthKey: string;
  attempts: number;
  actualSpendMicros: number;
  reservedSpendMicros: number;
  committedSpendMicros: number;
}

export interface AdmitRequestParams {
  visitorUid: string;
  requestId: string;
  requestPayloadHash: string;
  state: ReconstructedState;
  nowMs: number;
  leaseId: string;
  isEvaluation: boolean;
  evalRunId?: string;
  operatorId?: string;
  envAiDisabled: boolean;
  envLiveGenerationDisabled?: boolean;
  isMockProvider: boolean;
  worstCaseReservationMicros?: number;
  beforeCommitTestHook?: (attemptNumber: number) => Promise<void> | void;
}

export type AdmissionDecision =
  | {
      decision: 'disabled';
      response: AnalyzeIncidentResponse;
    }
  | {
      decision: 'duplicate_completed';
      response: AnalyzeIncidentResponse;
    }
  | {
      decision: 'pending';
      response: AnalyzeIncidentResponse;
    }
  | {
      decision: 'quota_reached';
      response: AnalyzeIncidentResponse;
    }
  | {
      decision: 'cache_hit';
      response: AnalyzeIncidentResponse;
    }
  | {
      decision: 'cooldown';
      response: AnalyzeIncidentResponse;
    }
  | {
      decision: 'generate';
      lease: GenerationLease;
    };

export interface FinalizeGenerationOutcome {
  kind: 'success' | 'timeout' | 'invalid_output' | 'unavailable';
  reasonCode: string;
  message: string;
  result?: AnalysisResult;
  usageKnown: boolean;
  actualCostMicros: number | null;
}

export interface FinalizeResult {
  alreadyFinalized: boolean;
  chargedCostMicros: number;
  refundedCostMicros: number;
  staleLeaseIgnored: boolean;
  response: AnalyzeIncidentResponse;
}

function getCacheHitBadgeLabel(isMockProvider: boolean): string {
  return isMockProvider ? 'Mocked AI analysis (shared cache hit)' : 'AI analysis (shared cache hit)';
}

function getCacheHitMessage(isMockProvider: boolean): string {
  return isMockProvider
    ? 'Served validated mocked analysis from shared Firestore cache.'
    : 'Served validated Gemini analysis from shared Firestore cache.';
}

function getFreshGenerationMessage(isMockProvider: boolean): string {
  return isMockProvider
    ? 'Generated and validated mocked AI analysis.'
    : 'Generated and validated live Gemini AI analysis.';
}

function buildResponseEnvelope(
  state: ReconstructedState,
  nowMs: number,
  isMockProvider: boolean,
  partial: Omit<
    AnalyzeIncidentResponse,
    'incidentId' | 'checkpoint' | 'selectedInterventionId' | 'cacheKey' | 'isMockProvider' | 'serverTimeIso'
  >,
): AnalyzeIncidentResponse {
  return {
    incidentId: state.scenario.incidentId,
    checkpoint: state.checkpoint,
    selectedInterventionId: state.selectedInterventionId,
    cacheKey: state.cacheKey,
    isMockProvider,
    serverTimeIso: new Date(nowMs).toISOString(),
    ...partial,
  };
}

function buildIdentityMetadata(state: ReconstructedState): Required<
  Pick<
    StoredIdentityMeta,
    'cacheDocId' | 'cacheKey' | 'packetSha256' | 'modelVersion' | 'promptVersion' | 'schemaVersion'
  >
> {
  return {
    cacheDocId: state.cacheDocId,
    cacheKey: state.cacheKey,
    packetSha256: state.packetSha256,
    modelVersion: state.modelVersion,
    promptVersion: state.promptVersion,
    schemaVersion: state.schemaVersion,
  };
}

function matchesCanonicalIdentity(
  meta: StoredIdentityMeta | undefined,
  state: ReconstructedState,
): boolean {
  if (!meta) return false;
  return (
    meta.cacheDocId === state.cacheDocId &&
    meta.cacheKey === state.cacheKey &&
    meta.packetSha256 === state.packetSha256 &&
    meta.modelVersion === state.modelVersion &&
    meta.promptVersion === state.promptVersion &&
    meta.schemaVersion === state.schemaVersion
  );
}

function buildObsoleteRequestResponse(
  state: ReconstructedState,
  nowMs: number,
  isMockProvider: boolean,
  isEvaluation: boolean,
): AnalyzeIncidentResponse {
  return buildResponseEnvelope(state, nowMs, isMockProvider, {
    status: 'unavailable',
    cacheHit: false,
    isEvaluation,
    reasonCode: 'request_identity_obsolete',
    message:
      'Stored response for this requestId is obsolete due to canonical content or version changes; issue a new requestId.',
  });
}

function buildExpiredRequestResponse(
  state: ReconstructedState,
  nowMs: number,
  isMockProvider: boolean,
  isEvaluation: boolean,
): AnalyzeIncidentResponse {
  return buildResponseEnvelope(state, nowMs, isMockProvider, {
    status: 'unavailable',
    cacheHit: false,
    isEvaluation,
    reasonCode: 'request_response_expired',
    message:
      'Stored analysis for this requestId has passed its original fixed 30-day expiry; issue a new requestId.',
  });
}

function evaluateStoredResponseValidity(
  storedResponse: AnalyzeIncidentResponse,
  meta: StoredIdentityMeta | undefined,
  state: ReconstructedState,
  nowMs: number,
  isEvaluation: boolean,
  isMockProvider: boolean,
): { valid: boolean; response: AnalyzeIncidentResponse } {
  if (!matchesCanonicalIdentity(meta, state) || storedResponse.cacheKey !== state.cacheKey) {
    return {
      valid: false,
      response: buildObsoleteRequestResponse(state, nowMs, isMockProvider, isEvaluation),
    };
  }

  const carriesAnalysis =
    storedResponse.status === 'ok' ||
    storedResponse.status === 'cached' ||
    storedResponse.result !== undefined;

  if (carriesAnalysis) {
    if (
      !storedResponse.result ||
      storedResponse.isMockProvider !== isMockProvider ||
      Boolean(storedResponse.result.isPreviewMock) !== isMockProvider ||
      storedResponse.result.modelVersion !== state.modelVersion ||
      storedResponse.result.promptVersion !== state.promptVersion ||
      !validateAnalysisResult(storedResponse.result, state.snapshot).valid
    ) {
      return {
        valid: false,
        response: buildObsoleteRequestResponse(state, nowMs, isMockProvider, isEvaluation),
      };
    }

    if (
      typeof meta?.responseExpiresAtMs !== 'number' ||
      nowMs >= meta.responseExpiresAtMs
    ) {
      return {
        valid: false,
        response: buildExpiredRequestResponse(state, nowMs, isMockProvider, isEvaluation),
      };
    }
  }

  return {
    valid: true,
    response: {
      ...storedResponse,
      serverTimeIso: new Date(nowMs).toISOString(),
    },
  };
}

function incrementRateCounters(
  tx: Transaction,
  visitorRef: FirebaseFirestore.DocumentReference,
  visitorDoc: VisitorStateDoc | undefined,
  minuteRef: FirebaseFirestore.DocumentReference,
  minuteCountCurrent: number,
  minuteKey: string,
  dayKey: string,
  activeLeaseToSet: ActiveLeaseRef | undefined,
): void {
  const effectiveVisitorMinute = visitorDoc?.minuteKey === minuteKey ? (visitorDoc.minuteCount ?? 0) : 0;
  const effectiveVisitorDay = visitorDoc?.dayKey === dayKey ? (visitorDoc.dayCount ?? 0) : 0;
  const nextVisitorState: Record<string, unknown> = {
    minuteKey,
    minuteCount: effectiveVisitorMinute + 1,
    dayKey,
    dayCount: effectiveVisitorDay + 1,
  };
  if (activeLeaseToSet !== undefined) {
    nextVisitorState.activeLease = activeLeaseToSet;
  } else if (visitorDoc?.activeLease !== undefined) {
    nextVisitorState.activeLease = visitorDoc.activeLease;
  }
  tx.set(visitorRef, nextVisitorState, { merge: true });
  tx.set(
    minuteRef,
    {
      minuteKey,
      acceptedRequests: minuteCountCurrent + 1,
    },
    { merge: true },
  );
}

/**
 * Transaction 1: Atomically validates kill switch, duplicate request IDs, visitor/project
 * rate limits, shared cache hits, active leases, failure cooldowns, daily/monthly generation
 * ceilings, and worst-case spending reservation before contacting the provider.
 */
export async function admitRequestTransaction(
  db: Firestore,
  params: AdmitRequestParams,
): Promise<AdmissionDecision> {
  const {
    visitorUid,
    requestId,
    requestPayloadHash,
    state,
    nowMs,
    leaseId,
    isEvaluation,
    evalRunId,
    operatorId,
    envAiDisabled,
    envLiveGenerationDisabled,
    isMockProvider,
    beforeCommitTestHook,
  } = params;

  const minuteKey = getUtcMinuteKey(nowMs);
  const dayKey = getUtcDayKey(nowMs);
  const monthKey = getUtcMonthKey(nowMs);
  const worstCaseMicros =
    params.worstCaseReservationMicros ?? MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros;

  const systemControlRef = db
    .collection(FIRESTORE_COLLECTIONS.systemControl)
    .doc(SYSTEM_CONTROL_DOC_ID);
  const requestRecordRef = db.collection(FIRESTORE_COLLECTIONS.requestRecords).doc(requestId);
  const visitorRef = db.collection(FIRESTORE_COLLECTIONS.visitorState).doc(visitorUid);
  const minuteRef = db.collection(FIRESTORE_COLLECTIONS.quotaMinutes).doc(minuteKey);
  const dayRef = db.collection(FIRESTORE_COLLECTIONS.quotaDays).doc(dayKey);
  const monthRef = db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey);
  const cacheRef = db.collection(FIRESTORE_COLLECTIONS.analysisCache).doc(state.cacheDocId);

  let txAttempt = 0;

  return db.runTransaction(async (tx) => {
    txAttempt += 1;

    // 1. All reads MUST occur before any writes in a Firestore transaction.
    const [
      systemSnap,
      reqSnap,
      visitorSnap,
      minuteSnap,
      daySnap,
      monthSnap,
      cacheSnap,
    ] = await Promise.all([
      tx.get(systemControlRef),
      tx.get(requestRecordRef),
      tx.get(visitorRef),
      tx.get(minuteRef),
      tx.get(dayRef),
      tx.get(monthRef),
      tx.get(cacheRef),
    ]);

    const existingRequest = reqSnap.exists ? (reqSnap.data() as RequestRecordDoc) : undefined;
    let existingAttemptDoc: GenerationAttemptDoc | undefined;
    if (existingRequest && existingRequest.status === 'in_flight' && existingRequest.leaseId) {
      const attemptSnap = await tx.get(
        db.collection(FIRESTORE_COLLECTIONS.generationAttempts).doc(existingRequest.leaseId),
      );
      existingAttemptDoc = attemptSnap.exists
        ? (attemptSnap.data() as GenerationAttemptDoc)
        : undefined;
    }

    if (beforeCommitTestHook) {
      await beforeCommitTestHook(txAttempt);
    }

    // 2. Request ID binding ownership & payload check
    if (
      existingRequest &&
      (existingRequest.visitorUid !== visitorUid ||
        existingRequest.requestPayloadHash !== requestPayloadHash)
    ) {
      throw new RequestValidationError(
        'REQUEST_ID_CONFLICT',
        'requestId is already bound to a different visitor or request payload',
      );
    }

    // 3. Emergency kill switch check (env var or Firestore systemControl/runtime.aiDisabled)
    const systemControl = systemSnap.exists
      ? (systemSnap.data() as {
          aiDisabled?: boolean;
          liveGenerationDisabled?: boolean;
          reason?: string;
        })
      : undefined;
    if (envAiDisabled || systemControl?.aiDisabled === true) {
      return {
        decision: 'disabled',
        response: buildResponseEnvelope(state, nowMs, isMockProvider, {
          status: 'disabled',
          cacheHit: false,
          isEvaluation,
          reasonCode: 'ai_disabled',
          message:
            systemControl?.reason ??
            'AI incident analysis is currently disabled by operator control.',
        }),
      };
    }

    const visitorDoc = visitorSnap.exists ? (visitorSnap.data() as VisitorStateDoc) : undefined;
    const minuteDoc = minuteSnap.exists
      ? (minuteSnap.data() as { acceptedRequests?: number })
      : undefined;
    const dayDoc = daySnap.exists ? (daySnap.data() as { attempts?: number }) : undefined;
    const monthDoc = monthSnap.exists ? (monthSnap.data() as MonthQuotaDoc) : undefined;

    const projectMinuteCount = minuteDoc?.acceptedRequests ?? 0;
    const visitorMinuteCount =
      visitorDoc?.minuteKey === minuteKey ? (visitorDoc.minuteCount ?? 0) : 0;
    const visitorDayCount = visitorDoc?.dayKey === dayKey ? (visitorDoc.dayCount ?? 0) : 0;
    const visitorHasOtherPending =
      visitorDoc?.activeLease != null &&
      nowMs < visitorDoc.activeLease.expiresAtMs &&
      visitorDoc.activeLease.requestId !== requestId;

    const makeQuotaResponse = (
      reasonCode: QuotaReasonCode,
      message: string,
      retryAfterMs?: number,
    ): AdmissionDecision => ({
      decision: 'quota_reached',
      response: buildResponseEnvelope(state, nowMs, isMockProvider, {
        status: 'quota_reached',
        cacheHit: false,
        isEvaluation,
        reasonCode,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        message,
      }),
    });

    // 4. Visitor & project rate limits apply to ALL public requests including duplicate/replay requests
    if (!isEvaluation) {
      if (visitorHasOtherPending && visitorDoc?.activeLease) {
        return makeQuotaResponse(
          'visitor_pending_limit',
          'Visitor already has an active pending AI analysis request.',
          Math.max(500, visitorDoc.activeLease.expiresAtMs - nowMs),
        );
      }
      if (visitorMinuteCount >= BACKEND_LIMITS.visitorMaxRequestsPerMinute) {
        return makeQuotaResponse(
          'visitor_minute_limit',
          `Visitor limit reached (${BACKEND_LIMITS.visitorMaxRequestsPerMinute} requests/minute).`,
          60_000 - (nowMs % 60_000),
        );
      }
      if (visitorDayCount >= BACKEND_LIMITS.visitorMaxRequestsPerDay) {
        return makeQuotaResponse(
          'visitor_daily_limit',
          `Visitor daily limit reached (${BACKEND_LIMITS.visitorMaxRequestsPerDay} requests/day).`,
        );
      }
    }

    if (projectMinuteCount >= BACKEND_LIMITS.projectMaxRequestsPerMinute) {
      return makeQuotaResponse(
        'project_minute_limit',
        `Project request rate limit reached (${BACKEND_LIMITS.projectMaxRequestsPerMinute} accepted requests/minute).`,
        60_000 - (nowMs % 60_000),
      );
    }

    const cacheDoc = cacheSnap.exists ? (cacheSnap.data() as CacheDocData) : undefined;
    const isCacheReady =
      !isEvaluation &&
      cacheDoc?.status === 'ready' &&
      cacheDoc.cacheKey === state.cacheKey &&
      typeof cacheDoc.expiresAtMs === 'number' &&
      nowMs < cacheDoc.expiresAtMs &&
      cacheDoc.result !== undefined &&
      (cacheDoc.isMockProvider ?? true) === isMockProvider &&
      Boolean(cacheDoc.result.isPreviewMock) === isMockProvider &&
      cacheDoc.result.modelVersion === state.modelVersion &&
      cacheDoc.result.promptVersion === state.promptVersion &&
      validateAnalysisResult(cacheDoc.result, state.snapshot).valid;

    // 5. Existing requestId replay / in-flight recovery (after rate limits pass; never regenerates or double-bills)
    if (existingRequest) {
      if (!isEvaluation) {
        incrementRateCounters(
          tx,
          visitorRef,
          visitorDoc,
          minuteRef,
          projectMinuteCount,
          minuteKey,
          dayKey,
          undefined,
        );
      }

      if (existingRequest.status === 'completed' && existingRequest.response) {
        const validity = evaluateStoredResponseValidity(
          existingRequest.response,
          existingRequest,
          state,
          nowMs,
          isEvaluation,
          isMockProvider,
        );
        return {
          decision: 'duplicate_completed',
          response: validity.response,
        };
      }

      if (existingRequest.status === 'in_flight') {
        if (!matchesCanonicalIdentity(existingRequest, state)) {
          const obsoleteResp = buildObsoleteRequestResponse(
            state,
            nowMs,
            isMockProvider,
            isEvaluation,
          );
          tx.set(
            requestRecordRef,
            { status: 'completed', response: obsoleteResp, updatedAtMs: nowMs },
            { merge: true },
          );
          return { decision: 'duplicate_completed', response: obsoleteResp };
        }

        if (existingAttemptDoc?.reconciled) {
          if (existingAttemptDoc.finalizedResponse) {
            const validity = evaluateStoredResponseValidity(
              existingAttemptDoc.finalizedResponse,
              existingAttemptDoc,
              state,
              nowMs,
              isEvaluation,
              isMockProvider,
            );
            let finalReplayResp = validity.response;
            if (
              validity.valid &&
              finalReplayResp.result &&
              existingAttemptDoc.visitorUid !== visitorUid
            ) {
              finalReplayResp = {
                ...finalReplayResp,
                status: 'cached',
                cacheHit: true,
                message: getCacheHitMessage(isMockProvider),
                result: {
                  ...finalReplayResp.result,
                  sourceMode: 'preview_cached_ai',
                  sourceBadgeLabel: getCacheHitBadgeLabel(isMockProvider),
                  isPreviewMock: isMockProvider,
                },
              };
            }
            tx.set(
              requestRecordRef,
              {
                status: 'completed',
                response: finalReplayResp,
                ...(existingAttemptDoc.responseGeneratedAtMs !== undefined
                  ? { responseGeneratedAtMs: existingAttemptDoc.responseGeneratedAtMs }
                  : {}),
                ...(existingAttemptDoc.responseExpiresAtMs !== undefined
                  ? { responseExpiresAtMs: existingAttemptDoc.responseExpiresAtMs }
                  : {}),
                updatedAtMs: nowMs,
              },
              { merge: true },
            );
            return { decision: 'duplicate_completed', response: finalReplayResp };
          }

          if (existingAttemptDoc.status === 'ok' && isCacheReady && cacheDoc?.result) {
            const cachedResult: AnalysisResult = {
              ...cacheDoc.result,
              sourceMode: 'preview_cached_ai',
              sourceBadgeLabel: getCacheHitBadgeLabel(isMockProvider),
              isPreviewMock: isMockProvider,
            };
            const cachedResponse = buildResponseEnvelope(state, nowMs, isMockProvider, {
              status: 'cached',
              cacheHit: true,
              isEvaluation,
              result: cachedResult,
              message: getCacheHitMessage(isMockProvider),
            });
            tx.set(
              requestRecordRef,
              {
                status: 'completed',
                ...buildIdentityMetadata(state),
                ...(cacheDoc.generatedAtMs !== undefined
                  ? { responseGeneratedAtMs: cacheDoc.generatedAtMs }
                  : {}),
                ...(cacheDoc.expiresAtMs !== undefined
                  ? { responseExpiresAtMs: cacheDoc.expiresAtMs }
                  : {}),
                response: cachedResponse,
                updatedAtMs: nowMs,
              },
              { merge: true },
            );
            return { decision: 'duplicate_completed', response: cachedResponse };
          }

          const unavailableResp = buildResponseEnvelope(state, nowMs, isMockProvider, {
            status: 'unavailable',
            cacheHit: false,
            isEvaluation,
            reasonCode: 'request_response_expired',
            message:
              'Finalized response for this requestId is no longer valid or has expired; issue a new requestId.',
          });
          tx.set(
            requestRecordRef,
            { status: 'completed', response: unavailableResp, updatedAtMs: nowMs },
            { merge: true },
          );
          return { decision: 'duplicate_completed', response: unavailableResp };
        }

        if (
          typeof existingRequest.leaseExpiresAtMs === 'number' &&
          nowMs < existingRequest.leaseExpiresAtMs
        ) {
          return {
            decision: 'pending',
            response: buildResponseEnvelope(state, nowMs, isMockProvider, {
              status: 'pending',
              cacheHit: false,
              isEvaluation,
              reasonCode: 'generation_in_progress',
              retryAfterMs: Math.max(500, existingRequest.leaseExpiresAtMs - nowMs),
              message: 'Analysis generation is already in progress for this request.',
            }),
          };
        }

        const expiredLeaseResp = buildResponseEnvelope(state, nowMs, isMockProvider, {
          status: 'timeout',
          cacheHit: false,
          isEvaluation,
          reasonCode: 'lease_expired',
          message:
            'Generation lease expired prior to completion; issue a new requestId to retry.',
        });
        tx.set(
          requestRecordRef,
          { status: 'completed', response: expiredLeaseResp, updatedAtMs: nowMs },
          { merge: true },
        );
        return { decision: 'duplicate_completed', response: expiredLeaseResp };
      }
    }

    // 6. Public shared cache hit (valid even if daily/monthly generation quotas are exhausted; does NOT extend expiry)
    if (isCacheReady && cacheDoc?.result) {
      const cachedResult: AnalysisResult = {
        ...cacheDoc.result,
        sourceMode: 'preview_cached_ai',
        sourceBadgeLabel: getCacheHitBadgeLabel(isMockProvider),
        isPreviewMock: isMockProvider,
      };
      const response = buildResponseEnvelope(state, nowMs, isMockProvider, {
        status: 'cached',
        cacheHit: true,
        isEvaluation: false,
        result: cachedResult,
        message: getCacheHitMessage(isMockProvider),
      });

      if (!isEvaluation) {
        incrementRateCounters(
          tx,
          visitorRef,
          visitorDoc,
          minuteRef,
          projectMinuteCount,
          minuteKey,
          dayKey,
          undefined,
        );
      }
      tx.set(requestRecordRef, {
        requestId,
        visitorUid,
        requestPayloadHash,
        status: 'completed',
        ...buildIdentityMetadata(state),
        ...(cacheDoc.generatedAtMs !== undefined
          ? { responseGeneratedAtMs: cacheDoc.generatedAtMs }
          : {}),
        ...(cacheDoc.expiresAtMs !== undefined
          ? { responseExpiresAtMs: cacheDoc.expiresAtMs }
          : {}),
        response,
        createdAtMs: existingRequest?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
      });

      return { decision: 'cache_hit', response };
    }

    // 7. Active per-key generation lease check (concurrent identical request receives pending)
    if (
      !isEvaluation &&
      cacheDoc?.currentLease != null &&
      nowMs < cacheDoc.currentLease.expiresAtMs
    ) {
      const retryAfterMs = Math.max(500, cacheDoc.currentLease.expiresAtMs - nowMs);
      const response = buildResponseEnvelope(state, nowMs, isMockProvider, {
        status: 'pending',
        cacheHit: false,
        isEvaluation: false,
        reasonCode: 'generation_in_progress',
        retryAfterMs,
        message: 'Another request is currently generating analysis for this canonical state.',
      });

      incrementRateCounters(
        tx,
        visitorRef,
        visitorDoc,
        minuteRef,
        projectMinuteCount,
        minuteKey,
        dayKey,
        undefined,
      );
      tx.set(requestRecordRef, {
        requestId,
        visitorUid,
        requestPayloadHash,
        status: 'in_flight',
        leaseId: cacheDoc.currentLease.leaseId,
        leaseExpiresAtMs: cacheDoc.currentLease.expiresAtMs,
        ...buildIdentityMetadata(state),
        createdAtMs: existingRequest?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
      });

      return { decision: 'pending', response };
    }

    // 8. Short failure cooldown check
    if (
      !isEvaluation &&
      typeof cacheDoc?.cooldownUntilMs === 'number' &&
      nowMs < cacheDoc.cooldownUntilMs
    ) {
      const retryAfterMs = Math.max(500, cacheDoc.cooldownUntilMs - nowMs);
      const failureStatus = cacheDoc.lastFailureStatus ?? 'unavailable';
      const response = buildResponseEnvelope(state, nowMs, isMockProvider, {
        status: failureStatus,
        cacheHit: false,
        isEvaluation: false,
        reasonCode: 'failure_cooldown',
        retryAfterMs,
        message: `Recent generation failure (${cacheDoc.lastFailureReason ?? failureStatus}); short cooldown active.`,
      });

      incrementRateCounters(
        tx,
        visitorRef,
        visitorDoc,
        minuteRef,
        projectMinuteCount,
        minuteKey,
        dayKey,
        undefined,
      );
      tx.set(requestRecordRef, {
        requestId,
        visitorUid,
        requestPayloadHash,
        status: 'completed',
        ...buildIdentityMetadata(state),
        response,
        createdAtMs: existingRequest?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
      });

      return { decision: 'cooldown', response };
    }

    // 8a. Live generation paused by operator control (cached responses remain available; generation blocked)
    if (envLiveGenerationDisabled || systemControl?.liveGenerationDisabled === true) {
      return {
        decision: 'disabled',
        response: buildResponseEnvelope(state, nowMs, isMockProvider, {
          status: 'disabled',
          cacheHit: false,
          isEvaluation,
          reasonCode: 'live_generation_disabled',
          message:
            systemControl?.reason ??
            'Live AI generation is temporarily paused by operator control; cached analysis remains available.',
        }),
      };
    }

    // 8b. Generation quota & conservative spending checks (shared by public misses & internal evaluations)
    const dailyAttempts = dayDoc?.attempts ?? 0;
    if (dailyAttempts >= BACKEND_LIMITS.maxGenerationAttemptsPerDay) {
      return makeQuotaResponse(
        'daily_generation_limit',
        `Daily generation attempt limit reached (${BACKEND_LIMITS.maxGenerationAttemptsPerDay}/day UTC).`,
      );
    }

    const monthlyAttempts = monthDoc?.attempts ?? 0;
    if (monthlyAttempts >= BACKEND_LIMITS.maxGenerationAttemptsPerMonth) {
      return makeQuotaResponse(
        'monthly_generation_limit',
        `Monthly generation attempt limit reached (${BACKEND_LIMITS.maxGenerationAttemptsPerMonth}/month UTC).`,
      );
    }

    const actualSpendMicros = monthDoc?.actualSpendMicros ?? 0;
    const reservedSpendMicros = monthDoc?.reservedSpendMicros ?? 0;
    const projectedSpendMicros = actualSpendMicros + reservedSpendMicros + worstCaseMicros;
    if (projectedSpendMicros > BACKEND_LIMITS.monthlySpendAllowanceMicros) {
      return makeQuotaResponse(
        'monthly_spend_allowance',
        'Monthly AI spending allowance ($4.50/month) reached; uncached generation paused.',
      );
    }

    // 9. Atomically admit generation: acquire lease, reserve worst-case spend, increment counters
    const expiresAtMs = nowMs + BACKEND_LIMITS.generationLeaseTtlMs;
    const lease: GenerationLease = {
      leaseId,
      requestId,
      visitorUid,
      cacheDocId: state.cacheDocId,
      cacheKey: state.cacheKey,
      isEvaluation,
      quotaDayKey: dayKey,
      quotaMonthKey: monthKey,
      acquiredAtMs: nowMs,
      expiresAtMs,
      reservedCostMicros: worstCaseMicros,
    };

    const activeLeaseRef: ActiveLeaseRef = {
      leaseId,
      requestId,
      visitorUid,
      acquiredAtMs: nowMs,
      expiresAtMs,
    };

    if (!isEvaluation) {
      incrementRateCounters(
        tx,
        visitorRef,
        visitorDoc,
        minuteRef,
        projectMinuteCount,
        minuteKey,
        dayKey,
        activeLeaseRef,
      );
      tx.set(
        cacheRef,
        {
          cacheDocId: state.cacheDocId,
          cacheKey: state.cacheKey,
          status: cacheDoc?.status === 'ready' ? 'ready' : 'leased',
          currentLease: activeLeaseRef,
        },
        { merge: true },
      );
    } else {
      tx.set(
        minuteRef,
        {
          minuteKey,
          acceptedRequests: projectMinuteCount + 1,
        },
        { merge: true },
      );
    }

    tx.set(
      dayRef,
      {
        dayKey,
        attempts: dailyAttempts + 1,
      },
      { merge: true },
    );

    tx.set(
      monthRef,
      {
        monthKey,
        attempts: monthlyAttempts + 1,
        actualSpendMicros,
        reservedSpendMicros: reservedSpendMicros + worstCaseMicros,
        committedSpendMicros: actualSpendMicros + reservedSpendMicros + worstCaseMicros,
      },
      { merge: true },
    );

    const attemptRef = db.collection(FIRESTORE_COLLECTIONS.generationAttempts).doc(leaseId);
    const attemptDoc: GenerationAttemptDoc = {
      leaseId,
      requestId,
      visitorUid,
      ...buildIdentityMetadata(state),
      isEvaluation,
      ...(evalRunId !== undefined ? { evalRunId } : {}),
      ...(operatorId !== undefined ? { operatorId } : {}),
      quotaDayKey: dayKey,
      quotaMonthKey: monthKey,
      acquiredAtMs: nowMs,
      expiresAtMs,
      reservedCostMicros: worstCaseMicros,
      reconciled: false,
      status: 'in_flight',
    };
    tx.set(attemptRef, attemptDoc);

    tx.set(requestRecordRef, {
      requestId,
      visitorUid,
      requestPayloadHash,
      status: 'in_flight',
      leaseId,
      leaseExpiresAtMs: expiresAtMs,
      ...buildIdentityMetadata(state),
      createdAtMs: existingRequest?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    });

    return { decision: 'generate', lease };
  });
}

/**
 * Transaction 2: Idempotent, lease-guarded finalization & conservative spend reconciliation.
 * - Reconciles known usage at most once onto `lease.quotaMonthKey` (across UTC rollover).
 * - Preserves full worst-case reservation when usage is unknown or lease expired.
 * - Protects against stale lease owners overwriting newer cache results or leases.
 */
export async function finalizeGenerationTransaction(
  db: Firestore,
  params: {
    lease: GenerationLease;
    state: ReconstructedState;
    outcome: FinalizeGenerationOutcome;
    finalNowMs: number;
    isMockProvider: boolean;
  },
): Promise<FinalizeResult> {
  const { lease, state, outcome, finalNowMs, isMockProvider } = params;

  const attemptRef = db.collection(FIRESTORE_COLLECTIONS.generationAttempts).doc(lease.leaseId);
  const monthRef = db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(lease.quotaMonthKey);
  const visitorRef = db.collection(FIRESTORE_COLLECTIONS.visitorState).doc(lease.visitorUid);
  const requestRecordRef = db
    .collection(FIRESTORE_COLLECTIONS.requestRecords)
    .doc(lease.requestId);
  const cacheRef = db.collection(FIRESTORE_COLLECTIONS.analysisCache).doc(lease.cacheDocId);

  return db.runTransaction(async (tx) => {
    const [attemptSnap, monthSnap, visitorSnap, reqSnap, cacheSnap] = await Promise.all([
      tx.get(attemptRef),
      tx.get(monthRef),
      tx.get(visitorRef),
      tx.get(requestRecordRef),
      lease.isEvaluation ? Promise.resolve(null) : tx.get(cacheRef),
    ]);

    if (!attemptSnap.exists) {
      throw new Error(`Missing generationAttempts record for lease "${lease.leaseId}"`);
    }

    const attemptDoc = attemptSnap.data() as GenerationAttemptDoc;
    if (attemptDoc.reconciled) {
      const existingResponse =
        attemptDoc.finalizedResponse ??
        buildResponseEnvelope(state, finalNowMs, isMockProvider, {
          status: attemptDoc.status === 'in_flight' ? 'unavailable' : attemptDoc.status,
          cacheHit: false,
          isEvaluation: lease.isEvaluation,
          reasonCode: 'already_finalized',
          message: 'Generation attempt was already finalized.',
        });
      return {
        alreadyFinalized: true,
        chargedCostMicros: attemptDoc.chargedCostMicros ?? lease.reservedCostMicros,
        refundedCostMicros: attemptDoc.refundedCostMicros ?? 0,
        staleLeaseIgnored: attemptDoc.staleLeaseIgnored ?? false,
        response: existingResponse,
      };
    }

    const monthDoc = monthSnap.exists ? (monthSnap.data() as MonthQuotaDoc) : undefined;
    const visitorDoc = visitorSnap.exists ? (visitorSnap.data() as VisitorStateDoc) : undefined;
    const reqDoc = reqSnap.exists ? (reqSnap.data() as RequestRecordDoc) : undefined;
    const cacheDoc = cacheSnap && cacheSnap.exists ? (cacheSnap.data() as CacheDocData) : undefined;

    const isLeaseExpired = finalNowMs >= lease.expiresAtMs;
    const isLeaseStillOwner = lease.isEvaluation
      ? true
      : cacheDoc?.currentLease?.leaseId === lease.leaseId;
    const canMutateCache = !isLeaseExpired && isLeaseStillOwner;

    // Conservative, unclamped spending reconciliation:
    // - When lease did not expire AND usage is explicitly known: charge exact actualCostMicros
    //   (0 for pre-generation rejections that never dispatched paid calls; full unclamped cost on overruns).
    // - When usage is unknown: preserve lease.reservedCostMicros.
    // - When lease expired: charge max(reservedCostMicros, actualCostMicros) so overruns are never hidden.
    const hasKnownCost = outcome.usageKnown && outcome.actualCostMicros !== null;
    const unclampedActual = hasKnownCost ? Math.max(0, outcome.actualCostMicros!) : 0;
    const chargedCostMicros = !isLeaseExpired
      ? hasKnownCost
        ? unclampedActual
        : lease.reservedCostMicros
      : hasKnownCost
        ? Math.max(lease.reservedCostMicros, unclampedActual)
        : lease.reservedCostMicros;
    const refundedCostMicros = Math.max(0, lease.reservedCostMicros - chargedCostMicros);

    const prevActual = monthDoc?.actualSpendMicros ?? 0;
    const prevReserved = monthDoc?.reservedSpendMicros ?? 0;
    const nextReserved = Math.max(0, prevReserved - lease.reservedCostMicros);
    const nextActual = prevActual + chargedCostMicros;

    tx.set(
      monthRef,
      {
        monthKey: lease.quotaMonthKey,
        attempts: monthDoc?.attempts ?? 1,
        actualSpendMicros: nextActual,
        reservedSpendMicros: nextReserved,
        committedSpendMicros: nextActual + nextReserved,
      },
      { merge: true },
    );

    const effectiveStatus: AnalyzeIncidentStatus = isLeaseExpired
      ? 'timeout'
      : outcome.kind === 'success'
        ? 'ok'
        : outcome.kind;

    const finalResponse = buildResponseEnvelope(state, finalNowMs, isMockProvider, {
      status: effectiveStatus,
      cacheHit: false,
      isEvaluation: lease.isEvaluation,
      ...(effectiveStatus === 'ok' && outcome.result ? { result: outcome.result } : {}),
      ...(effectiveStatus !== 'ok'
        ? {
            reasonCode: isLeaseExpired ? 'lease_expired_late_completion' : outcome.reasonCode,
            message: isLeaseExpired
              ? 'Generation lease expired prior to completion; full reservation retained.'
              : outcome.message,
          }
        : {
            message: lease.isEvaluation
              ? 'Completed internal evaluation generation (public cache bypassed).'
              : getFreshGenerationMessage(isMockProvider),
          }),
    });

    // Cache / cooldown updates only permitted if lease is active and still the owner
    if (!lease.isEvaluation && canMutateCache) {
      if (outcome.kind === 'success' && outcome.result) {
        const expiresAtMs = finalNowMs + BACKEND_LIMITS.cacheTtlMs;
        tx.set(cacheRef, {
          cacheDocId: state.cacheDocId,
          cacheKey: state.cacheKey,
          incidentId: state.scenario.incidentId,
          scenarioVersion: state.scenario.scenarioVersion,
          engineVersion: state.snapshot.engineVersion,
          checkpoint: state.checkpoint,
          selectedInterventionId: state.selectedInterventionId,
          packetSha256: state.packetSha256,
          modelVersion: state.modelVersion,
          promptVersion: state.promptVersion,
          schemaVersion: state.schemaVersion,
          status: 'ready',
          result: outcome.result,
          isMockProvider,
          generatedAtMs: finalNowMs,
          generatedAtIso: new Date(finalNowMs).toISOString(),
          expiresAtMs,
          expiresAtIso: new Date(expiresAtMs).toISOString(),
          currentLease: null,
          cooldownUntilMs: null,
          lastFailureStatus: null,
          lastFailureReason: null,
        });
      } else {
        tx.set(
          cacheRef,
          {
            cacheDocId: state.cacheDocId,
            cacheKey: state.cacheKey,
            status: 'cooldown',
            currentLease: null,
            cooldownUntilMs: finalNowMs + BACKEND_LIMITS.failureCooldownMs,
            lastFailureStatus: outcome.kind,
            lastFailureReason: outcome.reasonCode,
          },
          { merge: true },
        );
      }
    }

    // Only release visitor pending lock if this lease still owns it
    if (!lease.isEvaluation && visitorDoc?.activeLease?.leaseId === lease.leaseId) {
      tx.set(visitorRef, { activeLease: null }, { merge: true });
    }

    const responseGeneratedAtMs = effectiveStatus === 'ok' ? finalNowMs : undefined;
    const responseExpiresAtMs =
      effectiveStatus === 'ok' ? finalNowMs + BACKEND_LIMITS.cacheTtlMs : undefined;

    // Update request record only if this lease owns it (or no newer lease replaced it)
    if (!reqDoc || reqDoc.leaseId === lease.leaseId) {
      tx.set(
        requestRecordRef,
        {
          status: 'completed',
          ...buildIdentityMetadata(state),
          ...(responseGeneratedAtMs !== undefined ? { responseGeneratedAtMs } : {}),
          ...(responseExpiresAtMs !== undefined ? { responseExpiresAtMs } : {}),
          response: finalResponse,
          updatedAtMs: finalNowMs,
        },
        { merge: true },
      );
    }

    if (lease.isEvaluation) {
      const evalRef = db.collection(FIRESTORE_COLLECTIONS.evaluationRuns).doc(lease.leaseId);
      tx.set(evalRef, {
        leaseId: lease.leaseId,
        evalRunId: attemptDoc.evalRunId ?? lease.requestId,
        operatorId: attemptDoc.operatorId ?? lease.visitorUid,
        incidentId: state.scenario.incidentId,
        checkpoint: state.checkpoint,
        selectedInterventionId: state.selectedInterventionId,
        cacheDocId: state.cacheDocId,
        status: effectiveStatus,
        ...(effectiveStatus === 'ok' && outcome.result ? { result: outcome.result } : {}),
        usageKnown: !isLeaseExpired && outcome.usageKnown,
        chargedCostMicros,
        refundedCostMicros,
        createdAtMs: finalNowMs,
      });
    }

    tx.set(
      attemptRef,
      {
        reconciled: true,
        status: effectiveStatus,
        finalizedAtMs: finalNowMs,
        ...buildIdentityMetadata(state),
        ...(responseGeneratedAtMs !== undefined ? { responseGeneratedAtMs } : {}),
        ...(responseExpiresAtMs !== undefined ? { responseExpiresAtMs } : {}),
        chargedCostMicros,
        refundedCostMicros,
        usageKnown: !isLeaseExpired && outcome.usageKnown,
        staleLeaseIgnored: !canMutateCache,
        finalizedResponse: finalResponse,
      },
      { merge: true },
    );

    return {
      alreadyFinalized: false,
      chargedCostMicros,
      refundedCostMicros,
      staleLeaseIgnored: !canMutateCache,
      response: finalResponse,
    };
  });
}
