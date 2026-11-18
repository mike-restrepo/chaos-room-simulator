import type { PricingFixture, TokenUsageFixture } from './types.js';

export const DEMO_PROJECT_ID = 'demo-chaos-room';

export const CURRENT_PROMPT_VERSION = '1.0.0';
export const CURRENT_SCHEMA_VERSION = '1.0.0';
export const DEFAULT_MOCK_MODEL_VERSION = 'mock-gemini-phase3a-v1';
export const DEFAULT_LIVE_MODEL_VERSION = 'gemini-3.5-flash-lite';
export const SECONDARY_LIVE_MODEL_VERSION = 'gemini-3.1-flash-lite';
export const SUPPORTED_LIVE_MODEL_VERSIONS = [
  DEFAULT_LIVE_MODEL_VERSION,
  SECONDARY_LIVE_MODEL_VERSION,
] as const;
export const GEMINI_API_KEY_SECRET_NAME = 'GEMINI_API_KEY';

/** Centralized PRD defaults for admission, concurrency, quotas, and deadlines. */
export const BACKEND_LIMITS = {
  visitorMaxRequestsPerMinute: 2,
  visitorMaxRequestsPerDay: 12,
  visitorMaxPendingRequests: 1,
  projectMaxRequestsPerMinute: 30,
  maxGenerationAttemptsPerDay: 30,
  maxGenerationAttemptsPerMonth: 600,
  monthlySpendAllowanceMicros: 4_500_000, // $4.50 USD in integer microdollars
  maxInputTokens: 8_000,
  maxOutputThinkingTokens: 2_000,
  providerDeadlineMs: 15_000,
  functionTimeoutSeconds: 25,
  generationLeaseTtlMs: 25_000,
  cacheTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days, fixed from successful generation
  failureCooldownMs: 15_000, // Short cooldown after transient failure/invalid output
  maxRequestPayloadBytes: 1_024,
} as const;

/**
 * Derives conservative integer worst-case microdollar reservation directly from model rates
 * and centralized token ceilings so admission reservation and usage reconciliation share one source of truth.
 */
export function deriveWorstCaseReservationMicros(
  rates: {
    inputRateMicrosPerMillion: number;
    outputThinkingRateMicrosPerMillion: number;
  },
  limits: { maxInputTokens: number; maxOutputThinkingTokens: number } = BACKEND_LIMITS,
): number {
  const inputWorst = Math.ceil((limits.maxInputTokens * rates.inputRateMicrosPerMillion) / 1_000_000);
  const outputWorst = Math.ceil(
    (limits.maxOutputThinkingTokens * rates.outputThinkingRateMicrosPerMillion) / 1_000_000,
  );
  return inputWorst + outputWorst;
}

/**
 * Explicitly labeled mock pricing fixture used only for local emulator/mock verification.
 */
export const MOCK_PRICING_FIXTURE_V1: PricingFixture = {
  fixtureLabel: 'MOCK_PHASE3A_FIXTURE_UNVERIFIED',
  modelVersion: DEFAULT_MOCK_MODEL_VERSION,
  isLiveVerifiedPricing: false,
  inputRateMicrosPerMillion: 250_000, // $0.25 / 1M input tokens -> 2,000 microusd at 8,000 tokens
  outputThinkingRateMicrosPerMillion: 1_500_000, // $1.50 / 1M output+thinking -> 3,000 microusd at 2,000 tokens
  worstCaseReservationMicros: deriveWorstCaseReservationMicros({
    inputRateMicrosPerMillion: 250_000,
    outputThinkingRateMicrosPerMillion: 1_500_000,
  }),
};

/**
 * Verified live pricing configurations (verified 2026-11-14 against official Gemini API pricing:
 * https://ai.google.dev/gemini-api/docs/pricing and https://aistudio.google.com/docs/whats-new-gemini-3.6.md).
 * Thinking tokens generated during hybrid reasoning are billed as output tokens at the output rate.
 */
export const GEMINI_3_5_FLASH_LITE_PRICING_V1: PricingFixture = {
  fixtureLabel: 'GEMINI_3_5_FLASH_LITE_VERIFIED_2026_11_14',
  modelVersion: DEFAULT_LIVE_MODEL_VERSION,
  isLiveVerifiedPricing: true,
  verifiedAtIso: '2026-11-14',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  inputRateMicrosPerMillion: 300_000, // $0.30 / 1M text input tokens -> 2,400 microusd at 8,000 tokens
  outputThinkingRateMicrosPerMillion: 2_500_000, // $2.50 / 1M output+thinking -> 5,000 microusd at 2,000 tokens
  worstCaseReservationMicros: deriveWorstCaseReservationMicros({
    inputRateMicrosPerMillion: 300_000,
    outputThinkingRateMicrosPerMillion: 2_500_000,
  }), // 7,400 microusd ($0.0074/attempt; 600 attempts = $4.44 <= $4.50 monthly allowance)
};

