/**
 * Core contracts for Chaos Room deterministic incident simulator.
 * Pure TypeScript — shared between browser and backend.
 */

export const ENGINE_VERSION = '1.0.0';
export const TICK_STEP_SECONDS = 5;
export const MAX_SIMULATION_SECONDS = 900; // 15:00

export const CHECKPOINT_TIMES = {
  alert: 180,    // 03:00
  evidence: 360, // 06:00
  outcome: 900,  // 15:00
} as const;

export type CheckpointId = keyof typeof CHECKPOINT_TIMES;

export type ServiceId =
  | 'visitor'
  | 'api-gateway'
  | 'reservation-service'
  | 'inventory-db'
  | 'confirmation-queue'
  | 'confirmation-worker'
  | 'notification-provider';

export type ServiceHealth = 'healthy' | 'degraded' | 'failing';

export interface ServiceNodeDefinition {
  id: ServiceId;
  name: string;
  role: string;
  upstreamIds: ServiceId[];
  downstreamIds: ServiceId[];
}

export interface ServiceRuntimeStatus {
  id: ServiceId;
  name: string;
  role: string;
  health: ServiceHealth;
  statusSummary: string;
  primaryMetricLabel: string;
  primaryMetricValue: string;
  secondaryMetricLabel: string;
  secondaryMetricValue: string;
}

export type EvidenceType = 'metric' | 'log' | 'trace' | 'deployment';
export type EvidenceSeverity = 'info' | 'warn' | 'error';

export interface TraceSpan {
  spanId: string;
  service: ServiceId;
  operation: string;
  startOffsetMs: number;
  durationMs: number;
  status: 'ok' | 'timeout' | 'error';
  note?: string;
}

export interface EvidenceItem {
  id: string;
  simTimeSeconds: number;
  formattedTime: string;
  service: ServiceId;
  type: EvidenceType;
  severity: EvidenceSeverity;
  title: string;
  summary: string;
  detail: string;
  correlationId?: string;
  measureName?: string;
  measureValue?: string;
  traceSpans?: TraceSpan[];
  isAlternativeClue?: boolean;
}

export interface InterventionOption {
  id: string;
  label: string;
  shortLabel: string;
  summary: string;
  immediateTradeoff: string;
  stages?: string[];
  stageSchedule?: Array<{
    unlocksAtSeconds: number;
    plannedText: string;
    observedText: string;
  }>;
}

export interface HeadlineMeasures {
  /** Failed reservation attempts (including timeouts) / all reservation attempts in trailing 60s [0..1] */
  reservationErrorRate: number;
  /** 95th percentile of completed attempt durations (including timeouts) in trailing 60s (ms), or null if empty */
  apiP95LatencyMs: number | null;
  /** Current number of accepted reservations still awaiting confirmation at current tick */
  confirmationBacklog: number;
  /** Cumulative count of unique synthetic reservation IDs impacted so far in the incident */
  affectedReservations: number;
  /** Delivery attempts / unique messages in trailing 60s */
  retryAmplification: number;
  /** Supporting diagnostic counters for trailing 60s */
  windowAttempts: number;
  windowFailedAttempts: number;
  activeDbConnections: number;
  maxDbConnections: number;
  dbCpuPercent: number;
  /** Optional scenario-2/3 diagnostic measures (omitted in incident-001 to preserve golden snapshots) */
  providerP95LatencyMs?: number | null;
  queueAgeP95Seconds?: number | null;
  /** Optional scenario-3 contract-mismatch / quarantine / replay diagnostic measures */
  validationErrorAttempts?: number;
  validationErrorUniqueMessages?: number;
  quarantinedBacklog?: number;
  replayedDeliveries?: number;
  acceptedReservationsTotal?: number;
  deliveredConfirmationsTotal?: number;
}

