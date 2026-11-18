import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  buildSnapshot,
  CHECKPOINT_TIMES,
  clampSimulationTime,
  fnv1aHex,
  getNextCheckpointTarget,
  INCIDENT_001_DEFINITION,
  INCIDENT_002_DEFINITION,
  INCIDENT_003_DEFINITION,
  MAX_SIMULATION_SECONDS,
  resolveSnapshotCheckpoint,
  TICK_STEP_SECONDS,
  ENGINE_VERSION,
  type AnalysisSourceMode,
  type AnalyzeIncidentResponse,
  type EvidenceType,
  type ServiceId,
} from '@chaos-room/shared';
import {
  resolveAssessmentView,
  resolveCheckpointAuthoredWalkthrough,
} from './services/assessmentService.js';
import {
  buildPublicAnalyzeRequest,
  computeCanonicalStateKey,
  DEFAULT_CLIENT_ANALYSIS_DEADLINE_MS,
  FirebaseCallableTransport,
  MockAnalyzeIncidentTransport,
  normalizeValidatedResponse,
  OfflineUnconfiguredTransport,
  isConfirmedTerminalBackendStatus,
  type AnalyzeIncidentTransport,
  type ExpectedCanonicalState,
  type FirebaseClientConfig,
  type TransportTimingEntry,
} from './services/aiClient.js';
import { ServiceMapPanel } from './components/ServiceMap/ServiceMapPanel.js';
import { EvidencePanel } from './components/Evidence/EvidencePanel.js';
import { AssessmentPanel } from './components/Assessment/AssessmentPanel.js';
import { DebriefPanel } from './components/Debrief/DebriefPanel.js';
import { MissionBriefingDialog } from './components/Briefing/MissionBriefingDialog.js';
import { GUIDED_TOUR_STEPS, GuidedTourDialog } from './components/Tour/GuidedTourDialog.js';
import { CHAOS_PRODUCTION_FIREBASE_CONFIG } from './config/firebase.js';
import {
  hasDismissedMissionBriefing,
  saveGuidedTourPreference,
  saveMissionBriefingDismissed,
} from './services/onboardingPreferences.js';
import { resolveNextStepGuidance } from './services/guidanceService.js';

type MobileWorkspaceTab = 'system' | 'evidence' | 'analysis';

const SCENARIOS = [
  {
    id: 'incident-001',
    label: 'Incident 1: “Reservations are timing out”',
    definition: INCIDENT_001_DEFINITION,
  },
  {
    id: 'incident-002',
    label: 'Incident 2: “Reservations succeed, confirmations stall”',
    definition: INCIDENT_002_DEFINITION,
  },
  {
    id: 'incident-003',
    label: 'Incident 3: “A release leaves confirmations behind”',
    definition: INCIDENT_003_DEFINITION,
  },
] as const;

export interface AppProps {
  transportOverride?: AnalyzeIncidentTransport;
  clientDeadlineMs?: number;
  environmentOverride?: { DEV?: boolean; MODE?: string };
}

