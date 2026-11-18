import React from 'react';
import type { DebriefOutcomeComparison, ScenarioDebrief } from '@chaos-room/shared';

interface DebriefPanelProps {
  debrief: ScenarioDebrief;
  selectedInterventionId: string | null;
  onSwitchIntervention: (interventionId: string) => void;
  onResetInvestigation: () => void;
}

/**
 * Maps a branch verdict to its semantic outcome health independent of current selection.
 */
function getVerdictHealth(
  verdict: DebriefOutcomeComparison['verdict'],
): 'healthy' | 'degraded' | 'failing' {
  if (verdict === 'Recommended resolution') return 'healthy';
  if (verdict === 'Temporary relief only' || verdict === 'Partial recovery only') {
    return 'degraded';
  }
  return 'failing';
}

const OUTCOME_BANNER_TONES: Record<
  'healthy' | 'degraded' | 'failing',
  { background: string; border: string }
> = {
  healthy: {
    background: 'var(--color-emerald-subtle)',
    border: 'var(--color-emerald-border)',
  },
  degraded: {
    background: 'var(--color-amber-subtle)',
    border: 'var(--color-amber-border)',
  },
  failing: {
    background: 'var(--color-red-subtle)',
    border: 'var(--color-red-border)',
  },
};

function formatScenario3ValFails(item: DebriefOutcomeComparison): string {
  if (
    typeof item.finalValidationErrorAttempts === 'number' &&
    typeof item.finalValidationErrorUniqueMsgs === 'number'
  ) {
    return `${item.finalValidationErrorAttempts.toLocaleString()} (${item.finalValidationErrorUniqueMsgs} uniq)`;
  }
  return 'Unavailable';
}

function formatScenario3ReplayDelivered(item: DebriefOutcomeComparison): string {
  if (
    typeof item.finalReplayedDeliveries === 'number' &&
    typeof item.finalDeliveredConfirmations === 'number' &&
    typeof item.finalAcceptedReservations === 'number'
  ) {
    return `${item.finalReplayedDeliveries} / ${item.finalDeliveredConfirmations.toLocaleString()} of ${item.finalAcceptedReservations.toLocaleString()}`;
  }
  return 'Unavailable';
}

interface MobileBranchCardListProps {
  outcomes: DebriefOutcomeComparison[];
  selectedInterventionId: string | null;
  incidentId: string;
  onSwitchIntervention: (interventionId: string) => void;
}

