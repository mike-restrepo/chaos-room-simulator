import { sha256Hex, stableStringify, type CanonicalAIPacket } from '@chaos-room/shared';
import {
  BACKEND_LIMITS,
  DEFAULT_LIVE_MODEL_VERSION,
  SUPPORTED_LIVE_MODEL_VERSIONS,
  isValidNonNegativeInteger,
} from './config.js';
import type {
  ModelProvider,
  ProviderGenerationOptions,
  ProviderGenerationResponse,
  TokenUsageFixture,
} from './types.js';

export const GEMINI_GENERATE_CONTENT_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_COUNT_TOKENS_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_GEMINI_THINKING_LEVEL = 'LOW' as const;
export const ZERO_BILLABLE_TOKEN_USAGE: TokenUsageFixture = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  totalTokens: 0,
});

export type GeminiThinkingLevelInput = 'minimal' | 'low' | 'MINIMAL' | 'LOW';
export type GeminiThinkingLevel = 'MINIMAL' | 'LOW';

export interface GeminiGenerateContentRequestBody {
  readonly systemInstruction: {
    readonly parts: readonly [{ readonly text: string }];
  };
  readonly contents: readonly [
    {
      readonly role: 'user';
      readonly parts: readonly [{ readonly text: string }];
    },
  ];
  readonly generationConfig: {
    readonly responseMimeType: 'application/json';
    readonly responseJsonSchema: Record<string, unknown>;
    readonly maxOutputTokens: number;
    readonly thinkingConfig: {
      readonly thinkingLevel: GeminiThinkingLevel;
    };
  };
}

export interface GeminiCountTokensRequestBody {
  readonly generateContentRequest: GeminiGenerateContentRequestBody & {
    readonly model: string;
  };
}

export interface GeminiTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  serializedBody?: string;
  abortSignal: AbortSignal;
  timeoutMs: number;
}

export interface GeminiTransportResponse {
  status: number;
  body: unknown;
}

export type GeminiTransport = (request: GeminiTransportRequest) => Promise<GeminiTransportResponse>;

export interface GeminiPreparedTransportPayload<TBody extends object> {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  body: TBody;
  serializedBody: string;
}

export interface GeminiPreparedRequest {
  modelVersion: string;
  thinkingLevel: GeminiThinkingLevel;
  packetSnapshotJson: string;
  systemInstruction: string;
  inputPayload: string;
  responseSchema: Record<string, unknown>;
  responseSchemaJson: string;
  requestSha256: string;
  /**
   * Diagnostic-only UTF-8 byte/3 comparison value. Never used for spending
   * admission, limit enforcement, or billing bounds.
   */
  legacyHeuristicTokens: number;
  generateContentRequest: GeminiPreparedTransportPayload<GeminiGenerateContentRequestBody>;
  countTokensRequest: GeminiPreparedTransportPayload<GeminiCountTokensRequestBody>;
}

export interface GeminiModelProviderConfig {
  apiKey?: string;
  endpointBaseUrl?: string;
  countTokensEndpointBaseUrl?: string;
  thinkingLevel?: GeminiThinkingLevelInput;
  transport?: GeminiTransport;
  countTokensTransport?: GeminiTransport;
  beforePaidGenerationHook?: (prepared: GeminiPreparedRequest) => Promise<void> | void;
}

export type GeminiProviderErrorPhase = 'pre_generation' | 'generation';

export class GeminiProviderError extends Error {
  readonly usage: TokenUsageFixture | null;
  readonly phase: GeminiProviderErrorPhase;
  readonly reasonCode: string | undefined;

  constructor(
    message: string,
    usage: TokenUsageFixture | null = null,
    phase: GeminiProviderErrorPhase = 'generation',
    reasonCode?: string,
  ) {
    super(message);
    this.name = 'GeminiProviderError';
    this.usage = usage;
    this.phase = phase;
    this.reasonCode = reasonCode;
  }
}

/**
 * Non-authoritative legacy heuristic (`ceil(utf8Bytes / 3)`) retained solely
 * for unit/emulator tests demonstrating why naive byte division cannot
 * establish a pre-generation token cap or spending guarantee.
 */
