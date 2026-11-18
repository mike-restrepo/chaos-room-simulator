import type { AnalysisResult } from '@chaos-room/shared';
import type { ReconstructedState } from './types.js';

export type EvaluationHaltCode =
  | 'UNSUCCESSFUL_OUTPUT'
  | 'MISSING_TOKEN_COUNTS'
  | 'TOKEN_DISCREPANCY'
  | 'TOKEN_CEILING_BREACH'
  | 'ACCOUNTING_DISCREPANCY'
  | 'STRUCTURAL_VALIDATION_FAILURE';

export class EvaluationHaltError extends Error {
  public readonly code: EvaluationHaltCode;
  public readonly details: Record<string, unknown>;

  constructor(code: EvaluationHaltCode, message: string, details: Record<string, unknown> = {}) {
    super(`[EvaluationHaltError:${code}] ${message}`);
    this.name = 'EvaluationHaltError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, EvaluationHaltError.prototype);
  }
}

export interface StoppingEvaluationResponse {
  status: string;
  result?: AnalysisResult;
  message?: string;
}

export interface StoppingTokenMetadata {
  countTotalTokens: number | null | undefined;
  promptTokenCount: number | null | undefined;
  candidatesTokenCount: number | null | undefined;
  totalTokenCount: number | null | undefined;
}

export interface StoppingAttemptDoc {
  reconciled?: boolean;
  status?: string;
  chargedCostMicros?: number;
  reservedCostMicros?: number;
  refundedCostMicros?: number;
}

export interface EvaluationStoppingParams {
  evalRunId: string;
  response: StoppingEvaluationResponse;
  tokens: StoppingTokenMetadata;
  attemptDoc?: StoppingAttemptDoc;
  expectedWorstCaseMicros?: number;
  state?: ReconstructedState;
  maxInputTokenCeiling?: number;
}

/**
 * Validates structural compliance of citations and interventions against the canonical snapshot.
 * Note: Structural compliance validates visible citation IDs and checkpoint-gated intervention rules;
 * it distinguishes structural integrity from semantic review of future-outcome disclosures.
 */
