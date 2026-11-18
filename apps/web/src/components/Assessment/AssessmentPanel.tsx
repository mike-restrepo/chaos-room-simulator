import React, { useEffect, useState } from 'react';
import {
  CHECKPOINT_TIMES,
  type AnalysisSourceMode,
  type AnalyzeIncidentStatus,
  type InterventionOption,
  type Snapshot,
} from '@chaos-room/shared';
import type { ResolvedAssessmentView } from '../../services/assessmentService.js';

interface AssessmentPanelProps {
  snapshot: Snapshot;
  assessmentView: ResolvedAssessmentView;
  sourceMode?: AnalysisSourceMode;
  onChangeSourceMode?: (mode: AnalysisSourceMode) => void;
  onSelectIntervention: (interventionId: string, jumpToOutcome: boolean) => void;
  onJumpToAlert: () => void;
  onOpenCitation: (evidenceId: string) => void;
  isDevOrReviewEnvironment?: boolean;
  onRequestAIAnalysis?: (options?: { isExplicitNewAttempt?: boolean }) => void;
  isAIRequestLoading?: boolean;
  aiResponseStatus?: AnalyzeIncidentStatus | null;
  retryUntilMs?: number;
  hasLiveOrCachedAI?: boolean;
  isViewingAuthored?: boolean;
  onToggleViewAuthored?: (viewAuthored: boolean) => void;
  onRetryPending?: () => void;
}

