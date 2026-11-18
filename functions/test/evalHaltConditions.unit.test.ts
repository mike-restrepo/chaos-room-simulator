import { describe, expect, it } from 'vitest';
import { ALL_SCENARIOS } from '@chaos-room/shared';
import {
  assertEvaluationHaltConditions,
  EvaluationHaltError,
  validateSnapshotStructuralCompliance,
} from '../src/evalHaltConditions.js';
import { reconstructCanonicalState } from '../src/reconstruction.js';
import type { AnalysisResult } from '../src/types.js';

describe('Evaluation Fail-Closed Stopping Conditions & Structural Snapshot Validation', () => {
  const scenario = ALL_SCENARIOS[0]!;
  const alertState = reconstructCanonicalState(scenario, 'alert', null);
  const evidenceState = reconstructCanonicalState(scenario, 'evidence', null);

  const validAlertResult: AnalysisResult = {
    incidentId: 'incident-001',
    scenarioVersion: '1.0.0',
    checkpoint: 'alert',
    selectedInterventionId: null,
    sourceMode: 'preview_cached_ai',
    sourceBadgeLabel: 'AI analysis (generated live)',
    isPreviewMock: false,
    modelVersion: 'gemini-3.5-flash-lite',
    promptVersion: '1.0.0',
    generatedAtIso: new Date().toISOString(),
    conciseAssessment: 'Alert checkpoint active with database connection saturation.',
    observedFacts: [
      { text: 'Active connections climbed to 94.', citationIds: ['ev-met-180'] },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement: 'Connection pool saturation.',
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
    recommendedInterventions: [], // Strictly empty on Alert
    verificationChecks: ['Check connection pool metrics.'],
    stakeholderUpdate: 'Investigation underway.',
  };

  const validTokens = {
    countTotalTokens: 1273,
    promptTokenCount: 1273,
    candidatesTokenCount: 882,
    totalTokenCount: 2155,
  };

  const validAttemptDoc = {
    reconciled: true,
    status: 'ok',
    chargedCostMicros: 2587,
    reservedCostMicros: 7400,
    refundedCostMicros: 4813,
  };

  it('passes cleanly when output is valid, token counts match 1:1, accounting is exact, and citations belong to snapshot', () => {
    expect(() =>
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-01',
        response: { status: 'ok', result: validAlertResult },
        tokens: validTokens,
        attemptDoc: validAttemptDoc,
        state: alertState,
      }),
    ).not.toThrow();
  });

  // 1. Unsuccessful output stopping condition
  it('fails closed on unsuccessful output (error, timeout, or missing result)', () => {
    expect(() =>
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-error',
        response: { status: 'error', message: 'Internal provider failure' },
        tokens: validTokens,
        attemptDoc: validAttemptDoc,
        state: alertState,
      }),
    ).toThrowError(EvaluationHaltError);

    try {
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-error',
        response: { status: 'timeout' },
        tokens: validTokens,
        attemptDoc: validAttemptDoc,
        state: alertState,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluationHaltError);
      expect((err as EvaluationHaltError).code).toBe('UNSUCCESSFUL_OUTPUT');
    }
  });

  // 2. Missing token counts stopping condition
  it('fails closed when any token usage count is null or undefined', () => {
    const missingFields: Array<keyof typeof validTokens> = [
      'countTotalTokens',
      'promptTokenCount',
      'candidatesTokenCount',
      'totalTokenCount',
    ];

    for (const field of missingFields) {
      const incompleteTokens = { ...validTokens, [field]: null };
      expect(() =>
        assertEvaluationHaltConditions({
          evalRunId: `test-eval-missing-${field}`,
          response: { status: 'ok', result: validAlertResult },
          tokens: incompleteTokens,
          attemptDoc: validAttemptDoc,
          state: alertState,
        }),
      ).toThrowError(/incomplete token usage metadata/);
    }
  });

  // 3. Token ceiling breach stopping condition
  it('fails closed when promptTokenCount exceeds the 8,000 token ceiling', () => {
    const oversizedTokens = {
      countTotalTokens: 8001,
      promptTokenCount: 8001,
      candidatesTokenCount: 500,
      totalTokenCount: 8501,
    };

    try {
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-ceiling',
        response: { status: 'ok', result: validAlertResult },
        tokens: oversizedTokens,
        attemptDoc: validAttemptDoc,
        state: alertState,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluationHaltError);
      expect((err as EvaluationHaltError).code).toBe('TOKEN_CEILING_BREACH');
    }
  });

  // 4. Token discrepancy stopping condition
  it('fails closed on token discrepancy (promptTokenCount !== countTotalTokens)', () => {
    const divergentTokens = {
      countTotalTokens: 1273,
      promptTokenCount: 1350, // Divergence (e.g. uncounted schema tokens)
      candidatesTokenCount: 882,
      totalTokenCount: 2232,
    };

    try {
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-discrepancy',
        response: { status: 'ok', result: validAlertResult },
        tokens: divergentTokens,
        attemptDoc: validAttemptDoc,
        state: alertState,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluationHaltError);
      expect((err as EvaluationHaltError).code).toBe('TOKEN_DISCREPANCY');
      expect((err as EvaluationHaltError).details.diff).toBe(77);
    }
  });

  // 5. Accounting discrepancy stopping condition
  it('fails closed when attempt doc is missing, un-reconciled, non-ok, or math is inconsistent', () => {
    // Missing attempt doc
    expect(() =>
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-no-doc',
        response: { status: 'ok', result: validAlertResult },
        tokens: validTokens,
        attemptDoc: undefined,
        state: alertState,
      }),
    ).toThrowError(/generationAttempt document was not found/);

    // Un-reconciled
    expect(() =>
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-unreconciled',
        response: { status: 'ok', result: validAlertResult },
        tokens: validTokens,
        attemptDoc: { ...validAttemptDoc, reconciled: false },
        state: alertState,
      }),
    ).toThrowError(/was not reconciled/);

    // Non-ok status
    expect(() =>
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-status-error',
        response: { status: 'ok', result: validAlertResult },
        tokens: validTokens,
        attemptDoc: { ...validAttemptDoc, status: 'error' },
        state: alertState,
      }),
    ).toThrowError(/status is "error"/);

    // Math mismatch: charged (2587) + refunded (4000) !== reserved (7400)
    expect(() =>
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-math-error',
        response: { status: 'ok', result: validAlertResult },
        tokens: validTokens,
        attemptDoc: { ...validAttemptDoc, refundedCostMicros: 4000 },
        state: alertState,
      }),
    ).toThrowError(/accounting equation breach/);
  });

  // 6. Structural snapshot compliance & leakage distinction
  it('fails closed when citations reference evidence outside the canonical snapshot', () => {
    const invalidCitationResult: AnalysisResult = {
      ...validAlertResult,
      observedFacts: [
        { text: 'Fact citing phantom evidence.', citationIds: ['ev-phantom-999'] },
      ],
    };

    const structural = validateSnapshotStructuralCompliance(invalidCitationResult, alertState);
    expect(structural.valid).toBe(false);
    expect(structural.errors[0]).toContain('ev-phantom-999');

    expect(() =>
      assertEvaluationHaltConditions({
        evalRunId: 'test-eval-invalid-citation',
        response: { status: 'ok', result: invalidCitationResult },
        tokens: validTokens,
        attemptDoc: validAttemptDoc,
        state: alertState,
      }),
    ).toThrowError(/failed structural snapshot validation/);
  });

  it('fails closed when Alert checkpoint illegally recommends interventions', () => {
    const alertWithInterventions: AnalysisResult = {
      ...validAlertResult,
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-drain',
          rationale: 'Premature recommendation at Alert.',
          keyRisk: 'Premature.',
        },
      ],
    };

    const structural = validateSnapshotStructuralCompliance(alertWithInterventions, alertState);
    expect(structural.valid).toBe(false);
    expect(structural.errors[0]).toContain('Alert checkpoint recommends 1 interventions');
  });

  it('validates evidence checkpoint interventions against visible interventions in canonical snapshot', () => {
    const validEvidenceResult: AnalysisResult = {
      ...validAlertResult,
      checkpoint: 'evidence',
      observedFacts: [
        { text: 'Fact from log.', citationIds: ['ev-log-270'] },
      ],
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-drain',
          rationale: 'Rollback recommended at evidence checkpoint.',
          keyRisk: 'Brief drain delay.',
        },
      ],
    };

    const validCheck = validateSnapshotStructuralCompliance(validEvidenceResult, evidenceState);
    expect(validCheck.valid).toBe(true);

    const invalidActResult: AnalysisResult = {
      ...validEvidenceResult,
      recommendedInterventions: [
        {
          interventionId: 'act-invented-action-xyz',
          rationale: 'Invented action not in scenario.',
          keyRisk: 'None.',
        },
      ],
    };

    const invalidCheck = validateSnapshotStructuralCompliance(invalidActResult, evidenceState);
    expect(invalidCheck.valid).toBe(false);
    expect(invalidCheck.errors[0]).toContain('act-invented-action-xyz');
  });

  it('explicitly distinguishes structural citation compliance from semantic review of future-outcome disclosures', () => {
    // A structurally valid result can theoretically contain semantic disclosures in prose.
    // Structural checks verify ID membership and schema bounds; semantic review requires analyzing prose disclosures.
    const structurallyValidResult: AnalysisResult = {
      ...validAlertResult,
      conciseAssessment:
        'Reservations are failing. (Hypothetically disclosing future root cause prematurely without citing future evidence).',
    };

    const structuralCheck = validateSnapshotStructuralCompliance(structurallyValidResult, alertState);
    expect(structuralCheck.valid).toBe(true);
    // Structural compliance passes because citations and schema are valid,
    // demonstrating that structural compliance and semantic disclosure review are orthogonal guarantees.
  });
});
