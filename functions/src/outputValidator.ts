import {
  validateAnalysisResult,
  type AnalysisResult,
  type RankedHypothesis,
  type RecommendedInterventionRef,
} from '@chaos-room/shared';
import type { ReconstructedState } from './types.js';

export class OutputValidationError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Provider output failed validation: ${reasons.join('; ')}`);
    this.name = 'OutputValidationError';
    this.reasons = reasons;
    Object.setPrototypeOf(this, OutputValidationError.prototype);
  }
}

const ALLOWED_OUTPUT_KEYS = new Set([
  'conciseAssessment',
  'observedFacts',
  'rankedHypotheses',
  'alternativeExplanations',
  'missingInformation',
  'confidence',
  'recommendedInterventions',
  'verificationChecks',
  'stakeholderUpdate',
  // Provenance keys may be echoed by structured JSON generators; server always overwrites them.
  'incidentId',
  'scenarioVersion',
  'checkpoint',
  'selectedInterventionId',
  'sourceMode',
  'sourceBadgeLabel',
  'isPreviewMock',
  'modelVersion',
  'promptVersion',
  'generatedAtIso',
]);

const LIKELIHOOD_VALUES = new Set<RankedHypothesis['likelihood']>([
  'Primary',
  'Plausible alternative',
  'Unlikely',
]);

const CONFIDENCE_VALUES = new Set(['Low', 'Medium', 'High']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateBoundedString(
  value: unknown,
  field: string,
  minLen: number,
  maxLen: number,
  errors: string[],
): string {
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) {
    errors.push(`${field} length must be between ${minLen} and ${maxLen} characters`);
  }
  return trimmed;
}

function hasOnlyKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      errors.push(`${label} contains unexpected field "${key}"`);
    }
  }
}

function validateCitationArray(
  value: unknown,
  field: string,
  validEvidenceIds: Set<string>,
  minItems: number,
  maxItems: number,
  errors: string[],
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  if (value.length < minItems || value.length > maxItems) {
    errors.push(`${field} must have between ${minItems} and ${maxItems} citations`);
  }
  const ids: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const cid = value[i];
    if (typeof cid !== 'string' || cid.trim().length === 0 || cid.length > 64) {
      errors.push(`${field}[${i}] must be a non-empty string citation ID`);
      continue;
    }
    if (!validEvidenceIds.has(cid)) {
      errors.push(`${field}[${i}] citation "${cid}" does not belong to canonical snapshot`);
      continue;
    }
    ids.push(cid);
  }
  return ids;
}

export interface ValidateOutputContext {
  state: ReconstructedState;
  generatedAtIso: string;
  isMockProvider: boolean;
}

/**
 * Treats raw model output as untrusted unknown data.
 * Parses JSON if needed, verifies strict structure, field lengths, enums, citations,
 * intervention IDs, and Alert rules, and constructs the final AnalysisResult with
 * server-owned provenance (ignoring any model-invented provenance/cache/live labels).
 */
export function validateAndNormalizeProviderOutput(
  rawOutput: unknown,
  context: ValidateOutputContext,
): AnalysisResult {
  const { state, generatedAtIso, isMockProvider } = context;
  const errors: string[] = [];

  let parsed: unknown = rawOutput;
  if (typeof rawOutput === 'string') {
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      throw new OutputValidationError(['Provider output is not valid JSON']);
    }
  }

  if (!isPlainObject(parsed)) {
    throw new OutputValidationError(['Provider output must be a JSON object']);
  }

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_OUTPUT_KEYS.has(key)) {
      errors.push(`Unexpected top-level output field "${key}"`);
    }
  }

  const validEvidenceIds = new Set(state.snapshot.visibleEvidence.map((item) => item.id));
  const validInterventionIds = new Set(state.snapshot.availableInterventions.map((item) => item.id));

  const conciseAssessment = validateBoundedString(
    parsed.conciseAssessment,
    'conciseAssessment',
    10,
    800,
    errors,
  );

  // observedFacts
  const observedFacts: AnalysisResult['observedFacts'] = [];
  if (!Array.isArray(parsed.observedFacts)) {
    errors.push('observedFacts must be an array');
  } else {
    if (parsed.observedFacts.length < 1 || parsed.observedFacts.length > 8) {
      errors.push('observedFacts must contain 1 to 8 items');
    }
    for (let i = 0; i < parsed.observedFacts.length; i++) {
      const item = parsed.observedFacts[i];
      if (!isPlainObject(item)) {
        errors.push(`observedFacts[${i}] must be an object`);
        continue;
      }
      hasOnlyKeys(item, ['text', 'citationIds'], `observedFacts[${i}]`, errors);
      const text = validateBoundedString(item.text, `observedFacts[${i}].text`, 5, 400, errors);
      const citationIds = validateCitationArray(
        item.citationIds,
        `observedFacts[${i}].citationIds`,
        validEvidenceIds,
        1,
        6,
        errors,
      );
      observedFacts.push({ text, citationIds });
    }
  }

  // rankedHypotheses
  const rankedHypotheses: RankedHypothesis[] = [];
  if (!Array.isArray(parsed.rankedHypotheses)) {
    errors.push('rankedHypotheses must be an array');
  } else {
    if (parsed.rankedHypotheses.length < 1 || parsed.rankedHypotheses.length > 5) {
      errors.push('rankedHypotheses must contain 1 to 5 items');
    }
    for (let i = 0; i < parsed.rankedHypotheses.length; i++) {
      const item = parsed.rankedHypotheses[i];
      if (!isPlainObject(item)) {
        errors.push(`rankedHypotheses[${i}] must be an object`);
        continue;
      }
      hasOnlyKeys(
        item,
        ['rank', 'statement', 'likelihood', 'supportingCitationIds'],
        `rankedHypotheses[${i}]`,
        errors,
      );
      const rank = item.rank;
      if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > 5) {
        errors.push(`rankedHypotheses[${i}].rank must be an integer between 1 and 5`);
      }
      const statement = validateBoundedString(
        item.statement,
        `rankedHypotheses[${i}].statement`,
        5,
        400,
        errors,
      );
      const likelihood = item.likelihood;
      if (
        typeof likelihood !== 'string' ||
        !LIKELIHOOD_VALUES.has(likelihood as RankedHypothesis['likelihood'])
      ) {
        errors.push(`rankedHypotheses[${i}].likelihood must be a valid enum value`);
      }
      const supportingCitationIds = validateCitationArray(
        item.supportingCitationIds,
        `rankedHypotheses[${i}].supportingCitationIds`,
        validEvidenceIds,
        1,
        8,
        errors,
      );
      rankedHypotheses.push({
        rank: typeof rank === 'number' ? rank : i + 1,
        statement,
        likelihood: (likelihood as RankedHypothesis['likelihood']) ?? 'Primary',
        supportingCitationIds,
      });
    }
  }

  // alternativeExplanations
  const alternativeExplanations: AnalysisResult['alternativeExplanations'] = [];
  if (!Array.isArray(parsed.alternativeExplanations)) {
    errors.push('alternativeExplanations must be an array');
  } else {
    if (parsed.alternativeExplanations.length > 5) {
      errors.push('alternativeExplanations must contain at most 5 items');
    }
    for (let i = 0; i < parsed.alternativeExplanations.length; i++) {
      const item = parsed.alternativeExplanations[i];
      if (!isPlainObject(item)) {
        errors.push(`alternativeExplanations[${i}] must be an object`);
        continue;
      }
      hasOnlyKeys(
        item,
        ['explanation', 'whyLessLikely', 'citationIds'],
        `alternativeExplanations[${i}]`,
        errors,
      );
      const explanation = validateBoundedString(
        item.explanation,
        `alternativeExplanations[${i}].explanation`,
        5,
        400,
        errors,
      );
      const whyLessLikely = validateBoundedString(
        item.whyLessLikely,
        `alternativeExplanations[${i}].whyLessLikely`,
        5,
        400,
        errors,
      );
      const citationIds = validateCitationArray(
        item.citationIds,
        `alternativeExplanations[${i}].citationIds`,
        validEvidenceIds,
        1,
        6,
        errors,
      );
      alternativeExplanations.push({ explanation, whyLessLikely, citationIds });
    }
  }

  // missingInformation
  const missingInformation: string[] = [];
  if (!Array.isArray(parsed.missingInformation)) {
    errors.push('missingInformation must be an array');
  } else {
    if (parsed.missingInformation.length > 6) {
      errors.push('missingInformation must contain at most 6 items');
    }
    for (let i = 0; i < parsed.missingInformation.length; i++) {
      missingInformation.push(
        validateBoundedString(
          parsed.missingInformation[i],
          `missingInformation[${i}]`,
          3,
          300,
          errors,
        ),
      );
    }
  }

  // confidence
  let confidence: AnalysisResult['confidence'] = { level: 'Medium', justification: '' };
  if (!isPlainObject(parsed.confidence)) {
    errors.push('confidence must be an object');
  } else {
    hasOnlyKeys(parsed.confidence, ['level', 'justification'], 'confidence', errors);
    const level = parsed.confidence.level;
    if (typeof level !== 'string' || !CONFIDENCE_VALUES.has(level)) {
      errors.push('confidence.level must be Low, Medium, or High');
    }
    const justification = validateBoundedString(
      parsed.confidence.justification,
      'confidence.justification',
      5,
      400,
      errors,
    );
    confidence = {
      level: (CONFIDENCE_VALUES.has(String(level)) ? level : 'Medium') as AnalysisResult['confidence']['level'],
      justification,
    };
  }

  // recommendedInterventions
  const recommendedInterventions: RecommendedInterventionRef[] = [];
  if (!Array.isArray(parsed.recommendedInterventions)) {
    errors.push('recommendedInterventions must be an array');
  } else if (state.checkpoint === 'alert') {
    if (parsed.recommendedInterventions.length !== 0) {
      errors.push('recommendedInterventions must be empty [] at the Alert checkpoint');
    }
  } else {
    if (parsed.recommendedInterventions.length < 1 || parsed.recommendedInterventions.length > 3) {
      errors.push('recommendedInterventions must contain 1 to 3 items at Evidence/Outcome');
    }
    const seenInterventions = new Set<string>();
    for (let i = 0; i < parsed.recommendedInterventions.length; i++) {
      const item = parsed.recommendedInterventions[i];
      if (!isPlainObject(item)) {
        errors.push(`recommendedInterventions[${i}] must be an object`);
        continue;
      }
      hasOnlyKeys(
        item,
        ['interventionId', 'rationale', 'keyRisk'],
        `recommendedInterventions[${i}]`,
        errors,
      );
      const interventionId = validateBoundedString(
        item.interventionId,
        `recommendedInterventions[${i}].interventionId`,
        1,
        64,
        errors,
      );
      if (interventionId && !validInterventionIds.has(interventionId)) {
        errors.push(
          `recommendedInterventions[${i}].interventionId "${interventionId}" is not valid for scenario "${state.scenario.incidentId}"`,
        );
      }
      if (seenInterventions.has(interventionId)) {
        errors.push(`Duplicate recommended interventionId "${interventionId}"`);
      }
      seenInterventions.add(interventionId);
      const rationale = validateBoundedString(
        item.rationale,
        `recommendedInterventions[${i}].rationale`,
        5,
        400,
        errors,
      );
      const keyRisk = validateBoundedString(
        item.keyRisk,
        `recommendedInterventions[${i}].keyRisk`,
        3,
        400,
        errors,
      );
      recommendedInterventions.push({ interventionId, rationale, keyRisk });
    }
  }

  // verificationChecks
  const verificationChecks: string[] = [];
  if (!Array.isArray(parsed.verificationChecks)) {
    errors.push('verificationChecks must be an array');
  } else {
    const minChecks = state.checkpoint === 'alert' ? 1 : 0;
    if (parsed.verificationChecks.length < minChecks || parsed.verificationChecks.length > 6) {
      errors.push(`verificationChecks must contain ${minChecks} to 6 items`);
    }
    for (let i = 0; i < parsed.verificationChecks.length; i++) {
      verificationChecks.push(
        validateBoundedString(
          parsed.verificationChecks[i],
          `verificationChecks[${i}]`,
          5,
          300,
          errors,
        ),
      );
    }
  }

  const stakeholderUpdate = validateBoundedString(
    parsed.stakeholderUpdate,
    'stakeholderUpdate',
    10,
    600,
    errors,
  );

  // Server-owned provenance ONLY (never trust model-supplied identity, timestamps, or live flags).
  const normalized: AnalysisResult = {
    incidentId: state.scenario.incidentId,
    scenarioVersion: state.scenario.scenarioVersion,
    checkpoint: state.checkpoint,
    selectedInterventionId: state.selectedInterventionId,
    sourceMode: 'preview_cached_ai',
    sourceBadgeLabel: isMockProvider
      ? 'Mocked AI analysis (Phase 3A emulator)'
      : 'AI analysis (generated live)',
    isPreviewMock: isMockProvider,
    modelVersion: state.modelVersion,
    promptVersion: state.promptVersion,
    generatedAtIso,
    conciseAssessment,
    observedFacts,
    rankedHypotheses,
    alternativeExplanations,
    missingInformation,
    confidence,
    recommendedInterventions,
    verificationChecks,
    stakeholderUpdate,
  };

  const sharedOutcome = validateAnalysisResult(normalized, state.snapshot);
  if (!sharedOutcome.valid) {
    errors.push(...sharedOutcome.errors);
  }

  if (errors.length > 0) {
    throw new OutputValidationError(errors);
  }

  return normalized;
}