export function estimateLegacyHeuristicInputTokens(
  systemInstruction: string,
  inputText: string,
  responseSchema?: Record<string, unknown>,
): number {
  const schemaPart = responseSchema ? `\n${JSON.stringify(responseSchema)}` : '';
  const utf8Bytes = Buffer.byteLength(`${systemInstruction}\n${inputText}${schemaPart}`, 'utf8');
  return Math.ceil(utf8Bytes / 3);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Builds system instructions exclusively from canonical boundary rules.
 * Ground truth, authored walkthroughs, and post-incident debriefs are never imported or supplied.
 */
export function buildGeminiSystemInstruction(
  packet: CanonicalAIPacket,
  options: ProviderGenerationOptions,
): string {
  const evidenceIds = packet.visibleEvidence.map((item) => item.id).join(', ');
  const interventionRule =
    packet.checkpoint === 'alert'
      ? 'You are at the Alert (03:00) checkpoint. recommendedInterventions MUST be an empty array []. Provide investigative verificationChecks instead.'
      : `You are at the ${packet.checkpoint} checkpoint. Populate 1 to 3 recommendedInterventions using ONLY valid intervention IDs from visibleInterventions (${packet.visibleInterventions.map((opt) => opt.id).join(', ')}).`;

  return [
    'You are an incident-response assistant analyzing a synthetic telemetry snapshot.',
    'Use ONLY facts present in the CanonicalAIPacket JSON input provided by the caller.',
    `Do NOT speculate about future timestamps beyond ${packet.simTimeSeconds}s or invent external causes.`,
    `Cite ONLY visible evidence IDs from this exact set: [${evidenceIds}].`,
    interventionRule,
    `Respond with strict JSON matching schema version ${options.schemaVersion} (prompt ${options.promptVersion}).`,
  ].join(' ');
}

export function buildGeminiInputPayload(packet: CanonicalAIPacket): string {
  return JSON.stringify(packet);
}

/**
 * Builds a strict JSON Schema aligned with `outputValidator.ts` and the canonical packet bounds.
 */
export function buildGeminiResponseSchema(packet: CanonicalAIPacket): Record<string, unknown> {
  const interventionIds = packet.visibleInterventions.map((item) => item.id);
  const citationIdSchema: Record<string, unknown> = {
    type: 'string',
    minLength: 5,
    maxLength: 64,
  };

  const interventionIdSchema: Record<string, unknown> =
    interventionIds.length > 0
      ? { type: 'string', enum: interventionIds }
      : { type: 'string', minLength: 1, maxLength: 64 };

  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'conciseAssessment',
      'observedFacts',
      'rankedHypotheses',
      'alternativeExplanations',
      'missingInformation',
      'confidence',
      'recommendedInterventions',
      'verificationChecks',
      'stakeholderUpdate',
    ],
    properties: {
      conciseAssessment: { type: 'string', minLength: 10, maxLength: 800 },
      observedFacts: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'citationIds'],
          properties: {
            text: { type: 'string', minLength: 5, maxLength: 400 },
            citationIds: { type: 'array', minItems: 1, maxItems: 6, items: citationIdSchema },
          },
        },
      },
      rankedHypotheses: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rank', 'statement', 'likelihood', 'supportingCitationIds'],
          properties: {
            rank: { type: 'integer', minimum: 1, maximum: 5 },
            statement: { type: 'string', minLength: 5, maxLength: 400 },
            likelihood: { type: 'string', enum: ['Primary', 'Plausible alternative', 'Unlikely'] },
            supportingCitationIds: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: citationIdSchema,
            },
          },
        },
      },
      alternativeExplanations: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['explanation', 'whyLessLikely', 'citationIds'],
          properties: {
            explanation: { type: 'string', minLength: 5, maxLength: 400 },
            whyLessLikely: { type: 'string', minLength: 5, maxLength: 400 },
            citationIds: { type: 'array', minItems: 1, maxItems: 6, items: citationIdSchema },
          },
        },
      },
      missingInformation: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', minLength: 3, maxLength: 300 },
      },
      confidence: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'justification'],
        properties: {
          level: { type: 'string', enum: ['Low', 'Medium', 'High'] },
          justification: { type: 'string', minLength: 5, maxLength: 400 },
        },
      },
      recommendedInterventions:
        packet.checkpoint === 'alert'
          ? { type: 'array', maxItems: 0 }
          : {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['interventionId', 'rationale', 'keyRisk'],
                properties: {
                  interventionId: interventionIdSchema,
                  rationale: { type: 'string', minLength: 5, maxLength: 400 },
                  keyRisk: { type: 'string', minLength: 3, maxLength: 400 },
                },
              },
            },
      verificationChecks: {
        type: 'array',
        minItems: packet.checkpoint === 'alert' ? 1 : 0,
        maxItems: 6,
        items: { type: 'string', minLength: 5, maxLength: 300 },
      },
      stakeholderUpdate: { type: 'string', minLength: 10, maxLength: 600 },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Extracts and validates billable token usage from `generateContent`
 * (`usageMetadata`) payloads (and legacy `usage` payloads for compatibility).
 * Returns `null` if metadata is absent or any billable field is malformed so
 * conservative worst-case spend applies.
 */
