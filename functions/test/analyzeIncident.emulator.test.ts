import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import {
  ALL_SCENARIOS,
  ENGINE_VERSION,
  enumerateCanonicalAnalysisStates,
  sha256Hex,
  stableStringify,
  validateAnalysisResult,
} from '@chaos-room/shared';
import {
  BACKEND_LIMITS,
  DEFAULT_LIVE_MODEL_VERSION,
  DEMO_PROJECT_ID,
  FIRESTORE_COLLECTIONS,
  GEMINI_3_5_FLASH_LITE_PRICING_V1,
  MOCK_PRICING_FIXTURE_V1,
  SYSTEM_CONTROL_DOC_ID,
  computeTokenCostMicros,
} from '../src/config.js';
import { assertSafeLocalExecutionEnvironment } from '../src/emulatorGuard.js';
import { GeminiModelProvider, type GeminiTransport } from '../src/geminiProvider.js';
import { MockModelProvider } from '../src/mockProvider.js';
import { reconstructCanonicalState } from '../src/reconstruction.js';
import { RequestValidationError } from '../src/requestValidator.js';
import { executeAnalyzeIncident, runInternalEvaluationAnalysis } from '../src/service.js';
import {
  admitRequestTransaction,
  finalizeGenerationTransaction,
  getUtcDayKey,
  getUtcMinuteKey,
  getUtcMonthKey,
} from '../src/accountingStore.js';
import type { CallableAuthContext, GenerationLease, ReconstructedState } from '../src/types.js';

const repoRoot = path.resolve(__dirname, '../..');
const rulesText = fs.readFileSync(path.join(repoRoot, 'firestore.rules'), 'utf8');

function makeAuth(visitorUid = 'visitor-alpha', appId = 'appcheck-web-local'): CallableAuthContext {
  return {
    auth: { uid: visitorUid },
    app: { appId },
  };
}

function parseHostPort(hostPort: string): { host: string; port: number } {
  const [host, portStr] = hostPort.split(':');
  return {
    host: host || '127.0.0.1',
    port: Number(portStr || '8080'),
  };
}