export interface MetricTimelinePoint {
  simTimeSeconds: number;
  formattedTime: string;
  reservationErrorRate: number;
  apiP95LatencyMs: number | null;
  confirmationBacklog: number;
  affectedReservations: number;
  retryAmplification: number;
  activeDbConnections: number;
  maxDbConnections: number;
  dbCpuPercent: number;
  requestsPerMinute: number;
  /** Optional scenario-2/3 diagnostic timeline measures */
  providerP95LatencyMs?: number | null;
  queueAgeP95Seconds?: number | null;
  validationErrorAttempts?: number;
  validationErrorUniqueMessages?: number;
  quarantinedBacklog?: number;
  replayedDeliveries?: number;
}

export interface SyntheticAttemptSample {
  attemptId: string;
  reservationId: string;
  simTimeSeconds: number;
  durationMs: number;
  failed: boolean;
  timedOut: boolean;
  isRetry: boolean;
  confirmationCreated: boolean;
  confirmationCompletedAt: number | null;
  confirmationAttemptsInTick: number;
}

export interface Snapshot {
  incidentId: string;
  symptomTitle: string;
  scenarioVersion: string;
  engineVersion: string;
  seed: number;
  simTimeSeconds: number;
  formattedTime: string;
  activeCheckpoint: CheckpointId | null;
  reachedCheckpoints: CheckpointId[];
  /** Locked totrue at 06:00 (360s) when no intervention is selected yet */
  awaitingInterventionDecision: boolean;
  selectedInterventionId: string | null;
  selectedInterventionAppliedAt: number | null;
  severity: 'normal' | 'elevated' | 'high' | 'critical' | 'recovering' | 'resolved';
  customerImpactBanner: string;
  measures: HeadlineMeasures;
  timelineSeries: MetricTimelinePoint[];
  services: ServiceRuntimeStatus[];
  visibleEvidence: EvidenceItem[];
  availableInterventions: InterventionOption[];
}

export type ConfidenceLevel = 'Low' | 'Medium' | 'High';

export type AnalysisSourceMode =
  | 'authored_walkthrough'
  | 'live_generated'
  | 'preview_cached_ai'
  | 'preview_quota_reached'
  | 'preview_unavailable'
  | 'preview_malformed_fallback';

export type AnalyzeIncidentStatus =
  | 'ok'
  | 'cached'
  | 'pending'
  | 'quota_reached'
  | 'disabled'
  | 'version_mismatch'
  | 'timeout'
  | 'invalid_output'
  | 'unavailable';

export type QuotaReasonCode =
  | 'visitor_pending_limit'
  | 'visitor_minute_limit'
  | 'visitor_daily_limit'
  | 'project_minute_limit'
  | 'daily_generation_limit'
  | 'monthly_generation_limit'
  | 'monthly_spend_allowance';

export interface PublicAnalyzeRequest {
  incidentId: string;
  scenarioVersion: string;
  engineVersion?: string;
  checkpoint: CheckpointId;
  selectedInterventionId: string | null;
  requestId: string;
}

export interface AnalyzeIncidentResponse {
  status: AnalyzeIncidentStatus;
  incidentId: string;
  checkpoint: CheckpointId;
  selectedInterventionId: string | null;
  cacheKey?: string;
  cacheHit: boolean;
  isEvaluation?: boolean;
  isMockProvider: boolean;
  result?: AnalysisResult;
  reasonCode?: string;
  message: string;
  retryAfterMs?: number;
  expectedScenarioVersion?: string;
  expectedEngineVersion?: string;
  serverTimeIso: string;
}

export interface RankedHypothesis {
  rank: number;
  statement: string;
  likelihood: 'Primary' | 'Plausible alternative' | 'Unlikely';
  supportingCitationIds: string[];
}

export interface RecommendedInterventionRef {
  interventionId: string;
  rationale: string;
  keyRisk: string;
}