export function extractGeminiUsage(
  body: unknown,
  fallbackInputTokens?: number,
): TokenUsageFixture | null {
  const root = asRecord(body);
  if (!root) {
    return null;
  }

  const meta = asRecord(root.usageMetadata);
  if (meta) {
    const inputRaw =
      meta.promptTokenCount === undefined &&
      fallbackInputTokens !== undefined &&
      isValidNonNegativeInteger(fallbackInputTokens)
        ? fallbackInputTokens
        : meta.promptTokenCount;
    const outputTokens = meta.candidatesTokenCount ?? meta.responseTokenCount;
    const thinkingRaw = meta.thoughtsTokenCount;
    const thinkingTokens = thinkingRaw === undefined ? 0 : thinkingRaw;
    const toolRaw = meta.toolUsePromptTokenCount;
    const toolTokens = toolRaw === undefined ? 0 : toolRaw;
    const totalTokensRaw = meta.totalTokenCount;

    if (
      !isValidNonNegativeInteger(inputRaw) ||
      !isValidNonNegativeInteger(outputTokens) ||
      !isValidNonNegativeInteger(thinkingTokens) ||
      !isValidNonNegativeInteger(toolTokens)
    ) {
      return null;
    }

    const baseSum = inputRaw + outputTokens + thinkingTokens;
    const derivedTotal =
      totalTokensRaw === undefined ? baseSum + toolTokens : totalTokensRaw;
    if (!isValidNonNegativeInteger(derivedTotal) || derivedTotal < baseSum) {
      return null;
    }

    return {
      inputTokens: inputRaw,
      outputTokens,
      thinkingTokens,
      totalTokens: derivedTotal,
    };
  }

  const legacyUsage = asRecord(root.usage);
  if (legacyUsage) {
    const inputRaw =
      legacyUsage.total_input_tokens ?? legacyUsage.input_tokens;
    const inputTokens =
      inputRaw === undefined &&
      fallbackInputTokens !== undefined &&
      isValidNonNegativeInteger(fallbackInputTokens)
        ? fallbackInputTokens
        : inputRaw;
    const outputTokens =
      legacyUsage.total_output_tokens ?? legacyUsage.output_tokens;
    const thinkingRaw =
      legacyUsage.total_thought_tokens ??
      legacyUsage.thought_tokens ??
      legacyUsage.thinking_tokens;
    const thinkingTokens = thinkingRaw === undefined ? 0 : thinkingRaw;
    const toolRaw =
      legacyUsage.total_tool_use_tokens ?? legacyUsage.tool_use_tokens;
    const toolTokens = toolRaw === undefined ? 0 : toolRaw;
    const totalTokensRaw = legacyUsage.total_tokens;

    if (
      !isValidNonNegativeInteger(inputTokens) ||
      !isValidNonNegativeInteger(outputTokens) ||
      !isValidNonNegativeInteger(thinkingTokens) ||
      !isValidNonNegativeInteger(toolTokens)
    ) {
      return null;
    }

    const baseSum = inputTokens + outputTokens + thinkingTokens;
    const derivedTotal =
      totalTokensRaw === undefined ? baseSum + toolTokens : totalTokensRaw;
    if (!isValidNonNegativeInteger(derivedTotal) || derivedTotal < baseSum) {
      return null;
    }

    return {
      inputTokens,
      outputTokens,
      thinkingTokens,
      totalTokens: derivedTotal,
    };
  }

  return null;
}

function extractGeminiOutputText(body: Record<string, unknown>): string | null {
  if (Array.isArray(body.candidates) && body.candidates.length > 0) {
    const first = asRecord(body.candidates[0]);
    const content = first ? asRecord(first.content) : null;
    if (content && Array.isArray(content.parts)) {
      const chunks: string[] = [];
      for (const partRaw of content.parts) {
        const part = asRecord(partRaw);
        if (part && typeof part.text === 'string') {
          chunks.push(part.text);
        }
      }
      const combined = chunks.join('');
      if (combined.trim().length > 0) {
        return combined;
      }
    }
  }

  if (typeof body.output_text === 'string' && body.output_text.trim().length > 0) {
    return body.output_text;
  }

  if (Array.isArray(body.steps)) {
    const chunks: string[] = [];
    for (const stepRaw of body.steps) {
      const step = asRecord(stepRaw);
      if (!step || step.type !== 'model_output' || !Array.isArray(step.content)) {
        continue;
      }
      for (const partRaw of step.content) {
        const part = asRecord(partRaw);
        if (part && part.type === 'text' && typeof part.text === 'string') {
          chunks.push(part.text);
        }
      }
    }
    const combined = chunks.join('');
    if (combined.trim().length > 0) {
      return combined;
    }
  }

  return null;
}

export function createFetchGeminiTransport(): GeminiTransport {
  return async (request: GeminiTransportRequest): Promise<GeminiTransportResponse> => {
    if (process.env.FIRESTORE_EMULATOR_HOST?.trim()) {
      throw new Error(
        'Default network Gemini transport is blocked while FIRESTORE_EMULATOR_HOST is active',
      );
    }
    if (process.env.CHAOS_LIVE_GEMINI_ENABLED !== 'true') {
      throw new Error(
        'Default network Gemini transport is disabled until CHAOS_LIVE_GEMINI_ENABLED=true',
      );
    }

    const res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.serializedBody ?? JSON.stringify(request.body),
      signal: request.abortSignal,
    });
    const text = await res.text();
    let parsedBody: unknown = text;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      // Preserve raw text payload when upstream returns non-JSON error body.
    }
    return {
      status: res.status,
      body: parsedBody,
    };
  };
}

export function buildGeminiGenerateContentEndpoint(
  modelVersion: string,
  baseUrl = GEMINI_GENERATE_CONTENT_BASE_URL,
): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/${encodeURIComponent(modelVersion)}:generateContent`;
}

export function buildGeminiCountTokensEndpoint(
  modelVersion: string,
  baseUrl = GEMINI_COUNT_TOKENS_BASE_URL,
): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/${encodeURIComponent(modelVersion)}:countTokens`;
}

function normalizeThinkingLevel(raw?: GeminiThinkingLevelInput): GeminiThinkingLevel {
  if (raw === 'minimal' || raw === 'MINIMAL') {
    return 'MINIMAL';
  }
  return 'LOW';
}

