import React from 'react';
import type {
  EvidenceItem,
  EvidenceType,
  MetricTimelinePoint,
  ScenarioChartConfig,
  ServiceId,
} from '@chaos-room/shared';

interface EvidencePanelProps {
  visibleEvidence: EvidenceItem[];
  timelineSeries: MetricTimelinePoint[];
  selectedServiceId: ServiceId | null;
  onClearServiceFilter: () => void;
  selectedTypeFilter: EvidenceType | 'all' | 'pinned';
  onChangeTypeFilter: (filter: EvidenceType | 'all' | 'pinned') => void;
  pinnedIds: string[];
  onTogglePin: (evidenceId: string) => void;
  highlightedEvidenceId: string | null;
  chartConfig?: ScenarioChartConfig;
  scenarioIncidentId?: string;
}

function getSeverityBadge(severity: EvidenceItem['severity']): { icon: string; label: string } {
  switch (severity) {
    case 'error':
      return { icon: '◆', label: 'ERROR' };
    case 'warn':
      return { icon: '▲', label: 'WARN' };
    case 'info':
      return { icon: '●', label: 'INFO' };
  }
}

export const EvidencePanel: React.FC<EvidencePanelProps> = ({
  visibleEvidence,
  timelineSeries,
  selectedServiceId,
  onClearServiceFilter,
  selectedTypeFilter,
  onChangeTypeFilter,
  pinnedIds,
  onTogglePin,
  highlightedEvidenceId,
  chartConfig,
  scenarioIncidentId,
}) => {
  const pinnedSet = new Set(pinnedIds);

  const filteredItems = visibleEvidence.filter((item) => {
    if (selectedServiceId && item.service !== selectedServiceId) return false;
    if (selectedTypeFilter === 'pinned') return pinnedSet.has(item.id);
    if (selectedTypeFilter !== 'all' && item.type !== selectedTypeFilter) return false;
    return true;
  });

  // Build SVG polyline points dynamically based on scenario chartConfig
  const isStacked = chartConfig?.layout === 'stacked';
  const chartWidth = 520;
  const chartHeight = isStacked ? 170 : 132;
  const padX = isStacked ? 62 : 32;
  const padRight = isStacked ? 18 : 32;
  const padTop = 12;
  const padBottom = 22;
  const plotW = chartWidth - padX - padRight;
  const plotH = chartHeight - padTop - padBottom;

  const series1Label = chartConfig?.series1Label ?? '━ Error Rate (trailing 60s %)';
  const series1Color = chartConfig?.series1Color ?? 'var(--color-red)';
  const series2Label = chartConfig?.series2Label ?? '┅ DB Pool Utilization (active / max)';
  const series2Color = chartConfig?.series2Color ?? 'var(--color-cyan-bright)';

  // Stacked subplots vertical coordinates
  const subH = 46;
  const sub1Top = 16;
  const sub2Top = 82;

  const series1Points = timelineSeries
    .map((pt) => {
      const x = padX + (pt.simTimeSeconds / 900) * plotW;
      const ratio = chartConfig ? chartConfig.getSeries1Ratio(pt) : pt.reservationErrorRate;
      const clampedRatio = Math.max(0, Math.min(1, ratio));
      const y = isStacked
        ? sub1Top + subH - clampedRatio * subH
        : padTop + plotH - clampedRatio * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const series2Points = timelineSeries
    .map((pt) => {
      const x = padX + (pt.simTimeSeconds / 900) * plotW;
      const ratio = chartConfig
        ? chartConfig.getSeries2Ratio(pt)
        : Math.min(1, pt.activeDbConnections / pt.maxDbConnections);
      const clampedRatio = Math.max(0, Math.min(1, ratio));
      const y = isStacked
        ? sub2Top + subH - clampedRatio * subH
        : padTop + plotH - clampedRatio * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const latestPoint = timelineSeries[timelineSeries.length - 1];

  // Show the most recent / highest-signal items inline and group earlier items in an expandable section
  // when viewing the full unfiltered feed (> 4 items), preventing large column height imbalances.
  const INLINE_EVIDENCE_LIMIT = 4;
  const shouldGroupEarlier =
    selectedTypeFilter === 'all' &&
    selectedServiceId === null &&
    filteredItems.length > INLINE_EVIDENCE_LIMIT;

  const primaryItems = shouldGroupEarlier
    ? filteredItems.slice(filteredItems.length - INLINE_EVIDENCE_LIMIT)
    : filteredItems;
  const earlierItems = shouldGroupEarlier
    ? filteredItems.slice(0, filteredItems.length - INLINE_EVIDENCE_LIMIT)
    : [];
  const earlierContainsHighlight = earlierItems.some(
    (item) => item.id === highlightedEvidenceId || pinnedSet.has(item.id),
  );

  const renderEvidenceCard = (item: EvidenceItem, isLatestInline: boolean) => {
    const isPinned = pinnedSet.has(item.id);
    const isHighlighted = highlightedEvidenceId === item.id;
    const sev = getSeverityBadge(item.severity);
    const shouldDefaultOpen = isHighlighted || isPinned || isLatestInline;

    return (
      <li
        key={item.id}
        id={`evidence-card-${item.id}`}
        tabIndex={-1}
        className="evidence-item"
        data-severity={item.severity}
        data-highlighted={isHighlighted}
      >
        <div className="evidence-meta-row">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.35rem',
              alignItems: 'center',
            }}
          >
            <span className="mono" style={{ color: 'var(--color-cyan-bright)', fontWeight: 700 }}>
              [{item.id}]
            </span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {item.formattedTime}
            </span>
            <span
              style={{
                padding: '0.06rem 0.4rem',
                borderRadius: '4px',
                background: 'var(--bg-surface-elevated)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
            >
              {item.service}
            </span>
            <span
              style={{
                textTransform: 'uppercase',
                fontWeight: 700,
                letterSpacing: '0.03em',
              }}
            >
              {sev.icon} {item.type}
            </span>
          </div>

          <button
            type="button"
            className="filter-chip"
            aria-pressed={isPinned}
            onClick={() => onTogglePin(item.id)}
            aria-label={`${isPinned ? 'Unpin' : 'Pin'} evidence ${item.id}: ${item.title}`}
          >
            {isPinned ? '★ Pinned' : '☆ Pin'}
          </button>
        </div>

        <h3 style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          {item.title}
        </h3>

        <p style={{ fontSize: '0.77rem', color: 'var(--text-secondary)' }}>{item.summary}</p>

        <details className="tech-details" open={shouldDefaultOpen}>
          <summary>
            Raw telemetry payload{item.traceSpans ? ' & request trace waterfall' : ''}
          </summary>
          <div style={{ marginBlockStart: '0.3rem' }}>
            <pre className="evidence-code">{item.detail}</pre>

            {/* Request Trace Waterfall View */}
            {item.traceSpans && item.traceSpans.length > 0 && (
              <div className="trace-waterfall" aria-label={`Request trace spans for ${item.id}`}>
                <div
                  className="mono"
                  style={{
                    fontSize: '0.7rem',
                    color: 'var(--text-muted)',
                    fontWeight: 700,
                  }}
                >
                  Request Trace Waterfall (2,500 ms Gateway Budget)
                </div>
                {item.traceSpans.map((span) => {
                  const leftPct = Math.min(95, (span.startOffsetMs / 2500) * 100);
                  const widthPct = Math.max(
                    3,
                    Math.min(100 - leftPct, (span.durationMs / 2500) * 100),
                  );
                  return (
                    <div key={span.spanId} className="trace-span-row">
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: '0.5rem',
                        }}
                      >
                        <span className="mono">
                          <strong>{span.service}</strong> · {span.operation}
                        </span>
                        <span className="mono" style={{ fontWeight: 700 }}>
                          {span.durationMs} ms ({span.status.toUpperCase()})
                        </span>
                      </div>
                      <div className="trace-bar-track">
                        <div
                          className="trace-bar-fill"
                          data-status={span.status}
                          style={{
                            insetInlineStart: `${leftPct}%`,
                            inlineSize: `${widthPct}%`,
                          }}
                        />
                      </div>
                      {span.note && (
                        <span style={{ fontSize: '0.69rem', color: 'var(--text-muted)' }}>
                          {span.note}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </details>
      </li>
    );
  };

  return (
    <section className="panel-card" aria-labelledby="evidence-workspace-heading">
      <div className="panel-header">
        <div>
          <h2 id="evidence-workspace-heading" className="panel-title">
            Evidence
          </h2>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {visibleEvidence.length === 0
              ? `No incident evidence recorded yet at ${latestPoint?.formattedTime ?? '00:00'}.`
              : `Showing ${filteredItems.length} of ${visibleEvidence.length} telemetry items up to ${latestPoint?.formattedTime ?? '00:00'}.`}
          </p>
        </div>
        {selectedServiceId && (
          <button type="button" className="btn" onClick={onClearServiceFilter}>
            Service: {selectedServiceId} ✕
          </button>
        )}
      </div>

      {/* Synchronized Time-Series Chart */}
      <figure className="chart-box">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: '0.4rem',
            marginBlockEnd: '0.25rem',
            fontSize: '0.73rem',
          }}
        >
          <span style={{ color: series1Color, fontWeight: 700 }}>
            {series1Label}
            {isStacked && (
              <span className="mono" style={{ fontWeight: 600, marginInlineStart: '0.35rem' }}>
                ·{' '}
                {latestPoint
                  ? chartConfig?.formatSeries1Value
                    ? chartConfig.formatSeries1Value(latestPoint)
                    : `${latestPoint.confirmationBacklog} msgs`
                  : 'Unavailable'}
              </span>
            )}
          </span>
          <span style={{ color: series2Color, fontWeight: 700 }}>
            {series2Label}
            {isStacked && (
              <span className="mono" style={{ fontWeight: 600, marginInlineStart: '0.35rem' }}>
                ·{' '}
                {latestPoint
                  ? chartConfig?.formatSeries2Value
                    ? chartConfig.formatSeries2Value(latestPoint)
                    : scenarioIncidentId === 'incident-002'
                      ? `${latestPoint.retryAmplification.toFixed(2)}x`
                      : 'Unavailable'
                  : 'Unavailable'}
              </span>
            )}
          </span>
        </div>

        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          style={{ inlineSize: '100%', blockSize: 'auto', display: 'block' }}
          role="img"
          aria-labelledby="chart-title"
        >
          <title id="chart-title">
            Time-series telemetry chart for {series1Label} and {series2Label} up to{' '}
            {latestPoint?.formattedTime ?? '00:00'}.
          </title>

          {isStacked ? (
            /* Scenario 2 Stacked Subplots: Unambiguous Independent Scales sharing the same Timeline */
            <>
              {/* --- Subplot 1: Confirmation Backlog (queued messages) --- */}
              <text
                x={padX}
                y={sub1Top - 5}
                fill={series1Color}
                fontSize="8.5"
                fontFamily="monospace"
                fontWeight="700"
              >
                {series1Label}
              </text>
              {(
                chartConfig?.series1Ticks ?? [
                  { ratio: 1.0, label: '1400 msgs' },
                  { ratio: 0.5, label: '700 msgs' },
                  { ratio: 0.0, label: '0 msgs' },
                ]
              ).map((tick) => {
                const y = sub1Top + subH - tick.ratio * subH;
                return (
                  <g key={`s1-${tick.label}`}>
                    <line
                      x1={padX}
                      y1={y}
                      x2={chartWidth - padRight}
                      y2={y}
                      stroke="#1b3159"
                      strokeDasharray="3 3"
                    />
                    <text
                      x={padX - 6}
                      y={y + 3}
                      fill="#fbbf24"
                      fontSize="9"
                      fontFamily="monospace"
                      textAnchor="end"
                    >
                      {tick.label}
                    </text>
                  </g>
                );
              })}

              {/* Checkpoint guide lines for Subplot 1 */}
              {[180, 360, 900].map((sec) => {
                const x = padX + (sec / 900) * plotW;
                return (
                  <line
                    key={`cp1-${sec}`}
                    x1={x}
                    y1={sub1Top}
                    x2={x}
                    y2={sub1Top + subH}
                    stroke="#2b4c87"
                    strokeWidth={1}
                  />
                );
              })}

              {/* Subplot 1 Polyline (Backlog - solid amber) */}
              {series1Points && (
                <polyline
                  fill="none"
                  stroke={series1Color}
                  strokeWidth="2.3"
                  points={series1Points}
                />
              )}

              {/* --- Subplot 2: Delivery Retry Amplification (ratio) --- */}
              <text
                x={padX}
                y={sub2Top - 5}
                fill={series2Color}
                fontSize="8.5"
                fontFamily="monospace"
                fontWeight="700"
              >
                {series2Label}
              </text>
              {(
                chartConfig?.series2Ticks ?? [
                  { ratio: 1.0, label: '7.0x' },
                  { ratio: 0.5, label: '4.0x' },
                  { ratio: 0.0, label: '1.0x' },
                ]
              ).map((tick) => {
                const y = sub2Top + subH - tick.ratio * subH;
                return (
                  <g key={`s2-${tick.label}`}>
                    <line
                      x1={padX}
                      y1={y}
                      x2={chartWidth - padRight}
                      y2={y}
                      stroke="#1b3159"
                      strokeDasharray="3 3"
                    />
                    <text
                      x={padX - 6}
                      y={y + 3}
                      fill="#38bdf8"
                      fontSize="9"
                      fontFamily="monospace"
                      textAnchor="end"
                    >
                      {tick.label}
                    </text>
                  </g>
                );
              })}

              {/* Checkpoint guide lines for Subplot 2 */}
              {[180, 360, 900].map((sec) => {
                const x = padX + (sec / 900) * plotW;
                return (
                  <line
                    key={`cp2-${sec}`}
                    x1={x}
                    y1={sub2Top}
                    x2={x}
                    y2={sub2Top + subH}
                    stroke="#2b4c87"
                    strokeWidth={1}
                  />
                );
              })}

              {/* Subplot 2 Polyline (Retry Amplification - solid cyan) */}
              {series2Points && (
                <polyline
                  fill="none"
                  stroke={series2Color}
                  strokeWidth="2.3"
                  points={series2Points}
                />
              )}

              {/* Synchronized Timeline Checkpoint Labels at Bottom */}
              {[
                { sec: 180, label: '03:00 Alert', align: 'middle' as const },
                { sec: 360, label: '06:00 Evidence', align: 'middle' as const },
                { sec: 900, label: '15:00 Outcome', align: 'end' as const },
              ].map((cp) => {
                const x = padX + (cp.sec / 900) * plotW;
                return (
                  <text
                    key={`lbl-${cp.sec}`}
                    x={x}
                    y={sub2Top + subH + 15}
                    textAnchor={cp.align}
                    fill="#cbd5e1"
                    fontSize="9.5"
                    fontFamily="monospace"
                  >
                    {cp.label}
                  </text>
                );
              })}
            </>
          ) : (
            /* Scenario 1 Existing Semantics: Single Plot with Percentage Grid (0%, 50%, 100%) */
            <>
              {/* Horizontal Grid Lines (0%, 50%, 100%) */}
              {[0, 0.5, 1].map((level) => {
                const y = padTop + plotH - level * plotH;
                return (
                  <g key={level}>
                    <line
                      x1={padX}
                      y1={y}
                      x2={chartWidth - padX}
                      y2={y}
                      stroke="#1b3159"
                      strokeDasharray="3 3"
                    />
                    <text x={2} y={y + 3} fill="#94a3b8" fontSize="9.5" fontFamily="monospace">
                      {Math.round(level * 100)}%
                    </text>
                  </g>
                );
              })}

              {/* Canonical Checkpoint Guides (03:00, 06:00, 15:00) */}
              {[
                { sec: 180, label: '03:00 Alert', align: 'middle' as const },
                { sec: 360, label: '06:00 Evidence', align: 'middle' as const },
                { sec: 900, label: '15:00 Outcome', align: 'end' as const },
              ].map((cp) => {
                const x = padX + (cp.sec / 900) * plotW;
                return (
                  <g key={cp.sec}>
                    <line
                      x1={x}
                      y1={padTop}
                      x2={x}
                      y2={padTop + plotH}
                      stroke="#2b4c87"
                      strokeWidth={1}
                    />
                    <text
                      x={x}
                      y={chartHeight - 5}
                      textAnchor={cp.align}
                      fill="#cbd5e1"
                      fontSize="9.5"
                      fontFamily="monospace"
                    >
                      {cp.label}
                    </text>
                  </g>
                );
              })}

              {/* Series 2 Polyline (dashed) */}
              {series2Points && (
                <polyline
                  fill="none"
                  stroke={series2Color}
                  strokeWidth="2.1"
                  strokeDasharray="4 2"
                  points={series2Points}
                />
              )}

              {/* Series 1 Polyline (solid) */}
              {series1Points && (
                <polyline
                  fill="none"
                  stroke={series1Color}
                  strokeWidth="2.3"
                  points={series1Points}
                />
              )}
            </>
          )}
        </svg>

        <figcaption
          className="mono"
          style={{ fontSize: '0.71rem', color: 'var(--text-muted)', marginBlockStart: '0.2rem' }}
        >
          {chartConfig?.formatCaption ? (
            latestPoint ? (
              chartConfig.formatCaption(latestPoint)
            ) : (
              'Current: Telemetry unavailable'
            )
          ) : scenarioIncidentId === 'incident-002' ? (
            <>
              Current ({latestPoint?.formattedTime ?? '00:00'}): Confirmation backlog{' '}
              {latestPoint?.confirmationBacklog ?? 0} msgs · Retry amp{' '}
              {(latestPoint?.retryAmplification ?? 1).toFixed(2)}x · Provider p95{' '}
              {latestPoint?.providerP95LatencyMs ?? 125} ms
            </>
          ) : scenarioIncidentId === 'incident-003' ? (
            <>Current ({latestPoint?.formattedTime ?? '00:00'}): Telemetry summary unavailable</>
          ) : (
            <>
              Current ({latestPoint?.formattedTime ?? '00:00'}): Error rate{' '}
              {((latestPoint?.reservationErrorRate ?? 0) * 100).toFixed(1)}% · Active DB pool{' '}
              {latestPoint?.activeDbConnections ?? 20}/{latestPoint?.maxDbConnections ?? 100} · DB
              CPU {latestPoint?.dbCpuPercent ?? 30}%
            </>
          )}
        </figcaption>
      </figure>

      {/* Evidence Type & Pin Filter Bar */}
      <div className="filter-bar" role="group" aria-label="Filter evidence by category">
        {(
          [
            { id: 'all', label: `All (${visibleEvidence.length})` },
            { id: 'metric', label: 'Metrics' },
            { id: 'log', label: 'Logs' },
            { id: 'trace', label: 'Traces' },
            { id: 'deployment', label: 'Deployments' },
            { id: 'pinned', label: `Pinned (${pinnedIds.length})` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="filter-chip"
            aria-pressed={selectedTypeFilter === tab.id}
            onClick={() => onChangeTypeFilter(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Evidence Feed */}
      {filteredItems.length === 0 ? (
        visibleEvidence.length === 0 ? (
          <div className="evidence-empty-state" data-empty-state="no-evidence-yet">
            <strong style={{ color: 'var(--text-primary)' }}>
              No incident evidence recorded yet at {latestPoint?.formattedTime ?? '00:00'}.
            </strong>
            <p>
              Deployment, metric, log, and trace evidence will appear here as the simulation
              advances toward the first alert (03:00).
            </p>
          </div>
        ) : (
          <div className="evidence-empty-state" data-empty-state="filter-empty">
            <strong style={{ color: 'var(--text-primary)' }}>
              No evidence items match the active filter.
            </strong>
            <p>
              {visibleEvidence.length} evidence{' '}
              {visibleEvidence.length === 1 ? 'item exists' : 'items exist'} at{' '}
              {latestPoint?.formattedTime ?? '00:00'}, but none match the current filter.
            </p>
            {(selectedServiceId !== null || selectedTypeFilter !== 'all') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onClearServiceFilter();
                  onChangeTypeFilter('all');
                }}
              >
                Reset evidence filters
              </button>
            )}
          </div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <ul className="evidence-list" role="list">
            {primaryItems.map((item, idx) =>
              renderEvidenceCard(item, idx === primaryItems.length - 1),
            )}
          </ul>

          {earlierItems.length > 0 && (
            <details
              key={earlierContainsHighlight ? 'earlier-open' : 'earlier-closed'}
              className="tech-details"
              open={earlierContainsHighlight}
            >
              <summary>
                Earlier timeline telemetry ({earlierItems.length} items from{' '}
                {earlierItems[0]?.formattedTime} to{' '}
                {earlierItems[earlierItems.length - 1]?.formattedTime})
              </summary>
              <ul
                className="evidence-list"
                role="list"
                style={{ marginBlockStart: '0.45rem' }}
              >
                {earlierItems.map((item) => renderEvidenceCard(item, false))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
};
