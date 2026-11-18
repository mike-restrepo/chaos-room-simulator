import type {
  AnalysisResult,
  AnalyzeIncidentResponse,
  AnalyzeIncidentStatus,
  CanonicalAIPacket,
  CheckpointId,
  PublicAnalyzeRequest,
  QuotaReasonCode,
  ScenarioDefinition,
  Snapshot,
} from '@chaos-room/shared';

export type {
  AnalyzeIncidentResponse,
  AnalyzeIncidentStatus,
  PublicAnalyzeRequest,
  QuotaReasonCode,
};

export interface CallableAuthContext {
  auth?: {
    uid?: string;
    token?: Record<string, unknown>;
  } | null;
  app?: {
    appId?: string;
    alreadyConsumed?: boolean;
  } | null;
  rawRequest?: {
    headers?: Record<string, string | string[] | undefined>;
  };
}

export interface ValidatedCallableAuth {
  visitorUid: string;
  appId: string;
}

export interface TokenUsageFixture {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens?: number;
}

export interface PricingFixture {
  readonly fixtureLabel: string;
  readonly isLiveVerifiedPricing: boolean;
  readonly modelVersion?: string;
  readonly verifiedAtIso?: string;
  readonly sourceUrl?: string;
  readonly inputRateMicrosPerMillion: number;
  readonly outputThinkingRateMicrosPerMillion: number;
  readonly worstCaseReservationMicros: number;
}

export type BackendRuntimeMode = 'emulator_mock' | 'live_gemini';

export interface ProviderGenerationOptions {
  modelVersion: string;
  promptVersion: string;
  schemaVersion: string;
  maxInputTokens: number;
  maxOutputThinkingTokens: number;
  deadlineMs: number;
}

export interface ProviderGenerationResponse {
  rawOutput: unknown;
  usage: TokenUsageFixture | null;
  modelVersion: string;
}

export interface ModelProvider {
  readonly providerName: string;
  readonly isMock: boolean;
  generateAnalysis(
    packet: CanonicalAIPacket,
    options: ProviderGenerationOptions,
    abortSignal: AbortSignal,
  ): Promise<ProviderGenerationResponse>;
}

export interface ReconstructedState {
  scenario: ScenarioDefinition;
  checkpoint: CheckpointId;
  selectedInterventionId: string | null;
  snapshot: Snapshot;
  packet: CanonicalAIPacket;
  packetSha256: string;
  cacheKey: string;
  cacheDocId: string;
  modelVersion: string;
  promptVersion: string;
  schemaVersion: string;
}

export interface GenerationLease {
  leaseId: string;
  requestId: string;
  visitorUid: string;
  cacheDocId: string;
  cacheKey: string;
  isEvaluation: boolean;
  quotaDayKey: string;
  quotaMonthKey: string;
  acquiredAtMs: number;
  expiresAtMs: number;
  reservedCostMicros: number;
}

export interface InternalEvaluationRequest {
  operatorId: string;
  evalRunId: string;
  incidentId: string;
  checkpoint: CheckpointId;
  selectedInterventionId: string | null;
  modelVersion?: string;
  promptVersion?: string;
  schemaVersion?: string;
}

export interface ServiceClock {
  nowMs(): number;
}