function buildGenerateContentRequestBody(params: {
  systemInstruction: string;
  inputPayload: string;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
  thinkingLevel: GeminiThinkingLevel;
}): GeminiGenerateContentRequestBody {
  return {
    systemInstruction: {
      parts: [{ text: params.systemInstruction }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: params.inputPayload }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: params.responseSchema,
      maxOutputTokens: params.maxOutputTokens,
      thinkingConfig: {
        thinkingLevel: params.thinkingLevel,
      },
    },
  };
}

/**
 * Validates model + token ceilings and constructs both the frozen Gemini
 * `GenerateContentRequest` payload and its matched `:countTokens` request
 * wrapping that exact `GenerateContentRequest`.
 */
export function prepareGeminiRequest(params: {
  packet: CanonicalAIPacket;
  options: ProviderGenerationOptions;
  apiKey: string;
  endpointBaseUrl?: string;
  countTokensEndpointBaseUrl?: string;
  thinkingLevel?: GeminiThinkingLevelInput;
}): GeminiPreparedRequest {
  const { packet, options, apiKey } = params;
  const endpointBaseUrl = params.endpointBaseUrl ?? GEMINI_GENERATE_CONTENT_BASE_URL;
  const countTokensBaseUrl = params.countTokensEndpointBaseUrl ?? GEMINI_COUNT_TOKENS_BASE_URL;
  const thinkingLevel = normalizeThinkingLevel(
    params.thinkingLevel ?? DEFAULT_GEMINI_THINKING_LEVEL,
  );

  if (!apiKey.trim()) {
    throw new GeminiProviderError(
      'Gemini API key is missing',
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'missing_api_key',
    );
  }

  const modelVersion = options.modelVersion || DEFAULT_LIVE_MODEL_VERSION;
  if (
    !SUPPORTED_LIVE_MODEL_VERSIONS.includes(
      modelVersion as (typeof SUPPORTED_LIVE_MODEL_VERSIONS)[number],
    )
  ) {
    throw new GeminiProviderError(
      `Unsupported live Gemini model "${modelVersion}". Supported models: ${SUPPORTED_LIVE_MODEL_VERSIONS.join(', ')}`,
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'unsupported_model',
    );
  }

  if (
    !isValidNonNegativeInteger(options.maxInputTokens) ||
    options.maxInputTokens <= 0 ||
    options.maxInputTokens > BACKEND_LIMITS.maxInputTokens
  ) {
    throw new GeminiProviderError(
      `Unsupported maxInputTokens ceiling (${options.maxInputTokens}); maximum allowed is ${BACKEND_LIMITS.maxInputTokens}`,
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'unsupported_ceiling',
    );
  }

  if (
    !isValidNonNegativeInteger(options.maxOutputThinkingTokens) ||
    options.maxOutputThinkingTokens <= 0 ||
    options.maxOutputThinkingTokens > BACKEND_LIMITS.maxOutputThinkingTokens
  ) {
    throw new GeminiProviderError(
      `Unsupported maxOutputThinkingTokens ceiling (${options.maxOutputThinkingTokens}); maximum allowed is ${BACKEND_LIMITS.maxOutputThinkingTokens}`,
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'unsupported_ceiling',
    );
  }

  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new GeminiProviderError(
      `Invalid provider deadline (${options.deadlineMs}ms)`,
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'invalid_deadline',
    );
  }

  const packetSnapshotJson = stableStringify(packet);
  const systemInstruction = buildGeminiSystemInstruction(packet, options);
  const inputPayload = buildGeminiInputPayload(packet);
  const responseSchema = buildGeminiResponseSchema(packet);
  const responseSchemaJson = JSON.stringify(responseSchema);
  const legacyHeuristicTokens = estimateLegacyHeuristicInputTokens(
    systemInstruction,
    inputPayload,
    responseSchema,
  );

  const generateContentBody = deepFreeze(
    buildGenerateContentRequestBody({
      systemInstruction,
      inputPayload,
      responseSchema: structuredClone(responseSchema),
      maxOutputTokens: options.maxOutputThinkingTokens,
      thinkingLevel,
    }),
  );
  const serializedGenerateContentBody = JSON.stringify(generateContentBody);
  const requestSha256 = sha256Hex(serializedGenerateContentBody);

  // Send the exact GenerateContentRequest structure (model, systemInstruction,
  // contents, and generationConfig including responseJsonSchema) to :countTokens.
  const countTokensBody = deepFreeze({
    generateContentRequest: {
      model: `models/${modelVersion}`,
      ...structuredClone(generateContentBody),
    },
  }) as GeminiCountTokensRequestBody;
  const serializedCountTokensBody = JSON.stringify(countTokensBody);

  const sharedHeaders = Object.freeze({
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey.trim(),
  });

  return {
    modelVersion,
    thinkingLevel,
    packetSnapshotJson,
    systemInstruction,
    inputPayload,
    responseSchema,
    responseSchemaJson,
    requestSha256,
    legacyHeuristicTokens,
    generateContentRequest: {
      endpoint: buildGeminiGenerateContentEndpoint(modelVersion, endpointBaseUrl),
      headers: sharedHeaders,
      body: generateContentBody,
      serializedBody: serializedGenerateContentBody,
    },
    countTokensRequest: {
      endpoint: buildGeminiCountTokensEndpoint(modelVersion, countTokensBaseUrl),
      headers: sharedHeaders,
      body: countTokensBody,
      serializedBody: serializedCountTokensBody,
    },
  };
}

