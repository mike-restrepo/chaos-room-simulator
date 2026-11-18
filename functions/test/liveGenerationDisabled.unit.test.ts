import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { ALL_SCENARIOS, ENGINE_VERSION } from '@chaos-room/shared';
import { admitRequestTransaction } from '../src/accountingStore.js';
import { reconstructCanonicalState } from '../src/reconstruction.js';
import { FIRESTORE_COLLECTIONS, SYSTEM_CONTROL_DOC_ID } from '../src/config.js';
import type { AnalysisResult } from '../src/types.js';

interface MockDocData {
  exists: boolean;
  data?: Record<string, unknown>;
}

class InMemoryMockFirestore {
  private docs = new Map<string, Record<string, unknown>>();
  public recordedSets: Array<{ path: string; data: Record<string, unknown>; options?: unknown }> = [];

  public setDoc(path: string, data: Record<string, unknown>) {
    this.docs.set(path, JSON.parse(JSON.stringify(data)));
  }

  public getDoc(path: string): Record<string, unknown> | undefined {
    const raw = this.docs.get(path);
    return raw ? JSON.parse(JSON.stringify(raw)) : undefined;
  }

  public collection(colName: string) {
    return {
      doc: (docId: string) => {
        const fullPath = `${colName}/${docId}`;
        return {
          id: docId,
          path: fullPath,
        };
      },
    };
  }

  public async runTransaction<T>(
    updateFunction: (tx: {
      get: (ref: { path: string }) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
      set: (ref: { path: string }, data: Record<string, unknown>, options?: unknown) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const tx = {
      get: async (ref: { path: string }) => {
        const data = this.getDoc(ref.path);
        return {
          exists: data !== undefined,
          data: () => data,
        };
      },
      set: (ref: { path: string }, data: Record<string, unknown>, options?: unknown) => {
        this.recordedSets.push({ path: ref.path, data: JSON.parse(JSON.stringify(data)), options });
        const existing = this.docs.get(ref.path) ?? {};
        if (options && typeof options === 'object' && 'merge' in options && options.merge) {
          this.docs.set(ref.path, { ...existing, ...data });
        } else {
          this.docs.set(ref.path, JSON.parse(JSON.stringify(data)));
        }
      },
    };

    return updateFunction(tx);
  }
}

describe('Server-enforced liveGenerationDisabled control & cache hit guarantees', () => {
  const scenario = ALL_SCENARIOS[0]!;
  const state = reconstructCanonicalState(scenario, 'alert', null, {
    modelVersion: 'gemini-3.5-flash-lite',
    promptVersion: '1.0.0',
    schemaVersion: '1.0.0',
  });

  const nowMs = 1794870000000;
  const visitorUid = 'test-visitor-123';
  const requestPayloadHash = 'hash-abc-123';

  const validAlertResult: AnalysisResult = {
    incidentId: 'incident-001',
    scenarioVersion: '1.0.0',
    checkpoint: 'alert',
    selectedInterventionId: null,
    sourceMode: 'preview_cached_ai',
    sourceBadgeLabel: 'Shared cached AI analysis (Gemini)',
    isPreviewMock: false,
    modelVersion: 'gemini-3.5-flash-lite',
    promptVersion: '1.0.0',
    generatedAtIso: new Date(nowMs - 60_000).toISOString(),
    conciseAssessment: 'Alert checkpoint with database connection saturation.',
    observedFacts: [
      { text: 'Active connections climbed to 94.', citationIds: ['ev-met-180'] },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement: 'Connection pool saturation caused by leak.',
        likelihood: 'Primary',
        supportingCitationIds: ['ev-met-180'],
      },
    ],
    alternativeExplanations: [
      {
        explanation: 'Traffic spike.',
        whyLessLikely: 'DB CPU remains low.',
        citationIds: ['ev-met-180'],
      },
    ],
    missingInformation: ['Detailed connection pool metrics.'],
    confidence: { level: 'High', justification: 'Direct telemetry correlation.' },
    recommendedInterventions: [],
    verificationChecks: ['Check connection pool metrics.'],
    stakeholderUpdate: 'Investigation underway.',
  };

  const createReadyCacheDoc = () => ({
    status: 'ready',
    cacheKey: state.cacheKey,
    expiresAtMs: nowMs + 86400_000, // 24h in future
    generatedAtMs: nowMs - 60_000,
    result: validAlertResult,
    isMockProvider: false,
  });

  it('proves master kill switch (aiDisabled: true) overrides cache access and returns ai_disabled immediately', async () => {
    const mockDb = new InMemoryMockFirestore();
    // System control has aiDisabled: true
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.systemControl}/${SYSTEM_CONTROL_DOC_ID}`, {
      aiDisabled: true,
      reason: 'Emergency system shutdown',
    });
    // Cache has ready valid document
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.analysisCache}/${state.cacheDocId}`, createReadyCacheDoc());

    const admission = await admitRequestTransaction(mockDb as unknown as Firestore, {
      visitorUid,
      requestId: 'req-001',
      requestPayloadHash,
      state,
      nowMs,
      leaseId: 'lease-001',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: false,
    });

    expect(admission.decision).toBe('disabled');
    expect(admission.response.status).toBe('disabled');
    expect(admission.response.reasonCode).toBe('ai_disabled');
    expect(admission.response.message).toContain('Emergency system shutdown');
    expect(admission.response.cacheHit).toBe(false);
    // Zero mutations allowed on master shutdown
    expect(mockDb.recordedSets.length).toBe(0);
  });