let db: Firestore;
let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const guard = assertSafeLocalExecutionEnvironment(process.env, {
    requireEmulatorHost: true,
    projectIdOverride: DEMO_PROJECT_ID,
  });

  if (getApps().length === 0) {
    initializeApp({ projectId: guard.projectId });
  }
  db = getFirestore();

  const { host, port } = parseHostPort(guard.firestoreEmulatorHost!);
  testEnv = await initializeTestEnvironment({
    projectId: DEMO_PROJECT_ID,
    firestore: {
      host,
      port,
      rules: rulesText,
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

describe('Phase 3A analyzeIncident Firestore emulator integration', () => {
  it('reconstructs and serves all 15 canonical states cleanly and rejects forged or cross-scenario requests', async () => {
    const provider = new MockModelProvider({ kind: 'success' });
    let nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    const clock = { nowMs: () => nowMs };

    const canonicalStates = enumerateCanonicalAnalysisStates(ALL_SCENARIOS);
    expect(canonicalStates).toHaveLength(15);

    const cacheKeys = new Set<string>();
    for (let i = 0; i < canonicalStates.length; i++) {
      const spec = canonicalStates[i]!;
      // Spread visitors/minutes slightly to stay under per-visitor limits (2/min, 12/day)
      const visitorUid = `visitor-canonical-${Math.floor(i / 5)}`;
      nowMs += 65_000;

      const response = await executeAnalyzeIncident(
        {
          incidentId: spec.incidentId,
          scenarioVersion: spec.scenario.scenarioVersion,
          engineVersion: ENGINE_VERSION,
          checkpoint: spec.checkpoint,
          selectedInterventionId: spec.selectedInterventionId,
          requestId: `req-all15-${i}-${spec.checkpoint}`,
        },
        makeAuth(visitorUid),
        { db, provider, clock },
      );

      expect(response.status).toBe('ok');
      expect(response.isMockProvider).toBe(true);
      expect(response.result).toBeDefined();
      expect(response.result?.isPreviewMock).toBe(true);
      expect(response.result?.checkpoint).toBe(spec.checkpoint);
      expect(response.result?.selectedInterventionId).toBe(spec.selectedInterventionId);

      const rebuilt = reconstructCanonicalState(
        spec.scenario,
        spec.checkpoint,
        spec.selectedInterventionId,
      );
      expect(validateAnalysisResult(response.result!, rebuilt.snapshot).valid).toBe(true);
      if (spec.checkpoint === 'alert') {
        expect(response.result?.recommendedInterventions).toEqual([]);
      }
      expect(response.cacheKey).toBeTruthy();
      cacheKeys.add(response.cacheKey!);
    }

    expect(cacheKeys.size).toBe(15);
    expect(provider.callCount).toBe(15);

    // Forged requests & version mismatch
    await expect(
      executeAnalyzeIncident(
        {
          incidentId: 'incident-001',
          scenarioVersion: '1.0.0',
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-missing-auth-01',
        },
        { auth: null, app: { appId: 'appcheck-web-local' } },
        { db, provider, clock },
      ),
    ).rejects.toThrowError(RequestValidationError);

    await expect(
      executeAnalyzeIncident(
        {
          incidentId: 'incident-001',
          scenarioVersion: '1.0.0',
          checkpoint: 'outcome',
          selectedInterventionId: ALL_SCENARIOS[1]!.interventions[0]!.id,
          requestId: 'req-cross-01',
        },
        makeAuth('visitor-forged'),
        { db, provider, clock },
      ),
    ).rejects.toThrowError(RequestValidationError);

    const mismatch = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: '0.0.9',
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-mismatch-emulator-01',
      },
      makeAuth('visitor-forged'),
      { db, provider, clock },
    );
    expect(mismatch.status).toBe('version_mismatch');
    expect(mismatch.expectedScenarioVersion).toBe(ALL_SCENARIOS[0]!.scenarioVersion);
  });

  it('reuses shared cache across visitors, expires at fixed 30 days without extending on reads, and invalidates on version/evidence changes', async () => {
    const provider = new MockModelProvider({ kind: 'success' });
    const t0 = Date.UTC(2026, 10, 1, 0, 0, 0);
    let nowMs = t0;
    const clock = { nowMs: () => nowMs };

    const req = {
      incidentId: 'incident-002',
      scenarioVersion: ALL_SCENARIOS[1]!.scenarioVersion,
      checkpoint: 'evidence',
      selectedInterventionId: null,
    };

    const miss1 = await executeAnalyzeIncident(
      { ...req, requestId: 'req-cache-v1-a' },
      makeAuth('visitor-cache-a'),
      { db, provider, clock },
    );
    expect(miss1.status).toBe('ok');
    expect(provider.callCount).toBe(1);

    // Day 29 hit across different visitor -> no provider call, expiry unchanged
    nowMs = t0 + 29 * 24 * 60 * 60 * 1000;
    const hitDay29 = await executeAnalyzeIncident(
      { ...req, requestId: 'req-cache-v2-b' },
      makeAuth('visitor-cache-b'),
      { db, provider, clock },
    );
    expect(hitDay29.status).toBe('cached');
    expect(hitDay29.cacheHit).toBe(true);
    expect(provider.callCount).toBe(1);

    // Day 30 + 1 second -> fixed TTL expired despite Day 29 read!
    nowMs = t0 + BACKEND_LIMITS.cacheTtlMs + 1_000;
    const missAfterExpiry = await executeAnalyzeIncident(
      { ...req, requestId: 'req-cache-v3-c' },
      makeAuth('visitor-cache-c'),
      { db, provider, clock },
    );
    expect(missAfterExpiry.status).toBe('ok');
    expect(missAfterExpiry.cacheHit).toBe(false);
    expect(provider.callCount).toBe(2);

    // Model/prompt/schema version bumps isolate cache keys and trigger fresh generation
    nowMs += 65_000;
    const missNewModel = await executeAnalyzeIncident(
      { ...req, requestId: 'req-cache-model-v2' },
      makeAuth('visitor-cache-d'),
      { db, provider, clock, modelVersion: 'mock-gemini-v2' },
    );
    expect(missNewModel.status).toBe('ok');
    expect(missNewModel.cacheKey).not.toBe(missAfterExpiry.cacheKey);
    expect(provider.callCount).toBe(3);

    // Mutated evidence text (same evidence IDs) produces distinct canonical SHA-256 cacheDocId
    const baseScenario = ALL_SCENARIOS[1]!;
    const mutatedScenario = {
      ...baseScenario,
      buildEvidenceCatalog: (interventionId: string | null) =>
        baseScenario.buildEvidenceCatalog(interventionId).map((item, idx) =>
          idx === 0
            ? {
                ...item,
                summary: `${item.summary} [edited telemetry summary]`,
                detail: `${item.detail} [edited detail]`,
              }
            : item,
        ),
    };
    const originalState = reconstructCanonicalState(baseScenario, 'evidence', null);
    const mutatedState = reconstructCanonicalState(mutatedScenario, 'evidence', null);
    expect(mutatedState.cacheDocId).not.toBe(originalState.cacheDocId);
    expect(mutatedState.cacheKey).not.toBe(originalState.cacheKey);
  });

  it('handles concurrent identical requests (ok + pending), visitor/project limits, and exhausted daily/monthly/spend competition', async () => {
    const provider = new MockModelProvider({ kind: 'success' });
    let nowMs = Date.UTC(2026, 10, 5, 14, 0, 0);
    const clock = { nowMs: () => nowMs };

    // 1. Concurrent identical requests: caller A holds lease while caller B arrives -> caller B gets pending
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let markInProvider!: () => void;
    const inProviderReady = new Promise<void>((resolve) => {
      markInProvider = resolve;
    });

    const slowProvider: MockModelProvider = new MockModelProvider({ kind: 'success' });
    let slowInvocations = 0;
    const origGen = slowProvider.generateAnalysis.bind(slowProvider);
    slowProvider.generateAnalysis = async (packet, options, signal) => {
      slowInvocations += 1;
      markInProvider();
      await providerGate;
      return origGen(packet, options, signal);
    };

    const sharedPayload = {
      incidentId: 'incident-001',
      scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
      checkpoint: 'evidence',
      selectedInterventionId: null,
    };

    const callerAPromise = executeAnalyzeIncident(
      { ...sharedPayload, requestId: 'req-conc-a' },
      makeAuth('visitor-conc-a'),
      { db, provider: slowProvider, clock },
    );

    await inProviderReady;

    // Visitor A trying a second concurrent request hits per-visitor pending limit (1 pending)
    const callerASecond = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-conc-a-second',
      },
      makeAuth('visitor-conc-a'),
      { db, provider, clock },
    );
    expect(callerASecond.status).toBe('quota_reached');
    expect(callerASecond.reasonCode).toBe('visitor_pending_limit');

    // Different visitor requesting the SAME key gets `pending` without calling provider
    const callerB = await executeAnalyzeIncident(
      { ...sharedPayload, requestId: 'req-conc-b' },
      makeAuth('visitor-conc-b'),
      { db, provider: slowProvider, clock },
    );
    expect(callerB.status).toBe('pending');
    expect(slowInvocations).toBe(1);

    releaseProvider();
    const callerA = await callerAPromise;
    expect(callerA.status).toBe('ok');
    expect(slowProvider.callCount).toBe(1);

    // Now caller B / C hits the shared cache cleanly
    const callerC = await executeAnalyzeIncident(
      { ...sharedPayload, requestId: 'req-conc-c' },
      makeAuth('visitor-conc-c'),
      { db, provider: slowProvider, clock },
    );
    expect(callerC.status).toBe('cached');
    expect(slowProvider.callCount).toBe(1);
    expect(slowInvocations).toBe(1);

    // 2. Per-visitor minute (2/min) and daily (12/day) limits, plus project minute (30/min) limit
    await testEnv.clearFirestore();
    nowMs = Date.UTC(2026, 10, 6, 8, 0, 0);
    // Use same cached hit for quick limit testing after 1 miss
    for (let m = 0; m < 6; m++) {
      nowMs = Date.UTC(2026, 10, 6, 8, m, 0);
      const r1 = await executeAnalyzeIncident(
        { ...sharedPayload, requestId: `req-day-${m}-1` },
        makeAuth('visitor-rate'),
        { db, provider, clock },
      );
      const r2 = await executeAnalyzeIncident(
        { ...sharedPayload, requestId: `req-day-${m}-2` },
        makeAuth('visitor-rate'),
        { db, provider, clock },
      );
      expect(['ok', 'cached']).toContain(r1.status);
      expect(['ok', 'cached']).toContain(r2.status);
      if (m === 0) {
        const r3MinuteCap = await executeAnalyzeIncident(
          { ...sharedPayload, requestId: `req-min-cap` },
          makeAuth('visitor-rate'),
          { db, provider, clock },
        );
        expect(r3MinuteCap.status).toBe('quota_reached');
        expect(r3MinuteCap.reasonCode).toBe('visitor_minute_limit');
      }
    }
    nowMs = Date.UTC(2026, 10, 6, 8, 10, 0);
    const r13DailyCap = await executeAnalyzeIncident(
      { ...sharedPayload, requestId: 'req-day-cap-13' },
      makeAuth('visitor-rate'),
      { db, provider, clock },
    );
    expect(r13DailyCap.status).toBe('quota_reached');
    expect(r13DailyCap.reasonCode).toBe('visitor_daily_limit');

    // Project 30/min limit across distinct visitors (even cache hits!)
    await testEnv.clearFirestore();
    nowMs = Date.UTC(2026, 10, 7, 9, 0, 0);
    for (let v = 0; v < 30; v++) {
      const r = await executeAnalyzeIncident(
        { ...sharedPayload, requestId: `req-proj-${v}` },
        makeAuth(`visitor-proj-${v}`),
        { db, provider, clock },
      );
      expect(['ok', 'cached']).toContain(r.status);
    }
    const r31ProjectCap = await executeAnalyzeIncident(
      { ...sharedPayload, requestId: 'req-proj-31' },
      makeAuth('visitor-proj-31'),
      { db, provider, clock },
    );
    expect(r31ProjectCap.status).toBe('quota_reached');
    expect(r31ProjectCap.reasonCode).toBe('project_minute_limit');

    // 3. Competing concurrent misses near exhausted daily (29/30), monthly (599/600), and $4.50 allowance
    await testEnv.clearFirestore();
    nowMs = Date.UTC(2026, 10, 8, 10, 0, 0);
    const dayKey = getUtcDayKey(nowMs);
    const monthKey = getUtcMonthKey(nowMs);
    await db.collection(FIRESTORE_COLLECTIONS.quotaDays).doc(dayKey).set({
      dayKey,
      attempts: 29,
    });
    const compProvider = new MockModelProvider({ kind: 'success' });
    const compStates = enumerateCanonicalAnalysisStates(ALL_SCENARIOS).slice(0, 3);
    const dailyRace = await Promise.all(
      compStates.map((spec, idx) =>
        executeAnalyzeIncident(
          {
            incidentId: spec.incidentId,
            scenarioVersion: spec.scenario.scenarioVersion,
            checkpoint: spec.checkpoint,
            selectedInterventionId: spec.selectedInterventionId,
            requestId: `req-daily-race-${idx}`,
          },
          makeAuth(`visitor-race-d-${idx}`),
          { db, provider: compProvider, clock },
        ),
      ),
    );
    expect(dailyRace.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(dailyRace.filter((r) => r.status === 'quota_reached' && r.reasonCode === 'daily_generation_limit')).toHaveLength(2);
    expect(compProvider.callCount).toBe(1);

    // Near exhausted monthly spend ($4.495 -> room for 1 worst-case $0.005 reservation)
    await testEnv.clearFirestore();
    await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).set({
      monthKey,
      attempts: 100,
      actualSpendMicros: BACKEND_LIMITS.monthlySpendAllowanceMicros - MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros,
      reservedSpendMicros: 0,
      committedSpendMicros: BACKEND_LIMITS.monthlySpendAllowanceMicros - MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros,
    });
    compProvider.reset();
    const spendRace = await Promise.all(
      compStates.map((spec, idx) =>
        executeAnalyzeIncident(
          {
            incidentId: spec.incidentId,
            scenarioVersion: spec.scenario.scenarioVersion,
            checkpoint: spec.checkpoint,
            selectedInterventionId: spec.selectedInterventionId,
            requestId: `req-spend-race-${idx}`,
          },
          makeAuth(`visitor-race-s-${idx}`),
          { db, provider: compProvider, clock },
        ),
      ),
    );
    expect(spendRace.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(
      spendRace.filter(
        (r) => r.status === 'quota_reached' && r.reasonCode === 'monthly_spend_allowance',
      ),
    ).toHaveLength(2);
    const finalMonthSnap = await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get();
    expect(finalMonthSnap.data()?.committedSpendMicros).toBeLessThanOrEqual(
      BACKEND_LIMITS.monthlySpendAllowanceMicros,
    );
  });

  it('enforces idempotent requestIds, handles Firestore transaction retries, preserves crashed spend, protects against stale/late leases, and keeps finalization idempotent', async () => {
    const provider = new MockModelProvider({ kind: 'success' });
    let nowMs = Date.UTC(2026, 10, 9, 11, 0, 0);
    const clock = { nowMs: () => nowMs };

    const reqPayload = {
      incidentId: 'incident-003',
      scenarioVersion: ALL_SCENARIOS[2]!.scenarioVersion,
      checkpoint: 'evidence',
      selectedInterventionId: null,
      requestId: 'req-dup-001',
    };

    const first = await executeAnalyzeIncident(reqPayload, makeAuth('visitor-dup'), {
      db,
      provider,
      clock,
    });
    expect(first.status).toBe('ok');

    // Identical visitor + requestId + payload returns cached/idempotent response cleanly
    const dupSame = await executeAnalyzeIncident(reqPayload, makeAuth('visitor-dup'), {
      db,
      provider,
      clock,
    });
    expect(dupSame.status).toBe('ok');
    expect(provider.callCount).toBe(1);

    // Same requestId from DIFFERENT visitor OR different payload is rejected
    await expect(
      executeAnalyzeIncident(reqPayload, makeAuth('visitor-attacker'), {
        db,
        provider,
        clock,
      }),
    ).rejects.toThrow(/already bound/);

    await expect(
      executeAnalyzeIncident(
        { ...reqPayload, checkpoint: 'alert' },
        makeAuth('visitor-dup'),
        { db, provider, clock },
      ),
    ).rejects.toThrow(/already bound/);

    // Simulated Firestore transaction retry during admission
    await testEnv.clearFirestore();
    provider.reset();
    let txAttemptSeen = 0;
    const retryRes = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'evidence',
        selectedInterventionId: null,
        requestId: 'req-retry-01',
      },
      makeAuth('visitor-retry'),
      {
        db,
        provider,
        clock,
        beforeAdmissionCommitHook: async (attemptNum) => {
          txAttemptSeen = attemptNum;
          if (attemptNum === 1) {
            // Simulate Firestore transaction ABORTED contention (gRPC StatusCode 10) so SDK retries cleanly
            const abortedErr = new Error('Simulated Firestore transaction ABORTED contention') as Error & {
              code?: number;
            };
            abortedErr.code = 10;
            throw abortedErr;
          }
        },
      },
    );
    expect(retryRes.status).toBe('ok');
    expect(txAttemptSeen).toBe(2);
    expect(provider.callCount).toBe(1);

    // Simulated crash after lease acquisition: reserved spend NOT refunded after lease expiry
    await testEnv.clearFirestore();
    nowMs = Date.UTC(2026, 10, 10, 12, 0, 0);
    const monthKey = getUtcMonthKey(nowMs);
    await expect(
      executeAnalyzeIncident(
        {
          incidentId: 'incident-001',
          scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-crash-01',
        },
        makeAuth('visitor-crash'),
        { db, provider, clock, simulateCrashAfterLease: true },
      ),
    ).rejects.toThrow(/Simulated process crash while holding lease/);

    const afterCrashMonth = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
    ).data();
    expect(afterCrashMonth?.reservedSpendMicros).toBe(
      MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros,
    );

    // Advance past 25s lease TTL: a second visitor can generate, while crashed spend stays reserved!
    nowMs += BACKEND_LIMITS.generationLeaseTtlMs + 2_000;
    const recoveredAttempt = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-after-crash-02',
      },
      makeAuth('visitor-next'),
      { db, provider, clock },
    );
    expect(recoveredAttempt.status).toBe('ok');
    const afterRecoveryMonth = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
    ).data();
    // Attempt 1's 5,000 reserved + Attempt 2's 2,150 actual = 7,150 committed!
    expect(afterRecoveryMonth?.reservedSpendMicros).toBe(
      MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros,
    );
    expect(afterRecoveryMonth?.actualSpendMicros).toBe(2_150);

    // Stale/expired lease late completion protection + repeated finalization idempotency
    await testEnv.clearFirestore();
    nowMs = Date.UTC(2026, 10, 11, 15, 0, 0);
    let capturedLease1: GenerationLease | null = null;
    let capturedState1: ReconstructedState | null = null;
    let releaseAttempt1!: () => void;
    const attempt1Gate = new Promise<void>((resolve) => {
      releaseAttempt1 = resolve;
    });
    let markAttempt1Inside!: () => void;
    const attempt1Inside = new Promise<void>((resolve) => {
      markAttempt1Inside = resolve;
    });

    const slowLease1Provider = new MockModelProvider({ kind: 'invented_provenance' });
    const origLease1Gen = slowLease1Provider.generateAnalysis.bind(slowLease1Provider);
    slowLease1Provider.generateAnalysis = async (packet, options, signal) => {
      markAttempt1Inside();
      await attempt1Gate;
      return origLease1Gen(packet, options, signal);
    };

    const req1Promise = executeAnalyzeIncident(
      {
        incidentId: 'incident-002',
        scenarioVersion: ALL_SCENARIOS[1]!.scenarioVersion,
        checkpoint: 'outcome',
        selectedInterventionId: ALL_SCENARIOS[1]!.interventions[0]!.id,
        requestId: 'req-stale-1',
      },
      makeAuth('visitor-stale-1'),
      {
        db,
        provider: slowLease1Provider,
        clock,
        providerDeadlineMs: 120_000,
        onLeaseAcquired: (lease, s) => {
          capturedLease1 = lease;
          capturedState1 = s;
        },
      },
    );

    await attempt1Inside;
    expect(capturedLease1).not.toBeNull();

    // Advance clock past lease1 expiry (25s) and complete Attempt 2 on the same cache key
    nowMs += BACKEND_LIMITS.generationLeaseTtlMs + 5_000;
    const attempt2Provider = new MockModelProvider({ kind: 'success' });
    const attempt2Res = await executeAnalyzeIncident(
      {
        incidentId: 'incident-002',
        scenarioVersion: ALL_SCENARIOS[1]!.scenarioVersion,
        checkpoint: 'outcome',
        selectedInterventionId: ALL_SCENARIOS[1]!.interventions[0]!.id,
        requestId: 'req-stale-2',
      },
      makeAuth('visitor-stale-2'),
      { db, provider: attempt2Provider, clock },
    );
    expect(attempt2Res.status).toBe('ok');
    const attempt2CacheGeneratedAt = attempt2Res.result?.generatedAtIso;

    // Now release expired Attempt 1 -> returns timeout, keeps Attempt 2's cache untouched, charges full 5,000
    releaseAttempt1();
    const attempt1LateRes = await req1Promise;
    expect(attempt1LateRes.status).toBe('timeout');
    expect(attempt1LateRes.reasonCode).toBe('lease_expired_late_completion');

    const cacheAfterLate = (
      await db.collection(FIRESTORE_COLLECTIONS.analysisCache).doc(capturedState1!.cacheDocId).get()
    ).data();
    expect(cacheAfterLate?.result?.generatedAtIso).toBe(attempt2CacheGeneratedAt);

    // Calling finalizeGenerationTransaction again on Attempt 1's lease is strictly idempotent
    const secondFinalize = await finalizeGenerationTransaction(db, {
      lease: capturedLease1!,
      state: capturedState1!,
      outcome: {
        kind: 'success',
        usageKnown: true,
        actualCostMicros: 2_150,
        result: attempt2Res.result,
      },
      finalNowMs: nowMs,
      isMockProvider: true,
    });
    expect(secondFinalize.alreadyFinalized).toBe(true);
    expect(secondFinalize.chargedCostMicros).toBe(MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros);
    expect(secondFinalize.refundedCostMicros).toBe(0);
  });

  it('preserves worst-case spend on timeout/unknown usage, settles across UTC midnight/month rollover, and runs evaluations within shared caps', async () => {
    // 1. Timeout + Unknown usage
    let nowMs = Date.UTC(2026, 10, 30, 23, 59, 55); // Nov 30, 23:59:55 UTC
    const clock = { nowMs: () => nowMs };

    const timeoutProvider = new MockModelProvider({ kind: 'delay', delayMs: 250 });
    const timeoutRes = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-timeout-01',
      },
      makeAuth('visitor-timeout'),
      { db, provider: timeoutProvider, clock, providerDeadlineMs: 40 },
    );
    expect(timeoutRes.status).toBe('timeout');

    const novMonth = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc('2026-11').get()
    ).data();
    expect(novMonth?.actualSpendMicros).toBe(MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros);
    expect(novMonth?.reservedSpendMicros).toBe(0);

    // 2. UTC midnight + month boundary rollover reconciliation:
    // Acquire lease at 2026-11-30T23:59:55Z, advance clock to 2026-12-01T00:00:05Z during provider execution
    nowMs = Date.UTC(2026, 10, 30, 23, 59, 55);
    const rolloverProvider = new MockModelProvider({ kind: 'success' });
    const origGen = rolloverProvider.generateAnalysis.bind(rolloverProvider);
    rolloverProvider.generateAnalysis = async (packet, opts, signal) => {
      nowMs = Date.UTC(2026, 11, 1, 0, 0, 5); // Crosses UTC midnight & month into Dec 1!
      return origGen(packet, opts, signal);
    };

    const rolloverRes = await executeAnalyzeIncident(
      {
        incidentId: 'incident-002',
        scenarioVersion: ALL_SCENARIOS[1]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-rollover-01',
      },
      makeAuth('visitor-rollover'),
      { db, provider: rolloverProvider, clock },
    );
    expect(rolloverRes.status).toBe('ok');

    const novAfterRollover = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc('2026-11').get()
    ).data();
    const decAfterRollover = await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc('2026-12').get();
    expect(novAfterRollover?.attempts).toBe(2);
    expect(novAfterRollover?.actualSpendMicros).toBe(5_000 + 2_150);
    expect(novAfterRollover?.reservedSpendMicros).toBe(0);
    expect(decAfterRollover.exists).toBe(false);

    // 3. Unknown usage preserves full worst-case 5,000 microusd reservation
    const unknownUsageProvider = new MockModelProvider({ kind: 'unknown_usage' });
    const unknownRes = await executeAnalyzeIncident(
      {
        incidentId: 'incident-003',
        scenarioVersion: ALL_SCENARIOS[2]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-unknown-usage-01',
      },
      makeAuth('visitor-unknown-usage'),
      { db, provider: unknownUsageProvider, clock },
    );
    expect(unknownRes.status).toBe('ok');
    const decMonth = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc('2026-12').get()
    ).data();
    expect(decMonth?.actualSpendMicros).toBe(MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros);

    // 4. Internal evaluation path bypasses public cache and shares generation/spend allowances
    const evalRes = await runInternalEvaluationAnalysis(
      {
        operatorId: 'owner-mike',
        evalRunId: 'eval-phase3a-01',
        incidentId: 'incident-003',
        checkpoint: 'alert',
        selectedInterventionId: null,
      },
      { db, provider: new MockModelProvider({ kind: 'success' }), clock },
    );
    expect(evalRes.status).toBe('ok');
    expect(evalRes.isEvaluation).toBe(true);
    expect(evalRes.cacheHit).toBe(false);

    const evalSnap = await db.collection(FIRESTORE_COLLECTIONS.evaluationRuns).get();
    expect(evalSnap.size).toBe(1);
    const decAfterEval = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc('2026-12').get()
    ).data();
    expect(decAfterEval?.attempts).toBe(2);
    expect(decAfterEval?.actualSpendMicros).toBe(5_000 + 2_150);
  });

  it('rejects invalid outputs into cooldown, serves cache hits under exhausted generation quota, obeys emergency disable, and denies all browser DB access', async () => {
    let nowMs = Date.UTC(2026, 10, 12, 16, 0, 0);
    const clock = { nowMs: () => nowMs };

    // 1. Invalid citations output -> status: 'invalid_output' + 15s failure cooldown
    const badProvider = new MockModelProvider({ kind: 'invalid_citations' });
    const badRes = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'evidence',
        selectedInterventionId: null,
        requestId: 'req-bad-out-1',
      },
      makeAuth('visitor-bad-1'),
      { db, provider: badProvider, clock },
    );
    expect(badRes.status).toBe('invalid_output');
    expect(badRes.result).toBeUndefined();

    // Immediate retry during 15s cooldown returns cooldown status with 0 new provider calls
    nowMs += 3_000;
    const cooldownRes = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'evidence',
        selectedInterventionId: null,
        requestId: 'req-bad-out-2',
      },
      makeAuth('visitor-bad-2'),
      { db, provider: badProvider, clock },
    );
    expect(cooldownRes.status).toBe('invalid_output');
    expect(cooldownRes.reasonCode).toBe('failure_cooldown');
    expect(badProvider.callCount).toBe(1);

    // 2. Generation quota exhaustion still serves valid existing cache hits
    await testEnv.clearFirestore();
    const okProvider = new MockModelProvider({ kind: 'success' });
    const cachedSetup = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-cached-before-exhaust',
      },
      makeAuth('visitor-seed'),
      { db, provider: okProvider, clock },
    );
    expect(cachedSetup.status).toBe('ok');

    const dayKey = getUtcDayKey(nowMs);
    await db.collection(FIRESTORE_COLLECTIONS.quotaDays).doc(dayKey).set({
      dayKey,
      attempts: BACKEND_LIMITS.maxGenerationAttemptsPerDay,
    });

    // Uncached miss hits quota_reached
    const uncachedBlocked = await executeAnalyzeIncident(
      {
        incidentId: 'incident-002',
        scenarioVersion: ALL_SCENARIOS[1]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-uncached-blocked',
      },
      makeAuth('visitor-hit-check'),
      { db, provider: okProvider, clock },
    );
    expect(uncachedBlocked.status).toBe('quota_reached');
    expect(uncachedBlocked.reasonCode).toBe('daily_generation_limit');

    // Existing valid cache hit STILL succeeds cleanly!
    const cacheHitUnderExhaustion = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-cached-under-exhaust',
      },
      makeAuth('visitor-hit-check'),
      { db, provider: okProvider, clock },
    );
    expect(cacheHitUnderExhaustion.status).toBe('cached');
    expect(cacheHitUnderExhaustion.cacheHit).toBe(true);

    // 3. Emergency disable switch blocks even valid cache hits
    await db
      .collection(FIRESTORE_COLLECTIONS.systemControl)
      .doc(SYSTEM_CONTROL_DOC_ID)
      .set({ aiDisabled: true, reason: 'Emergency maintenance pause' });

    const disabledByDb = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-disabled-db',
      },
      makeAuth('visitor-disabled'),
      { db, provider: okProvider, clock },
    );
    expect(disabledByDb.status).toBe('disabled');

    const disabledByEnv = await executeAnalyzeIncident(
      {
        incidentId: 'incident-001',
        scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-disabled-env',
      },
      makeAuth('visitor-disabled'),
      { db, provider: okProvider, clock, envAiDisabled: true },
    );
    expect(disabledByEnv.status).toBe('disabled');

    // 4. Browser Firestore Security Rules: deny ALL unauthenticated & authenticated client reads/writes
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    const authDb = testEnv.authenticatedContext('visitor-browser-client').firestore();
    const cachedAlertState = reconstructCanonicalState(ALL_SCENARIOS[0]!, 'alert', null);

    for (const collectionName of [
      ...Object.values(FIRESTORE_COLLECTIONS),
      'arbitraryPublicCollection',
    ]) {
      const targetDocId =
        collectionName === FIRESTORE_COLLECTIONS.analysisCache
          ? cachedAlertState.cacheDocId
          : collectionName === FIRESTORE_COLLECTIONS.systemControl
            ? SYSTEM_CONTROL_DOC_ID
            : 'probe-doc';

      await assertFails(getDoc(doc(unauthDb, collectionName, targetDocId)));
      await assertFails(setDoc(doc(unauthDb, collectionName, 'write-probe'), { forged: true }));
      await assertFails(getDoc(doc(authDb, collectionName, targetDocId)));
      await assertFails(setDoc(doc(authDb, collectionName, 'write-probe'), { forged: true }));
      await assertFails(updateDoc(doc(authDb, collectionName, targetDocId), { forged: true }));
      await assertFails(deleteDoc(doc(authDb, collectionName, targetDocId)));
    }
  });

  it('enforces public visitor and project request limits on duplicate completed and pending requestIds without duplicate generation or billing', async () => {
    const provider = new MockModelProvider({ kind: 'success' });
    let nowMs = Date.UTC(2026, 10, 14, 14, 0, 0);
    const clock = { nowMs: () => nowMs };

    const dupCompletedReq = {
      incidentId: 'incident-001',
      scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
      checkpoint: 'evidence',
      selectedInterventionId: null,
      requestId: 'req-dup-rate-completed',
    };

    // 1. Completed requestId replay increments visitor/project counters and obeys 2/min and 12/day limits
    const initialRes = await executeAnalyzeIncident(
      dupCompletedReq,
      makeAuth('visitor-dup-rate'),
      { db, provider, clock },
    );
    expect(initialRes.status).toBe('ok');
    expect(provider.callCount).toBe(1);

    const replaySameMin = await executeAnalyzeIncident(
      dupCompletedReq,
      makeAuth('visitor-dup-rate'),
      { db, provider, clock },
    );
    expect(replaySameMin.status).toBe('ok');
    expect(provider.callCount).toBe(1);

    const replayBlockedMin = await executeAnalyzeIncident(
      dupCompletedReq,
      makeAuth('visitor-dup-rate'),
      { db, provider, clock },
    );
    expect(replayBlockedMin.status).toBe('quota_reached');
    expect(replayBlockedMin.reasonCode).toBe('visitor_minute_limit');

    const minuteSnapAfterBlocked = await db
      .collection(FIRESTORE_COLLECTIONS.quotaMinutes)
      .doc(getUtcMinuteKey(nowMs))
      .get();
    expect(minuteSnapAfterBlocked.data()?.acceptedRequests).toBe(2);

    // Exhaust remaining 10 daily requests across subsequent minutes by replaying the same completed requestId
    for (let m = 1; m <= 5; m++) {
      nowMs = Date.UTC(2026, 10, 14, 14, m, 0);
      const rA = await executeAnalyzeIncident(dupCompletedReq, makeAuth('visitor-dup-rate'), {
        db,
        provider,
        clock,
      });
      const rB = await executeAnalyzeIncident(dupCompletedReq, makeAuth('visitor-dup-rate'), {
        db,
        provider,
        clock,
      });
      expect(rA.status).toBe('ok');
      expect(rB.status).toBe('ok');
    }

    nowMs = Date.UTC(2026, 10, 14, 14, 6, 0);
    const replayBlockedDaily = await executeAnalyzeIncident(
      dupCompletedReq,
      makeAuth('visitor-dup-rate'),
      { db, provider, clock },
    );
    expect(replayBlockedDaily.status).toBe('quota_reached');
    expect(replayBlockedDaily.reasonCode).toBe('visitor_daily_limit');

    const daySnap = await db
      .collection(FIRESTORE_COLLECTIONS.quotaDays)
      .doc(getUtcDayKey(nowMs))
      .get();
    const monthSnap = await db
      .collection(FIRESTORE_COLLECTIONS.quotaMonths)
      .doc(getUtcMonthKey(nowMs))
      .get();
    expect(provider.callCount).toBe(1);
    expect(daySnap.data()?.attempts).toBe(1);
    expect(monthSnap.data()?.attempts).toBe(1);
    expect(monthSnap.data()?.actualSpendMicros).toBe(2_150);

    // 2. Completed requestId replay blocked by project 30/min limit
    await testEnv.clearFirestore();
    provider.reset();
    nowMs = Date.UTC(2026, 10, 14, 15, 0, 0);
    const projDupReq = {
      incidentId: 'incident-002',
      scenarioVersion: ALL_SCENARIOS[1]!.scenarioVersion,
      checkpoint: 'alert',
      selectedInterventionId: null,
      requestId: 'req-dup-proj-cap',
    };
    expect(
      (await executeAnalyzeIncident(projDupReq, makeAuth('visitor-proj-dup-owner'), {
        db,
        provider,
        clock,
      })).status,
    ).toBe('ok');

    for (let v = 1; v < BACKEND_LIMITS.projectMaxRequestsPerMinute; v++) {
      const r = await executeAnalyzeIncident(
        { ...projDupReq, requestId: `req-proj-fill-${v}` },
        makeAuth(`visitor-proj-fill-${v}`),
        { db, provider, clock },
      );
      expect(r.status).toBe('cached');
    }

    const replayBlockedProject = await executeAnalyzeIncident(
      projDupReq,
      makeAuth('visitor-proj-dup-owner'),
      { db, provider, clock },
    );
    expect(replayBlockedProject.status).toBe('quota_reached');
    expect(replayBlockedProject.reasonCode).toBe('project_minute_limit');
    expect(provider.callCount).toBe(1);

    // 3. Pending requestId replay obeys visitor and project limits without duplicate leases or spend
    await testEnv.clearFirestore();
    nowMs = Date.UTC(2026, 10, 14, 16, 0, 0);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let markInside!: () => void;
    const inside = new Promise<void>((resolve) => {
      markInside = resolve;
    });
    const slowPendingProvider = new MockModelProvider({ kind: 'success' });
    let slowCount = 0;
    const origSlow = slowPendingProvider.generateAnalysis.bind(slowPendingProvider);
    slowPendingProvider.generateAnalysis = async (packet, opts, sig) => {
      slowCount += 1;
      markInside();
      await gate;
      return origSlow(packet, opts, sig);
    };

    const pendBaseReq = {
      incidentId: 'incident-003',
      scenarioVersion: ALL_SCENARIOS[2]!.scenarioVersion,
      checkpoint: 'evidence',
      selectedInterventionId: null,
    };

    const holderPromise = executeAnalyzeIncident(
      { ...pendBaseReq, requestId: 'req-pending-holder' },
      makeAuth('visitor-pending-owner'),
      { db, provider: slowPendingProvider, clock },
    );
    await inside;

    // Owner replaying the exact same pending requestId once increments minuteCount (1 -> 2) and gets pending
    const ownerReplay1 = await executeAnalyzeIncident(
      { ...pendBaseReq, requestId: 'req-pending-holder' },
      makeAuth('visitor-pending-owner'),
      { db, provider: slowPendingProvider, clock },
    );
    expect(ownerReplay1.status).toBe('pending');
    expect(slowCount).toBe(1);

    // Owner replaying a second time in the same minute hits visitor_minute_limit
    const ownerReplay2 = await executeAnalyzeIncident(
      { ...pendBaseReq, requestId: 'req-pending-holder' },
      makeAuth('visitor-pending-owner'),
      { db, provider: slowPendingProvider, clock },
    );
    expect(ownerReplay2.status).toBe('quota_reached');
    expect(ownerReplay2.reasonCode).toBe('visitor_minute_limit');

    // Separate waiter hits pending once, then project minute limit fills to 30, then waiter replay hits project_minute_limit
    const waiterInitial = await executeAnalyzeIncident(
      { ...pendBaseReq, requestId: 'req-pending-waiter' },
      makeAuth('visitor-pending-waiter'),
      { db, provider: slowPendingProvider, clock },
    );
    expect(waiterInitial.status).toBe('pending');

    for (let v = 1; v <= 27; v++) {
      const filler = await executeAnalyzeIncident(
        { ...pendBaseReq, requestId: `req-pending-filler-${v}` },
        makeAuth(`visitor-pending-filler-${v}`),
        { db, provider: slowPendingProvider, clock },
      );
      expect(filler.status).toBe('pending');
    }

    const waiterReplayProjCap = await executeAnalyzeIncident(
      { ...pendBaseReq, requestId: 'req-pending-waiter' },
      makeAuth('visitor-pending-waiter'),
      { db, provider: slowPendingProvider, clock },
    );
    expect(waiterReplayProjCap.status).toBe('quota_reached');
    expect(waiterReplayProjCap.reasonCode).toBe('project_minute_limit');

    const pendMonthBeforeFinish = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(getUtcMonthKey(nowMs)).get()
    ).data();
    expect(pendMonthBeforeFinish?.attempts).toBe(1);
    expect(pendMonthBeforeFinish?.reservedSpendMicros).toBe(
      MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros,
    );

    releaseGate();
    const holderDone = await holderPromise;
    expect(holderDone.status).toBe('ok');
    expect(slowPendingProvider.callCount).toBe(1);
    const pendMonthAfterFinish = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(getUtcMonthKey(nowMs)).get()
    ).data();
    expect(pendMonthAfterFinish?.attempts).toBe(1);
    expect(pendMonthAfterFinish?.actualSpendMicros).toBe(2_150);
  });

  it('bounds stored-response reuse for completed and reconciled-attempt requestIds by fixed 30-day expiry and canonical identity', async () => {
    const provider = new MockModelProvider({ kind: 'success' });
    const t0 = Date.UTC(2026, 10, 1, 0, 0, 0);
    let nowMs = t0;
    const clock = { nowMs: () => nowMs };

    const reqBase = {
      incidentId: 'incident-001',
      scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
      checkpoint: 'evidence',
      selectedInterventionId: null,
    };

    // 1. Original completed request & cache-hit request both remain bound to original fixed 30-day expiry
    const origResp = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-ttl-orig' },
      makeAuth('visitor-ttl-orig'),
      { db, provider, clock },
    );
    expect(origResp.status).toBe('ok');
    expect(provider.callCount).toBe(1);

    nowMs = t0 + 5 * 24 * 60 * 60 * 1000;
    const cacheReqResp = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-ttl-cached' },
      makeAuth('visitor-ttl-cached'),
      { db, provider, clock },
    );
    expect(cacheReqResp.status).toBe('cached');

    const cachedRecAtDay5 = (
      await db.collection(FIRESTORE_COLLECTIONS.requestRecords).doc('req-ttl-cached').get()
    ).data();
    expect(cachedRecAtDay5?.responseExpiresAtMs).toBe(t0 + BACKEND_LIMITS.cacheTtlMs);

    // Day 29 replay succeeds without silently extending expiry
    nowMs = t0 + 29 * 24 * 60 * 60 * 1000;
    const day29Orig = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-ttl-orig' },
      makeAuth('visitor-ttl-orig'),
      { db, provider, clock },
    );
    expect(day29Orig.status).toBe('ok');
    expect(day29Orig.result).toBeDefined();

    const day29Cached = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-ttl-cached' },
      makeAuth('visitor-ttl-cached'),
      { db, provider, clock },
    );
    expect(day29Cached.status).toBe('cached');
    expect(day29Cached.result).toBeDefined();

    const cachedRecAfterDay29Read = (
      await db.collection(FIRESTORE_COLLECTIONS.requestRecords).doc('req-ttl-cached').get()
    ).data();
    expect(cachedRecAfterDay29Read?.responseExpiresAtMs).toBe(t0 + BACKEND_LIMITS.cacheTtlMs);

    // Past 30-day expiry, reusing the exact same requestIds refuses to return expired analysis
    nowMs = t0 + BACKEND_LIMITS.cacheTtlMs + 1_000;
    const expiredOrig = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-ttl-orig' },
      makeAuth('visitor-ttl-orig'),
      { db, provider, clock },
    );
    expect(expiredOrig.status).toBe('unavailable');
    expect(expiredOrig.reasonCode).toBe('request_response_expired');
    expect(expiredOrig.result).toBeUndefined();

    const expiredCached = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-ttl-cached' },
      makeAuth('visitor-ttl-cached'),
      { db, provider, clock },
    );
    expect(expiredCached.status).toBe('unavailable');
    expect(expiredCached.reasonCode).toBe('request_response_expired');
    expect(expiredCached.result).toBeUndefined();
    expect(provider.callCount).toBe(1);

    // Visitor/payload binding remains enforced even after expiry
    await expect(
      executeAnalyzeIncident(
        { ...reqBase, requestId: 'req-ttl-orig' },
        makeAuth('visitor-other'),
        { db, provider, clock },
      ),
    ).rejects.toThrow(/already bound/);

    // 2. Completed requestId invalidated by modelVersion, promptVersion, schemaVersion, and evidence text changes
    await testEnv.clearFirestore();
    provider.reset();
    nowMs = t0;
    const verResp = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-ver-orig' },
      makeAuth('visitor-ver'),
      { db, provider, clock },
    );
    expect(verResp.status).toBe('ok');

    nowMs += 65_000;
    for (const versionOverride of [
      { modelVersion: 'mock-gemini-v2' },
      { promptVersion: '2.0.0' },
      { schemaVersion: '2.0.0' },
    ]) {
      nowMs += 65_000;
      const obs = await executeAnalyzeIncident(
        { ...reqBase, requestId: 'req-ver-orig' },
        makeAuth('visitor-ver'),
        { db, provider, clock, ...versionOverride },
      );
      expect(obs.status).toBe('unavailable');
      expect(obs.reasonCode).toBe('request_identity_obsolete');
      expect(obs.result).toBeUndefined();
    }

    // Mutate canonical evidence text while keeping evidence IDs and payload versions unchanged
    const baseScenario = ALL_SCENARIOS[0]!;
    const editedScenario = {
      ...baseScenario,
      buildEvidenceCatalog: (interventionId: string | null) =>
        baseScenario.buildEvidenceCatalog(interventionId).map((item, idx) =>
          idx === 0
            ? { ...item, summary: `${item.summary} [modified canonical evidence]` }
            : item,
        ),
    };
    const editedState = reconstructCanonicalState(editedScenario, 'evidence', null);
    const samePayloadHash = sha256Hex(
      stableStringify({
        incidentId: reqBase.incidentId,
        scenarioVersion: reqBase.scenarioVersion,
        engineVersion: ENGINE_VERSION,
        checkpoint: reqBase.checkpoint,
        selectedInterventionId: reqBase.selectedInterventionId,
      }),
    );
    nowMs += 65_000;
    const evidenceObsolete = await admitRequestTransaction(db, {
      visitorUid: 'visitor-ver',
      requestId: 'req-ver-orig',
      requestPayloadHash: samePayloadHash,
      state: editedState,
      nowMs,
      leaseId: 'lease_unused',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: true,
    });
    expect(evidenceObsolete.decision).toBe('duplicate_completed');
    if (evidenceObsolete.decision === 'duplicate_completed') {
      expect(evidenceObsolete.response.status).toBe('unavailable');
      expect(evidenceObsolete.response.reasonCode).toBe('request_identity_obsolete');
      expect(evidenceObsolete.response.result).toBeUndefined();
    }

    // 3. Same identity and expiry protections apply when recovering an in_flight requestId from a reconciled attempt
    await testEnv.clearFirestore();
    provider.reset();
    nowMs = t0;
    let releaseAttempt!: () => void;
    const attemptGate = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const slowProvider = new MockModelProvider({ kind: 'success' });
    const origSlowGen = slowProvider.generateAnalysis.bind(slowProvider);
    slowProvider.generateAnalysis = async (packet, opts, sig) => {
      markStarted();
      await attemptGate;
      return origSlowGen(packet, opts, sig);
    };

    const holderReq = executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-inflight-owner' },
      makeAuth('visitor-inf-0'),
      { db, provider: slowProvider, clock },
    );
    await started;

    // Queue 4 waiters while the attempt is in flight (each creates an in_flight requestRecord pointing to the active lease)
    for (let w = 1; w <= 4; w++) {
      const p = await executeAnalyzeIncident(
        { ...reqBase, requestId: `req-inflight-w${w}` },
        makeAuth(`visitor-inf-${w}`),
        { db, provider: slowProvider, clock },
      );
      expect(p.status).toBe('pending');
    }

    releaseAttempt();
    expect((await holderReq).status).toBe('ok');

    // Waiter 1 recovers validly before 30 days, and its expiry matches t0 + 30d (not extended)
    nowMs = t0 + 10 * 24 * 60 * 60 * 1000;
    const w1Recovered = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-inflight-w1' },
      makeAuth('visitor-inf-1'),
      { db, provider: slowProvider, clock },
    );
    expect(w1Recovered.status).toBe('cached');
    expect(w1Recovered.result).toBeDefined();
    const w1Rec = (
      await db.collection(FIRESTORE_COLLECTIONS.requestRecords).doc('req-inflight-w1').get()
    ).data();
    expect(w1Rec?.responseExpiresAtMs).toBe(t0 + BACKEND_LIMITS.cacheTtlMs);

    // Waiter 2 recovers after model/prompt/schema change -> rejected as obsolete
    const w2Obsolete = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-inflight-w2' },
      makeAuth('visitor-inf-2'),
      { db, provider: slowProvider, clock, promptVersion: '9.9.9' },
    );
    expect(w2Obsolete.status).toBe('unavailable');
    expect(w2Obsolete.reasonCode).toBe('request_identity_obsolete');
    expect(w2Obsolete.result).toBeUndefined();

    // Waiter 3 recovers after canonical evidence text mutation -> rejected as obsolete
    const w3Obsolete = await admitRequestTransaction(db, {
      visitorUid: 'visitor-inf-3',
      requestId: 'req-inflight-w3',
      requestPayloadHash: samePayloadHash,
      state: editedState,
      nowMs,
      leaseId: 'lease_unused_2',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: true,
    });
    expect(w3Obsolete.decision).toBe('duplicate_completed');
    if (w3Obsolete.decision === 'duplicate_completed') {
      expect(w3Obsolete.response.status).toBe('unavailable');
      expect(w3Obsolete.response.reasonCode).toBe('request_identity_obsolete');
      expect(w3Obsolete.response.result).toBeUndefined();
    }

    // Waiter 4 recovers after original 30-day expiry -> rejected as expired (even after regenerating a new cache)
    nowMs = t0 + BACKEND_LIMITS.cacheTtlMs + 5_000;
    const freshCacheFill = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-fresh-after-30d' },
      makeAuth('visitor-fresh-filler'),
      { db, provider: new MockModelProvider({ kind: 'success' }), clock },
    );
    expect(freshCacheFill.status).toBe('ok');

    const w4Expired = await executeAnalyzeIncident(
      { ...reqBase, requestId: 'req-inflight-w4' },
      makeAuth('visitor-inf-4'),
      { db, provider: slowProvider, clock },
    );
    expect(w4Expired.status).toBe('unavailable');
    expect(w4Expired.reasonCode).toBe('request_response_expired');
    expect(w4Expired.result).toBeUndefined();
  });

  it('enforces the provider deadline independently when providers ignore AbortSignal and resolve late, reject late, or never settle', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const nowMs = Date.UTC(2026, 10, 14, 18, 0, 0);
      const clock = { nowMs: () => nowMs };
      const monthKey = getUtcMonthKey(nowMs);
      const state = reconstructCanonicalState(ALL_SCENARIOS[0]!, 'evidence', null);

      // 1. Uncooperative provider ignores AbortSignal and resolves AFTER deadline
      const resolveLateProvider = new MockModelProvider({
        kind: 'ignore_abort_resolve_late',
        delayMs: 900,
      });
      const startedAt = Date.now();
      const lateResolveRes = await executeAnalyzeIncident(
        {
          incidentId: 'incident-001',
          scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
          checkpoint: 'evidence',
          selectedInterventionId: null,
          requestId: 'req-deadline-resolve-late',
        },
        makeAuth('visitor-deadline-1'),
        { db, provider: resolveLateProvider, clock, providerDeadlineMs: 25 },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(lateResolveRes.status).toBe('timeout');
      expect(lateResolveRes.reasonCode).toBe('provider_deadline_exceeded');
      expect(lateResolveRes.result).toBeUndefined();
      // Prove settlement happened well before the 900ms delayed provider resolved (including emulator RTT).
      expect(elapsedMs).toBeLessThan(700);

      // Wait past late provider resolution to verify no late cache mutation, double reconciliation, or unhandled errors
      await new Promise((resolve) => setTimeout(resolve, 950));

      const cacheAfterLateResolve = (
        await db.collection(FIRESTORE_COLLECTIONS.analysisCache).doc(state.cacheDocId).get()
      ).data();
      expect(cacheAfterLateResolve?.status).toBe('cooldown');
      expect(cacheAfterLateResolve?.result).toBeUndefined();

      const monthAfterLateResolve = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterLateResolve?.actualSpendMicros).toBe(
        MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros,
      );
      expect(monthAfterLateResolve?.reservedSpendMicros).toBe(0);
      expect(unhandledRejections).toEqual([]);

      // 2. Uncooperative provider ignores AbortSignal and rejects AFTER deadline
      await testEnv.clearFirestore();
      const rejectLateProvider = new MockModelProvider({
        kind: 'ignore_abort_reject_late',
        delayMs: 900,
        message: 'Late background failure',
      });
      const lateRejectStartedAt = Date.now();
      const lateRejectRes = await executeAnalyzeIncident(
        {
          incidentId: 'incident-001',
          scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
          checkpoint: 'evidence',
          selectedInterventionId: null,
          requestId: 'req-deadline-reject-late',
        },
        makeAuth('visitor-deadline-2'),
        { db, provider: rejectLateProvider, clock, providerDeadlineMs: 25 },
      );
      expect(Date.now() - lateRejectStartedAt).toBeLessThan(700);
      expect(lateRejectRes.status).toBe('timeout');
      expect(lateRejectRes.reasonCode).toBe('provider_deadline_exceeded');

      await new Promise((resolve) => setTimeout(resolve, 950));
      const monthAfterLateReject = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterLateReject?.actualSpendMicros).toBe(
        MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros,
      );
      expect(monthAfterLateReject?.reservedSpendMicros).toBe(0);
      expect(unhandledRejections).toEqual([]);

      // 3. Provider never settles -> settles promptly with timeout and preserves worst-case spend
      await testEnv.clearFirestore();
      const neverSettleProvider = new MockModelProvider({ kind: 'never_settle' });
      const neverStart = Date.now();
      const neverRes = await executeAnalyzeIncident(
        {
          incidentId: 'incident-001',
          scenarioVersion: ALL_SCENARIOS[0]!.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-deadline-never-settle',
        },
        makeAuth('visitor-deadline-3'),
        { db, provider: neverSettleProvider, clock, providerDeadlineMs: 25 },
      );
      expect(Date.now() - neverStart).toBeLessThan(700);
      expect(neverRes.status).toBe('timeout');
      expect(neverRes.reasonCode).toBe('provider_deadline_exceeded');

      const monthAfterNever = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterNever?.actualSpendMicros).toBe(
        MOCK_PRICING_FIXTURE_V1.worstCaseReservationMicros,
      );
      expect(monthAfterNever?.reservedSpendMicros).toBe(0);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('Phase 3B live Gemini provider Firestore emulator integration', () => {
  function makeGroundedLiveJson(
    state: ReturnType<typeof reconstructCanonicalState>,
  ): string {
    const firstEv = state.packet.visibleEvidence[0]!.id;
    const firstOpt = state.packet.visibleInterventions[0]?.id;
    return JSON.stringify({
      conciseAssessment: `Live grounded telemetry summary at ${state.checkpoint} (${state.packet.simTimeSeconds}s).`,
      observedFacts: [{ text: 'Observed telemetry anomaly in packet.', citationIds: [firstEv] }],
      rankedHypotheses: [
        {
          rank: 1,
          statement: 'Primary subsystem degradation matches packet telemetry.',
          likelihood: 'Primary',
          supportingCitationIds: [firstEv],
        },
      ],
      alternativeExplanations: [],
      missingInformation: ['Confirm post-mitigation convergence metrics.'],
      confidence: {
        level: 'Medium',
        justification: 'Derived strictly from canonical checkpoint evidence.',
      },
      recommendedInterventions:
        state.checkpoint === 'alert' || !firstOpt
          ? []
          : [
              {
                interventionId: firstOpt,
                rationale: 'Targets dominant degradation mechanism in packet.',
                keyRisk: 'May briefly shift upstream latency.',
              },
            ],
      verificationChecks: ['Inspect saturation and error metrics after checkpoint.'],
      stakeholderUpdate: 'Investigating canonical telemetry signals and tracking mitigation.',
    });
  }

  it('reserves 7,400 microusd under GEMINI_3_5_FLASH_LITE_PRICING_V1, reconciles billable tokens, isolates mock vs live cache, and marks live provenance', async () => {
    const nowMs = Date.UTC(2026, 10, 14, 15, 0, 0);
    const clock = { nowMs: () => nowMs };
    const monthKey = getUtcMonthKey(nowMs);
    const scenario = ALL_SCENARIOS[0]!;

    const mockState = reconstructCanonicalState(scenario, 'evidence', null);
    const liveState = reconstructCanonicalState(scenario, 'evidence', null, {
      modelVersion: DEFAULT_LIVE_MODEL_VERSION,
    });
    expect(liveState.cacheDocId).not.toBe(mockState.cacheDocId);

    // Seed mocked cache first to verify live provider ignores mocked cache entries
    const mockProvider = new MockModelProvider({ kind: 'success' });
    const mockSeedRes = await executeAnalyzeIncident(
      {
        incidentId: scenario.incidentId,
        scenarioVersion: scenario.scenarioVersion,
        checkpoint: 'evidence',
        selectedInterventionId: null,
        requestId: 'req-p3b-mock-seed',
      },
      makeAuth('visitor-p3b-mock'),
      { db, provider: mockProvider, clock },
    );
    expect(mockSeedRes.status).toBe('ok');
    expect(mockSeedRes.isMockProvider).toBe(true);
    expect(mockSeedRes.result?.isPreviewMock).toBe(true);
    expect(mockSeedRes.result?.sourceBadgeLabel).toBe('Mocked AI analysis (Phase 3A emulator)');

    const monthBeforeLive = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
    ).data();
    const spendBeforeLive = Number(monthBeforeLive?.actualSpendMicros ?? 0);

    let transportCalls = 0;
    let countCalls = 0;
    let observedReservedInFlight = -1;
    let observedActualInFlight = -1;
    const liveTransport: GeminiTransport = async (req) => {
      transportCalls += 1;
      expect(req.url).toContain(`models/${DEFAULT_LIVE_MODEL_VERSION}:generateContent`);
      expect(req.headers['X-Chaos-Request-Sha256']).toBeUndefined();
      const genConfig = req.body.generationConfig as {
        responseMimeType?: string;
        responseJsonSchema?: unknown;
        thinkingConfig?: { thinkingLevel?: string };
      };
      expect(genConfig.responseMimeType).toBe('application/json');
      expect(genConfig.responseJsonSchema).toBeDefined();
      expect(genConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
      const serializedReq = JSON.stringify(req.body);
      expect(serializedReq).not.toContain(scenario.debrief.actualRootCause);
      expect(serializedReq).not.toContain(scenario.walkthroughs.evidence.conciseAssessment);

      const inFlightMonth = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      observedReservedInFlight = Number(inFlightMonth?.reservedSpendMicros ?? -1);
      observedActualInFlight = Number(inFlightMonth?.actualSpendMicros ?? -1);

      return {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: makeGroundedLiveJson(liveState) }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 3_200,
            candidatesTokenCount: 640,
            thoughtsTokenCount: 260,
            totalTokenCount: 4_100,
          },
        },
      };
    };

    const liveProvider = new GeminiModelProvider({
      apiKey: 'emu-test-key',
      countTokensTransport: async (req) => {
        countCalls += 1;
        expect(req.url).toContain(`models/${DEFAULT_LIVE_MODEL_VERSION}:countTokens`);
        expect(req.headers['X-Chaos-Request-Sha256']).toBeUndefined();
        return { status: 200, body: { totalTokens: 3_200 } };
      },
      transport: liveTransport,
    });
    expect(liveProvider.isMock).toBe(false);

    const liveRes = await executeAnalyzeIncident(
      {
        incidentId: scenario.incidentId,
        scenarioVersion: scenario.scenarioVersion,
        checkpoint: 'evidence',
        selectedInterventionId: null,
        requestId: 'req-p3b-live-gen',
      },
      makeAuth('visitor-p3b-live-1'),
      { db, provider: liveProvider, clock },
    );

    expect(countCalls).toBe(1);
    expect(transportCalls).toBe(1);
    expect(observedReservedInFlight).toBe(
      GEMINI_3_5_FLASH_LITE_PRICING_V1.worstCaseReservationMicros,
    );
    expect(observedReservedInFlight).toBe(7_400);
    expect(observedActualInFlight).toBe(spendBeforeLive);

    expect(liveRes.status).toBe('ok');
    expect(liveRes.cacheHit).toBe(false);
    expect(liveRes.isMockProvider).toBe(false);
    expect(liveRes.result?.isPreviewMock).toBe(false);
    expect(liveRes.result?.sourceBadgeLabel).toBe('AI analysis (generated live)');
    expect(liveRes.result?.modelVersion).toBe(DEFAULT_LIVE_MODEL_VERSION);

    const expectedCost = computeTokenCostMicros(
      { inputTokens: 3_200, outputTokens: 640, thinkingTokens: 260, totalTokens: 4_100 },
      GEMINI_3_5_FLASH_LITE_PRICING_V1,
    );
    expect(expectedCost).toEqual({ known: true, costMicros: 3_210 });

    const monthAfterLive = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
    ).data();
    expect(monthAfterLive?.reservedSpendMicros).toBe(0);
    expect(Number(monthAfterLive?.actualSpendMicros) - spendBeforeLive).toBe(3_210);

    // Cross-visitor live cache hit reuses cached live entry without hitting transport or touching mock cache
    const cachedLiveRes = await executeAnalyzeIncident(
      {
        incidentId: scenario.incidentId,
        scenarioVersion: scenario.scenarioVersion,
        checkpoint: 'evidence',
        selectedInterventionId: null,
        requestId: 'req-p3b-live-cache',
      },
      makeAuth('visitor-p3b-live-2'),
      { db, provider: liveProvider, clock },
    );
    expect(transportCalls).toBe(1);
    expect(cachedLiveRes.status).toBe('cached');
    expect(cachedLiveRes.cacheHit).toBe(true);
    expect(cachedLiveRes.isMockProvider).toBe(false);
    expect(cachedLiveRes.result?.isPreviewMock).toBe(false);
    expect(cachedLiveRes.result?.sourceBadgeLabel).toBe('AI analysis (shared cache hit)');

    // Internal evaluation bypasses public cache under live pricing and leaves public visitor limits untouched
    const evalRes = await runInternalEvaluationAnalysis(
      {
        operatorId: 'owner-smoke-test',
        evalRunId: 'eval-p3b-1',
        incidentId: scenario.incidentId,
        checkpoint: 'evidence',
        selectedInterventionId: null,
      },
      { db, provider: liveProvider, clock },
    );
    expect(countCalls).toBe(2);
    expect(transportCalls).toBe(2);
    expect(evalRes.status).toBe('ok');
    expect(evalRes.isMockProvider).toBe(false);
    expect(evalRes.result?.isPreviewMock).toBe(false);
    expect(evalRes.result?.sourceBadgeLabel).toBe('AI analysis (generated live)');
    const monthAfterEval = (
      await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
    ).data();
    expect(Number(monthAfterEval?.actualSpendMicros) - Number(monthAfterLive?.actualSpendMicros)).toBe(
      3_210,
    );
    const evalRunDocs = await db
      .collection(FIRESTORE_COLLECTIONS.evaluationRuns)
      .where('evalRunId', '==', 'eval-p3b-1')
      .get();
    expect(evalRunDocs.size).toBe(1);
    expect(evalRunDocs.docs[0]?.data()?.chargedCostMicros).toBe(3_210);
    const evalVisitorDoc = await db
      .collection(FIRESTORE_COLLECTIONS.visitorState)
      .doc('operator:owner-smoke-test')
      .get();
    expect(evalVisitorDoc.exists).toBe(false);
  });

  it('retains full 7,400 microusd reservation on missing usage/unavailable error and enforces independent live timeout without unhandled rejections', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const nowMs = Date.UTC(2026, 10, 14, 19, 0, 0);
      const clock = { nowMs: () => nowMs };
      const monthKey = getUtcMonthKey(nowMs);
      const scenario = ALL_SCENARIOS[0]!;
      const alertState = reconstructCanonicalState(scenario, 'alert', null, {
        modelVersion: DEFAULT_LIVE_MODEL_VERSION,
      });
      const outcomeInterventionId = scenario.interventions[0]!.id;

      // 1. Missing usageMetadata on 200 response retains full 7,400 microusd worst-case reservation
      const missingUsageProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () => ({ status: 200, body: { totalTokens: 2_800 } }),
        transport: async () => ({
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: makeGroundedLiveJson(alertState) }],
                },
                finishReason: 'STOP',
              },
            ],
          },
        }),
      });
      const missingUsageRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-p3b-missing-usage',
        },
        makeAuth('visitor-p3b-missing-usage'),
        { db, provider: missingUsageProvider, clock },
      );
      expect(missingUsageRes.status).toBe('ok');
      expect(missingUsageRes.isMockProvider).toBe(false);
      expect(missingUsageRes.result?.isPreviewMock).toBe(false);
      const monthAfterMissing = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterMissing?.actualSpendMicros).toBe(7_400);
      expect(monthAfterMissing?.reservedSpendMicros).toBe(0);

      // 2. Provider HTTP 503 with zero retries retains full 7,400 microusd and enters 15s cooldown
      await testEnv.clearFirestore();
      let errorCalls = 0;
      const unavailableProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () => ({ status: 200, body: { totalTokens: 3_100 } }),
        transport: async () => {
          errorCalls += 1;
          return {
            status: 503,
            body: { error: { message: 'Service temporarily unavailable' } },
          };
        },
      });
      const outcomeState = reconstructCanonicalState(scenario, 'outcome', outcomeInterventionId, {
        modelVersion: DEFAULT_LIVE_MODEL_VERSION,
      });
      const unavailableRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'outcome',
          selectedInterventionId: outcomeInterventionId,
          requestId: 'req-p3b-503',
        },
        makeAuth('visitor-p3b-503'),
        { db, provider: unavailableProvider, clock },
      );
      expect(errorCalls).toBe(1);
      expect(unavailableRes.status).toBe('unavailable');
      expect(unavailableRes.reasonCode).toBe('provider_error');
      const cacheAfter503 = (
        await db.collection(FIRESTORE_COLLECTIONS.analysisCache).doc(outcomeState.cacheDocId).get()
      ).data();
      expect(cacheAfter503?.status).toBe('cooldown');
      const monthAfter503 = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfter503?.actualSpendMicros).toBe(7_400);
      expect(monthAfter503?.reservedSpendMicros).toBe(0);

      // 3. Uncooperative Gemini transport ignoring AbortSignal: resolve late, reject late, never settle
      const makeHangingProvider = (behavior: 'resolve' | 'reject' | 'never') =>
        new GeminiModelProvider({
          apiKey: 'emu-test-key',
          countTokensTransport: async () => ({ status: 200, body: { totalTokens: 2_800 } }),
          transport: async () =>
            new Promise((resolve, reject) => {
              if (behavior === 'never') {
                return;
              }
              setTimeout(() => {
                if (behavior === 'resolve') {
                  resolve({
                    status: 200,
                    body: {
                      candidates: [
                        {
                          content: {
                            role: 'model',
                            parts: [{ text: makeGroundedLiveJson(alertState) }],
                          },
                          finishReason: 'STOP',
                        },
                      ],
                      usageMetadata: {
                        promptTokenCount: 1_000,
                        candidatesTokenCount: 100,
                        thoughtsTokenCount: 0,
                        totalTokenCount: 1_100,
                      },
                    },
                  });
                } else {
                  reject(new Error('Late network socket failure'));
                }
              }, 900);
            }),
        });

      for (const mode of ['resolve', 'reject', 'never'] as const) {
        await testEnv.clearFirestore();
        const startedAt = Date.now();
        const res = await executeAnalyzeIncident(
          {
            incidentId: scenario.incidentId,
            scenarioVersion: scenario.scenarioVersion,
            checkpoint: 'alert',
            selectedInterventionId: null,
            requestId: `req-p3b-timeout-${mode}`,
          },
          makeAuth(`visitor-p3b-timeout-${mode}`),
          { db, provider: makeHangingProvider(mode), clock, providerDeadlineMs: 25 },
        );
        expect(Date.now() - startedAt).toBeLessThan(700);
        expect(res.status).toBe('timeout');
        expect(res.reasonCode).toBe('provider_deadline_exceeded');
        if (mode !== 'never') {
          await new Promise((resolve) => setTimeout(resolve, 950));
        }
        const cacheDoc = (
          await db.collection(FIRESTORE_COLLECTIONS.analysisCache).doc(alertState.cacheDocId).get()
        ).data();
        expect(cacheDoc?.status).toBe('cooldown');
        expect(cacheDoc?.result).toBeUndefined();
        const monthDoc = (
          await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
        ).data();
        expect(monthDoc?.actualSpendMicros).toBe(7_400);
        expect(monthDoc?.reservedSpendMicros).toBe(0);
      }

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('enforces pre-generation :countTokens gates, malformed/oversized/exact-boundary responses, timeouts, mutation checks, and unclamped overrun accounting in Firestore', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const nowMs = Date.UTC(2026, 10, 14, 20, 0, 0);
      const clock = { nowMs: () => nowMs };
      const monthKey = getUtcMonthKey(nowMs);
      const scenario = ALL_SCENARIOS[0]!;
      const alertState = reconstructCanonicalState(scenario, 'alert', null, {
        modelVersion: DEFAULT_LIVE_MODEL_VERSION,
      });

      // 1. Pre-generation countTokens HTTP 503 failure never invokes paid transport and refunds full 7,400 microUSD
      await testEnv.clearFirestore();
      let paidCalls = 0;
      const countFailProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () => ({
          status: 503,
          body: { error: { message: 'countTokens unavailable' } },
        }),
        transport: async () => {
          paidCalls += 1;
          return { status: 200, body: {} };
        },
      });
      const countFailRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-p3b-closeout-count-503',
        },
        makeAuth('visitor-p3b-closeout-1'),
        { db, provider: countFailProvider, clock },
      );
      expect(paidCalls).toBe(0);
      expect(countFailRes.status).toBe('unavailable');
      expect(countFailRes.reasonCode).toBe('count_tokens_failed');
      const monthAfterCount503 = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterCount503?.actualSpendMicros).toBe(0);
      expect(monthAfterCount503?.reservedSpendMicros).toBe(0);
      expect(monthAfterCount503?.committedSpendMicros).toBe(0);
      const attemptsAfter503 = await db.collection(FIRESTORE_COLLECTIONS.generationAttempts).get();
      expect(attemptsAfter503.size).toBe(1);
      expect(attemptsAfter503.docs[0]?.data()?.chargedCostMicros).toBe(0);
      expect(attemptsAfter503.docs[0]?.data()?.refundedCostMicros).toBe(7_400);

      // 2. Malformed countTokens response ({}) never invokes paid transport and refunds 7,400 microUSD
      await testEnv.clearFirestore();
      const malformedCountProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () => ({
          status: 200,
          body: {},
        }),
        transport: async () => {
          paidCalls += 1;
          return { status: 200, body: {} };
        },
      });
      const malformedCountRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-p3b-closeout-count-malformed',
        },
        makeAuth('visitor-p3b-closeout-1b'),
        { db, provider: malformedCountProvider, clock },
      );
      expect(paidCalls).toBe(0);
      expect(malformedCountRes.status).toBe('unavailable');
      expect(malformedCountRes.reasonCode).toBe('count_tokens_unverified');
      const monthAfterMalformed = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterMalformed?.actualSpendMicros).toBe(0);
      expect(monthAfterMalformed?.reservedSpendMicros).toBe(0);
      expect(monthAfterMalformed?.committedSpendMicros).toBe(0);

      // 3. Oversized pre-generation countTokens (8,001 > 8,000) never invokes paid transport and refunds 7,400 microUSD
      await testEnv.clearFirestore();
      const oversizedProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () => ({
          status: 200,
          body: { totalTokens: 8_001 },
        }),
        transport: async () => {
          paidCalls += 1;
          return { status: 200, body: {} };
        },
      });
      const oversizedRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-p3b-closeout-oversized',
        },
        makeAuth('visitor-p3b-closeout-2'),
        { db, provider: oversizedProvider, clock },
      );
      expect(paidCalls).toBe(0);
      expect(oversizedRes.status).toBe('unavailable');
      expect(oversizedRes.reasonCode).toBe('input_token_limit_exceeded');
      const monthAfterOversized = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterOversized?.actualSpendMicros).toBe(0);
      expect(monthAfterOversized?.reservedSpendMicros).toBe(0);
      expect(monthAfterOversized?.committedSpendMicros).toBe(0);
      const attemptsAfterOversized = await db
        .collection(FIRESTORE_COLLECTIONS.generationAttempts)
        .get();
      expect(attemptsAfterOversized.size).toBe(1);
      expect(attemptsAfterOversized.docs[0]?.data()?.chargedCostMicros).toBe(0);
      expect(attemptsAfterOversized.docs[0]?.data()?.refundedCostMicros).toBe(7_400);

      // 4. Exact-boundary countTokens (8,000) proceeds to paid generation and reconciles exact usage (2,900 microUSD)
      await testEnv.clearFirestore();
      const exactBoundaryProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () => ({
          status: 200,
          body: { totalTokens: 8_000 },
        }),
        transport: async () => {
          paidCalls += 1;
          return {
            status: 200,
            body: {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: makeGroundedLiveJson(alertState) }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 8_000,
                candidatesTokenCount: 150,
                thoughtsTokenCount: 50,
                totalTokenCount: 8_200,
              },
            },
          };
        },
      });
      const exactBoundaryRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-p3b-closeout-exact-8000',
        },
        makeAuth('visitor-p3b-closeout-2b'),
        { db, provider: exactBoundaryProvider, clock },
      );
      expect(paidCalls).toBe(1);
      expect(exactBoundaryRes.status).toBe('ok');
      const monthAfterExact = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterExact?.actualSpendMicros).toBe(2_900);
      expect(monthAfterExact?.reservedSpendMicros).toBe(0);

      // 5. Post-counting request mutation fails pre-generation integrity check and refunds 7,400 microUSD
      await testEnv.clearFirestore();
      const tamperedProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () => ({ status: 200, body: { totalTokens: 3_500 } }),
        beforePaidGenerationHook: (prepared) => {
          prepared.generateContentRequest.serializedBody = '{"tampered":true}';
        },
        transport: async () => {
          paidCalls += 1;
          return { status: 200, body: {} };
        },
      });
      const tamperedRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-p3b-closeout-tampered',
        },
        makeAuth('visitor-p3b-closeout-3'),
        { db, provider: tamperedProvider, clock },
      );
      expect(paidCalls).toBe(1);
      expect(tamperedRes.status).toBe('unavailable');
      expect(tamperedRes.reasonCode).toBe('request_content_changed');
      const monthAfterTamper = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterTamper?.actualSpendMicros).toBe(0);
      expect(monthAfterTamper?.reservedSpendMicros).toBe(0);
      expect(monthAfterTamper?.committedSpendMicros).toBe(0);
      const attemptsAfterTamper = await db
        .collection(FIRESTORE_COLLECTIONS.generationAttempts)
        .get();
      expect(attemptsAfterTamper.size).toBe(1);
      expect(attemptsAfterTamper.docs[0]?.data()?.chargedCostMicros).toBe(0);
      expect(attemptsAfterTamper.docs[0]?.data()?.refundedCostMicros).toBe(7_400);

      // 6. Uncooperative countTokens ignoring AbortSignal enforces deadline cleanly, never calls paid transport, retains 7,400 microUSD
      await testEnv.clearFirestore();
      const hangingCountProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                status: 200,
                body: { totalTokens: 3_500 },
              });
            }, 900);
          }),
        transport: async () => {
          paidCalls += 1;
          return { status: 200, body: {} };
        },
      });
      const countTimeoutStart = Date.now();
      const countTimeoutRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-p3b-closeout-count-timeout',
        },
        makeAuth('visitor-p3b-closeout-4'),
        { db, provider: hangingCountProvider, clock, providerDeadlineMs: 25 },
      );
      expect(Date.now() - countTimeoutStart).toBeLessThan(700);
      expect(countTimeoutRes.status).toBe('timeout');
      expect(countTimeoutRes.reasonCode).toBe('provider_deadline_exceeded');
      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(paidCalls).toBe(1);
      const monthAfterCountTimeout = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterCountTimeout?.actualSpendMicros).toBe(7_400);
      expect(monthAfterCountTimeout?.reservedSpendMicros).toBe(0);
      expect(monthAfterCountTimeout?.committedSpendMicros).toBe(7_400);
      const attemptsAfterCountTimeout = await db
        .collection(FIRESTORE_COLLECTIONS.generationAttempts)
        .get();
      expect(attemptsAfterCountTimeout.size).toBe(1);
      expect(attemptsAfterCountTimeout.docs[0]?.data()?.chargedCostMicros).toBe(7_400);
      expect(attemptsAfterCountTimeout.docs[0]?.data()?.refundedCostMicros).toBe(0);

      // 7. Unexpected provider usage overrun (> 7,400 worst-case reservation) is recorded unclamped (10,500 microUSD)
      await testEnv.clearFirestore();
      const overrunProvider = new GeminiModelProvider({
        apiKey: 'emu-test-key',
        countTokensTransport: async () => ({ status: 200, body: { totalTokens: 3_500 } }),
        transport: async () => {
          paidCalls += 1;
          return {
            status: 200,
            body: {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: makeGroundedLiveJson(alertState) }],
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
          };
        },
      });
      const overrunRes = await executeAnalyzeIncident(
        {
          incidentId: scenario.incidentId,
          scenarioVersion: scenario.scenarioVersion,
          checkpoint: 'alert',
          selectedInterventionId: null,
          requestId: 'req-p3b-closeout-overrun',
        },
        makeAuth('visitor-p3b-closeout-5'),
        { db, provider: overrunProvider, clock },
      );
      expect(paidCalls).toBe(2);
      expect(overrunRes.status).toBe('unavailable');
      expect(overrunRes.reasonCode).toBe('provider_error');
      const monthAfterOverrun = (
        await db.collection(FIRESTORE_COLLECTIONS.quotaMonths).doc(monthKey).get()
      ).data();
      expect(monthAfterOverrun?.actualSpendMicros).toBe(10_500);
      expect(monthAfterOverrun?.reservedSpendMicros).toBe(0);
      expect(monthAfterOverrun?.committedSpendMicros).toBe(10_500);
      const attemptsAfterOverrun = await db
        .collection(FIRESTORE_COLLECTIONS.generationAttempts)
        .get();
      expect(attemptsAfterOverrun.size).toBe(1);
      expect(attemptsAfterOverrun.docs[0]?.data()?.chargedCostMicros).toBe(10_500);
      expect(attemptsAfterOverrun.docs[0]?.data()?.refundedCostMicros).toBe(0);

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