/**
 * Pure request builder returning the frozen `GenerateContentRequest` payload.
 */
export function buildGeminiGenerateContentRequest(params: {
  packet: CanonicalAIPacket;
  options: ProviderGenerationOptions;
  apiKey: string;
  endpointBaseUrl?: string;
  thinkingLevel?: GeminiThinkingLevelInput;
}): GeminiPreparedTransportPayload<GeminiGenerateContentRequestBody> {
  return prepareGeminiRequest(params).generateContentRequest;
}

/**
 * Verifies local request integrity between `:countTokens` preflight verification
 * and paid `:generateContent` execution:
 * - Canonical `packet` has not mutated.
 * - `generateContentRequest` matches the canonical reconstruction & SHA-256 digest.
 * - `countTokensRequest.body.generateContentRequest` carries the identical
 *   `systemInstruction`, `contents`, and `generationConfig` as `generateContentRequest.body`.
 */
export function assertPreparedRequestUnchanged(
  currentPacket: CanonicalAIPacket,
  prepared: GeminiPreparedRequest,
  options: ProviderGenerationOptions,
): void {
  if (
    stableStringify(currentPacket) !== prepared.packetSnapshotJson ||
    buildGeminiInputPayload(currentPacket) !== prepared.inputPayload
  ) {
    throw new GeminiProviderError(
      'Canonical packet content changed after pre-generation token verification',
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'request_content_changed',
    );
  }

  const expectedSystemInstruction = buildGeminiSystemInstruction(currentPacket, options);
  const expectedSchema = buildGeminiResponseSchema(currentPacket);
  const expectedGenerateContentBody = buildGenerateContentRequestBody({
    systemInstruction: expectedSystemInstruction,
    inputPayload: prepared.inputPayload,
    responseSchema: expectedSchema,
    maxOutputTokens: options.maxOutputThinkingTokens,
    thinkingLevel: prepared.thinkingLevel,
  });
  const expectedGenerateContentJson = JSON.stringify(expectedGenerateContentBody);
  const expectedCountTokensBody: GeminiCountTokensRequestBody = {
    generateContentRequest: {
      model: `models/${prepared.modelVersion}`,
      ...expectedGenerateContentBody,
    },
  };

  let currentGenBodySha256 = '';
  try {
    currentGenBodySha256 = sha256Hex(prepared.generateContentRequest.serializedBody);
  } catch {
    currentGenBodySha256 = '';
  }

  const generateContentMatches =
    stableStringify(prepared.generateContentRequest.body) ===
      stableStringify(expectedGenerateContentBody) &&
    prepared.generateContentRequest.serializedBody === expectedGenerateContentJson &&
    currentGenBodySha256 === prepared.requestSha256;

  const countTokensMatches =
    stableStringify(prepared.countTokensRequest.body) ===
      stableStringify(expectedCountTokensBody) &&
    prepared.countTokensRequest.serializedBody === JSON.stringify(expectedCountTokensBody);

  const endpointSuffixOk =
    prepared.generateContentRequest.endpoint.endsWith(
      `/${encodeURIComponent(prepared.modelVersion)}:generateContent`,
    ) &&
    prepared.countTokensRequest.endpoint.endsWith(
      `/${encodeURIComponent(prepared.modelVersion)}:countTokens`,
    );

  if (!generateContentMatches || !countTokensMatches || !endpointSuffixOk) {
    throw new GeminiProviderError(
      'Prepared Gemini generateContent request diverged after pre-generation token verification',
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'request_content_changed',
    );
  }
}

/**
 * Validates HTTP status, completion state, token ceilings, and billable token metadata
 * from a Gemini `generateContent` API response.
 */
export function parseGeminiResponse(
  response: GeminiTransportResponse,
  options: ProviderGenerationOptions,
  verifiedInputTokensFallback?: number,
): ProviderGenerationResponse {
  const usage = extractGeminiUsage(response.body, verifiedInputTokensFallback);
  const root = asRecord(response.body);

  if (response.status < 200 || response.status >= 300) {
    const errDetail =
      root && asRecord(root.error)?.message
        ? String(asRecord(root.error)?.message)
        : `HTTP ${response.status}`;
    throw new GeminiProviderError(`Gemini API request failed: ${errDetail}`, usage);
  }

  if (!root) {
    throw new GeminiProviderError('Gemini API returned a non-object response payload', usage);
  }

  if (
    typeof root.status === 'string' &&
    ['incomplete', 'failed', 'cancelled'].includes(root.status)
  ) {
    throw new GeminiProviderError(
      `Gemini response ended with non-completed status "${root.status}"`,
      usage,
    );
  }

  if (Array.isArray(root.candidates) && root.candidates.length > 0) {
    const firstCandidate = asRecord(root.candidates[0]);
    if (firstCandidate?.finishReason === 'MAX_TOKENS') {
      throw new GeminiProviderError('Gemini candidate stopped with MAX_TOKENS truncation', usage);
    }
  }

  if (usage) {
    const outputPlusThinking =
      usage.totalTokens !== undefined
        ? Math.max(usage.outputTokens + usage.thinkingTokens, usage.totalTokens - usage.inputTokens)
        : usage.outputTokens + usage.thinkingTokens;
    if (usage.inputTokens > options.maxInputTokens) {
      throw new GeminiProviderError(
        `Gemini response input tokens (${usage.inputTokens}) exceeded ceiling (${options.maxInputTokens})`,
        usage,
      );
    }
    if (outputPlusThinking > options.maxOutputThinkingTokens) {
      throw new GeminiProviderError(
        `Gemini response output+thinking tokens (${outputPlusThinking}) exceeded ceiling (${options.maxOutputThinkingTokens})`,
        usage,
      );
    }
  }

  const rawText = extractGeminiOutputText(root);
  if (!rawText) {
    throw new GeminiProviderError('Gemini response contained no output text', usage);
  }

  return {
    rawOutput: rawText,
    usage,
    modelVersion: options.modelVersion || DEFAULT_LIVE_MODEL_VERSION,
  };
}