export const App: React.FC<AppProps> = ({
  transportOverride,
  clientDeadlineMs,
  environmentOverride,
}) => {
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('incident-001');

  const scenario = useMemo(
    () =>
      SCENARIOS.find((item) => item.id === selectedScenarioId)?.definition ??
      INCIDENT_001_DEFINITION,
    [selectedScenarioId],
  );

  // Core simulation state (consistent 00:00 paused entry across initial load, switches, and resets)
  const [simTimeSeconds, setSimTimeSeconds] = useState<number>(0);
  const [selectedInterventionId, setSelectedInterventionId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2>(1);
  const [decisionGatePrompted, setDecisionGatePrompted] = useState<boolean>(false);

  // Onboarding mission briefing & optional guided tour state (separate from simulation and AI state)
  const [isBriefingOpen, setIsBriefingOpen] = useState<boolean>(
    () => !hasDismissedMissionBriefing(),
  );
  const [isTourOpen, setIsTourOpen] = useState<boolean>(false);
  const [tourStepIndex, setTourStepIndex] = useState<number>(0);
  const briefingTriggerRef = useRef<HTMLButtonElement | null>(null);
  const tourTriggerRef = useRef<HTMLButtonElement | null>(null);
  const playButtonRef = useRef<HTMLButtonElement | null>(null);
  const openedViaTriggerRef = useRef<boolean>(false);
  const tourOriginRef = useRef<'header' | 'briefing'>('header');
  const preTourMobileTabRef = useRef<MobileWorkspaceTab>('system');

  // Local workspace UI state (excluded from AI cache key and simulation determinism)
  const [selectedServiceId, setSelectedServiceId] = useState<ServiceId | null>(null);
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<EvidenceType | 'all' | 'pinned'>(
    'all',
  );
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [highlightedEvidenceId, setHighlightedEvidenceId] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<AnalysisSourceMode>('authored_walkthrough');
  const [mobileTab, setMobileTab] = useState<MobileWorkspaceTab>('system');

  // AI responses and request state
  const [requestIdsByStateKey, setRequestIdsByStateKey] = useState<Record<string, string>>({});
  const [retryUntilByStateKey, setRetryUntilByStateKey] = useState<Record<string, number>>({});
  const [aiResponsesByStateKey, setAiResponsesByStateKey] = useState<
    Record<string, AnalyzeIncidentResponse>
  >({});
  const [isAIRequestLoading, setIsAIRequestLoading] = useState<boolean>(false);
  const [viewingAuthoredOverride, setViewingAuthoredOverride] = useState<boolean>(false);

  // Local invocation identity and generation token
  const invocationCounterRef = useRef<number>(0);
  const activeInvocationIdRef = useRef<number>(0);
  const inFlightControllerRef = useRef<AbortController | null>(null);

  // Only allow dev/review controls in development or explicit review builds.
  // A production query parameter alone must not unlock development controls.
  const isDevOrReviewEnvironment = environmentOverride
    ? Boolean(
        environmentOverride.MODE === 'review' ||
          (environmentOverride.DEV && environmentOverride.MODE !== 'production'),
      )
    : Boolean(
        import.meta.env?.MODE === 'review' ||
          (import.meta.env?.DEV && import.meta.env?.MODE !== 'production'),
      );

  const snapshot = useMemo(
    () =>
      buildSnapshot({
        scenario,
        seed: scenario.defaultSeed,
        simTimeSeconds,
        selectedInterventionId,
      }),
    [scenario, simTimeSeconds, selectedInterventionId],
  );

  const currentCheckpoint = resolveSnapshotCheckpoint(snapshot);
  const currentCanonicalStateKey = computeCanonicalStateKey(
    scenario.incidentId,
    scenario.scenarioVersion,
    ENGINE_VERSION,
    currentCheckpoint,
    currentCheckpoint === 'outcome' ? selectedInterventionId : null,
  );

  const pendingTimingRecordRef = useRef<{
    status: 'completed' | 'in_flight' | 'cancelled' | 'failed';
    requestId: string;
    invocationId: number;
    checkpoint: string;
    clickTimestampMs: number;
    transportDurationMs?: number;
    validationDurationMs?: number;
    domCommittedMs?: number | null;
    clickToDomCommittedMs?: number | null;
    renderSettledMs?: number | null;
    clickToRenderDurationMs?: number | null;
    transportTiming?: TransportTimingEntry | null;
    stageObservability?: {
      clickToTransport: 'observable';
      sdkImport: 'observable';
      authAndAppCheck: 'observable_aggregate (individual reCAPTCHA script eval/risk scoring is unobservable in SDK)';
      callableAndTokenExecution: 'observable (includes SDK token readiness and HTTPS callable roundtrip)';
      validation: 'observable';
      domCommit: 'observable (useLayoutEffect immediate post-DOM commit)';
      renderSettlement: 'approximate (requestAnimationFrame scheduled from matching DOM commit)';
    };
  } | null>(null);

  const invalidateInFlightRequest = () => {
    activeInvocationIdRef.current = 0;
    pendingTimingRecordRef.current = null;
    if (inFlightControllerRef.current) {
      inFlightControllerRef.current.abort();
      inFlightControllerRef.current = null;
    }
    setIsAIRequestLoading(false);
    if (typeof window !== 'undefined') {
      const prevTiming = (window as unknown as { __CHAOS_AI_LAST_TIMING__?: { status?: string } })
        ?.__CHAOS_AI_LAST_TIMING__;
      if (prevTiming?.status === 'in_flight') {
        (window as unknown as { __CHAOS_AI_LAST_TIMING__?: unknown }).__CHAOS_AI_LAST_TIMING__ = {
          status: 'cancelled',
          cancelledAtMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        };
      }
    }
  };

  // Invalidate in-flight request when canonical state changes (stale response protection)
  useEffect(() => {
    invalidateInFlightRequest();
    return () => {
      invalidateInFlightRequest();
    };
  }, [currentCanonicalStateKey]);

  // Measure exact DOM commit synchronously when matching response updates in React state,
  // and schedule post-commit animation frame paint approximation strictly from that commit.
  useLayoutEffect(() => {
    const activeTiming = pendingTimingRecordRef.current;
    if (
      activeTiming &&
      activeTiming.status === 'completed' &&
      activeTiming.invocationId === activeInvocationIdRef.current &&
      activeTiming.domCommittedMs === null
    ) {
      const tDom = typeof performance !== 'undefined' ? performance.now() : Date.now();
      activeTiming.domCommittedMs = tDom;
      activeTiming.clickToDomCommittedMs = Math.max(0, tDom - activeTiming.clickTimestampMs);

      // Schedule post-commit animation-frame paint approximation strictly from this matching commit
      if (typeof window !== 'undefined' && typeof requestAnimationFrame !== 'undefined') {
        const capturedInvocationId = activeTiming.invocationId;
        const capturedClickMs = activeTiming.clickTimestampMs;
        requestAnimationFrame(() => {
          if (activeInvocationIdRef.current === capturedInvocationId && activeTiming.renderSettledMs === null) {
            const tRender = typeof performance !== 'undefined' ? performance.now() : Date.now();
            activeTiming.renderSettledMs = tRender;
            activeTiming.clickToRenderDurationMs = Math.max(0, tRender - capturedClickMs);
          }
        });
      }
    }
  }, [aiResponsesByStateKey, currentCanonicalStateKey]);

  // Stable transport across playback ticks and time updates
  const firebaseTransportRef = useRef<FirebaseCallableTransport | null>(null);
  const transport = useMemo<AnalyzeIncidentTransport>(() => {
    if (transportOverride) return transportOverride;

    let cachedDevTransport: MockAnalyzeIncidentTransport | null = null;
    const offlineTransport = new OfflineUnconfiguredTransport();

    return {
      transportName: 'app_delegating_transport',
      analyzeIncident: async (req, signal) => {
        const win =
          typeof window !== 'undefined'
            ? (window as unknown as {
                __CHAOS_FIREBASE_CONFIG__?: FirebaseClientConfig;
                __CHAOS_TRANSPORT_OVERRIDE__?: AnalyzeIncidentTransport;
              })
            : undefined;
        if (isDevOrReviewEnvironment) {
          if (win?.__CHAOS_TRANSPORT_OVERRIDE__) {
            const res = await win.__CHAOS_TRANSPORT_OVERRIDE__.analyzeIncident(req, signal);
            // Force mock provenance on injected/override responses so fabricated responses can never pose as live Gemini analysis
            if (res.result) {
              res.isMockProvider = true;
              res.result.isPreviewMock = true;
              if (res.result.sourceMode === 'live_generated') {
                res.result.sourceMode = 'preview_cached_ai';
              }
              if (!res.result.sourceBadgeLabel.toLowerCase().includes('mock')) {
                res.result.sourceBadgeLabel = `Mocked AI analysis (${res.result.sourceBadgeLabel})`;
              }
            }
            return res;
          }

          if (!cachedDevTransport) {
            cachedDevTransport = new MockAnalyzeIncidentTransport((request) => {
              const scDef =
                SCENARIOS.find((s) => s.id === request.incidentId)?.definition ?? INCIDENT_001_DEFINITION;
              const currentSnap = buildSnapshot({
                scenario: scDef,
                seed: scDef.defaultSeed,
                simTimeSeconds: CHECKPOINT_TIMES[request.checkpoint],
                selectedInterventionId: request.selectedInterventionId,
              });
              const { walkthrough } = resolveCheckpointAuthoredWalkthrough(scDef, currentSnap);
              return {
                status: 'ok',
                cacheHit: false,
                isMockProvider: true,
                result: {
                  ...walkthrough,
                  sourceMode: 'live_generated',
                  sourceBadgeLabel: 'Mocked AI analysis (local dev transport)',
                  isPreviewMock: true,
                },
              };
            });
          }
          return cachedDevTransport.analyzeIncident(req, signal);
        }

        const isDefaultProductionBuild = Boolean(import.meta.env?.PROD) && !environmentOverride;
        const clientConfig =
          win?.__CHAOS_FIREBASE_CONFIG__ ??
          (isDefaultProductionBuild ? CHAOS_PRODUCTION_FIREBASE_CONFIG : null);
        if (clientConfig?.projectId && clientConfig?.apiKey && clientConfig?.appId) {
          if (!firebaseTransportRef.current) {
            firebaseTransportRef.current = new FirebaseCallableTransport(clientConfig);
          }
          return firebaseTransportRef.current.analyzeIncident(req, signal);
        }

        return offlineTransport.analyzeIncident(req, signal);
      },
    };
  }, [transportOverride, isDevOrReviewEnvironment, environmentOverride]);

  const activeAIResponse = aiResponsesByStateKey[currentCanonicalStateKey] ?? null;

  const assessmentView = useMemo(
    () =>
      resolveAssessmentView({
        scenario,
        snapshot,
        sourceMode,
        aiResponse: activeAIResponse,
        viewingAuthoredOverride,
      }),
    [scenario, snapshot, sourceMode, activeAIResponse, viewingAuthoredOverride],
  );

  const handleRequestAIAnalysis = async (options?: { isExplicitNewAttempt?: boolean }) => {
    if (isAIRequestLoading) return;
    if (currentCheckpoint === 'outcome' && !selectedInterventionId) return;

    // Honor retryAfter waiting period: disable submission while waiting period is active
    const retryUntil = retryUntilByStateKey[currentCanonicalStateKey] ?? 0;
    if (Date.now() < retryUntil) {
      return;
    }

    const previousResponse = aiResponsesByStateKey[currentCanonicalStateKey];
    const isTerminal = isConfirmedTerminalBackendStatus(previousResponse);

    // Centralized Request ID rules:
    // - Preserve existing requestId for ambiguous outcomes:
    //   client_deadline_exceeded, callable deadlines, network transport drops, and pending leases.
    // - Allocate a fresh UUID requestId ONLY for:
    //   1. Initial request (no requestId exists yet for this canonical state)
    //   2. Explicitly requested new attempt after a confirmed terminal failure (disabled, quota_reached, etc.)
    let requestId = requestIdsByStateKey[currentCanonicalStateKey];
    if (!requestId || (isTerminal && Boolean(options?.isExplicitNewAttempt))) {
      const freshId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      requestId = freshId;
      setRequestIdsByStateKey((prev) => ({
        ...prev,
        [currentCanonicalStateKey]: freshId,
      }));
    }

    // Allocate new invocation identity
    const invocationId = ++invocationCounterRef.current;
    activeInvocationIdRef.current = invocationId;

    const clickTimeMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const abortController = new AbortController();
    inFlightControllerRef.current = abortController;
    setIsAIRequestLoading(true);

    if (typeof window !== 'undefined') {
      (window as unknown as { __CHAOS_AI_LAST_TIMING__?: unknown }).__CHAOS_AI_LAST_TIMING__ = {
        status: 'in_flight',
        requestId,
        invocationId,
        checkpoint: currentCheckpoint,
        clickTimestampMs: clickTimeMs,
      };
    }

    const deadlineMs = clientDeadlineMs ?? DEFAULT_CLIENT_ANALYSIS_DEADLINE_MS;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const deadlinePromise = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Client analysis deadline exceeded (${deadlineMs}ms).`));
      }, deadlineMs);
    });

    const expectedState: ExpectedCanonicalState = {
      incidentId: scenario.incidentId,
      scenarioVersion: scenario.scenarioVersion,
      engineVersion: ENGINE_VERSION,
      checkpoint: currentCheckpoint,
      selectedInterventionId: currentCheckpoint === 'outcome' ? selectedInterventionId : null,
    };

    const requestPayload = buildPublicAnalyzeRequest({
      incidentId: scenario.incidentId,
      scenarioVersion: scenario.scenarioVersion,
      engineVersion: ENGINE_VERSION,
      checkpoint: currentCheckpoint,
      selectedInterventionId,
      requestId,
    });

    try {
      const rawResponse = await Promise.race([
        transport.analyzeIncident(requestPayload, abortController.signal),
        deadlinePromise,
      ]);

      const tTransportDone = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const transportDurationMs = Math.max(0, tTransportDone - clickTimeMs);

      clearTimeout(deadlineTimer);

      // Verify that this invocation still owns the active request
      if (activeInvocationIdRef.current !== invocationId) {
        return;
      }

      // Reconstruct the canonical checkpoint snapshot (rather than arbitrary playback tick)
      const canonicalSnapshot = buildSnapshot({
        scenario,
        seed: scenario.defaultSeed,
        simTimeSeconds: CHECKPOINT_TIMES[currentCheckpoint],
        selectedInterventionId: currentCheckpoint === 'outcome' ? selectedInterventionId : null,
      });

      // Validate runtime response as untrusted data against canonical checkpoint snapshot
      const tValStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const normalized = normalizeValidatedResponse(rawResponse, expectedState, canonicalSnapshot);
      const tValDone = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const validationDurationMs = Math.max(0, tValDone - tValStart);

      const transportTiming =
        (firebaseTransportRef.current as { getTimingForRequest?: (id: string) => TransportTimingEntry | null })
          ?.getTimingForRequest?.(requestId) ??
        (firebaseTransportRef.current as { getLastTiming?: () => TransportTimingEntry | null })
          ?.getLastTiming?.() ??
        null;

      const timingRecord = {
        status: 'completed' as const,
        requestId,
        invocationId,
        checkpoint: currentCheckpoint,
        clickTimestampMs: clickTimeMs,
        transportDurationMs,
        validationDurationMs,
        domCommittedMs: null as number | null,
        clickToDomCommittedMs: null as number | null,
        renderSettledMs: null as number | null,
        clickToRenderDurationMs: null as number | null,
        transportTiming,
        response: {
          status: normalized.status,
          reasonCode: normalized.reasonCode ?? null,
          cacheHit: Boolean(normalized.cacheHit),
          message: normalized.message ?? null,
          incidentId: normalized.incidentId,
          checkpoint: normalized.checkpoint,
          selectedInterventionId: normalized.selectedInterventionId,
          requestId: (normalized as { requestId?: string }).requestId ?? requestId,
        },
        stageObservability: {
          clickToTransport: 'observable' as const,
          sdkImport: 'observable' as const,
          authAndAppCheck: 'observable_aggregate (individual reCAPTCHA script eval/risk scoring is unobservable in SDK)' as const,
          callableAndTokenExecution: 'observable (includes SDK token readiness and HTTPS callable roundtrip)' as const,
          validation: 'observable' as const,
          domCommit: 'observable (useLayoutEffect immediate post-DOM commit)' as const,
          renderSettlement: 'approximate (requestAnimationFrame scheduled from matching DOM commit)' as const,
        },
      };

      pendingTimingRecordRef.current = timingRecord;

      if (typeof window !== 'undefined') {
        (window as unknown as { __CHAOS_AI_LAST_TIMING__?: typeof timingRecord }).__CHAOS_AI_LAST_TIMING__ = timingRecord;
        (window as unknown as { __CHAOS_AI_LAST_RESPONSE__?: typeof normalized }).__CHAOS_AI_LAST_RESPONSE__ = normalized;
      }

      if (typeof normalized.retryAfterMs === 'number' && normalized.retryAfterMs > 0) {
        setRetryUntilByStateKey((prev) => ({
          ...prev,
          [currentCanonicalStateKey]: Date.now() + normalized.retryAfterMs!,
        }));
      }

      setAiResponsesByStateKey((prev) => ({
        ...prev,
        [currentCanonicalStateKey]: normalized,
      }));
      setViewingAuthoredOverride(false);
    } catch (err: unknown) {
      clearTimeout(deadlineTimer);

      if (activeInvocationIdRef.current !== invocationId) {
        return;
      }

      pendingTimingRecordRef.current = null;

      if (typeof window !== 'undefined') {
        const prevTiming = (window as unknown as { __CHAOS_AI_LAST_TIMING__?: { status?: string } })
          ?.__CHAOS_AI_LAST_TIMING__;
        if (prevTiming?.status === 'in_flight') {
          (window as unknown as { __CHAOS_AI_LAST_TIMING__?: unknown }).__CHAOS_AI_LAST_TIMING__ = {
            status: err instanceof DOMException && err.name === 'AbortError' ? 'cancelled' : 'failed',
            requestId,
            invocationId,
            checkpoint: currentCheckpoint,
            clickTimestampMs: clickTimeMs,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }

      const isDeadlineError =
        err instanceof Error && err.message.includes('Client analysis deadline exceeded');

      const failureResponse: AnalyzeIncidentResponse = isDeadlineError
        ? {
            status: 'timeout',
            incidentId: scenario.incidentId,
            checkpoint: currentCheckpoint,
            selectedInterventionId: currentCheckpoint === 'outcome' ? selectedInterventionId : null,
            cacheHit: false,
            isMockProvider: false,
            reasonCode: 'client_deadline_exceeded',
            message: `Request exceeded client deadline (${deadlineMs}ms). Deterministic authored walkthrough is active. (Client-side deadline does not cancel server-side processing).`,
            serverTimeIso: new Date().toISOString(),
          }
        : {
            status: 'unavailable',
            incidentId: scenario.incidentId,
            checkpoint: currentCheckpoint,
            selectedInterventionId: currentCheckpoint === 'outcome' ? selectedInterventionId : null,
            cacheHit: false,
            isMockProvider: false,
            reasonCode: 'transport_failure',
            message: err instanceof Error ? err.message : 'Communication error',
            serverTimeIso: new Date().toISOString(),
          };

      setAiResponsesByStateKey((prev) => ({
        ...prev,
        [currentCanonicalStateKey]: failureResponse,
      }));
      if (typeof window !== 'undefined') {
        (window as unknown as { __CHAOS_AI_LAST_RESPONSE__?: typeof failureResponse }).__CHAOS_AI_LAST_RESPONSE__ = failureResponse;
      }
    } finally {
      if (activeInvocationIdRef.current === invocationId) {
        inFlightControllerRef.current = null;
        setIsAIRequestLoading(false);
      }
    }
  };

  const canonicalSnapshotDigests = useMemo(() => {
    const states = [
      { key: 'alert@03:00', time: CHECKPOINT_TIMES.alert, action: null },
      { key: 'evidence@06:00', time: CHECKPOINT_TIMES.evidence, action: null },
      ...scenario.interventions.map((act) => ({
        key: `outcome@15:00:${act.id}` as const,
        time: CHECKPOINT_TIMES.outcome,
        action: act.id,
      })),
    ];

    return states.map((st) => {
      const snap = buildSnapshot({
        scenario,
        seed: scenario.defaultSeed,
        simTimeSeconds: st.time,
        selectedInterventionId: st.action,
      });
      const serialized = JSON.stringify(snap);
      return {
        key: st.key,
        digest: fnv1aHex(serialized),
        jsonLength: serialized.length,
      };
    });
  }, [scenario]);

  // Compressed playback loop: pauses automatically at Alert (03:00), Evidence (06:00), and Outcome (15:00)
  useEffect(() => {
    if (!isPlaying) return;

    const intervalMs = playbackSpeed === 2 ? 180 : 350;
    const timer = window.setInterval(() => {
      setSimTimeSeconds((prev) => {
        const nextRaw = prev + TICK_STEP_SECONDS;

        // Auto-pause at Alert (03:00)
        if (prev < CHECKPOINT_TIMES.alert && nextRaw >= CHECKPOINT_TIMES.alert) {
          setIsPlaying(false);
          return CHECKPOINT_TIMES.alert;
        }

        // Auto-pause at Evidence (06:00)
        if (prev < CHECKPOINT_TIMES.evidence && nextRaw >= CHECKPOINT_TIMES.evidence) {
          setIsPlaying(false);
          if (!selectedInterventionId) {
            setDecisionGatePrompted(true);
          }
          return CHECKPOINT_TIMES.evidence;
        }

        // Enforce 06:00 decision gate if already at 06:00 without a selected intervention
        if (prev >= CHECKPOINT_TIMES.evidence && !selectedInterventionId) {
          setIsPlaying(false);
          setDecisionGatePrompted(true);
          return CHECKPOINT_TIMES.evidence;
        }

        // Auto-pause at Outcome (15:00)
        if (nextRaw >= CHECKPOINT_TIMES.outcome) {
          setIsPlaying(false);
          return CHECKPOINT_TIMES.outcome;
        }

        return clampSimulationTime(nextRaw, scenario, selectedInterventionId);
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, playbackSpeed, scenario, selectedInterventionId]);

  const handleFocusInterventionPanel = () => {
    setMobileTab('analysis');
    window.setTimeout(() => {
      const el = document.getElementById('intervention-decision-heading');
      const prefersReducedMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el?.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'nearest',
      });
      el?.focus({ preventScroll: true });
    }, 40);
  };

  const handleFocusDebrief = () => {
    const el = document.getElementById('debrief-heading');
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
    el?.focus({ preventScroll: true });
  };

  const handleOpenBriefing = () => {
    openedViaTriggerRef.current = true;
    setIsPlaying(false);
    if (isTourOpen) {
      setIsTourOpen(false);
      setMobileTab(preTourMobileTabRef.current);
    }
    setIsBriefingOpen(true);
  };

  const handleDismissBriefing = () => {
    saveMissionBriefingDismissed();
    setIsBriefingOpen(false);
    setIsPlaying(false);
    window.setTimeout(() => {
      if (openedViaTriggerRef.current) {
        briefingTriggerRef.current?.focus();
      } else {
        playButtonRef.current?.focus();
      }
    }, 0);
  };

  const handleStartTourFromHeader = () => {
    setIsPlaying(false);
    setIsBriefingOpen(false);
    preTourMobileTabRef.current = mobileTab;
    tourOriginRef.current = 'header';
    setTourStepIndex(0);
    setIsTourOpen(true);
  };

  const handleStartTourFromBriefing = () => {
    saveMissionBriefingDismissed();
    setIsPlaying(false);
    setIsBriefingOpen(false);
    preTourMobileTabRef.current = mobileTab;
    tourOriginRef.current = 'briefing';
    setTourStepIndex(0);
    setIsTourOpen(true);
  };

  const handleSelectTourStep = (nextIndex: number) => {
    const clamped = Math.max(0, Math.min(GUIDED_TOUR_STEPS.length - 1, nextIndex));
    setTourStepIndex(clamped);
    const targetStep = GUIDED_TOUR_STEPS[clamped];
    if (targetStep?.mobileTab) {
      setMobileTab(targetStep.mobileTab);
    } else {
      setMobileTab(preTourMobileTabRef.current);
    }
  };

  const handleCloseTour = (status: 'dismissed' | 'completed') => {
    const activeStep = GUIDED_TOUR_STEPS[tourStepIndex];
    saveGuidedTourPreference(status, activeStep?.id);
    setIsTourOpen(false);
    setIsPlaying(false);
    setMobileTab(preTourMobileTabRef.current);
    window.setTimeout(() => {
      if (tourOriginRef.current === 'header') {
        tourTriggerRef.current?.focus();
      } else {
        playButtonRef.current?.focus();
      }
    }, 0);
  };

  const handleTogglePlay = () => {
    if (simTimeSeconds >= CHECKPOINT_TIMES.evidence && selectedInterventionId === null) {
      setDecisionGatePrompted(true);
      setIsPlaying(false);
      handleFocusInterventionPanel();
      return;
    }
    if (simTimeSeconds >= MAX_SIMULATION_SECONDS) {
      // Restart from 00:00 if Play is clicked at 15:00
      setSimTimeSeconds(0);
      setIsPlaying(true);
      return;
    }
    setIsPlaying((p) => !p);
  };

  const handleJumpToTime = (requestedSeconds: number) => {
    invalidateInFlightRequest();
    setIsPlaying(false);
    if (requestedSeconds > CHECKPOINT_TIMES.evidence && selectedInterventionId === null) {
      setSimTimeSeconds(CHECKPOINT_TIMES.evidence);
      setDecisionGatePrompted(true);
      handleFocusInterventionPanel();
      return;
    }
    setDecisionGatePrompted(false);
    setSimTimeSeconds(clampSimulationTime(requestedSeconds, scenario, selectedInterventionId));
  };

  const handleJumpNextCheckpoint = () => {
    invalidateInFlightRequest();
    setIsPlaying(false);
    const next = getNextCheckpointTarget(simTimeSeconds, scenario, selectedInterventionId);
    setSimTimeSeconds(next.targetSeconds);
    if (next.blockedByDecision) {
      setDecisionGatePrompted(true);
      handleFocusInterventionPanel();
    } else {
      setDecisionGatePrompted(false);
    }
  };

  const handleScrubChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    invalidateInFlightRequest();
    const requested = Number(e.target.value);
    setIsPlaying(false);
    if (requested > CHECKPOINT_TIMES.evidence && selectedInterventionId === null) {
      setSimTimeSeconds(CHECKPOINT_TIMES.evidence);
      setDecisionGatePrompted(true);
      return;
    }
    setDecisionGatePrompted(false);
    setSimTimeSeconds(clampSimulationTime(requested, scenario, selectedInterventionId));
  };

  const handleSelectIntervention = (interventionId: string, jumpToOutcome: boolean) => {
    invalidateInFlightRequest();
    setSelectedInterventionId(interventionId);
    setDecisionGatePrompted(false);
    if (jumpToOutcome) {
      setIsPlaying(false);
      setSimTimeSeconds(CHECKPOINT_TIMES.outcome);
    } else {
      setSimTimeSeconds(CHECKPOINT_TIMES.evidence + TICK_STEP_SECONDS);
      setIsPlaying(true);
    }
  };

  const handleResetInvestigation = () => {
    invalidateInFlightRequest();
    setIsPlaying(false);
    setSelectedInterventionId(null);
    setDecisionGatePrompted(false);
    setSimTimeSeconds(0);
    setSelectedServiceId(null);
    setSelectedTypeFilter('all');
    setHighlightedEvidenceId(null);
    setViewingAuthoredOverride(false);
  };

  const handleSwitchScenario = (newScenarioId: string) => {
    invalidateInFlightRequest();
    setIsPlaying(false);
    setSelectedScenarioId(newScenarioId);
    setSelectedInterventionId(null);
    setDecisionGatePrompted(false);
    setSimTimeSeconds(0);
    setSelectedServiceId(null);
    setSelectedTypeFilter('all');
    setPinnedIds([]);
    setHighlightedEvidenceId(null);
    setViewingAuthoredOverride(false);
  };

  const handleTogglePin = (evidenceId: string) => {
    setPinnedIds((prev) =>
      prev.includes(evidenceId) ? prev.filter((id) => id !== evidenceId) : [...prev, evidenceId],
    );
  };

  const handleOpenCitation = (evidenceId: string) => {
    setSelectedServiceId(null);
    setSelectedTypeFilter('all');
    setHighlightedEvidenceId(evidenceId);
    setMobileTab('evidence');
    window.setTimeout(() => {
      const el = document.getElementById(`evidence-card-${evidenceId}`);
      const prefersReducedMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el?.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'nearest',
      });
      el?.focus({ preventScroll: true });
    }, 50);
  };

  const handleMobileTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const order: MobileWorkspaceTab[] = ['system', 'evidence', 'analysis'];
    const idx = order.indexOf(mobileTab);
    let nextTab: MobileWorkspaceTab | null = null;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextTab = order[(idx + 1) % order.length]!;
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nextTab = order[(idx - 1 + order.length) % order.length]!;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextTab = order[0]!;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextTab = order[order.length - 1]!;
    }
    if (nextTab) {
      setMobileTab(nextTab);
      const tabEl = document.getElementById(`tab-${nextTab}`);
      tabEl?.focus();
    }
  };

  const errorRatePercent = (snapshot.measures.reservationErrorRate * 100).toFixed(1);
  const errorMetricState =
    snapshot.measures.reservationErrorRate >= 0.15
      ? 'failing'
      : snapshot.measures.reservationErrorRate > 0
        ? 'degraded'
        : 'healthy';
  const latencyMetricState =
    (snapshot.measures.apiP95LatencyMs ?? 0) >= 1800
      ? 'failing'
      : (snapshot.measures.apiP95LatencyMs ?? 0) >= 400
        ? 'degraded'
        : 'healthy';
  const backlogMetricState =
    snapshot.measures.confirmationBacklog >= 150
      ? 'failing'
      : snapshot.measures.confirmationBacklog >= 30
        ? 'degraded'
        : 'healthy';

  const activeBranchOption = scenario.interventions.find(
    (opt) => opt.id === snapshot.selectedInterventionId,
  );
  const activeBranchLabel = activeBranchOption ? activeBranchOption.shortLabel : 'None selected yet';

  const guidance = useMemo(
    () =>
      resolveNextStepGuidance({
        simTimeSeconds: snapshot.simTimeSeconds,
        isPlaying,
        selectedInterventionId: snapshot.selectedInterventionId,
        awaitingInterventionDecision: snapshot.awaitingInterventionDecision,
        decisionGatePrompted,
        thirdInterventionLabel: scenario.interventions[2]?.label,
      }),
    [
      snapshot.simTimeSeconds,
      isPlaying,
      snapshot.selectedInterventionId,
      snapshot.awaitingInterventionDecision,
      decisionGatePrompted,
      scenario.interventions,
    ],
  );

  return (
    <div className="app-shell">
      {/* Static Decorative Motherboard Circuitry around Workspace Edges */}
      <div className="circuit-backdrop" aria-hidden="true">
        <svg
          className="circuit-edge-svg"
          viewBox="0 0 1600 960"
          preserveAspectRatio="xMidYMid slice"
        >
          <g stroke="#1e40af" strokeWidth="1.4" fill="none">
            {/* Left edge circuit traces & right-angle paths */}
            <path d="M 0 68 L 54 68 L 82 96 L 82 240 L 46 276 L 46 430" />
            <path d="M 0 140 L 32 140 L 58 166 L 58 310 L 24 344 L 24 560" />
            <path d="M 0 720 L 48 720 L 78 690 L 78 540" />
            {/* Right edge circuit traces & right-angle paths */}
            <path d="M 1600 84 L 1542 84 L 1514 112 L 1514 280 L 1550 316 L 1550 480" />
            <path d="M 1600 172 L 1564 172 L 1538 198 L 1538 380 L 1572 414 L 1572 620" />
            <path d="M 1600 760 L 1548 760 L 1518 730 L 1518 560" />
          </g>
          {/* Connection pads & via rings */}
          <g stroke="#38bdf8" strokeWidth="1.4" fill="#040915">
            <circle cx="82" cy="96" r="4" />
            <circle cx="46" cy="430" r="4.5" />
            <circle cx="58" cy="166" r="3.5" />
            <circle cx="24" cy="560" r="4" />
            <circle cx="78" cy="540" r="4.5" />
            <circle cx="1514" cy="112" r="4" />
            <circle cx="1550" cy="480" r="4.5" />
            <circle cx="1538" cy="198" r="3.5" />
            <circle cx="1572" cy="620" r="4" />
            <circle cx="1518" cy="560" r="4.5" />
          </g>
        </svg>
      </div>

      <a
        href="#investigation-main"
        className="skip-link visually-hidden"
        onClick={(e) => {
          e.preventDefault();
          const mainEl = document.getElementById('investigation-main');
          mainEl?.focus();
        }}
      >
        Skip to investigation workspace
      </a>

      {/* Header & Prominent Wordmark Console Bar */}
      <header id="tour-anchor-header" data-tour-anchor="header-context" className="top-header">
        <svg
          className="header-circuit-overlay"
          viewBox="0 0 520 120"
          preserveAspectRatio="xMaxYMid slice"
          aria-hidden="true"
        >
          <g stroke="#2563eb" strokeWidth="1.3" fill="none">
            <path d="M 520 18 L 410 18 L 388 40 L 290 40" />
            <path d="M 520 52 L 442 52 L 420 74 L 336 74" />
            <path d="M 520 92 L 468 92 L 448 112 L 380 112" />
          </g>
          <g stroke="#38bdf8" strokeWidth="1.4" fill="#0a1428">
            <circle cx="290" cy="40" r="3.5" />
            <circle cx="336" cy="74" r="3.5" />
            <circle cx="380" cy="112" r="3.5" />
            <rect x="406" y="14" width="7" height="7" rx="1" />
            <rect x="438" y="48" width="7" height="7" rx="1" />
          </g>
        </svg>

        <div className="header-main-bar">
          <div className="brand-identity">
            <span className="brand-wordmark">
              <span className="brand-wordmark-node" aria-hidden="true" />
              CHAOS ROOM
            </span>

            <div className="incident-heading-group">
              <h1 className="incident-title">
                Incident Investigation: “{snapshot.symptomTitle}”
              </h1>
            </div>
          </div>

          <div className="header-badges">
            <div className="scenario-selector-box">
              <label htmlFor="scenario-selector-input" className="scenario-selector-label mono">
                Incident:
              </label>
              <select
                id="scenario-selector-input"
                className="scenario-selector-select mono"
                value={selectedScenarioId}
                onChange={(e) => handleSwitchScenario(e.target.value)}
                aria-label="Select incident scenario to investigate"
              >
                {SCENARIOS.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              ref={briefingTriggerRef}
              type="button"
              className="btn btn-sm mission-briefing-btn"
              onClick={handleOpenBriefing}
            >
              Mission briefing
            </button>

            <button
              ref={tourTriggerRef}
              type="button"
              className="btn btn-sm guided-tour-btn"
              data-tour-trigger="header"
              onClick={handleStartTourFromHeader}
            >
              Guided tour
            </button>

            <span className="synthetic-badge">Fictional system · Synthetic data</span>
            <span
              className="mono"
              style={{
                fontSize: '0.74rem',
                color: 'var(--color-cyan-bright)',
                padding: '0.14rem 0.5rem',
                borderRadius: '4px',
                background: 'var(--bg-surface-subtle)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {snapshot.incidentId}
            </span>

            <details style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <summary style={{ fontWeight: 600 }}>System &amp; Version Details</summary>
              <div
                className="mono"
                style={{
                  marginBlockStart: '0.35rem',
                  padding: '0.5rem 0.65rem',
                  background: 'var(--bg-surface-subtle)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.72rem',
                }}
              >
                <div>
                  Incident: {snapshot.incidentId} · Scenario v{snapshot.scenarioVersion} · Engine v
                  {snapshot.engineVersion} · Seed {snapshot.seed}
                </div>
                <div style={{ marginBlockStart: '0.2rem' }}>
                  Modeling note: Happy-path assumes atomic reservation write + event enqueue;
                  dual-write partial failure is outside MVP scope.
                </div>
                <div style={{ marginBlockStart: '0.35rem', color: 'var(--text-secondary)' }}>
                  Browser Canonical Snapshot Digests (FNV-1a / byte length):
                  {canonicalSnapshotDigests.map((item) => (
                    <div key={item.key} data-testid={`canonical-digest-${item.key}`}>
                      {item.key}: {item.digest} ({item.jsonLength}B)
                    </div>
                  ))}
                </div>
              </div>
            </details>
          </div>
        </div>

        {/* Customer Impact Status Banner */}
        <div className="impact-banner" data-severity={snapshot.severity}>
          <div role="status">
            <strong
              style={{
                textTransform: 'uppercase',
                fontSize: '0.74rem',
                letterSpacing: '0.04em',
              }}
            >
              [{snapshot.severity}]
            </strong>{' '}
            <span>{snapshot.customerImpactBanner}</span>
          </div>
          <span className="mono" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
            Sim clock: <strong>{snapshot.formattedTime}</strong> / 15:00 · Follow the evidence &amp;
            test your response
          </span>
        </div>
      </header>

      <main
        id="investigation-main"
        tabIndex={-1}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.65rem',
          inlineSize: '100%',
          maxInlineSize: '100%',
          minInlineSize: 0,
          boxSizing: 'border-box',
        }}
      >
        {/* Simplified Headline Metric Cards (4-up desktop, 2x2 mobile grid) */}
        <section
          id="tour-anchor-metrics"
          data-tour-anchor="headline-metrics"
          aria-label="Headline operational measures"
        >
          <div className="metric-strip">
            <article className="metric-card" data-state={errorMetricState}>
              <div className="metric-header">
                <span className="metric-label">Reservation failures</span>
                <span className="metric-window-tag mono">Trailing 60s</span>
              </div>
              <div className="metric-value">{errorRatePercent}%</div>
              <div className="metric-description">Failed attempts in the trailing 60 seconds</div>
              <div className="metric-subtext mono">
                {snapshot.measures.windowFailedAttempts} / {snapshot.measures.windowAttempts} failed
                attempts
              </div>
            </article>

            <article className="metric-card" data-state={latencyMetricState}>
              <div className="metric-header">
                <span className="metric-label">Response time</span>
                <span className="metric-window-tag mono">p95 · Trailing 60s</span>
              </div>
              <div className="metric-value">
                {snapshot.measures.apiP95LatencyMs !== null
                  ? `${snapshot.measures.apiP95LatencyMs.toLocaleString()} ms`
                  : 'No data'}
              </div>
              <div className="metric-description">API latency, 95th percentile</div>
              <div className="metric-subtext mono">Gateway timeout: 2,500 ms</div>
            </article>

            <article className="metric-card" data-state={backlogMetricState}>
              <div className="metric-header">
                <span className="metric-label">Pending confirmations</span>
                <span className="metric-window-tag mono">Current @ {snapshot.formattedTime}</span>
              </div>
              <div className="metric-value">{snapshot.measures.confirmationBacklog}</div>
              <div className="metric-description">Messages awaiting delivery</div>
              <div className="metric-subtext mono">
                {scenario.incidentId === 'incident-003'
                  ? typeof snapshot.measures.quarantinedBacklog === 'number' &&
                    snapshot.measures.quarantinedBacklog > 0
                    ? `${snapshot.measures.quarantinedBacklog} quarantined awaiting replay (${snapshot.measures.replayedDeliveries ?? 0} replayed)`
                    : typeof snapshot.measures.replayedDeliveries === 'number' &&
                        snapshot.measures.replayedDeliveries > 0
                      ? `${snapshot.measures.replayedDeliveries} adapted replays delivered`
                      : 'Queued in confirmation backlog'
                  : 'Queued in confirmation backlog'}
              </div>
            </article>

            <article
              className="metric-card"
              data-state={snapshot.measures.affectedReservations > 0 ? 'degraded' : 'healthy'}
            >
              <div className="metric-header">
                <span className="metric-label">Reservations impacted</span>
                <span className="metric-window-tag mono">Cumulative</span>
              </div>
              <div className="metric-value">{snapshot.measures.affectedReservations}</div>
              <div className="metric-description">Unique reservations affected so far</div>
              <div className="metric-subtext mono">
                {scenario.incidentId === 'incident-002' || scenario.incidentId === 'incident-003'
                  ? 'Confirmation delay > 30s threshold'
                  : 'Unique IDs (retries deduplicated)'}
              </div>
            </article>
          </div>

          {/* Secondary Diagnostic Bar with Readable Action Name */}
          <div className="secondary-diag-bar mono">
            {scenario.incidentId === 'incident-002' ? (
              <>
                <span>
                  Provider Latency (p95):{' '}
                  <strong style={{ color: 'var(--color-cyan-bright)' }}>
                    {snapshot.measures.providerP95LatencyMs ?? 125} ms
                  </strong>
                </span>
                <span>
                  Delivery Retry Amp (60s):{' '}
                  <strong>{snapshot.measures.retryAmplification.toFixed(2)}x</strong>
                </span>
                <span>
                  Queue Age (p95): <strong>{snapshot.measures.queueAgeP95Seconds ?? 0}s</strong>
                </span>
                <span>
                  Active Response: <strong>{activeBranchLabel}</strong>
                </span>
              </>
            ) : scenario.incidentId === 'incident-003' ? (
              <>
                <span>
                  Validation Failures (60s):{' '}
                  <strong style={{ color: 'var(--color-cyan-bright)' }}>
                    {typeof snapshot.measures.validationErrorAttempts === 'number' &&
                    typeof snapshot.measures.validationErrorUniqueMessages === 'number'
                      ? `${snapshot.measures.validationErrorAttempts.toLocaleString()} (${snapshot.measures.validationErrorUniqueMessages} uniq msgs)`
                      : 'Unavailable'}
                  </strong>
                </span>
                <span>
                  Queue Age (p95):{' '}
                  <strong>
                    {typeof snapshot.measures.queueAgeP95Seconds === 'number'
                      ? `${snapshot.measures.queueAgeP95Seconds}s`
                      : 'Unavailable'}
                  </strong>
                </span>
                <span>
                  Quarantined / Replayed:{' '}
                  <strong>
                    {typeof snapshot.measures.quarantinedBacklog === 'number' &&
                    typeof snapshot.measures.replayedDeliveries === 'number'
                      ? `${snapshot.measures.quarantinedBacklog} / ${snapshot.measures.replayedDeliveries}`
                      : 'Unavailable'}
                  </strong>
                </span>
                <span>
                  Active Response: <strong>{activeBranchLabel}</strong>
                </span>
              </>
            ) : scenario.incidentId === 'incident-001' ? (
              <>
                <span>
                  Inventory DB Pool:{' '}
                  <strong style={{ color: 'var(--color-cyan-bright)' }}>
                    {snapshot.measures.activeDbConnections} / {snapshot.measures.maxDbConnections}{' '}
                    connections
                  </strong>
                </span>
                <span>
                  Inventory DB CPU: <strong>{snapshot.measures.dbCpuPercent}%</strong>
                </span>
                <span>
                  Confirmation Retry Amp (60s):{' '}
                  <strong>{snapshot.measures.retryAmplification.toFixed(2)}x</strong>
                </span>
                <span>
                  Active Response: <strong>{activeBranchLabel}</strong>
                </span>
              </>
            ) : (
              <span>
                Active Response: <strong>{activeBranchLabel}</strong>
              </span>
            )}
          </div>
        </section>

        {/* Shared Simulation Timeline & Checkpoint Controls (Accessible across all desktop panels and mobile tabs) */}
        <section
          id="tour-anchor-timeline"
          data-tour-anchor="timeline-controls"
          className="timeline-card"
          aria-label="Simulation timeline and checkpoint controls"
        >
          <div className="timeline-header-row">
            <div className="timeline-heading-group">
              <span className="timeline-title mono">INCIDENT TIMELINE</span>
              <span className="timeline-accel-note">
                Accelerated simulation time — not a countdown or real-time wait
              </span>
            </div>
            <span className="mono clock-pill">{isPlaying ? '▶ LIVE PLAYBACK' : '⏸ PAUSED'}</span>
          </div>

          <div className="timeline-compact-grid">
            <div className="scrubber-row">
              <label htmlFor="sim-timeline-scrubber" className="clock-readout">
                {snapshot.formattedTime} / 15:00
              </label>
              <input
                id="sim-timeline-scrubber"
                type="range"
                className="scrubber-input"
                min={0}
                max={MAX_SIMULATION_SECONDS}
                step={TICK_STEP_SECONDS}
                value={snapshot.simTimeSeconds}
                onChange={handleScrubChange}
                aria-valuetext={`${snapshot.formattedTime} simulated time`}
              />
            </div>

            <div className="timeline-controls-row">
              <div className="playback-btn-group">
                <button
                  ref={playButtonRef}
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-initial-play={snapshot.simTimeSeconds === 0 && !isPlaying}
                  onClick={handleTogglePlay}
                >
                  {isPlaying ? '⏸ Pause' : '▶ Play'}
                </button>

                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPlaybackSpeed((s) => (s === 1 ? 2 : 1))}
                  aria-label={`Playback pace: ${playbackSpeed === 1 ? 'Standard' : 'Fast'} (accelerated). Click to switch pace.`}
                >
                  Pace: {playbackSpeed === 1 ? 'Standard' : 'Fast'}
                </button>

                <button type="button" className="btn btn-sm" onClick={handleJumpNextCheckpoint}>
                  ⏭ Next Checkpoint
                </button>

                <button type="button" className="btn btn-sm" onClick={handleResetInvestigation}>
                  ↺ Reset (00:00)
                </button>
              </div>

              <div className="checkpoint-btn-group" role="group" aria-label="Canonical checkpoints">
                <button
                  type="button"
                  className="btn checkpoint-pill"
                  data-active={snapshot.simTimeSeconds < CHECKPOINT_TIMES.alert}
                  onClick={() => handleJumpToTime(0)}
                >
                  00:00 Orient
                </button>
                <button
                  type="button"
                  className="btn checkpoint-pill"
                  data-active={
                    snapshot.simTimeSeconds >= CHECKPOINT_TIMES.alert &&
                    snapshot.simTimeSeconds < CHECKPOINT_TIMES.evidence
                  }
                  onClick={() => handleJumpToTime(CHECKPOINT_TIMES.alert)}
                >
                  03:00 Alert
                </button>
                <button
                  type="button"
                  className="btn checkpoint-pill"
                  data-active={
                    snapshot.simTimeSeconds >= CHECKPOINT_TIMES.evidence &&
                    snapshot.simTimeSeconds < CHECKPOINT_TIMES.outcome
                  }
                  onClick={() => handleJumpToTime(CHECKPOINT_TIMES.evidence)}
                >
                  06:00 Evidence &amp; Intervene
                </button>
                <button
                  type="button"
                  className="btn checkpoint-pill"
                  data-active={snapshot.simTimeSeconds === CHECKPOINT_TIMES.outcome}
                  aria-disabled={selectedInterventionId === null}
                  onClick={() => handleJumpToTime(CHECKPOINT_TIMES.outcome)}
                >
                  15:00 Outcome &amp; Debrief {selectedInterventionId === null ? '🔒' : ''}
                </button>
              </div>
            </div>
          </div>

          <div
            className={`next-step-guidance${guidance.isDecisionGate ? ' decision-gate-notice' : ''}`}
            data-guidance-phase={guidance.phase}
          >
            <div className="guidance-message" role="status" aria-live="polite">
              {guidance.isDecisionGate ? (
                <>
                  <strong className="guidance-step-label">Decision Checkpoint at 06:00:</strong>{' '}
                  <span>
                    {guidance.message} Select one of the three response paths in{' '}
                    <strong>Assessment &amp; response</strong>
                    {guidance.thirdOptionLabel ? (
                      <>
                        {' '}
                        (including <em>“{guidance.thirdOptionLabel}”</em>)
                      </>
                    ) : null}{' '}
                    before advancing to 15:00.
                  </span>
                </>
              ) : (
                <>
                  <strong className="guidance-step-label mono">{guidance.stepLabel}:</strong>{' '}
                  <span>{guidance.message}</span>
                </>
              )}
            </div>
            {guidance.isDecisionGate && (
              <button
                type="button"
                className="btn btn-amber btn-sm"
                onClick={handleFocusInterventionPanel}
              >
                Choose response in Assessment &amp; response →
              </button>
            )}
            {guidance.phase === 'outcome' && (
              <button type="button" className="btn btn-sm" onClick={handleFocusDebrief}>
                Open debrief ↓
              </button>
            )}
          </div>
        </section>

        {/* Mobile/Tablet Workspace Switcher Tabs */}
        <div
          className="mobile-workspace-tabs"
          role="tablist"
          aria-label="Investigation workspace sections"
          onKeyDown={handleMobileTabKeyDown}
        >
          <button
            type="button"
            role="tab"
            id="tab-system"
            tabIndex={mobileTab === 'system' ? 0 : -1}
            aria-selected={mobileTab === 'system'}
            aria-controls="panel-system"
            onClick={() => setMobileTab('system')}
          >
            1. System map ({snapshot.services.filter((s) => s.health !== 'healthy').length})
          </button>
          <button
            type="button"
            role="tab"
            id="tab-evidence"
            tabIndex={mobileTab === 'evidence' ? 0 : -1}
            aria-selected={mobileTab === 'evidence'}
            aria-controls="panel-evidence"
            onClick={() => setMobileTab('evidence')}
          >
            2. Evidence ({snapshot.visibleEvidence.length})
          </button>
          <button
            type="button"
            role="tab"
            id="tab-analysis"
            tabIndex={mobileTab === 'analysis' ? 0 : -1}
            aria-selected={mobileTab === 'analysis'}
            aria-controls="panel-analysis"
            onClick={() => setMobileTab('analysis')}
          >
            3. Assessment &amp; response {snapshot.awaitingInterventionDecision ? '▲' : ''}
          </button>
        </div>

        {/* Reordered Workspace Grid: System map -> Evidence -> Assessment & response */}
        <div className="workspace-grid">
          {/* 1. System Map */}
          <div
            role="tabpanel"
            id="panel-system"
            data-tour-anchor="system-map"
            aria-labelledby="tab-system"
            className="workspace-panel system-map-panel"
            data-mobile-hidden={mobileTab !== 'system'}
          >
            <ServiceMapPanel
              services={snapshot.services}
              selectedServiceId={selectedServiceId}
              onSelectService={(svc) => {
                setSelectedServiceId(svc);
                if (svc) setMobileTab('evidence');
              }}
              oneSentenceJourney={scenario.oneSentenceJourney}
            />
          </div>

          {/* 2. Evidence & Telemetry Feed */}
          <div
            role="tabpanel"
            id="panel-evidence"
            data-tour-anchor="evidence-feed"
            aria-labelledby="tab-evidence"
            className="workspace-panel evidence-panel"
            data-mobile-hidden={mobileTab !== 'evidence'}
          >
            <EvidencePanel
              visibleEvidence={snapshot.visibleEvidence}
              timelineSeries={snapshot.timelineSeries}
              selectedServiceId={selectedServiceId}
              onClearServiceFilter={() => setSelectedServiceId(null)}
              selectedTypeFilter={selectedTypeFilter}
              onChangeTypeFilter={setSelectedTypeFilter}
              pinnedIds={pinnedIds}
              onTogglePin={handleTogglePin}
              highlightedEvidenceId={highlightedEvidenceId}
              chartConfig={scenario.chartConfig}
              scenarioIncidentId={scenario.incidentId}
            />
          </div>

          {/* 3. Assessment & Response */}
          <div
            role="tabpanel"
            id="panel-analysis"
            data-tour-anchor="assessment-gate"
            aria-labelledby="tab-analysis"
            className="workspace-panel assessment-panel"
            data-mobile-hidden={mobileTab !== 'analysis'}
          >
            <AssessmentPanel
              snapshot={snapshot}
              assessmentView={assessmentView}
              sourceMode={sourceMode}
              onChangeSourceMode={setSourceMode}
              onSelectIntervention={handleSelectIntervention}
              onJumpToAlert={() => handleJumpToTime(CHECKPOINT_TIMES.alert)}
              onOpenCitation={handleOpenCitation}
              isDevOrReviewEnvironment={isDevOrReviewEnvironment}
              onRequestAIAnalysis={handleRequestAIAnalysis}
              isAIRequestLoading={isAIRequestLoading}
              aiResponseStatus={activeAIResponse?.status ?? null}
              retryUntilMs={retryUntilByStateKey[currentCanonicalStateKey]}
              hasLiveOrCachedAI={Boolean(
                activeAIResponse &&
                  (activeAIResponse.status === 'ok' || activeAIResponse.status === 'cached'),
              )}
              isViewingAuthored={viewingAuthoredOverride}
              onToggleViewAuthored={setViewingAuthoredOverride}
              onRetryPending={handleRequestAIAnalysis}
            />
          </div>
        </div>

        {/* Deterministic Debrief Section (Unlocked at 15:00 Outcome) */}
        {snapshot.simTimeSeconds === CHECKPOINT_TIMES.outcome &&
          snapshot.selectedInterventionId !== null && (
            <DebriefPanel
              debrief={scenario.debrief}
              selectedInterventionId={snapshot.selectedInterventionId}
              onSwitchIntervention={(id) => handleSelectIntervention(id, true)}
              onResetInvestigation={handleResetInvestigation}
            />
          )}
      </main>

      <footer
        style={{
          marginBlockStart: '0.5rem',
          paddingBlockStart: '0.65rem',
          borderBlockStart: '1px solid var(--border-subtle)',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: '0.5rem',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
        }}
      >
        <span>
          Chaos Room · Fictional event-reservation incident simulator
        </span>
        <span>
          Deterministic engine v{snapshot.engineVersion} · Controlled AI incident investigation
        </span>
      </footer>

      <MissionBriefingDialog
        isOpen={isBriefingOpen}
        onDismiss={handleDismissBriefing}
        onStartTour={handleStartTourFromBriefing}
      />

      <GuidedTourDialog
        isOpen={isTourOpen}
        stepIndex={tourStepIndex}
        onSelectStep={handleSelectTourStep}
        onDismiss={() => handleCloseTour('dismissed')}
        onComplete={() => handleCloseTour('completed')}
      />
    </div>
  );
};