const MobileBranchCardList: React.FC<MobileBranchCardListProps> = ({
  outcomes,
  selectedInterventionId,
  incidentId,
  onSwitchIntervention,
}) => (
  <div className="mobile-branch-cards" aria-label="Branch comparison summary cards">
    {outcomes.map((item) => {
      const isCurrent = item.interventionId === selectedInterventionId;
      const outcomeHealth = getVerdictHealth(item.verdict);
      return (
        <div
          key={`mob-${item.interventionId}`}
          className="branch-comparison-card"
          data-user-choice={isCurrent}
          data-branch-id={item.interventionId}
          data-outcome-health={outcomeHealth}
        >
          <div className="branch-card-header">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
              <strong style={{ fontSize: '0.82rem', color: 'var(--text-primary)' }}>
                {item.label}
              </strong>
              {isCurrent && (
                <span
                  className="mono"
                  style={{
                    fontSize: '0.72rem',
                    color: 'var(--color-cyan-bright)',
                    fontWeight: 700,
                  }}
                >
                  ★ Active branch
                </span>
              )}
            </div>
            <span
              className="status-badge"
              data-health={outcomeHealth}
              data-verdict-badge={item.interventionId}
            >
              {item.verdict}
            </span>
          </div>

          <div className="branch-card-metrics-grid mono">
            {incidentId === 'incident-002' ? (
              <>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 Backlog</span>
                  <span className="metric-val">{item.finalBacklog ?? 0} msgs</span>
                </div>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 Queue Age</span>
                  <span className="metric-val">
                    {item.finalQueueAgeP95Seconds ? `${item.finalQueueAgeP95Seconds}s` : '0s'}
                  </span>
                </div>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 Retry Amp</span>
                  <span className="metric-val">
                    {item.finalRetryAmplification?.toFixed(2) ?? '1.00'}x
                  </span>
                </div>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 Provider p95</span>
                  <span className="metric-val">
                    {item.finalProviderP95Ms
                      ? `${item.finalProviderP95Ms.toLocaleString()} ms`
                      : '129 ms'}
                  </span>
                </div>
                <div className="branch-metric-item" style={{ gridColumn: 'span 2' }}>
                  <span className="metric-name">Delayed &gt; 30s SLA</span>
                  <span className="metric-val">{item.totalAffectedReservations} reservations</span>
                </div>
              </>
            ) : incidentId === 'incident-003' ? (
              <>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 Outstanding</span>
                  <span className="metric-val">
                    {typeof item.finalBacklog === 'number' ? `${item.finalBacklog} msgs` : 'Unavailable'}
                  </span>
                </div>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 Queue Age</span>
                  <span className="metric-val">
                    {typeof item.finalQueueAgeP95Seconds === 'number'
                      ? `${item.finalQueueAgeP95Seconds}s`
                      : 'Unavailable'}
                  </span>
                </div>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 Val Fails (60s)</span>
                  <span className="metric-val">{formatScenario3ValFails(item)}</span>
                </div>
                <div className="branch-metric-item">
                  <span className="metric-name">Replayed / Delivered</span>
                  <span className="metric-val">{formatScenario3ReplayDelivered(item)}</span>
                </div>
                <div className="branch-metric-item" style={{ gridColumn: 'span 2' }}>
                  <span className="metric-name">Delayed &gt; 30s SLA</span>
                  <span className="metric-val">{item.totalAffectedReservations} reservations</span>
                </div>
              </>
            ) : incidentId === 'incident-001' ? (
              <>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 Error Rate</span>
                  <span className="metric-val">{item.finalErrorRatePercent.toFixed(1)}%</span>
                </div>
                <div className="branch-metric-item">
                  <span className="metric-name">15:00 API p95</span>
                  <span className="metric-val">{item.finalP95LatencyMs} ms</span>
                </div>
                <div className="branch-metric-item" style={{ gridColumn: 'span 2' }}>
                  <span className="metric-name">Cumulative Affected IDs</span>
                  <span className="metric-val">{item.totalAffectedReservations}</span>
                </div>
              </>
            ) : (
              <div className="branch-metric-item" style={{ gridColumn: 'span 2' }}>
                <span className="metric-name">Comparison metrics</span>
                <span className="metric-val">Unavailable</span>
              </div>
            )}
          </div>

          <p style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', margin: '0.2rem 0' }}>
            {item.tradeoffLesson}
          </p>

          <div style={{ marginBlockStart: '0.35rem' }}>
            {!isCurrent ? (
              <button
                type="button"
                className="btn btn-primary"
                style={{ inlineSize: '100%', fontSize: '0.75rem', padding: '0.35rem 0.6rem' }}
                data-intervention-id={item.interventionId}
                onClick={() => onSwitchIntervention(item.interventionId)}
              >
                Inspect this branch at 15:00 →
              </button>
            ) : (
              <span
                className="active-branch-badge mono"
                data-active-branch-indicator={item.interventionId}
              >
                Currently inspecting this branch
              </span>
            )}
          </div>
        </div>
      );
    })}
  </div>
);

