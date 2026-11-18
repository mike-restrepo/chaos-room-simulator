import React from 'react';
import type { ServiceHealth, ServiceId, ServiceRuntimeStatus } from '@chaos-room/shared';

interface ServiceMapPanelProps {
  services: ServiceRuntimeStatus[];
  selectedServiceId: ServiceId | null;
  onSelectService: (serviceId: ServiceId | null) => void;
  oneSentenceJourney: string;
}

interface NodeDef {
  id: ServiceId;
  cx: number;
  cy: number;
  size: number;
  iconSize: number;
  shortTitle: string;
  roleTag: string;
  iconId: string;
  labelPosition?: 'bottom' | 'right';
}

const NODE_DEFS: NodeDef[] = [
  {
    id: 'visitor',
    cx: 140,
    cy: 48,
    size: 52,
    iconSize: 30,
    shortTitle: 'Visitor Client',
    roleTag: 'CLIENT',
    iconId: '#icon-client',
  },
  {
    id: 'api-gateway',
    cx: 390,
    cy: 48,
    size: 54,
    iconSize: 32,
    shortTitle: 'API Gateway',
    roleTag: 'EDGE ROUTER',
    iconId: '#icon-gateway',
  },
  {
    id: 'reservation-service',
    cx: 390,
    cy: 160,
    size: 62,
    iconSize: 38,
    shortTitle: 'Reservation Service',
    roleTag: 'CORE API',
    iconId: '#icon-service',
  },
  {
    id: 'inventory-db',
    cx: 160,
    cy: 265,
    size: 54,
    iconSize: 32,
    shortTitle: 'Inventory Database',
    roleTag: 'POSTGRES DB',
    iconId: '#icon-database',
  },
  {
    id: 'confirmation-queue',
    cx: 570,
    cy: 250,
    size: 54,
    iconSize: 32,
    shortTitle: 'Confirmation Queue',
    roleTag: 'ASYNC BUS',
    iconId: '#icon-queue',
    labelPosition: 'right',
  },
  {
    id: 'confirmation-worker',
    cx: 570,
    cy: 385,
    size: 52,
    iconSize: 30,
    shortTitle: 'Confirmation Worker',
    roleTag: 'CONSUMER',
    iconId: '#icon-worker',
  },
  {
    id: 'notification-provider',
    cx: 320,
    cy: 385,
    size: 52,
    iconSize: 30,
    shortTitle: 'Notification Provider',
    roleTag: 'EXTERNAL API',
    iconId: '#icon-cloud',
  },
];

const EDGES: Array<{ from: ServiceId; to: ServiceId; path: string }> = [
  { from: 'visitor', to: 'api-gateway', path: 'M 166 48 L 363 48' },
  { from: 'api-gateway', to: 'reservation-service', path: 'M 390 75 L 390 129' },
  {
    from: 'reservation-service',
    to: 'inventory-db',
    path: 'M 359 160 C 270 160 180 200 160 238',
  },
  {
    from: 'reservation-service',
    to: 'confirmation-queue',
    path: 'M 421 160 C 490 160 550 185 570 223',
  },
  { from: 'confirmation-queue', to: 'confirmation-worker', path: 'M 570 277 L 570 359' },
  { from: 'confirmation-worker', to: 'notification-provider', path: 'M 544 385 L 346 385' },
];

export function getHealthSymbol(health: ServiceHealth): { symbol: string; label: string } {
  switch (health) {
    case 'healthy':
      return { symbol: '●', label: 'Healthy' };
    case 'degraded':
      return { symbol: '▲', label: 'Degraded' };
    case 'failing':
      return { symbol: '◆', label: 'Failing' };
  }
}

function getStrokeForHealth(health: ServiceHealth, isSelected: boolean): string {
  if (isSelected) return '#38bdf8';
  switch (health) {
    case 'healthy':
      return '#059669';
    case 'degraded':
      return '#d97706';
    case 'failing':
      return '#dc2626';
  }
}

function getFillForHealth(health: ServiceHealth, isSelected: boolean): string {
  if (isSelected) return 'url(#node-grad-selected)';
  switch (health) {
    case 'healthy':
      return 'url(#node-grad-healthy)';
    case 'degraded':
      return 'url(#node-grad-degraded)';
    case 'failing':
      return 'url(#node-grad-failing)';
  }
}