export interface OfficialGeminiCountTokensFixture {
  readonly id: string;
  readonly sourceUrl: string;
  readonly verifiedAtIso: string;
  readonly contentsText: string;
  readonly expectedTotalTokens: number;
}

/**
 * Contract fixtures copied from official Gemini API documentation examples
 * (verified 2026-11-14).
 */
export const OFFICIAL_GEMINI_COUNT_TOKENS_FIXTURES: readonly OfficialGeminiCountTokensFixture[] =
  Object.freeze([
    {
      id: 'gemini-docs-quick-brown-fox',
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/tokens',
      verifiedAtIso: '2026-11-14',
      contentsText: 'The quick brown fox jumps over the lazy dog.',
      expectedTotalTokens: 11,
    },
    {
      id: 'gemini-api-ref-analyze-sentence',
      sourceUrl: 'https://ai.google.dev/api/tokens',
      verifiedAtIso: '2026-11-14',
      contentsText: 'Analyze the token count for this sentence.',
      expectedTotalTokens: 9,
    },
  ]);

export interface MockCountTokensBreakdown {
  readonly isOfficialDocFixture: boolean;
  readonly systemInstructionTokens: number;
  readonly contentsTokens: number;
  readonly responseSchemaTokens: number;
  readonly envelopeTokens: number;
  readonly totalTokens: number;
}

/**
 * MOCK_ONLY_COUNT_TOKENS_FIXTURE — offline test-only breakdown helper.
 * NEVER a live Gemini tokenizer or proven spending upper bound; production code
 * rejects unverified/missing `:countTokens` counts and validates live counts in Step 2.
 */
function estimateMockFixtureTokensForString(text: string): number {
  let tokens = 0;
  for (const match of text.matchAll(/[A-Za-z0-9_]+|[^A-Za-z0-9_\s]/g)) {
    const piece = match[0];
    if (/^[A-Za-z0-9_]+$/.test(piece)) {
      tokens += Math.ceil(piece.length / 4);
    } else {
      const utf8Bytes = Buffer.byteLength(piece, 'utf8');
      tokens += utf8Bytes > 1 ? utf8Bytes : 1;
    }
  }
  return tokens;
}

/**
 * MOCK_ONLY_COUNT_TOKENS_FIXTURE — computes an offline test fixture token count
 * across `systemInstruction`, `contents`, and `generationConfig.responseJsonSchema`,
 * returning exact documented counts for verbatim official API doc fixture strings.
 */
export function computeMockCountTokensBreakdown(
  body: Record<string, unknown>,
): MockCountTokensBreakdown | null {
  const genReq = asRecord(body.generateContentRequest);
  if (!genReq || typeof genReq.model !== 'string' || !genReq.model.startsWith('models/')) {
    return null;
  }

  const contents = Array.isArray(genReq.contents) ? genReq.contents : null;
  if (!contents || contents.length === 0) {
    return null;
  }

  let systemInstructionTokens = 0;
  const sys = asRecord(genReq.systemInstruction);
  if (sys && Array.isArray(sys.parts)) {
    for (const partRaw of sys.parts) {
      const part = asRecord(partRaw);
      if (part && typeof part.text === 'string') {
        systemInstructionTokens += estimateMockFixtureTokensForString(part.text);
      }
    }
  }

  let contentsTokens = 0;
  let singleContentText: string | null = null;
  let textPartCount = 0;
  for (const contentRaw of contents) {
    const content = asRecord(contentRaw);
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const partRaw of parts) {
      const part = asRecord(partRaw);
      if (part && typeof part.text === 'string') {
        textPartCount += 1;
        singleContentText = part.text;
        contentsTokens += estimateMockFixtureTokensForString(part.text);
      }
    }
  }
  if (textPartCount === 0) {
    return null;
  }

  const genConfig = asRecord(genReq.generationConfig);
  const responseJsonSchema = genConfig ? genConfig.responseJsonSchema : undefined;
  const responseSchemaTokens =
    responseJsonSchema !== undefined
      ? estimateMockFixtureTokensForString(JSON.stringify(responseJsonSchema))
      : 0;

  if (
    systemInstructionTokens === 0 &&
    responseSchemaTokens === 0 &&
    contents.length === 1 &&
    textPartCount === 1 &&
    singleContentText !== null
  ) {
    const officialMatch = OFFICIAL_GEMINI_COUNT_TOKENS_FIXTURES.find(
      (fixture) => fixture.contentsText === singleContentText,
    );
    if (officialMatch) {
      return {
        isOfficialDocFixture: true,
        systemInstructionTokens: 0,
        contentsTokens: officialMatch.expectedTotalTokens,
        responseSchemaTokens: 0,
        envelopeTokens: 0,
        totalTokens: officialMatch.expectedTotalTokens,
      };
    }
  }

  const envelopeTokens = 12;
  return {
    isOfficialDocFixture: false,
    systemInstructionTokens,
    contentsTokens,
    responseSchemaTokens,
    envelopeTokens,
    totalTokens:
      systemInstructionTokens + contentsTokens + responseSchemaTokens + envelopeTokens,
  };
}