export interface AnalysisResult {
  incidentId: string;
  scenarioVersion: string;
  checkpoint: CheckpointId;
  selectedInterventionId: string | null;
  sourceMode: AnalysisSourceMode;
  sourceBadgeLabel: string;
  isPreviewMock: boolean;
  modelVersion: string;
  promptVersion: string;
  generatedAtIso: string;
  conciseAssessment: string;
  observedFacts: Array<{ text: string; citationIds: string[] }>;
  rankedHypotheses: RankedHypothesis[];
  alternativeExplanations: Array<{ explanation: string; whyLessLikely: string; citationIds: string[] }>;
  missingInformation: string[];
  confidence: {
    level: ConfidenceLevel;
    justification: string;
  };
  /** Must be empty [] at the Alert checkpoint */
  recommendedInterventions: RecommendedInterventionRef[];
  verificationChecks: string[];
  stakeholderUpdate: string;
}

export interface CanonicalAIPacket {
  incidentId: string;
  symptomTitle: string;
  scenarioVersion: string;
  engineVersion: string;
  checkpoint: CheckpointId;
  simTimeSeconds: number;
  systemDescription: string;
  topology: ServiceNodeDefinition[];
  measures: HeadlineMeasures;
  visibleEvidence: Array<{
    id: string;
    simTimeSeconds: number;
    service: ServiceId;
    type: EvidenceType;
    severity: EvidenceSeverity;
    title: string;
    summary: string;
    detail: string;
  }>;
  visibleInterventions: Array<{
    id: string;
    label: string;
    summary: string;
    immediateTradeoff: string;
  }>;
  appliedInterventionId: string | null;
}

export interface DebriefOutcomeComparison {
  interventionId: string;
  label: string;
  verdict:
    | 'Recommended resolution'
    | 'Temporary relief only'
    | 'Partial recovery only'
    | 'Unresolved impact';
  whatHappened: string;
  tradeoffLesson: string;
  finalErrorRatePercent: number;
  finalP95LatencyMs: number;
  totalAffectedReservations: number;
  /** Optional scenario-2 diagnostic outcome measures */
  finalBacklog?: number;
  finalQueueAgeP95Seconds?: number;
  finalRetryAmplification?: number;
  finalProviderP95Ms?: number;
  /** Optional scenario-3 diagnostic outcome measures */
  finalValidationErrorAttempts?: number;
  finalValidationErrorUniqueMsgs?: number;
  finalQuarantinedBacklog?: number;
  finalReplayedDeliveries?: number;
  finalDeliveredConfirmations?: number;
  finalAcceptedReservations?: number;
}

export interface ScenarioDebrief {
  incidentId: string;
  technicalTitle: string;
  actualRootCause: string;
  causalChain: string[];
  customerImpactSummary: string;
  alternativeClueExplanation: string;
  outcomeComparisons: Record<string, DebriefOutcomeComparison>;
  preventionOpportunities: Array<{
    category: string;
    recommendation: string;
    whyItMatters: string;
  }>;
}

export interface ScenarioTickInput {
  simTimeSeconds: number;
  seed: number;
  selectedInterventionId: string | null;
}

export interface ScenarioChartConfig {
  series1Label: string;
  series1Color: string;
  series2Label: string;
  series2Color: string;
  getSeries1Ratio: (pt: MetricTimelinePoint) => number;
  getSeries2Ratio: (pt: MetricTimelinePoint) => number;
  layout?: 'single' | 'stacked';
  series1Ticks?: Array<{ ratio: number; label: string }>;
  series2Ticks?: Array<{ ratio: number; label: string }>;
  formatSeries1Value?: (pt: MetricTimelinePoint) => string;
  formatSeries2Value?: (pt: MetricTimelinePoint) => string;
  formatCaption?: (pt: MetricTimelinePoint) => string;
}

export interface ScenarioDefinition {
  incidentId: string;
  symptomTitle: string;
  oneSentenceJourney: string;
  scenarioVersion: string;
  defaultSeed: number;
  systemDescription: string;
  topology: ServiceNodeDefinition[];
  interventions: InterventionOption[];
  chartConfig?: ScenarioChartConfig;
  buildEvidenceCatalog: (selectedInterventionId: string | null) => EvidenceItem[];
  walkthroughs: {
    alert: AnalysisResult;
    evidence: AnalysisResult;
    outcomes: Record<string, AnalysisResult>;
  };
  debrief: ScenarioDebrief;
}