function getPrimaryMetricDisplay(svc: ServiceRuntimeStatus): string {
  if (svc.id === 'reservation-service' && svc.secondaryMetricValue) {
    return `Failed: ${svc.secondaryMetricValue}`;
  }
  if (svc.id === 'visitor') {
    return `Impacted: ${svc.primaryMetricValue}`;
  }
  if (svc.id === 'inventory-db') {
    return `Pool: ${svc.primaryMetricValue}`;
  }
  if (svc.id === 'confirmation-queue') {
    return `Backlog: ${svc.primaryMetricValue}`;
  }
  if (svc.id === 'confirmation-worker') {
    return `Amp: ${svc.primaryMetricValue}`;
  }
  if (svc.id === 'notification-provider' || svc.id === 'api-gateway') {
    return `p95: ${svc.primaryMetricValue}`;
  }
  return `${svc.primaryMetricLabel}: ${svc.primaryMetricValue}`;
}

export const ServiceMapPanel: React.FC<ServiceMapPanelProps> = ({
  services,
  selectedServiceId,
  onSelectService,
  oneSentenceJourney,
}) => {
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const selectedService = selectedServiceId ? serviceById.get(selectedServiceId) : null;

  return (
    <section className="panel-card map-center-card" aria-labelledby="system-map-heading">
      <div className="panel-header">
        <div className="map-header-left">
          <div className="map-title-row">
            <h2 id="system-map-heading" className="panel-title">
              System map
            </h2>
            <span className="live-graph-tag mono">LIVE TOPOLOGY</span>
          </div>
          <p className="panel-subtitle">
            Interactive dependency architecture. Click a node to inspect details and filter telemetry.
          </p>
        </div>

        <div className="map-legend">
          <span className="legend-item">
            <span className="legend-dot" style={{ background: '#34d399' }} />
            <span>Healthy</span>
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ background: '#fbbf24' }} />
            <span>Degraded</span>
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ background: '#f87171' }} />
            <span>Failing</span>
          </span>
          {selectedServiceId && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onSelectService(null)}
              aria-label="Clear service selection"
              style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem' }}
            >
              Clear filter ✕
            </button>
          )}
        </div>
      </div>

      {/* Always-visible customer journey explanation */}
      <div className="customer-journey-strip" data-customer-journey="true">
        <span className="journey-label mono">CUSTOMER JOURNEY</span>
        <p className="journey-text">
          Customers reserve an event spot; the reservation is saved, then its confirmation is
          delivered separately.
        </p>
      </div>

      {/* Mobile Pan / Scroll Hint */}
      <div className="mobile-map-hint mono" aria-hidden="true">
        ↔ Pan map to explore topology · Tap node to inspect
      </div>

      {/* Dominant Interactive SVG Dependency Map */}
      <div className="topology-svg-wrap">
        <svg
          className="topology-svg"
          viewBox="0 0 790 465"
          role="img"
          aria-labelledby="svg-topology-title svg-topology-desc"
        >
          <title id="svg-topology-title">
            Simulated 7-node event-reservation system dependency graph
          </title>
          <desc id="svg-topology-desc">
            Visitor requests flow through API gateway to Reservation service, which writes to
            Inventory database and publishes to Confirmation queue, consumed by Confirmation worker
            and sent via Notification provider.
          </desc>
          <defs>
            {/* Tech background coordinate micro-grid */}
            <pattern id="topology-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="24" y2="0" stroke="rgba(56, 189, 248, 0.04)" strokeWidth="0.8" />
              <line x1="0" y1="0" x2="0" y2="24" stroke="rgba(56, 189, 248, 0.04)" strokeWidth="0.8" />
            </pattern>

            {/* Glowing drop shadow filters for selected / degraded / failing states */}
            <filter id="glow-cyan" x="-25%" y="-25%" width="150%" height="150%">
              <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="#38bdf8" floodOpacity="0.7" />
            </filter>
            <filter id="glow-fail" x="-25%" y="-25%" width="150%" height="150%">
              <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#f87171" floodOpacity="0.55" />
            </filter>
            <filter id="glow-warn" x="-25%" y="-25%" width="150%" height="150%">
              <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#fbbf24" floodOpacity="0.5" />
            </filter>

            {/* Linear gradients for console node backgrounds */}
            <linearGradient id="node-grad-healthy" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#0d1f3c" />
              <stop offset="100%" stopColor="#061226" />
            </linearGradient>
            <linearGradient id="node-grad-degraded" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#281a06" />
              <stop offset="100%" stopColor="#140d02" />
            </linearGradient>
            <linearGradient id="node-grad-failing" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#300d14" />
              <stop offset="100%" stopColor="#180407" />
            </linearGradient>
            <linearGradient id="node-grad-selected" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#0e3258" />
              <stop offset="100%" stopColor="#081c34" />
            </linearGradient>

            {/* Reusable Lightweight SVG Node Icons (24x24 viewBox) */}
            <g id="icon-client">
              <rect x="2" y="3" width="20" height="13" rx="2" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" />
              <path d="M 6 8 L 9 10 L 6 12 M 11 12 L 14 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M 8 19 L 16 19 M 12 16 L 12 19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </g>
            <g id="icon-gateway">
              <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" />
              <path d="M 12 3 L 12 6.5 M 12 17.5 L 12 21 M 3 12 L 6.5 12 M 17.5 12 L 21 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="12" cy="12" r="3.2" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.4" />
            </g>
            <g id="icon-service">
              {/* Isometric 3D Microservice Cube */}
              <path d="M 12 2.5 L 20.5 7.2 L 12 12 L 3.5 7.2 Z" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M 3.5 7.2 L 12 12 L 12 21.5 L 3.5 16.8 Z" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M 20.5 7.2 L 12 12 L 12 21.5 L 20.5 16.8 Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            </g>
            <g id="icon-database">
              {/* Database Cylinder */}
              <ellipse cx="12" cy="5.5" rx="8" ry="3.2" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.5" />
              <path d="M 4 11.5 C 4 13.3 7.6 14.8 12 14.8 C 16.4 14.8 20 13.3 20 11.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M 4 5.5 L 4 18.5 C 4 20.3 7.6 21.8 12 21.8 C 16.4 21.8 20 20.3 20 18.5 L 20 5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </g>
            <g id="icon-queue">
              {/* Message Queue / Event Bus */}
              <rect x="3" y="6" width="18" height="12" rx="2.5" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.5" />
              <line x1="8" y1="6" x2="8" y2="18" stroke="currentColor" strokeWidth="1.4" />
              <line x1="13" y1="6" x2="13" y2="18" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="17.2" cy="12" r="1.5" fill="currentColor" />
            </g>
            <g id="icon-worker">
              {/* Consumer Worker Daemon */}
              <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M 9 2 L 9 5 M 15 2 L 15 5 M 9 19 L 9 22 M 15 19 L 15 22 M 2 9 L 5 9 M 2 15 L 5 15 M 19 9 L 22 9 M 19 15 L 22 15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </g>
            <g id="icon-cloud">
              {/* External Cloud Provider */}
              <path
                d="M 6.5 18 C 4 18 2 16 2 13.5 C 2 11.2 3.6 9.3 5.8 9.1 C 6.5 6.2 9 4 12 4 C 15.5 4 18.3 6.6 18.7 10 C 20.6 10.4 22 12 22 14 C 22 16.2 20.2 18 18 18 Z"
                fill="currentColor"
                fillOpacity="0.18"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </g>

            {/* Edge Markers */}
            <marker
              id="arrow-head-healthy"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" />
            </marker>
            <marker
              id="arrow-head-warn"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#fbbf24" />
            </marker>
            <marker
              id="arrow-head-fail"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#f87171" />
            </marker>
          </defs>

          {/* Background grid & subtle radar rings */}
          <rect width="790" height="465" fill="url(#topology-grid)" />
          <circle cx="390" cy="230" r="90" fill="none" stroke="rgba(56, 189, 248, 0.05)" strokeDasharray="3 5" />
          <circle cx="390" cy="230" r="190" fill="none" stroke="rgba(56, 189, 248, 0.035)" strokeDasharray="4 7" />
          <circle cx="390" cy="230" r="290" fill="none" stroke="rgba(56, 189, 248, 0.025)" strokeDasharray="5 9" />

          {/* Directed Service Dependency Edges */}
          {EDGES.map((edge) => {
            const targetHealth = serviceById.get(edge.to)?.health ?? 'healthy';
            const sourceHealth = serviceById.get(edge.from)?.health ?? 'healthy';
            const hasIssue = targetHealth !== 'healthy' || sourceHealth !== 'healthy';
            const isFailing = targetHealth === 'failing' || sourceHealth === 'failing';

            const strokeColor = isFailing
              ? '#f87171'
              : hasIssue
                ? '#fbbf24'
                : 'rgba(56, 189, 248, 0.45)';
            const markerId = isFailing
              ? 'url(#arrow-head-fail)'
              : hasIssue
                ? 'url(#arrow-head-warn)'
                : 'url(#arrow-head-healthy)';

            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={edge.path}
                fill="none"
                stroke={strokeColor}
                strokeWidth={hasIssue ? 2 : 1.4}
                strokeDasharray={hasIssue ? '6 4' : undefined}
                markerEnd={markerId}
                opacity={hasIssue ? 0.95 : 0.75}
              />
            );
          })}

          {/* Interactive Topology Nodes (Icon-Led) */}
          {NODE_DEFS.map((coord) => {
            const svc = serviceById.get(coord.id);
            if (!svc) return null;

            const isSelected = selectedServiceId === coord.id;
            const strokeColor = getStrokeForHealth(svc.health, isSelected);
            const fillColor = getFillForHealth(svc.health, isSelected);
            const { symbol, label } = getHealthSymbol(svc.health);

            const badgeColor =
              svc.health === 'failing'
                ? '#f87171'
                : svc.health === 'degraded'
                  ? '#fbbf24'
                  : '#34d399';

            const metricColor =
              svc.health === 'failing'
                ? '#f87171'
                : svc.health === 'degraded'
                  ? '#fbbf24'
                  : '#38bdf8';

            const hSize = coord.size / 2;
            const bLen = 6;
            const bx = coord.cx - hSize;
            const by = coord.cy - hSize;
            const bw = coord.size;
            const bh = coord.size;
            const cornerStroke = isSelected
              ? '#38bdf8'
              : svc.health === 'failing'
                ? '#f87171'
                : svc.health === 'degraded'
                  ? '#fbbf24'
                  : '#1e3a8a';
            const cornerD = `M ${bx} ${by + bLen} L ${bx} ${by} L ${bx + bLen} ${by} M ${bx + bw - bLen} ${by} L ${bx + bw} ${by} L ${bx + bw} ${by + bLen} M ${bx} ${by + bh - bLen} L ${bx} ${by + bh} L ${bx + bLen} ${by + bh} M ${bx + bw - bLen} ${by + bh} L ${bx + bw} ${by + bh} L ${bx + bw} ${by + bh - bLen}`;

            const keyMetricStr = getPrimaryMetricDisplay(svc);

            const isRightLabel = coord.labelPosition === 'right';
            const plateWidth = 172;
            const plateHeight = 40;
            const plateX = isRightLabel ? coord.cx + hSize + 8 : coord.cx - plateWidth / 2;
            const plateY = isRightLabel ? coord.cy - plateHeight / 2 : coord.cy + hSize + 4;
            const titleX = isRightLabel ? plateX + plateWidth / 2 : coord.cx;
            const titleY = isRightLabel ? coord.cy - 4 : coord.cy + hSize + 19;
            const metricX = titleX;
            const metricY = isRightLabel ? coord.cy + 11 : coord.cy + hSize + 34;

            const hitX = isRightLabel ? coord.cx - hSize - 4 : coord.cx - plateWidth / 2 - 2;
            const hitY = coord.cy - hSize - 4;
            const hitW = isRightLabel ? hSize * 2 + 12 + plateWidth : plateWidth + 4;
            const hitH = isRightLabel ? hSize * 2 + 8 : hSize * 2 + 54;

            return (
              <g
                key={coord.id}
                className="map-node-group"
                data-service-id={coord.id}
                onClick={() => onSelectService(isSelected ? null : coord.id)}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${coord.shortTitle}: ${label}. Primary: ${svc.primaryMetricLabel} ${svc.primaryMetricValue}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectService(isSelected ? null : coord.id);
                  }
                }}
              >
                {/* Accessible Full-Area Hit Target */}
                <rect
                  x={hitX}
                  y={hitY}
                  width={hitW}
                  height={hitH}
                  fill="transparent"
                  rx={8}
                  className="map-node-hit"
                />

                {/* Primary Visual Object: Icon Plate with concentrated glow halo */}
                <rect
                  x={bx}
                  y={by}
                  width={bw}
                  height={bh}
                  rx={10}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={isSelected ? 2.5 : 1.4}
                  filter={
                    isSelected
                      ? 'url(#glow-cyan)'
                      : svc.health === 'failing'
                        ? 'url(#glow-fail)'
                        : svc.health === 'degraded'
                          ? 'url(#glow-warn)'
                          : undefined
                  }
                  className="map-node-symbol-plate"
                />

                {/* Technical corner brackets */}
                <path d={cornerD} stroke={cornerStroke} strokeWidth={isSelected ? 2.2 : 1.3} fill="none" opacity={0.85} />

                {/* Hero Vector Symbol */}
                <g
                  transform={`translate(${coord.cx - coord.iconSize / 2}, ${coord.cy - coord.iconSize / 2})`}
                  color={badgeColor}
                  className="map-node-hero-icon"
                >
                  <use href={coord.iconId} width={coord.iconSize} height={coord.iconSize} />
                </g>

                {/* Small status indicator pip */}
                <circle
                  cx={coord.cx + hSize - 3}
                  cy={coord.cy - hSize + 3}
                  r={4.2}
                  fill={badgeColor}
                  stroke="#020617"
                  strokeWidth={1.4}
                />

                {/* Compact Background Plate for Label & Key Metric */}
                <rect
                  x={plateX}
                  y={plateY}
                  width={plateWidth}
                  height={plateHeight}
                  rx={6}
                  fill="rgba(4, 11, 24, 0.88)"
                  stroke={isSelected ? 'rgba(56, 189, 248, 0.5)' : 'rgba(56, 189, 248, 0.18)'}
                  strokeWidth={0.9}
                />

                {/* Concise Service Label */}
                <text
                  x={titleX}
                  y={titleY}
                  textAnchor="middle"
                  fill="#f8fafc"
                  fontSize="12.5"
                  fontWeight="700"
                >
                  {coord.shortTitle}
                </text>

                {/* Role Tag & Key Metric in Monospace */}
                <text
                  x={metricX}
                  y={metricY}
                  textAnchor="middle"
                  fontSize="9.5"
                  fontFamily="ui-monospace, monospace"
                >
                  <tspan fill="#94a3b8" fontWeight="600">{coord.roleTag}</tspan>
                  <tspan fill={metricColor} fontWeight="700"> · {keyMetricStr}</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Selected Node Detailed Inspector */}
      {selectedService && (
        <div className="selected-node-inspector" role="region" aria-label="Selected service details">
          <div className="inspector-top-row">
            <div className="inspector-title-group">
              <span className="inspector-role-tag mono">{selectedService.id.toUpperCase()}</span>
              <h3 className="inspector-name">{selectedService.name}</h3>
            </div>
            <span className="status-badge" data-health={selectedService.health}>
              {getHealthSymbol(selectedService.health).symbol} {getHealthSymbol(selectedService.health).label}
            </span>
          </div>

          <p className="inspector-summary">{selectedService.statusSummary}</p>

          <div className="inspector-metrics mono">
            <div className="inspector-metric-pill">
              <span className="metric-tag">{selectedService.primaryMetricLabel}:</span>
              <strong className="metric-val">{selectedService.primaryMetricValue}</strong>
            </div>
            <div className="inspector-metric-pill">
              <span className="metric-tag">{selectedService.secondaryMetricLabel}:</span>
              <strong className="metric-val">{selectedService.secondaryMetricValue}</strong>
            </div>
          </div>

          <div className="inspector-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onSelectService(selectedService.id)}
            >
              Filter evidence for {selectedService.name} →
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onSelectService(null)}
            >
              Deselect
            </button>
          </div>
        </div>
      )}

      {/* Accessible Expandable Service List & Architecture Notes */}
      <details className="services-accessible-drawer">
        <summary className="services-drawer-summary">
          <h3 id="services-heading" style={{ display: 'inline', fontSize: '0.82rem', fontWeight: 700 }}>
            Services
          </h3>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginInlineStart: '0.35rem' }}>
            &amp; Architecture Notes
          </span>
          <span className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginInlineStart: '0.5rem' }}>
            ({services.length} registered · {services.filter((s) => s.health !== 'healthy').length} alerts)
          </span>
        </summary>
        <div style={{ padding: '0.4rem 0.65rem', borderBlockEnd: '1px solid var(--border-subtle)', fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          <strong>Request flow:</strong> {oneSentenceJourney}
        </div>
        <ul className="service-list" role="list">
          {services.map((svc) => {
            const isSelected = selectedServiceId === svc.id;
            const { symbol, label } = getHealthSymbol(svc.health);
            return (
              <li key={svc.id}>
                <button
                  type="button"
                  className="service-list-btn"
                  aria-pressed={isSelected}
                  onClick={() => onSelectService(isSelected ? null : svc.id)}
                >
                  <div className="service-item-top">
                    <span>{svc.name}</span>
                    <span className="status-badge" data-health={svc.health}>
                      <span aria-hidden="true">{symbol}</span>
                      <span>{label}</span>
                    </span>
                  </div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                    {svc.statusSummary}
                  </div>
                  <div className="service-item-metrics mono">
                    <span>
                      {svc.primaryMetricLabel}: <strong>{svc.primaryMetricValue}</strong>
                    </span>
                    <span>
                      {svc.secondaryMetricLabel}: <strong>{svc.secondaryMetricValue}</strong>
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
};