export const AssessmentPanel: React.FC<AssessmentPanelProps> = ({
  snapshot,
  assessmentView,
  sourceMode = 'authored_walkthrough',
  onChangeSourceMode,
  onSelectIntervention,
  onJumpToAlert,
  onOpenCitation,
  isDevOrReviewEnvironment = false,
  onRequestAIAnalysis,
  isAIRequestLoading = false,
  aiResponseStatus = null,
  retryUntilMs,
  hasLiveOrCachedAI = false,
  isViewingAuthored = false,
  onToggleViewAuthored,
  onRetryPending,
}) => {
  const { unlocked, result, statusBanner, cacheKey } = assessmentView;
  const canChooseIntervention = snapshot.simTimeSeconds >= CHECKPOINT_TIMES.evidence;

  const [remainingCooldownSeconds, setRemainingCooldownSeconds] = useState<number>(0);

  useEffect(() => {
    if (!retryUntilMs) {
      setRemainingCooldownSeconds(0);
      return;
    }
    const update = () => {
      const diffMs = retryUntilMs - Date.now();
      setRemainingCooldownSeconds(diffMs > 0 ? Math.ceil(diffMs / 1000) : 0);
    };
    update();
    const interval = setInterval(update, 500);
    return () => clearInterval(interval);
  }, [retryUntilMs]);

  const isCooldownActive = remainingCooldownSeconds > 0;
  const isFailedState =
    aiResponseStatus &&
    aiResponseStatus !== 'ok' &&
    aiResponseStatus !== 'cached' &&
    aiResponseStatus !== 'pending';

  const isTerminalFailure =
    aiResponseStatus === 'disabled' ||
    aiResponseStatus === 'quota_reached' ||
    aiResponseStatus === 'invalid_output' ||
    aiResponseStatus === 'version_mismatch';

  const interventionNameById = new Map<string, string>(
    snapshot.availableInterventions.map((opt: InterventionOption) => [opt.id, opt.shortLabel]),
  );

  return (
    <aside className="panel-card assessment-card" aria-labelledby="assessment-panel-heading">
      <div className="panel-header">
        <div>
          <div className="panel-title-group">
            <h2 id="assessment-panel-heading" className="panel-title">
              Assessment &amp; response
            </h2>
            <span className="ai-core-badge mono">AI &amp; TRIAGE</span>
          </div>
          <p className="panel-subtitle">
            Causal hypotheses, cited facts, and intervention strategy.
          </p>
        </div>
      </div>

      {/* Deliberate AI Request Action & Provenance Header */}
      {unlocked && (
        <section
          aria-label="AI incident analysis action"
          className="ai-action-box"
        >
          <div className="ai-action-header">
            <div>
              <div style={{ fontSize: '0.79rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                Checkpoint AI investigation
              </div>
              <div style={{ fontSize: '0.71rem', color: 'var(--text-muted)' }}>
                {hasLiveOrCachedAI
                  ? 'Compare live/cached AI analysis against the authored baseline.'
                  : 'Deliberately request grounded AI analysis for current checkpoint.'}
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
              {!hasLiveOrCachedAI ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onRequestAIAnalysis?.({ isExplicitNewAttempt: isTerminalFailure })}
                  disabled={
                    isAIRequestLoading ||
                    isCooldownActive ||
                    (assessmentView.checkpoint === 'outcome' && !snapshot.selectedInterventionId)
                  }
                  aria-busy={isAIRequestLoading}
                  style={{ fontSize: '0.76rem', padding: '0.32rem 0.65rem' }}
                >
                  {isAIRequestLoading
                    ? 'Requesting AI analysis…'
                    : isCooldownActive
                      ? `Cooldown active (${remainingCooldownSeconds}s)`
                      : isTerminalFailure
                        ? `Retry AI analysis (${assessmentView.checkpoint.toUpperCase()})`
                        : isFailedState
                          ? `Retry request (${assessmentView.checkpoint.toUpperCase()})`
                          : `Request AI analysis (${assessmentView.checkpoint.toUpperCase()})`}
                </button>
              ) : (
                <div style={{ display: 'flex', gap: '0.3rem' }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${!isViewingAuthored ? 'btn-primary' : ''}`}
                    onClick={() => onToggleViewAuthored?.(false)}
                    aria-pressed={!isViewingAuthored}
                    style={{ fontSize: '0.73rem', padding: '0.25rem 0.55rem' }}
                  >
                    AI analysis
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${isViewingAuthored ? 'btn-primary' : ''}`}
                    onClick={() => onToggleViewAuthored?.(true)}
                    aria-pressed={isViewingAuthored}
                    style={{ fontSize: '0.73rem', padding: '0.25rem 0.55rem' }}
                  >
                    Authored walkthrough
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onRequestAIAnalysis?.()}
                    disabled={isAIRequestLoading || isCooldownActive}
                    style={{ fontSize: '0.73rem', padding: '0.25rem 0.55rem' }}
                    aria-label={`Re-check analysis for ${assessmentView.checkpoint.toUpperCase()}`}
                  >
                    {isAIRequestLoading ? 'Checking...' : 'Re-check'}
                  </button>
                </div>
              )}

              {aiResponseStatus === 'pending' && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={onRetryPending}
                  disabled={isAIRequestLoading || isCooldownActive}
                  style={{ fontSize: '0.73rem', padding: '0.25rem 0.55rem' }}
                >
                  {isCooldownActive
                    ? `Check in ${remainingCooldownSeconds}s`
                    : `Check status (${assessmentView.checkpoint.toUpperCase()})`}
                </button>
              )}
            </div>
          </div>

          {assessmentView.checkpoint === 'outcome' && !snapshot.selectedInterventionId && (
            <div style={{ fontSize: '0.72rem', color: 'var(--color-amber)', marginBlockStart: '0.25rem' }}>
              Select an intervention at 06:00 to unlock Outcome AI analysis.
            </div>
          )}

          <div role="status" aria-live="polite" className="sr-only">
            {isAIRequestLoading
              ? 'Requesting AI analysis for checkpoint...'
              : statusBanner.badgeLabel}
          </div>
        </section>
      )}

      {/* Provenance & Source Status Banner (shown once assessment unlocks at 03:00) */}
      {unlocked && (
        <div
          className="provenance-banner"
          data-tone={statusBanner.tone}
        >
          <div className="provenance-badge-label">
            {statusBanner.badgeLabel}
          </div>
          <p className="provenance-explanation">
            {statusBanner.explanation}
          </p>
        </div>
      )}

      {/* Assessment Content */}
      {!unlocked || !result ? (
        <div className="locked-assessment-box" data-empty-state="pre-alert-assessment">
          <div className="locked-assessment-title">
            Structured assessment becomes available at Alert (03:00)
          </div>
          <p className="locked-assessment-copy">
            Watch the system and incoming evidence as the simulation advances. Cited hypotheses and
            optional AI analysis unlock at <strong>Alert (03:00)</strong>, and response options
            remain gated until <strong>Evidence (06:00)</strong>.
          </p>
          <button
            type="button"
            className="btn btn-sm btn-secondary-shortcut"
            onClick={onJumpToAlert}
          >
            Jump to Alert Checkpoint (03:00) →
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {result.isPreviewMock && (
            <div className="preview-warning-banner" role="status">
              [DEV / REVIEW PREVIEW ONLY] Showing mocked UI state ({result.sourceBadgeLabel}). Text
              below is authored fallback content—never a live Gemini generation.
            </div>
          )}

          {/* Header Metadata: Checkpoint + Confidence Level */}
          <div className="assessment-meta-row">
            <span className="brand-pill">
              Checkpoint: {result.checkpoint.toUpperCase()} (
              {result.checkpoint === 'alert'
                ? '03:00'
                : result.checkpoint === 'evidence'
                  ? '06:00'
                  : '15:00'}
              )
            </span>
            <span
              className="status-badge"
              data-health={
                result.confidence.level === 'High'
                  ? 'healthy'
                  : result.confidence.level === 'Medium'
                    ? 'degraded'
                    : 'failing'
              }
            >
              Confidence: {result.confidence.level} (qualitative)
            </span>
          </div>

          {/* Concise Assessment Summary */}
          <div className="concise-assessment-card">
            <h3 className="assessment-section-title">
              Assessment Summary (Hypothesis — Not Ground Truth)
            </h3>
            <p className="concise-assessment-text">
              {result.conciseAssessment}
            </p>
            <p className="confidence-justification">
              <strong>Confidence rationale:</strong> {result.confidence.justification}
            </p>
          </div>

          {/* Ranked Hypotheses */}
          <div className="hypotheses-box">
            <h3 className="assessment-section-title">
              Ranked Hypotheses
            </h3>
            <ol className="hypotheses-list">
              {result.rankedHypotheses.map((hyp) => (
                <li key={hyp.rank} className="hypothesis-item">
                  <div className="hypothesis-header">
                    <span className="hypothesis-rank mono">H{hyp.rank}</span>
                    <span className="hypothesis-likelihood mono">[{hyp.likelihood}]</span>
                  </div>
                  <div className="hypothesis-body">
                    <span>{hyp.statement} </span>
                    {hyp.supportingCitationIds.map((cid: string) => (
                      <button
                        key={cid}
                        type="button"
                        className="citation-pill"
                        onClick={() => onOpenCitation(cid)}
                        aria-label={`Inspect citation ${cid}`}
                      >
                        [{cid}]
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* Consolidated Intervention Decision Section (06:00 Decision Gate) */}
          {canChooseIntervention ? (
            <section
              id="intervention-decision-section"
              data-tour-anchor="intervention-decision"
              aria-labelledby="intervention-decision-heading"
              className="intervention-decision-section"
              data-awaiting={snapshot.awaitingInterventionDecision}
            >
              <div className="intervention-decision-header">
                <h3
                  id="intervention-decision-heading"
                  tabIndex={-1}
                  className="intervention-decision-title"
                >
                  {snapshot.awaitingInterventionDecision
                    ? '▲ Action Required at 06:00: Select an Intervention'
                    : 'Response Applied at 06:00 (Switch Anytime)'}
                </h3>
                <span className="mono decision-time-tag">
                  {snapshot.awaitingInterventionDecision ? '3 options available ↓' : '06:00 Decision'}
                </span>
              </div>

              <p className="intervention-decision-prompt">
                {snapshot.awaitingInterventionDecision
                  ? `Choose one of the three response paths below${
                      snapshot.availableInterventions[2]?.shortLabel
                        ? ` (including “${snapshot.availableInterventions[2].shortLabel}”)`
                        : ''
                    } to unlock progression to the 15:00 Outcome.`
                  : 'Every response branches deterministically from 06:00. Select another option below to compare its trajectory.'}
              </p>

              <div className="intervention-cards-stack">
                {snapshot.availableInterventions
                  .filter(
                    (option: InterventionOption) =>
                      snapshot.selectedInterventionId === null ||
                      snapshot.selectedInterventionId === option.id,
                  )
                  .map((option: InterventionOption) => {
                    const isSelected = snapshot.selectedInterventionId === option.id;
                    return (
                      <div key={option.id} className="intervention-card" data-selected={isSelected}>
                        <div className="intervention-card-top">
                          <strong className="intervention-label">
                            {option.label}
                          </strong>
                          {isSelected && (
                            <span
                              className="active-branch-badge mono"
                              data-selected-badge="true"
                            >
                              ✓ Selected
                            </span>
                          )}
                        </div>

                        <p className="intervention-summary-text">
                          {option.summary}
                        </p>

                        <p className="intervention-tradeoff-text">
                          <strong>Tradeoff:</strong> {option.immediateTradeoff}
                        </p>

                        {option.stages && isSelected && (
                          <details className="tech-details">
                            <summary>Causal execution stages (06:00 → 15:00)</summary>
                            <ul className="stages-list mono">
                              {option.stages.map((st: string) => (
                                <li key={st}>{st}</li>
                              ))}
                            </ul>
                          </details>
                        )}

                        <div className="intervention-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => onSelectIntervention(option.id, true)}
                          >
                            Apply &amp; Jump to Outcome (15:00)
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => onSelectIntervention(option.id, false)}
                          >
                            {isSelected ? 'Replay from 06:00' : 'Apply & Play from 06:00'}
                          </button>
                        </div>
                      </div>
                    );
                  })}

                {snapshot.selectedInterventionId !== null && (
                  <details className="tech-details branch-switcher-details">
                    <summary>Switch to another 06:00 response branch (2 other options)</summary>
                    <div className="other-branches-stack">
                      {snapshot.availableInterventions
                        .filter((option: InterventionOption) => option.id !== snapshot.selectedInterventionId)
                        .map((option: InterventionOption) => (
                          <div key={option.id} className="intervention-card" data-selected={false}>
                            <strong className="intervention-label">
                              {option.label}
                            </strong>
                            <p className="intervention-summary-text">
                              {option.summary}
                            </p>
                            <p className="intervention-tradeoff-text">
                              <strong>Tradeoff:</strong> {option.immediateTradeoff}
                            </p>
                            <div className="intervention-actions">
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => onSelectIntervention(option.id, true)}
                              >
                                Apply &amp; Jump to Outcome (15:00)
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => onSelectIntervention(option.id, false)}
                              >
                                Apply &amp; Play from 06:00
                              </button>
                            </div>
                          </div>
                        ))}
                    </div>
                  </details>
                )}
              </div>
            </section>
          ) : (
            <div className="response-locked-notice">
              <strong>Response locked until Evidence (06:00):</strong> Inspect early telemetry at Alert
              (03:00), then advance to Evidence (06:00) to select an intervention.
            </div>
          )}

          {/* At Alert: Proposed Next Investigation Checks */}
          {result.checkpoint === 'alert' && (
            <div className="investigation-checks-box">
              <h3 className="assessment-section-title">
                Proposed Next Investigation Checks (Pre-Intervention)
              </h3>
              <ul className="checks-list">
                {result.verificationChecks.map((check: string, i: number) => (
                  <li key={i}>{check}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Observed Facts with Clickable Citations */}
          <details className="tech-details" open={result.checkpoint === 'alert'}>
            <summary>Observed Facts &amp; Citations ({result.observedFacts.length} verified)</summary>
            <ul className="facts-list">
              {result.observedFacts.map((fact, idx: number) => (
                <li key={idx} className="fact-item">
                  <span>{fact.text} </span>
                  {fact.citationIds.map((cid: string) => (
                    <button
                      key={cid}
                      type="button"
                      className="citation-pill"
                      onClick={() => onOpenCitation(cid)}
                      aria-label={`Inspect cited evidence ${cid} in evidence workspace`}
                    >
                      [{cid}]
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          </details>

          {/* Deep Dives: Evaluated options, alternative clues, and missing info */}
          {result.checkpoint !== 'alert' && (
            <details className="tech-details">
              <summary>Evaluated response options, alternative clues &amp; open questions</summary>
              <div className="deep-dives-stack">
                <div>
                  <h4 className="deep-dive-title">Evaluated Response Options &amp; Risks</h4>
                  <div className="evaluated-options-stack">
                    {result.recommendedInterventions.map((rec) => (
                      <div key={rec.interventionId} className="evaluated-option-card">
                        <div className="evaluated-option-name">
                          {interventionNameById.get(rec.interventionId) ?? rec.interventionId}
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>{rec.rationale}</div>
                        <div style={{ color: 'var(--color-amber)', marginBlockStart: '0.15rem' }}>
                          <strong>Risk:</strong> {rec.keyRisk}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {result.alternativeExplanations.length > 0 && (
                  <div>
                    <h4 className="deep-dive-title">Alternative Explanations Considered</h4>
                    {result.alternativeExplanations.map((alt, i: number) => (
                      <div key={i} className="evaluated-option-card">
                        <div><strong>Clue:</strong> {alt.explanation}</div>
                        <div style={{ marginBlockStart: '0.15rem' }}>
                          <strong>Why less likely:</strong> {alt.whyLessLikely}{' '}
                          {alt.citationIds.map((cid: string) => (
                            <button
                              key={cid}
                              type="button"
                              className="citation-pill"
                              onClick={() => onOpenCitation(cid)}
                            >
                              [{cid}]
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {result.missingInformation.length > 0 && (
                  <div>
                    <h4 className="deep-dive-title" style={{ color: 'var(--text-secondary)' }}>
                      Unresolved / Missing Information
                    </h4>
                    <ul className="missing-info-list">
                      {result.missingInformation.map((item: string, idx: number) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          )}

          {/* Stakeholder Update */}
          {result.stakeholderUpdate && (
            <div className="stakeholder-card">
              <div className="stakeholder-label mono">STAKEHOLDER STATUS UPDATE</div>
              <p className="stakeholder-text">{result.stakeholderUpdate}</p>
            </div>
          )}

          {/* Dev / Review State Preview Switcher & Version Details */}
          {isDevOrReviewEnvironment && (
            <details
              style={{
                marginBlockStart: '0.3rem',
                padding: '0.55rem 0.7rem',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-surface-subtle)',
                border: '1px dashed var(--border-strong)',
                fontSize: '0.75rem',
              }}
            >
              <summary style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>
                Dev / Review Only: Preview Fallback &amp; Cache UI States
              </summary>
              <div
                style={{
                  marginBlockStart: '0.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.45rem',
                }}
              >
                <p style={{ color: 'var(--text-muted)' }}>
                  Restricted to local development/review. Previews how Phase 3 fallback and cache states
                  render while keeping authored text clearly marked as non-live.
                </p>
                <label htmlFor="assessment-mode-select" style={{ fontWeight: 600 }}>
                  Assessment State Mode:
                </label>
                <select
                  id="assessment-mode-select"
                  value={sourceMode}
                  onChange={(e) => onChangeSourceMode?.(e.target.value as AnalysisSourceMode)}
                  style={{
                    padding: '0.35rem 0.5rem',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-surface-elevated)',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  <option value="authored_walkthrough">
                    Authored baseline walkthrough
                  </option>
                  <option value="preview_cached_ai">
                    Preview: Previously generated AI analysis (mocked cache hit)
                  </option>
                  <option value="preview_quota_reached">
                    Preview: AI quota reached → Authored fallback
                  </option>
                  <option value="preview_unavailable">
                    Preview: Backend timeout / AI unavailable → Authored fallback
                  </option>
                  <option value="preview_malformed_fallback">
                    Preview: Malformed AI output rejected → Authored fallback
                  </option>
                </select>

                {cacheKey && (
                  <div
                    className="mono"
                    style={{ fontSize: '0.69rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}
                  >
                    Canonical Cache Key: {cacheKey}
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </aside>
  );
};