export const DebriefPanel: React.FC<DebriefPanelProps> = ({
  debrief,
  selectedInterventionId,
  onSwitchIntervention,
  onResetInvestigation,
}) => {
  const outcomes = Object.values(debrief.outcomeComparisons);
  const chosenOutcome = selectedInterventionId
    ? debrief.outcomeComparisons[selectedInterventionId]
    : null;
  const chosenTone = chosenOutcome
    ? OUTCOME_BANNER_TONES[getVerdictHealth(chosenOutcome.verdict)]
    : null;

  return (
    <section className="debrief-section" aria-labelledby="debrief-heading">
      <div className="panel-header">
        <div>
          <span className="brand-pill" style={{ marginBlockEnd: '0.28rem' }}>
            Deterministic Incident Debrief · Ground Truth
          </span>
          <h2 id="debrief-heading" tabIndex={-1} style={{ fontSize: '1.15rem', fontWeight: 700 }}>
            {debrief.technicalTitle}
          </h2>
        </div>
        <button type="button" className="btn btn-primary" onClick={onResetInvestigation}>
          ↺ Reset &amp; Replay Investigation
        </button>
      </div>

      {/* Selected Outcome Verdict Highlight */}
      {chosenOutcome && chosenTone && (
        <div
          style={{
            padding: '0.75rem 0.9rem',
            borderRadius: 'var(--radius-sm)',
            background: chosenTone.background,
            border: `1px solid ${chosenTone.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
          }}
        >
          <div style={{ fontSize: '0.86rem', fontWeight: 700 }}>
            Your Response at 06:00: {chosenOutcome.label} — <span>[{chosenOutcome.verdict}]</span>
          </div>
          <p style={{ fontSize: '0.81rem', color: 'var(--text-secondary)' }}>
            {chosenOutcome.whatHappened}
          </p>
          <p style={{ fontSize: '0.79rem', fontWeight: 600 }}>
            Decision takeaway: {chosenOutcome.tradeoffLesson}
          </p>
        </div>
      )}

      {/* Root Cause & Plausible Distraction */}
      <div className="debrief-grid">
        <div className="panel-card" style={{ background: 'var(--bg-surface-subtle)', gap: '0.45rem' }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--color-cyan-bright)' }}>
            Actual Root Cause
          </h3>
          <p style={{ fontSize: '0.81rem', color: 'var(--text-secondary)' }}>
            {debrief.actualRootCause}
          </p>
          <details className="tech-details" open>
            <summary>Customer impact &amp; reservation accounting</summary>
            <p
              style={{
                marginBlockStart: '0.3rem',
                fontSize: '0.78rem',
                color: 'var(--text-secondary)',
              }}
            >
              {debrief.customerImpactSummary}
            </p>
          </details>
        </div>

        <div className="panel-card" style={{ background: 'var(--bg-surface-subtle)', gap: '0.45rem' }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--color-amber)' }}>
            {debrief.incidentId === 'incident-003'
              ? 'Why the +22.2% Traffic Bump Was a Plausible Distraction'
              : 'Why the +18% Traffic Bump Was a Plausible Distraction'}
          </h3>
          <p style={{ fontSize: '0.81rem', color: 'var(--text-secondary)' }}>
            {debrief.alternativeClueExplanation}
          </p>
          <details className="tech-details" open>
            <summary>Causal timeline sequence (01:30 → 06:00)</summary>
            <ol
              style={{
                marginBlockStart: '0.3rem',
                paddingInlineStart: '1.1rem',
                fontSize: '0.77rem',
                color: 'var(--text-secondary)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.24rem',
              }}
            >
              {debrief.causalChain.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </details>
        </div>
      </div>

      {/* Three-Branch Outcome Comparison Table */}
      <div>
        <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBlockEnd: '0.4rem' }}>
          Response Branch Comparison at Outcome (15:00)
        </h3>

        {debrief.incidentId === 'incident-002' ? (
          <>
            <div
              style={{
                marginBlockEnd: '0.55rem',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-surface-subtle)',
                border: '1px solid var(--border-subtle)',
                fontSize: '0.78rem',
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.4rem',
              }}
            >
              <div>
                <strong style={{ color: 'var(--color-cyan-bright)' }}>
                  Upstream Reservation Pipeline Context:
                </strong>{' '}
                Across all three intervention branches, upstream reservations committed with{' '}
                <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                  0.0% error rate
                </span>{' '}
                and{' '}
                <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                  133 ms p95 latency
                </span>
                . All booking records were securely persisted in the database with zero transaction
                loss.
              </div>
              <span
                className="mono"
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--color-green)',
                  padding: '0.12rem 0.45rem',
                  borderRadius: '4px',
                  background: 'var(--color-green-subtle)',
                  border: '1px solid var(--color-green)',
                  whiteSpace: 'nowrap',
                }}
              >
                ● 100% Upstream Health
              </span>
            </div>

            <div className="comparison-table-wrap">
              <table className="comparison-table">
                <caption className="visually-hidden">
                  Comparison of the three intervention choices at 15:00 for Incident 2
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Response Applied at 06:00</th>
                    <th scope="col">Verdict</th>
                    <th scope="col">15:00 Backlog</th>
                    <th scope="col">15:00 Queue Age</th>
                    <th scope="col">15:00 Retry Amp</th>
                    <th scope="col">15:00 Provider p95</th>
                    <th scope="col">Delayed &gt; 30s</th>
                    <th scope="col">Decision Lesson &amp; Branch Switch</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomes.map((item) => {
                    const isCurrent = item.interventionId === selectedInterventionId;
                    const outcomeHealth = getVerdictHealth(item.verdict);
                    return (
                      <tr
                        key={item.interventionId}
                        data-user-choice={isCurrent}
                        data-branch-id={item.interventionId}
                        data-outcome-health={outcomeHealth}
                      >
                        <td>
                          <strong>{item.label}</strong>
                          {isCurrent && (
                            <div
                              style={{
                                fontSize: '0.72rem',
                                color: 'var(--color-cyan-bright)',
                                fontWeight: 700,
                              }}
                            >
                              ★ Active branch
                            </div>
                          )}
                        </td>
                        <td>{item.verdict}</td>
                        <td className="mono">{item.finalBacklog ?? 0} msgs</td>
                        <td className="mono">
                          {item.finalQueueAgeP95Seconds ? `${item.finalQueueAgeP95Seconds}s` : '0s'}
                        </td>
                        <td className="mono">
                          {item.finalRetryAmplification?.toFixed(2) ?? '1.00'}x
                        </td>
                        <td className="mono">
                          {item.finalProviderP95Ms
                            ? `${item.finalProviderP95Ms.toLocaleString()} ms`
                            : '129 ms'}
                        </td>
                        <td className="mono">{item.totalAffectedReservations}</td>
                        <td>
                          <p style={{ marginBlockEnd: '0.3rem' }}>{item.tradeoffLesson}</p>
                          {!isCurrent && (
                            <button
                              type="button"
                              className="btn"
                              data-intervention-id={item.interventionId}
                              onClick={() => onSwitchIntervention(item.interventionId)}
                            >
                              Inspect this branch at 15:00 →
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Stacked Branch Cards (Replaces wide table on mobile screens) */}
            <MobileBranchCardList
              outcomes={outcomes}
              selectedInterventionId={selectedInterventionId}
              incidentId="incident-002"
              onSwitchIntervention={onSwitchIntervention}
            />
          </>
        ) : debrief.incidentId === 'incident-003' ? (
          <>
            <div
              style={{
                marginBlockEnd: '0.55rem',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-surface-subtle)',
                border: '1px solid var(--border-subtle)',
                fontSize: '0.78rem',
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.4rem',
              }}
            >
              <div>
                <strong style={{ color: 'var(--color-cyan-bright)' }}>
                  Upstream &amp; Infrastructure Health Context:
                </strong>{' '}
                Across all three response branches, upstream bookings committed at{' '}
                <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                  0.0% error rate
                </span>{' '}
                (
                <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                  133 ms p95
                </span>
                ), <span className="mono">inventory-db</span> stayed at{' '}
                <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                  21/100 connections
                </span>
                , and <span className="mono">notification-provider</span> delivered cleanly (
                <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                  122 ms p95, 100% HTTP 200
                </span>
                ). Only compatibility and recovery of the stranded v2.0 cohort differed.
              </div>
              <span
                className="mono"
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--color-green)',
                  padding: '0.12rem 0.45rem',
                  borderRadius: '4px',
                  background: 'var(--color-green-subtle)',
                  border: '1px solid var(--color-green)',
                  whiteSpace: 'nowrap',
                }}
              >
                ● 100% Upstream &amp; Provider Health
              </span>
            </div>

            <div className="comparison-table-wrap">
              <table className="comparison-table">
                <caption className="visually-hidden">
                  Comparison of the three intervention choices at 15:00 for Incident 3
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Response Applied at 06:00</th>
                    <th scope="col">Verdict</th>
                    <th scope="col">15:00 Outstanding</th>
                    <th scope="col">15:00 Queue Age</th>
                    <th scope="col">15:00 Val Fails (60s)</th>
                    <th scope="col">Replayed / Delivered</th>
                    <th scope="col">Delayed &gt; 30s</th>
                    <th scope="col">Decision Lesson &amp; Branch Switch</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomes.map((item) => {
                    const isCurrent = item.interventionId === selectedInterventionId;
                    const outcomeHealth = getVerdictHealth(item.verdict);
                    return (
                      <tr
                        key={item.interventionId}
                        data-user-choice={isCurrent}
                        data-branch-id={item.interventionId}
                        data-outcome-health={outcomeHealth}
                      >
                        <td>
                          <strong>{item.label}</strong>
                          {isCurrent && (
                            <div
                              style={{
                                fontSize: '0.72rem',
                                color: 'var(--color-cyan-bright)',
                                fontWeight: 700,
                              }}
                            >
                              ★ Active branch
                            </div>
                          )}
                        </td>
                        <td>{item.verdict}</td>
                        <td className="mono">
                          {typeof item.finalBacklog === 'number'
                            ? `${item.finalBacklog} msgs`
                            : 'Unavailable'}
                        </td>
                        <td className="mono">
                          {typeof item.finalQueueAgeP95Seconds === 'number'
                            ? `${item.finalQueueAgeP95Seconds}s`
                            : 'Unavailable'}
                        </td>
                        <td className="mono">{formatScenario3ValFails(item)}</td>
                        <td className="mono">{formatScenario3ReplayDelivered(item)}</td>
                        <td className="mono">{item.totalAffectedReservations}</td>
                        <td>
                          <p style={{ marginBlockEnd: '0.3rem' }}>{item.tradeoffLesson}</p>
                          {!isCurrent && (
                            <button
                              type="button"
                              className="btn"
                              data-intervention-id={item.interventionId}
                              onClick={() => onSwitchIntervention(item.interventionId)}
                            >
                              Inspect this branch at 15:00 →
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <MobileBranchCardList
              outcomes={outcomes}
              selectedInterventionId={selectedInterventionId}
              incidentId="incident-003"
              onSwitchIntervention={onSwitchIntervention}
            />
          </>
        ) : debrief.incidentId === 'incident-001' ? (
          <>
            <div className="comparison-table-wrap">
              <table className="comparison-table">
                <caption className="visually-hidden">
                  Comparison of the three intervention choices at 15:00 simulated time
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Response Applied at 06:00</th>
                    <th scope="col">Verdict</th>
                    <th scope="col">15:00 Error Rate (60s)</th>
                    <th scope="col">15:00 API p95</th>
                    <th scope="col">Cumulative Affected IDs</th>
                    <th scope="col">Decision Lesson &amp; Branch Switch</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomes.map((item) => {
                    const isCurrent = item.interventionId === selectedInterventionId;
                    const outcomeHealth = getVerdictHealth(item.verdict);
                    return (
                      <tr
                        key={item.interventionId}
                        data-user-choice={isCurrent}
                        data-branch-id={item.interventionId}
                        data-outcome-health={outcomeHealth}
                      >
                        <td>
                          <strong>{item.label}</strong>
                          {isCurrent && (
                            <div
                              style={{
                                fontSize: '0.72rem',
                                color: 'var(--color-cyan-bright)',
                                fontWeight: 700,
                              }}
                            >
                              ★ Active branch
                            </div>
                          )}
                        </td>
                        <td>{item.verdict}</td>
                        <td className="mono">{item.finalErrorRatePercent.toFixed(1)}%</td>
                        <td className="mono">{item.finalP95LatencyMs} ms</td>
                        <td className="mono">{item.totalAffectedReservations}</td>
                        <td>
                          <p style={{ marginBlockEnd: '0.3rem' }}>{item.tradeoffLesson}</p>
                          {!isCurrent && (
                            <button
                              type="button"
                              className="btn"
                              data-intervention-id={item.interventionId}
                              onClick={() => onSwitchIntervention(item.interventionId)}
                            >
                              Inspect this branch at 15:00 →
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Stacked Branch Cards for Scenario 1 */}
            <MobileBranchCardList
              outcomes={outcomes}
              selectedInterventionId={selectedInterventionId}
              incidentId="incident-001"
              onSwitchIntervention={onSwitchIntervention}
            />
          </>
        ) : (
          <div className="panel-card" style={{ padding: '0.75rem', fontSize: '0.8rem' }}>
            Comparison metrics unavailable for scenario <code>{debrief.incidentId}</code>.
          </div>
        )}
      </div>

      {/* Prevention Opportunities */}
      <div>
        <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBlockEnd: '0.4rem' }}>
          Engineering &amp; Product Prevention Guardrails
        </h3>
        <div className="debrief-grid">
          {debrief.preventionOpportunities.map((prev) => (
            <div
              key={prev.category}
              className="panel-card"
              style={{ background: 'var(--bg-surface-subtle)', gap: '0.3rem', padding: '0.75rem' }}
            >
              <span
                className="mono"
                style={{ fontSize: '0.72rem', color: 'var(--color-cyan-bright)', fontWeight: 700 }}
              >
                {prev.category}
              </span>
              <h4 style={{ fontSize: '0.84rem', fontWeight: 700 }}>{prev.recommendation}</h4>
              <p style={{ fontSize: '0.77rem', color: 'var(--text-secondary)' }}>
                {prev.whyItMatters}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