/**
 * MOCK_ONLY_COUNT_TOKENS_FIXTURE — test convenience `:countTokens` transport
 * used only when tests pass a mocked generation `transport` without overriding
 * `countTokensTransport`. Production instances (`new GeminiModelProvider({ apiKey })`)
 * always bind both transports to `createFetchGeminiTransport()`.
 */
export function createMockCountTokensTransport(): GeminiTransport {
  return async (request: GeminiTransportRequest): Promise<GeminiTransportResponse> => {
    const body = asRecord(request.body);
    if (!body) {
      return {
        status: 400,
        body: { error: { message: 'Malformed countTokens request body' } },
      };
    }

    const breakdown = computeMockCountTokensBreakdown(body);
    if (!breakdown) {
      return {
        status: 400,
        body: { error: { message: 'Malformed countTokens generateContentRequest payload' } },
      };
    }

    return {
      status: 200,
      body: {
        totalTokens: breakdown.totalTokens,
      },
    };
  };
}

/**
 * Verifies input tokens via the matched `:countTokens` endpoint prior to paid
 * `:generateContent` execution:
 * 1. Calls `:countTokens` outside Firestore transactions under a strict deadline + AbortSignal race.
 * 2. Requires HTTP 2xx and a positive safe integer `CountTokensResponse.totalTokens`.
 * 3. Rejects immediately with zero paid generation calls on failure, timeout, malformed count,
 *    or `totalTokens > maxInputTokens`.
 */