export function validateSnapshotStructuralCompliance(
  result: AnalysisResult,
  state: ReconstructedState,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const validEvIds = new Set(state.packet.visibleEvidence.map((e: { id: string }) => e.id));
  const validActIds = new Set(state.packet.visibleInterventions.map((a: { id: string }) => a.id));

  // 1. Evidence citations
  for (const fact of result.observedFacts || []) {
    for (const cid of fact.citationIds || []) {
      if (!validEvIds.has(cid)) {
        errors.push(`observedFact cites invisible evidence ID: ${cid}`);
      }
    }
  }
  for (const hyp of result.rankedHypotheses || []) {
    for (const cid of hyp.supportingCitationIds || []) {
      if (!validEvIds.has(cid)) {
        errors.push(`rankedHypothesis cites invisible evidence ID: ${cid}`);
      }
    }
  }
  for (const alt of result.alternativeExplanations || []) {
    for (const cid of alt.citationIds || []) {
      if (!validEvIds.has(cid)) {
        errors.push(`alternativeExplanation cites invisible evidence ID: ${cid}`);
      }
    }
  }

  // 2. Recommended interventions
  const recActs = result.recommendedInterventions || [];
  if (state.checkpoint === 'alert') {
    if (recActs.length > 0) {
      errors.push(`Alert checkpoint recommends ${recActs.length} interventions (must be 0)`);
    }
  } else {
    for (const act of recActs) {
      if (!validActIds.has(act.interventionId)) {
        errors.push(`Recommended intervention not in visibleInterventions: ${act.interventionId}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates all fail-closed stopping conditions for calibration and evaluation runs.
 * Throws EvaluationHaltError immediately upon any violation.
 */
export function assertEvaluationHaltConditions(params: EvaluationStoppingParams): void {
  const {
    evalRunId,
    response,
    tokens,
    attemptDoc,
    expectedWorstCaseMicros = 7400,
    state,
    maxInputTokenCeiling = 8000,
  } = params;

  // 1. Unsuccessful output check
  if (response.status !== 'ok' || !response.result) {
    throw new EvaluationHaltError(
      'UNSUCCESSFUL_OUTPUT',
      `Evaluation ${evalRunId} failed with status="${response.status}": ${response.message ?? 'missing result'}`,
      { evalRunId, status: response.status, message: response.message },
    );
  }

  // 2. Missing token counts check (fail-closed on null or undefined)
  if (
    tokens.countTotalTokens === null ||
    tokens.countTotalTokens === undefined ||
    tokens.promptTokenCount === null ||
    tokens.promptTokenCount === undefined ||
    tokens.candidatesTokenCount === null ||
    tokens.candidatesTokenCount === undefined ||
    tokens.totalTokenCount === null ||
    tokens.totalTokenCount === undefined
  ) {
    throw new EvaluationHaltError(
      'MISSING_TOKEN_COUNTS',
      `Evaluation ${evalRunId} returned incomplete token usage metadata`,
      { evalRunId, tokens },
    );
  }

  // 3. Token ceiling breach
  if (tokens.promptTokenCount > maxInputTokenCeiling) {
    throw new EvaluationHaltError(
      'TOKEN_CEILING_BREACH',
      `Evaluation ${evalRunId} promptTokenCount (${tokens.promptTokenCount}) exceeded ceiling (${maxInputTokenCeiling})`,
      { evalRunId, promptTokenCount: tokens.promptTokenCount, maxInputTokenCeiling },
    );
  }

  // 4. Token discrepancy check (preflight countTokens must equal promptTokenCount)
  if (tokens.promptTokenCount !== tokens.countTotalTokens) {
    throw new EvaluationHaltError(
      'TOKEN_DISCREPANCY',
      `Evaluation ${evalRunId} token mismatch: promptTokenCount (${tokens.promptTokenCount}) !== countTotalTokens (${tokens.countTotalTokens})`,
      {
        evalRunId,
        countTotalTokens: tokens.countTotalTokens,
        promptTokenCount: tokens.promptTokenCount,
        diff: tokens.promptTokenCount - tokens.countTotalTokens,
      },
    );
  }

  // 5. Accounting reconciliation check
  if (!attemptDoc) {
    throw new EvaluationHaltError(
      'ACCOUNTING_DISCREPANCY',
      `Evaluation ${evalRunId} generationAttempt document was not found in Firestore`,
      { evalRunId },
    );
  }

  if (attemptDoc.reconciled !== true) {
    throw new EvaluationHaltError(
      'ACCOUNTING_DISCREPANCY',
      `Evaluation ${evalRunId} generationAttempt was not reconciled`,
      { evalRunId, attemptDoc },
    );
  }

  if (attemptDoc.status !== 'ok') {
    throw new EvaluationHaltError(
      'ACCOUNTING_DISCREPANCY',
      `Evaluation ${evalRunId} generationAttempt status is "${attemptDoc.status}" (expected "ok")`,
      { evalRunId, attemptDoc },
    );
  }

  if (typeof attemptDoc.chargedCostMicros !== 'number' || attemptDoc.chargedCostMicros <= 0) {
    throw new EvaluationHaltError(
      'ACCOUNTING_DISCREPANCY',
      `Evaluation ${evalRunId} chargedCostMicros (${attemptDoc.chargedCostMicros}) must be positive integer`,
      { evalRunId, attemptDoc },
    );
  }

  const reserved = attemptDoc.reservedCostMicros ?? expectedWorstCaseMicros;
  const refunded = attemptDoc.refundedCostMicros ?? 0;
  if (attemptDoc.chargedCostMicros + refunded !== reserved) {
    throw new EvaluationHaltError(
      'ACCOUNTING_DISCREPANCY',
      `Evaluation ${evalRunId} accounting equation breach: charged (${attemptDoc.chargedCostMicros}) + refunded (${refunded}) !== reserved (${reserved})`,
      { evalRunId, attemptDoc, reserved },
    );
  }

  // 6. Structural snapshot compliance check (if state provided)
  if (state && response.result) {
    const structural = validateSnapshotStructuralCompliance(response.result, state);
    if (!structural.valid) {
      throw new EvaluationHaltError(
        'STRUCTURAL_VALIDATION_FAILURE',
        `Evaluation ${evalRunId} failed structural snapshot validation: ${structural.errors.join('; ')}`,
        { evalRunId, errors: structural.errors },
      );
    }
  }
}
