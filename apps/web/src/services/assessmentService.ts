import {
  CHECKPOINT_TIMES,
  resolveSnapshotCheckpoint,
  validateAnalysisResult,
  type AnalysisResult,
  type AnalysisSourceMode,
  type AnalyzeIncidentResponse,
  type CheckpointId,
  type ScenarioDefinition,
  type Snapshot,
} from '@chaos-room/shared';

export interface AssessmentStatusBanner {
  tone: 'info' | 'amber' | 'red';
  badgeLabel: string;
  explanation: string;
  isDevPreview: boolean;
}

export interface ResolvedAssessmentView {
  checkpoint: CheckpointId;
  unlocked: boolean;
  result: AnalysisResult | null;
  cacheKey: string | null;
  statusBanner: AssessmentStatusBanner;
  authoredResult: AnalysisResult | null;
  hasLiveOrCachedAI: boolean;
}

export function resolveCheckpointAuthoredWalkthrough(
  scenario: ScenarioDefinition,
  snapshot: Snapshot,
): { checkpoint: CheckpointId; walkthrough: AnalysisResult } {
  const checkpoint = resolveSnapshotCheckpoint(snapshot);
  const baseWalkthrough =
    checkpoint === 'alert'
      ? scenario.walkthroughs.alert
      : checkpoint === 'evidence'
        ? scenario.walkthroughs.evidence
        : (scenario.walkthroughs.outcomes[snapshot.selectedInterventionId ?? ''] ??
          Object.values(scenario.walkthroughs.outcomes)[0]!);

  const validation = validateAnalysisResult(baseWalkthrough, snapshot);
  const validated: AnalysisResult = validation.valid
    ? baseWalkthrough
    : {
        ...baseWalkthrough,
        sourceMode: 'authored_walkthrough',
      };

  return { checkpoint, walkthrough: validated };
}

/**
 * Resolves the assessment view for the active snapshot.
 * Respects live/cached AI responses, failure/fallback states, and dev preview modes.
 * Durable visitor-facing copy is used throughout.
 */