export const GEMINI_3_1_FLASH_LITE_PRICING_V1: PricingFixture = {
  fixtureLabel: 'GEMINI_3_1_FLASH_LITE_VERIFIED_2026_11_14',
  modelVersion: SECONDARY_LIVE_MODEL_VERSION,
  isLiveVerifiedPricing: true,
  verifiedAtIso: '2026-11-14',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  inputRateMicrosPerMillion: 250_000, // $0.25 / 1M text input tokens -> 2,000 microusd at 8,000 tokens
  outputThinkingRateMicrosPerMillion: 1_500_000, // $1.50 / 1M output+thinking -> 3,000 microusd at 2,000 tokens
  worstCaseReservationMicros: deriveWorstCaseReservationMicros({
    inputRateMicrosPerMillion: 250_000,
    outputThinkingRateMicrosPerMillion: 1_500_000,
  }), // 5,000 microusd ($0.0050/attempt)
};

export const LIVE_MODEL_PRICING_BY_VERSION: Readonly<Record<string, PricingFixture>> = {
  [DEFAULT_LIVE_MODEL_VERSION]: GEMINI_3_5_FLASH_LITE_PRICING_V1,
  [SECONDARY_LIVE_MODEL_VERSION]: GEMINI_3_1_FLASH_LITE_PRICING_V1,
};

export function validatePricingFixture(
  pricing: PricingFixture,
  options: { requireLiveVerified?: boolean } = {},
): PricingFixture {
  if (
    !isValidNonNegativeInteger(pricing.inputRateMicrosPerMillion) ||
    pricing.inputRateMicrosPerMillion <= 0 ||
    !isValidNonNegativeInteger(pricing.outputThinkingRateMicrosPerMillion) ||
    pricing.outputThinkingRateMicrosPerMillion <= 0 ||
    !isValidNonNegativeInteger(pricing.worstCaseReservationMicros) ||
    pricing.worstCaseReservationMicros <= 0
  ) {
    throw new Error(`Invalid pricing fixture "${pricing.fixtureLabel}": rates must be positive integers`);
  }

  const expectedWorstCase = deriveWorstCaseReservationMicros(pricing);
  if (pricing.worstCaseReservationMicros !== expectedWorstCase) {
    throw new Error(
      `Invalid pricing fixture "${pricing.fixtureLabel}": worstCaseReservationMicros (${pricing.worstCaseReservationMicros}) does not match derived ceiling (${expectedWorstCase})`,
    );
  }

  if (options.requireLiveVerified && !pricing.isLiveVerifiedPricing) {
    throw new Error(
      `Pricing fixture "${pricing.fixtureLabel}" is not verified for live Gemini billing`,
    );
  }

  return pricing;
}

export function resolvePricingForModel(
  modelVersion: string,
  options: { allowMockPricing?: boolean } = {},
): PricingFixture {
  if (modelVersion === DEFAULT_MOCK_MODEL_VERSION && options.allowMockPricing !== false) {
    return validatePricingFixture(MOCK_PRICING_FIXTURE_V1);
  }
  const livePricing = LIVE_MODEL_PRICING_BY_VERSION[modelVersion];
  if (!livePricing) {
    throw new Error(`Unsupported or unpriced modelVersion "${modelVersion}"`);
  }
  return validatePricingFixture(livePricing, { requireLiveVerified: true });
}

export const LIVE_PRODUCTION_ORIGINS: string[] = ['https://chaos.mikerestrepo.com'];

export const ALLOWED_ORIGINS: string[] = [
  'https://chaos.mikerestrepo.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

export const FIRESTORE_COLLECTIONS = {
  analysisCache: 'analysisCache',
  generationAttempts: 'generationAttempts',
  requestRecords: 'requestRecords',
  quotaDays: 'quotaDays',
  quotaMonths: 'quotaMonths',
  quotaMinutes: 'quotaMinutes',
  visitorState: 'visitorState',
  evaluationRuns: 'evaluationRuns',
  systemControl: 'systemControl',
} as const;

export const SYSTEM_CONTROL_DOC_ID = 'runtime';

export function isValidNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

/**
 * Computes conservative integer microdollar cost from token usage and a pricing fixture.
 * Returns `{ known: false, costMicros: null }` if usage is null or malformed so callers
 * preserve the full worst-case spend reservation.
 */
export function computeTokenCostMicros(
  usage: TokenUsageFixture | null | undefined,
  pricing: PricingFixture = MOCK_PRICING_FIXTURE_V1,
): { known: boolean; costMicros: number | null } {
  if (!usage || typeof usage !== 'object') {
    return { known: false, costMicros: null };
  }
  const { inputTokens, outputTokens, thinkingTokens, totalTokens } = usage;
  if (
    !isValidNonNegativeInteger(inputTokens) ||
    !isValidNonNegativeInteger(outputTokens) ||
    !isValidNonNegativeInteger(thinkingTokens)
  ) {
    return { known: false, costMicros: null };
  }

  const summedTokens = inputTokens + outputTokens + thinkingTokens;
  let extraBillableTokens = 0;
  if (totalTokens !== undefined) {
    if (!isValidNonNegativeInteger(totalTokens) || totalTokens < summedTokens) {
      return { known: false, costMicros: null };
    }
    extraBillableTokens = totalTokens - summedTokens;
  }

  const inputCost = Math.ceil((inputTokens * pricing.inputRateMicrosPerMillion) / 1_000_000);
  const outputThinkingCost = Math.ceil(
    ((outputTokens + thinkingTokens + extraBillableTokens) * pricing.outputThinkingRateMicrosPerMillion) /
      1_000_000,
  );
  return {
    known: true,
    costMicros: inputCost + outputThinkingCost,
  };
}