  it('permits valid cache retrieval when aiDisabled: false and liveGenerationDisabled: true, with zero generation or spend reservation', async () => {
    const mockDb = new InMemoryMockFirestore();
    // Live generation disabled, but overall AI enabled
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.systemControl}/${SYSTEM_CONTROL_DOC_ID}`, {
      aiDisabled: false,
      liveGenerationDisabled: true,
      reason: 'Live generation paused for smoke test',
    });
    // Valid ready cache document present
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.analysisCache}/${state.cacheDocId}`, createReadyCacheDoc());
    // Initial quota ledger
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`, {
      monthKey: '2026-11',
      attempts: 18,
      actualSpendMicros: 55987,
      reservedSpendMicros: 0,
      committedSpendMicros: 55987,
    });

    const admission = await admitRequestTransaction(mockDb as unknown as Firestore, {
      visitorUid,
      requestId: 'req-cache-hit-002',
      requestPayloadHash,
      state,
      nowMs,
      leaseId: 'lease-002',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: false,
    });

    expect(admission.decision).toBe('cache_hit');
    expect(admission.response.status).toBe('cached');
    expect(admission.response.cacheHit).toBe(true);
    expect(admission.response.result).toBeDefined();
    expect(admission.response.result?.conciseAssessment).toBe(validAlertResult.conciseAssessment);

    // Verify generation attempts and spend reservation documents remain completely untouched!
    const monthDoc = mockDb.getDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`);
    expect(monthDoc?.attempts).toBe(18);
    expect(monthDoc?.actualSpendMicros).toBe(55987);
    expect(monthDoc?.reservedSpendMicros).toBe(0);

    // Verify no generation lease was created
    expect(mockDb.getDoc(`${FIRESTORE_COLLECTIONS.generationAttempts}/lease-002`)).toBeUndefined();
  });

  it('strictly rejects cache miss when liveGenerationDisabled: true before acquiring lease or reserving spend', async () => {
    const mockDb = new InMemoryMockFirestore();
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.systemControl}/${SYSTEM_CONTROL_DOC_ID}`, {
      aiDisabled: false,
      liveGenerationDisabled: true,
      reason: 'Live generation is paused by operator control',
    });
    // Cache is EMPTY (cache miss)
    // Month quota doc initialized
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`, {
      monthKey: '2026-11',
      attempts: 18,
      actualSpendMicros: 55987,
      reservedSpendMicros: 0,
      committedSpendMicros: 55987,
    });

    const admission = await admitRequestTransaction(mockDb as unknown as Firestore, {
      visitorUid,
      requestId: 'req-miss-003',
      requestPayloadHash,
      state,
      nowMs,
      leaseId: 'lease-003',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: false,
    });

    expect(admission.decision).toBe('disabled');
    expect(admission.response.status).toBe('disabled');
    expect(admission.response.reasonCode).toBe('live_generation_disabled');
    expect(admission.response.message).toContain('Live generation is paused by operator control');
    expect(admission.response.cacheHit).toBe(false);

    // Assert that generation ledger and attempts remain strictly UNCHANGED
    const monthDoc = mockDb.getDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`);
    expect(monthDoc?.attempts).toBe(18);
    expect(monthDoc?.actualSpendMicros).toBe(55987);
    expect(monthDoc?.reservedSpendMicros).toBe(0);

    // Assert NO generation lease was written to generationAttempts or cacheRef
    expect(mockDb.getDoc(`${FIRESTORE_COLLECTIONS.generationAttempts}/lease-003`)).toBeUndefined();
    expect(mockDb.getDoc(`${FIRESTORE_COLLECTIONS.analysisCache}/${state.cacheDocId}`)).toBeUndefined();
  });

  it('strictly rejects expired cache when liveGenerationDisabled: true without generating', async () => {
    const mockDb = new InMemoryMockFirestore();
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.systemControl}/${SYSTEM_CONTROL_DOC_ID}`, {
      aiDisabled: false,
      liveGenerationDisabled: true,
    });
    // Expired cache doc (expiresAtMs is in the past)
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.analysisCache}/${state.cacheDocId}`, {
      ...createReadyCacheDoc(),
      expiresAtMs: nowMs - 1000,
    });
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`, {
      monthKey: '2026-11',
      attempts: 18,
      actualSpendMicros: 55987,
      reservedSpendMicros: 0,
    });

    const admission = await admitRequestTransaction(mockDb as unknown as Firestore, {
      visitorUid,
      requestId: 'req-expired-004',
      requestPayloadHash,
      state,
      nowMs,
      leaseId: 'lease-004',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: false,
    });

    expect(admission.decision).toBe('disabled');
    expect(admission.response.status).toBe('disabled');
    expect(admission.response.reasonCode).toBe('live_generation_disabled');

    const monthDoc = mockDb.getDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`);
    expect(monthDoc?.attempts).toBe(18);
    expect(monthDoc?.reservedSpendMicros).toBe(0);
    expect(mockDb.getDoc(`${FIRESTORE_COLLECTIONS.generationAttempts}/lease-004`)).toBeUndefined();
  });

  it('strictly rejects invalid/corrupted cache when liveGenerationDisabled: true without generating', async () => {
    const mockDb = new InMemoryMockFirestore();
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.systemControl}/${SYSTEM_CONTROL_DOC_ID}`, {
      aiDisabled: false,
      liveGenerationDisabled: true,
    });
    // Invalid cache doc (status: 'error')
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.analysisCache}/${state.cacheDocId}`, {
      status: 'error',
      cacheKey: state.cacheKey,
      expiresAtMs: nowMs + 86400_000,
    });
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`, {
      monthKey: '2026-11',
      attempts: 18,
      actualSpendMicros: 55987,
      reservedSpendMicros: 0,
    });

    const admission = await admitRequestTransaction(mockDb as unknown as Firestore, {
      visitorUid,
      requestId: 'req-invalid-005',
      requestPayloadHash,
      state,
      nowMs,
      leaseId: 'lease-005',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: false,
    });

    expect(admission.decision).toBe('disabled');
    expect(admission.response.status).toBe('disabled');
    expect(admission.response.reasonCode).toBe('live_generation_disabled');

    const monthDoc = mockDb.getDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`);
    expect(monthDoc?.attempts).toBe(18);
    expect(monthDoc?.reservedSpendMicros).toBe(0);
    expect(mockDb.getDoc(`${FIRESTORE_COLLECTIONS.generationAttempts}/lease-005`)).toBeUndefined();
  });

  it('allows generation when liveGenerationDisabled: false and cache is missing', async () => {
    const mockDb = new InMemoryMockFirestore();
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.systemControl}/${SYSTEM_CONTROL_DOC_ID}`, {
      aiDisabled: false,
      liveGenerationDisabled: false,
    });
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.quotaMonths}/2026-11`, {
      monthKey: '2026-11',
      attempts: 18,
      actualSpendMicros: 55987,
      reservedSpendMicros: 0,
      committedSpendMicros: 55987,
    });

    const admission = await admitRequestTransaction(mockDb as unknown as Firestore, {
      visitorUid,
      requestId: 'req-gen-006',
      requestPayloadHash,
      state,
      nowMs,
      leaseId: 'lease-006',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: false,
      worstCaseReservationMicros: 7400,
    });

    expect(admission.decision).toBe('generate');
    if (admission.decision === 'generate') {
      expect(admission.lease.leaseId).toBe('lease-006');
      expect(admission.lease.reservedCostMicros).toBe(7400);
    }
  });

  it('preserves idempotency and replays existing completed request without re-evaluating generation guards', async () => {
    const mockDb = new InMemoryMockFirestore();
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.systemControl}/${SYSTEM_CONTROL_DOC_ID}`, {
      aiDisabled: false,
      liveGenerationDisabled: true,
    });
    // Existing completed request record
    mockDb.setDoc(`${FIRESTORE_COLLECTIONS.requestRecords}/req-existing-007`, {
      requestId: 'req-existing-007',
      visitorUid,
      requestPayloadHash,
      status: 'completed',
      cacheKey: state.cacheKey,
      cacheDocId: state.cacheDocId,
      modelVersion: state.modelVersion,
      promptVersion: state.promptVersion,
      schemaVersion: state.schemaVersion,
      packetSha256: state.packetSha256,
      responseExpiresAtMs: nowMs + 86400_000,
      createdAtMs: nowMs - 1000,
      updatedAtMs: nowMs - 1000,
      response: {
        status: 'cached',
        incidentId: 'incident-001',
        checkpoint: 'alert',
        selectedInterventionId: null,
        cacheHit: true,
        isMockProvider: false,
        cacheKey: state.cacheKey,
        serverTimeIso: new Date(nowMs - 1000).toISOString(),
        result: validAlertResult,
      },
    });

    const admission = await admitRequestTransaction(mockDb as unknown as Firestore, {
      visitorUid,
      requestId: 'req-existing-007',
      requestPayloadHash,
      state,
      nowMs,
      leaseId: 'lease-007',
      isEvaluation: false,
      envAiDisabled: false,
      isMockProvider: false,
    });

    expect(admission.decision).toBe('duplicate_completed');
    expect(admission.response.status).toBe('cached');
  });
});