export function resolveAssessmentView(params: {
  scenario: ScenarioDefinition;
  snapshot: Snapshot;
  sourceMode?: AnalysisSourceMode;
  aiResponse?: AnalyzeIncidentResponse | null;
  viewingAuthoredOverride?: boolean;
}): ResolvedAssessmentView {
  const { scenario, snapshot, sourceMode = 'authored_walkthrough', aiResponse, viewingAuthoredOverride } = params;

  if (snapshot.simTimeSeconds < CHECKPOINT_TIMES.alert) {
    return {
      checkpoint: 'alert',
      unlocked: false,
      result: null,
      cacheKey: null,
      authoredResult: null,
      hasLiveOrCachedAI: false,
      statusBanner: {
        tone: 'info',
        badgeLabel: 'Awaiting Alert checkpoint (03:00)',
        explanation:
          'Checkpoint assessment becomes available at the first alert (03:00). Response options unlock at Evidence (06:00).',
        isDevPreview: false,
      },
    };
  }

  const { checkpoint, walkthrough: baseWalkthrough } = resolveCheckpointAuthoredWalkthrough(scenario, snapshot);

  const authoredResult: AnalysisResult = {
    ...baseWalkthrough,
    sourceMode: 'authored_walkthrough',
    sourceBadgeLabel: 'Authored walkthrough',
    isPreviewMock: false,
  };

  // If viewing explicit dev preview modes
  if (sourceMode && sourceMode !== 'authored_walkthrough' && sourceMode !== 'live_generated') {
    switch (sourceMode) {
      case 'preview_cached_ai':
        return {
          checkpoint,
          unlocked: true,
          result: {
            ...authoredResult,
            sourceMode: 'preview_cached_ai',
            sourceBadgeLabel: 'Preview: Shared cached AI analysis (mocked)',
            isPreviewMock: true,
          },
          cacheKey: `preview|cached|${scenario.incidentId}|${checkpoint}`,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'amber',
            badgeLabel: 'DEV PREVIEW · Shared cache hit (mocked with authored content)',
            explanation:
              'Simulating a shared cache hit in the UI. Content shown is authored walkthrough text marked as a local preview.',
            isDevPreview: true,
          },
        };

      case 'preview_quota_reached':
        return {
          checkpoint,
          unlocked: true,
          result: {
            ...authoredResult,
            sourceMode: 'preview_quota_reached',
            sourceBadgeLabel: 'Authored walkthrough (AI quota reached fallback)',
            isPreviewMock: true,
          },
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'amber',
            badgeLabel: 'DEV PREVIEW · AI generation quota reached → Authored fallback',
            explanation:
              'Simulating generation quota exhaustion: deterministic authored walkthrough remains fully available.',
            isDevPreview: true,
          },
        };

      case 'preview_unavailable':
        return {
          checkpoint,
          unlocked: true,
          result: {
            ...authoredResult,
            sourceMode: 'preview_unavailable',
            sourceBadgeLabel: 'Authored walkthrough (AI backend unavailable)',
            isPreviewMock: true,
          },
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'red',
            badgeLabel: 'DEV PREVIEW · AI backend unavailable / timeout → Authored fallback',
            explanation:
              'Simulating a backend failure or client timeout: investigation continues using the authored walkthrough.',
            isDevPreview: true,
          },
        };

      case 'preview_malformed_fallback':
        return {
          checkpoint,
          unlocked: true,
          result: {
            ...authoredResult,
            sourceMode: 'preview_malformed_fallback',
            sourceBadgeLabel: 'Authored walkthrough (Malformed output rejected)',
            isPreviewMock: true,
          },
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'red',
            badgeLabel: 'DEV PREVIEW · Malformed output rejected by validator → Authored fallback',
            explanation:
              'Simulating rejected model output (e.g. ungrounded citations or schema mismatch): displays safe authored walkthrough.',
            isDevPreview: true,
          },
        };
    }
  }

  // Handle active AI response if present and matches current checkpoint & canonical intervention
  if (aiResponse) {
    const isStateMatch =
      aiResponse.incidentId === scenario.incidentId &&
      aiResponse.checkpoint === checkpoint &&
      (checkpoint === 'outcome'
        ? aiResponse.selectedInterventionId === snapshot.selectedInterventionId
        : aiResponse.selectedInterventionId === null);

    if (isStateMatch) {
      // If user explicitly chose to view the authored walkthrough tab while having an AI response
      if (viewingAuthoredOverride) {
        return {
          checkpoint,
          unlocked: true,
          result: authoredResult,
          cacheKey: aiResponse.cacheKey ?? null,
          authoredResult,
          hasLiveOrCachedAI: Boolean(aiResponse.result),
          statusBanner: {
            tone: 'info',
            badgeLabel: 'Authored baseline walkthrough',
            explanation:
              'Displaying the deterministic baseline assessment authored for this checkpoint. AI analysis is also available.',
            isDevPreview: false,
          },
        };
      }

      // Handle successful live AI or shared cached AI
      if ((aiResponse.status === 'ok' || aiResponse.status === 'cached') && aiResponse.result) {
        const isCached = aiResponse.status === 'cached' || aiResponse.cacheHit;
        const isLive = !isCached;
        const isMock = Boolean(aiResponse.isMockProvider || aiResponse.result.isPreviewMock);

        const badgeLabel = isMock
          ? isCached
            ? 'Local mock: Shared cached AI analysis'
            : 'Local mock: Generated AI analysis'
          : isCached
            ? 'Shared cached AI analysis (Gemini)'
            : 'Live AI analysis (Gemini)';

        const explanation = isMock
          ? isCached
            ? 'Retrieved simulated analysis from local mock cache.'
            : 'Simulated AI generation using local mock provider.'
          : isCached
            ? 'Retrieved previously generated and validated analysis from the shared cache.'
            : 'Fresh analysis generated and validated against canonical checkpoint evidence.';

        return {
          checkpoint,
          unlocked: true,
          result: {
            ...aiResponse.result,
            sourceMode: isLive ? 'live_generated' : 'preview_cached_ai',
            sourceBadgeLabel: badgeLabel,
            isPreviewMock: isMock,
          },
          cacheKey: aiResponse.cacheKey ?? null,
          authoredResult,
          hasLiveOrCachedAI: true,
          statusBanner: {
            tone: 'info',
            badgeLabel,
            explanation,
            isDevPreview: isMock,
          },
        };
      }

      // Handle specific backend failure / fallback statuses
      if (aiResponse.status === 'disabled') {
        const isLiveGenPaused = aiResponse.reasonCode === 'live_generation_disabled';
        return {
          checkpoint,
          unlocked: true,
          result: authoredResult,
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'amber',
            badgeLabel: isLiveGenPaused
              ? 'Live AI generation paused (Operational control)'
              : 'AI generation disabled (Operational control)',
            explanation:
              aiResponse.message ||
              (isLiveGenPaused
                ? 'Live AI generation is temporarily paused by operator control. Cached states remain available; displaying authored walkthrough for uncached states.'
                : 'Live AI generation is currently disabled by system control. Displaying the deterministic authored walkthrough.'),
            isDevPreview: false,
          },
        };
      }

      if (aiResponse.status === 'quota_reached') {
        return {
          checkpoint,
          unlocked: true,
          result: authoredResult,
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'amber',
            badgeLabel: 'AI generation limit reached',
            explanation:
              aiResponse.message ||
              'The generation budget or rate limit has been reached. Displaying the deterministic authored walkthrough.',
            isDevPreview: false,
          },
        };
      }

      if (aiResponse.status === 'pending') {
        return {
          checkpoint,
          unlocked: true,
          result: authoredResult,
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'amber',
            badgeLabel: 'AI analysis in progress on server',
            explanation:
              aiResponse.message ||
              'A generation lease is active on the server. You can check again or continue with the authored walkthrough.',
            isDevPreview: false,
          },
        };
      }

      if (aiResponse.status === 'timeout') {
        return {
          checkpoint,
          unlocked: true,
          result: authoredResult,
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'red',
            badgeLabel: 'AI request timed out',
            explanation:
              aiResponse.message ||
              'The AI analysis request exceeded the response deadline. Displaying the deterministic authored walkthrough.',
            isDevPreview: false,
          },
        };
      }

      if (aiResponse.status === 'invalid_output') {
        return {
          checkpoint,
          unlocked: true,
          result: authoredResult,
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'red',
            badgeLabel: 'Model output rejected by validator',
            explanation:
              aiResponse.message ||
              'The generated response failed schema or evidence citation grounding checks and was rejected. Displaying the authored walkthrough.',
            isDevPreview: false,
          },
        };
      }

      if (aiResponse.status === 'version_mismatch') {
        return {
          checkpoint,
          unlocked: true,
          result: authoredResult,
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'red',
            badgeLabel: 'Scenario/Engine version mismatch',
            explanation:
              aiResponse.message ||
              'Client version does not match the server expected version. Displaying the local authored walkthrough.',
            isDevPreview: false,
          },
        };
      }

      if (aiResponse.status === 'unavailable') {
        return {
          checkpoint,
          unlocked: true,
          result: authoredResult,
          cacheKey: null,
          authoredResult,
          hasLiveOrCachedAI: false,
          statusBanner: {
            tone: 'red',
            badgeLabel: 'AI service unavailable',
            explanation:
              aiResponse.message ||
              'The AI backend or authorization check is currently unavailable. Displaying the deterministic authored walkthrough.',
            isDevPreview: false,
          },
        };
      }
    }
  }

  // Default baseline authored walkthrough
  return {
    checkpoint,
    unlocked: true,
    result: authoredResult,
    cacheKey: null,
    authoredResult,
    hasLiveOrCachedAI: false,
    statusBanner: {
      tone: 'info',
      badgeLabel: 'Authored baseline walkthrough',
      explanation:
        'Displaying the deterministic baseline assessment authored for this canonical checkpoint.',
      isDevPreview: false,
    },
  };
}

/**
 * Backward compatibility alias for resolvePhase1Assessment.
 */
export function resolvePhase1Assessment(
  scenario: ScenarioDefinition,
  snapshot: Snapshot,
  sourceMode: AnalysisSourceMode,
): ResolvedAssessmentView {
  return resolveAssessmentView({ scenario, snapshot, sourceMode });
}