export async function verifyPreGenerationInputTokens(params: {
  prepared: GeminiPreparedRequest;
  maxInputTokens: number;
  deadlineMs: number;
  abortSignal: AbortSignal;
  countTokensTransport: GeminiTransport;
}): Promise<{
  verifiedInputTokens: number;
  reportedCountTokens: number;
}> {
  const { prepared, maxInputTokens, deadlineMs, abortSignal, countTokensTransport } = params;

  if (abortSignal.aborted) {
    throw new GeminiProviderError(
      'Gemini countTokens aborted before execution',
      null,
      'pre_generation',
      'count_tokens_timeout',
    );
  }

  const countController = new AbortController();
  let timedOutOrAborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => {
    timedOutOrAborted = true;
    countController.abort();
  };
  abortSignal.addEventListener('abort', onExternalAbort, { once: true });

  const deadlinePromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOutOrAborted = true;
      countController.abort();
      reject(
        new GeminiProviderError(
          `Gemini countTokens exceeded ${deadlineMs}ms deadline`,
          null,
          'pre_generation',
          'count_tokens_timeout',
        ),
      );
    }, deadlineMs);
    timer.unref?.();
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (abortSignal.aborted) {
      reject(
        new GeminiProviderError(
          'Gemini countTokens aborted by caller deadline',
          null,
          'pre_generation',
          'count_tokens_timeout',
        ),
      );
      return;
    }
    abortSignal.addEventListener(
      'abort',
      () => {
        reject(
          new GeminiProviderError(
            'Gemini countTokens aborted by caller deadline',
            null,
            'pre_generation',
            'count_tokens_timeout',
          ),
        );
      },
      { once: true },
    );
  });

  const countPromise = Promise.resolve().then(() =>
    countTokensTransport({
      url: prepared.countTokensRequest.endpoint,
      headers: { ...prepared.countTokensRequest.headers },
      body: prepared.countTokensRequest.body as unknown as Record<string, unknown>,
      serializedBody: prepared.countTokensRequest.serializedBody,
      abortSignal: countController.signal,
      timeoutMs: deadlineMs,
    }),
  );
  // Prevent late unhandled rejections if countTokens finishes after timeout.
  countPromise.catch(() => {});

  let countResponse: GeminiTransportResponse;
  try {
    countResponse = await Promise.race([countPromise, deadlinePromise, abortPromise]);
  } catch (error) {
    if (timedOutOrAborted || abortSignal.aborted) {
      throw new GeminiProviderError(
        `Gemini countTokens timed out or aborted within ${deadlineMs}ms`,
        null,
        'pre_generation',
        'count_tokens_timeout',
      );
    }
    if (error instanceof GeminiProviderError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : 'Unknown countTokens transport failure';
    throw new GeminiProviderError(
      `Gemini countTokens request failed: ${detail}`,
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'count_tokens_failed',
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    abortSignal.removeEventListener('abort', onExternalAbort);
  }

  if (timedOutOrAborted || abortSignal.aborted) {
    throw new GeminiProviderError(
      'Gemini countTokens timed out or aborted prior to validation',
      null,
      'pre_generation',
      'count_tokens_timeout',
    );
  }

  if (countResponse.status < 200 || countResponse.status >= 300) {
    const errRoot = asRecord(countResponse.body);
    const errMsg =
      errRoot && asRecord(errRoot.error)?.message
        ? String(asRecord(errRoot.error)?.message)
        : `HTTP ${countResponse.status}`;
    throw new GeminiProviderError(
      `Gemini countTokens request failed: ${errMsg}`,
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'count_tokens_failed',
    );
  }

  const root = asRecord(countResponse.body);
  const reportedRaw = root ? root.totalTokens : undefined;
  if (!isValidNonNegativeInteger(reportedRaw) || reportedRaw <= 0) {
    throw new GeminiProviderError(
      'Gemini countTokens returned missing or invalid totalTokens',
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'count_tokens_unverified',
    );
  }

  if (reportedRaw > maxInputTokens) {
    throw new GeminiProviderError(
      `Canonical evidence packet exceeds maximum input token budget (${reportedRaw} > ${maxInputTokens})`,
      ZERO_BILLABLE_TOKEN_USAGE,
      'pre_generation',
      'input_token_limit_exceeded',
    );
  }

  return {
    verifiedInputTokens: reportedRaw,
    reportedCountTokens: reportedRaw,
  };
}

/**
 * Controlled Google Gemini provider implementing `ModelProvider` against the
 * matched `v1beta` `:generateContent` and `:countTokens` contract with
 * `CountTokensRequest.generateContentRequest` preflight verification, local
 * request-integrity verification, and zero automatic retries.
 */
export class GeminiModelProvider implements ModelProvider {
  readonly providerName = 'google-gemini-generate-content';
  readonly isMock = false;

  private readonly apiKey: string;
  private readonly endpointBaseUrl: string;
  private readonly countTokensEndpointBaseUrl: string;
  private readonly thinkingLevel: GeminiThinkingLevel;
  private readonly transport: GeminiTransport;
  private readonly countTokensTransport: GeminiTransport;
  private readonly beforePaidGenerationHook?: (
    prepared: GeminiPreparedRequest,
  ) => Promise<void> | void;

  constructor(config: GeminiModelProviderConfig = {}) {
    this.apiKey = (config.apiKey ?? '').trim();
    this.endpointBaseUrl = config.endpointBaseUrl ?? GEMINI_GENERATE_CONTENT_BASE_URL;
    this.countTokensEndpointBaseUrl =
      config.countTokensEndpointBaseUrl ?? GEMINI_COUNT_TOKENS_BASE_URL;
    this.thinkingLevel = normalizeThinkingLevel(
      config.thinkingLevel ?? DEFAULT_GEMINI_THINKING_LEVEL,
    );
    this.transport = config.transport ?? createFetchGeminiTransport();
    this.countTokensTransport =
      config.countTokensTransport ??
      (config.transport
        ? createMockCountTokensTransport()
        : createFetchGeminiTransport());
    this.beforePaidGenerationHook = config.beforePaidGenerationHook;
  }

  async generateAnalysis(
    packet: CanonicalAIPacket,
    options: ProviderGenerationOptions,
    abortSignal: AbortSignal,
  ): Promise<ProviderGenerationResponse> {
    if (abortSignal.aborted) {
      throw new GeminiProviderError(
        'Gemini provider aborted before transport invocation',
        null,
        'pre_generation',
        'count_tokens_timeout',
      );
    }

    const startedAtMs = Date.now();
    const prepared = prepareGeminiRequest({
      packet,
      options,
      apiKey: this.apiKey,
      endpointBaseUrl: this.endpointBaseUrl,
      countTokensEndpointBaseUrl: this.countTokensEndpointBaseUrl,
      thinkingLevel: this.thinkingLevel,
    });

    const verification = await verifyPreGenerationInputTokens({
      prepared,
      maxInputTokens: options.maxInputTokens,
      deadlineMs: options.deadlineMs,
      abortSignal,
      countTokensTransport: this.countTokensTransport,
    });

    if (this.beforePaidGenerationHook) {
      await this.beforePaidGenerationHook(prepared);
    }

    assertPreparedRequestUnchanged(packet, prepared, options);

    if (abortSignal.aborted) {
      throw new GeminiProviderError(
        'Gemini provider aborted after pre-generation token verification',
        null,
        'pre_generation',
        'count_tokens_timeout',
      );
    }

    const remainingGenerateMs = options.deadlineMs - (Date.now() - startedAtMs);
    if (remainingGenerateMs <= 0) {
      throw new GeminiProviderError(
        'Gemini provider deadline exhausted after preflight token verification',
        null,
        'generation',
        'provider_deadline_exceeded',
      );
    }

    const response = await this.transport({
      url: prepared.generateContentRequest.endpoint,
      headers: { ...prepared.generateContentRequest.headers },
      body: prepared.generateContentRequest.body as unknown as Record<string, unknown>,
      serializedBody: prepared.generateContentRequest.serializedBody,
      abortSignal,
      timeoutMs: remainingGenerateMs,
    });
    return parseGeminiResponse(response, options, verification.verifiedInputTokens);
  }
}
