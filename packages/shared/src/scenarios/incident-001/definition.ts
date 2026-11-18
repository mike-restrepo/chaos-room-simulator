import type { EvidenceItem, InterventionOption, ScenarioDefinition } from '../../contracts/index.js';
import { formatSimTime } from '../../engine/prng.js';
import { SHARED_SYSTEM_DESCRIPTION, SHARED_TOPOLOGY } from '../topology.js';
import { INCIDENT_001_WALKTHROUGHS } from './walkthroughs.js';
import { INCIDENT_001_DEBRIEF } from './debrief.js';

export const INCIDENT_001_INTERVENTIONS: InterventionOption[] = [
  {
    id: 'act-rollback-drain',
    label: 'Roll back the recent release and drain/recycle affected instances',
    shortLabel: 'Roll back & drain instances',
    summary:
      'Revert reservation-service from v2.14.0 to v2.13.4 and gracefully drain active pods so leaked database connections close.',
    immediateTradeoff:
      'Brief capacity reduction (~90 simulated seconds) while affected pods drain before full pool recovery.',
    stages: [
      '06:00 — Initiate rollback to v2.13.4 and cordon v2.14.0 pods',
      '06:45 — Drain in-flight requests and close 82 stranded pool handles',
      '07:30 — Pool utilization recovers to ~20/100; reservation error rate returns to 0%',
    ],
  },
  {
    id: 'act-increase-pool',
    label: 'Increase the connection limit',
    shortLabel: 'Increase DB pool limit (100 → 200)',
    summary:
      'Double the reservation-service database connection pool ceiling from 100 to 200 connections via live configuration.',
    immediateTradeoff:
      'Provides immediate breathing room, but if connections are leaking rather than undersized, the larger pool will also saturate.',
    stages: [
      '06:00 — Live-update pool max_connections from 100 to 200',
      '06:30–08:30 — Temporary improvement as fresh slots absorb requests',
      '09:30–15:00 — Unreleased handles fill all 200 slots; severe timeouts resume',
    ],
  },
  {
    id: 'act-observe',
    label: 'Observe without changing anything',
    shortLabel: 'Observe without changing anything',
    summary:
      'Keep current deployment and pool settings unchanged while continuing to monitor telemetry through 15:00.',
    immediateTradeoff:
      'Zero change-induced risk, but ongoing customer reservation failures continue accumulating unabated.',
    stages: [
      '06:00 — Hold current configuration and continue observation',
      '09:00 — Pool remains pinned at 100/100 active connections',
      '15:00 — Sustained ~45% reservation error rate and mounting affected customers',
    ],
  },
];

const BASE_EVIDENCE_ITEMS: EvidenceItem[] = [
  {
    id: 'ev-dep-090',
    simTimeSeconds: 90,
    formattedTime: formatSimTime(90),
    service: 'reservation-service',
    type: 'deployment',
    severity: 'info',
    title: 'Deploy reservation-service v2.14.0',
    summary: 'Rolled out v2.14.0 across 4 reservation-service instances (commit 9f4c2a1).',
    detail:
      'Release v2.14.0 refactors inventory lock acquisition into reserveWithTimeout(ctx, 2200ms) to standardize deadline handling across reservation endpoints.',
    correlationId: 'rel-v2.14.0',
  },
  {
    id: 'ev-met-120',
    simTimeSeconds: 120,
    formattedTime: formatSimTime(120),
    service: 'api-gateway',
    type: 'metric',
    severity: 'info',
    title: 'Promotional newsletter traffic bump (+18% req/min)',
    summary: 'Inbound reservation request rate increased from 110 req/min to 130 req/min after scheduled campaign.',
    detail:
      'Traffic increase is well within the API gateway and reservation-service rated capacity of 250 req/min. Gateway CPU is 24%.',
    measureName: 'gateway_requests_per_min',
    measureValue: '130 req/min (+18%)',
    isAlternativeClue: true,
  },
  {
    id: 'ev-met-150',
    simTimeSeconds: 150,
    formattedTime: formatSimTime(150),
    service: 'inventory-db',
    type: 'metric',
    severity: 'warn',
    title: 'Active DB connections climbing rapidly (78 / 100)',
    summary: 'Pooled connections marked in-use rose from 20 to 78 while database CPU remains moderate at 36%.',
    detail:
      'inventory-db reports 78 active connections from reservation-service, but only 14 connections are actively executing SQL statements. DB CPU is 36%, disk IOPS at 22% of provisioned limit.',
    measureName: 'db_pool_active_connections',
    measureValue: '78 / 100 (DB CPU: 36%)',
  },
  {
    id: 'ev-log-165',
    simTimeSeconds: 165,
    formattedTime: formatSimTime(165),
    service: 'api-gateway',
    type: 'log',
    severity: 'warn',
    title: 'Upstream deadline exceeded calling reservation-service (2,500 ms)',
    summary: 'Gateway returned HTTP 504 for reservation attempt res-0019 after 2,500 ms timeout.',
    detail:
      'WARN [gateway] upstream_timeout route="POST /v1/reservations" reservation_id="res-0019" attempt=1 elapsed_ms=2500 upstream="reservation-service:8080"',
    correlationId: 'res-0019',
  },
  {
    id: 'ev-met-180',
    simTimeSeconds: 180,
    formattedTime: formatSimTime(180),
    service: 'reservation-service',
    type: 'metric',
    severity: 'error',
    title: 'Alert triggered: Reservation error rate > 12% and API p95 > 1,800 ms',
    summary: 'Checkpoint Alert @ 03:00 — Reservation timeouts breached SLO while DB CPU sits at 36%.',
    detail:
      'Trailing 60s reservation error rate reached 30.1% (43/143 failed) and API p95 latency hit 2,493 ms. Active DB connections reached 94/100 while confirmation queue backlog is only 1.',
    measureName: 'reservation_error_rate_60s',
    measureValue: '30.1% (p95: 2,493 ms)',
  },
  {
    id: 'ev-met-225',
    simTimeSeconds: 225,
    formattedTime: formatSimTime(225),
    service: 'inventory-db',
    type: 'metric',
    severity: 'error',
    title: 'DB connection pool saturated (100 / 100 active, 38% CPU)',
    summary: 'All 100 pool slots are held by reservation-service, yet DB CPU is 38% and query throughput dropped.',
    detail:
      'pool_max=100, pool_in_use=100, pool_wait_queue=34, db_cpu_pct=38%, active_running_queries=16, idle_in_pool_handles=84.',
    measureName: 'db_pool_active_connections',
    measureValue: '100 / 100 (84 idle-held)',
  },
  {
    id: 'ev-log-270',
    simTimeSeconds: 270,
    formattedTime: formatSimTime(270),
    service: 'reservation-service',
    type: 'log',
    severity: 'error',
    title: 'Early return on canceled context skips conn.Release() in v2.14.0',
    summary: 'reservation-service v2.14.0 logs show reserveWithTimeout returning on context timeout without releasing handle.',
    detail:
      'ERROR [reservation-service v2.14.0] file="inventory_repo.go:142" fn="reserveWithTimeout" msg="context deadline exceeded; returning early before conn.Release()" leaked_conn_id="pg-conn-074" pool_in_use="100/100" wait_queue=41',
    correlationId: 'trc-8841',
  },
  {
    id: 'ev-trc-315',
    simTimeSeconds: 315,
    formattedTime: formatSimTime(315),
    service: 'reservation-service',
    type: 'trace',
    severity: 'error',
    title: 'Trace trc-8841: 2,410 ms stalled in db.pool.acquire before query execution',
    summary: 'Distributed trace shows request spent 96.4% of its 2,500 ms budget waiting for a free pool connection.',
    detail:
      'Trace trc-8841 (reservation_id="res-0084"): api-gateway forwarded request in 4 ms; reservation-service blocked inside db.pool.acquire for 2,410 ms until context deadline canceled the request. Zero SQL queries were executed on this attempt.',
    correlationId: 'trc-8841',
    traceSpans: [
      {
        spanId: 'sp-1',
        service: 'api-gateway',
        operation: 'POST /v1/reservations',
        startOffsetMs: 0,
        durationMs: 2500,
        status: 'timeout',
        note: 'Gateway 2,500 ms deadline exceeded (HTTP 504)',
      },
      {
        spanId: 'sp-2',
        service: 'reservation-service',
        operation: 'reserveWithTimeout (v2.14.0)',
        startOffsetMs: 4,
        durationMs: 2492,
        status: 'timeout',
        note: 'Context canceled before conn.Release() on previously acquired handles',
      },
      {
        spanId: 'sp-3',
        service: 'inventory-db',
        operation: 'db.pool.acquire (wait queue depth: 41)',
        startOffsetMs: 8,
        durationMs: 2410,
        status: 'timeout',
        note: 'Blocked waiting for an available connection from 100/100 saturated pool',
      },
    ],
  },
  {
    id: 'ev-met-345',
    simTimeSeconds: 345,
    formattedTime: formatSimTime(345),
    service: 'confirmation-worker',
    type: 'metric',
    severity: 'info',
    title: 'Confirmation worker & notification provider healthy (backlog: 1)',
    summary: 'Asynchronous confirmation delivery is operating normally for all accepted reservations.',
    detail:
      'Confirmation queue depth is 1 message, worker processing time is 18 ms, and notification-provider p95 latency is 110 ms with 1.0x delivery attempts per message.',
    measureName: 'confirmation_pipeline_health',
    measureValue: 'Backlog: 1 · Provider p95: 110 ms',
  },
  {
    id: 'ev-log-360',
    simTimeSeconds: 360,
    formattedTime: formatSimTime(360),
    service: 'reservation-service',
    type: 'log',
    severity: 'error',
    title: 'Evidence checkpoint @ 06:00: 82 of 100 DB connections stranded by v2.14.0',
    summary: 'Pool diagnostics confirm 82 leaked handles held open by v2.14.0 pods; only 18 slots remain usable.',
    detail:
      'WARN [pool-diagnostics] total_capacity=100 leaked_idle_handles=82 usable_handles=18 error_rate_60s="52.4%" api_p95_ms=2495 cumulative_affected_reservations=169 release_version="v2.14.0"',
    correlationId: 'rel-v2.14.0',
  },
];

const BRANCH_EVIDENCE_ITEMS: Record<string, EvidenceItem[]> = {
  'act-rollback-drain': [
    {
      id: 'ev-dep-390-rb',
      simTimeSeconds: 390,
      formattedTime: formatSimTime(390),
      service: 'reservation-service',
      type: 'deployment',
      severity: 'info',
      title: 'Rollback initiated: restoring v2.13.4 and draining v2.14.0 pods',
      summary: 'Cordoned v2.14.0 instances and launched v2.13.4 replacement pods; draining in-flight connections.',
      detail:
        'Rolling deployment replacing 4x v2.14.0 pods with v2.13.4. Graceful termination closes orphaned TCP sockets and DB pool handles as each pod exits.',
      correlationId: 'rel-v2.13.4-rollback',
    },
    {
      id: 'ev-met-450-rb',
      simTimeSeconds: 450,
      formattedTime: formatSimTime(450),
      service: 'inventory-db',
      type: 'metric',
      severity: 'info',
      title: 'Stranded DB connections released (active pool: 22 / 100)',
      summary: 'Pool utilization dropped from 100/100 to 22/100 as v2.14.0 pods completed draining.',
      detail:
        'pool_max=100, pool_in_use=22, pool_wait_queue=0, acquire_wait_p95_ms=4, db_cpu_pct=31%. All 82 leaked handles were reclaimed.',
      measureName: 'db_pool_active_connections',
      measureValue: '22 / 100 (0 queued)',
    },
    {
      id: 'ev-trc-600-rb',
      simTimeSeconds: 600,
      formattedTime: formatSimTime(600),
      service: 'reservation-service',
      type: 'trace',
      severity: 'info',
      title: 'Trace trc-9104: End-to-end reservation completed in 84 ms',
      summary: 'Healthy v2.13.4 trace confirms immediate connection acquisition and proper handle release.',
      detail:
        'Trace trc-9104 (reservation_id="res-0211"): db.pool.acquire=3ms, inventory_db.query=16ms, confirmation_queue.enqueue=8ms, conn.Release() executed via defer.',
      correlationId: 'trc-9104',
      traceSpans: [
        {
          spanId: 'sp-rb-1',
          service: 'api-gateway',
          operation: 'POST /v1/reservations',
          startOffsetMs: 0,
          durationMs: 84,
          status: 'ok',
          note: 'HTTP 201 Created',
        },
        {
          spanId: 'sp-rb-2',
          service: 'reservation-service',
          operation: 'createReservation (v2.13.4)',
          startOffsetMs: 4,
          durationMs: 76,
          status: 'ok',
          note: 'defer conn.Release() executed cleanly',
        },
        {
          spanId: 'sp-rb-3',
          service: 'inventory-db',
          operation: 'db.pool.acquire + INSERT reservation',
          startOffsetMs: 7,
          durationMs: 19,
          status: 'ok',
          note: '3 ms pool acquire + 16 ms SQL transaction',
        },
        {
          spanId: 'sp-rb-4',
          service: 'confirmation-queue',
          operation: 'publish ReservationCreated',
          startOffsetMs: 28,
          durationMs: 8,
          status: 'ok',
          note: 'Picked up by confirmation-worker in 42 ms',
        },
      ],
    },
    {
      id: 'ev-log-900-rb',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'reservation-service',
      type: 'log',
      severity: 'info',
      title: 'Outcome @ 15:00: Service healthy on v2.13.4 (0.0% error rate, p95 147 ms)',
      summary: 'Seven consecutive minutes of zero reservation timeouts and normal connection pool headroom.',
      detail:
        'INFO [health] release="v2.13.4" pool_in_use="22/100" error_rate_60s="0.0%" api_p95_ms=147 confirmation_backlog=2 cumulative_affected_reservations=187 status="RESOLVED"',
      correlationId: 'rel-v2.13.4-rollback',
    },
  ],

  'act-increase-pool': [
    {
      id: 'ev-dep-390-pool',
      simTimeSeconds: 390,
      formattedTime: formatSimTime(390),
      service: 'inventory-db',
      type: 'deployment',
      severity: 'info',
      title: 'Live config update: DB connection pool limit raised from 100 to 200',
      summary: 'Added 100 additional connection slots without rolling back reservation-service v2.14.0.',
      detail:
        'Dynamic pool resize applied across reservation-service instances. Total pool ceiling is now 200 connections; v2.14.0 remains active.',
      correlationId: 'cfg-pool-200',
    },
    {
      id: 'ev-met-480-pool',
      simTimeSeconds: 480,
      formattedTime: formatSimTime(480),
      service: 'inventory-db',
      type: 'metric',
      severity: 'warn',
      title: 'Temporary relief fading: active connections at 158 / 200',
      summary: 'Error rate dipped to ~4% at 07:30, but leaked connections continue growing by ~18 handles/min.',
      detail:
        'pool_max=200, pool_in_use=158, leaked_idle_handles=134, usable_handles=66. Tail timeouts are still triggering the v2.14.0 cancellation leak.',
      measureName: 'db_pool_active_connections',
      measureValue: '158 / 200 (climbing)',
    },
    {
      id: 'ev-log-600-pool',
      simTimeSeconds: 600,
      formattedTime: formatSimTime(600),
      service: 'reservation-service',
      type: 'log',
      severity: 'error',
      title: 'Expanded 200-connection pool saturated (200 / 200 active)',
      summary: 'All 100 additional connection slots have now been consumed by unreleased handles in v2.14.0.',
      detail:
        'ERROR [reservation-service v2.14.0] fn="reserveWithTimeout" msg="pool exhausted after resize" pool_in_use="200/200" leaked_idle_handles=181 wait_queue=53',
      correlationId: 'cfg-pool-200',
    },
    {
      id: 'ev-met-900-pool',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'reservation-service',
      type: 'metric',
      severity: 'error',
      title: 'Outcome @ 15:00: Severe timeouts returned (54.5% error rate at 200/200 pool)',
      summary: 'Raising capacity delayed saturation by ~3 minutes but left the leak active and the incident unresolved.',
      detail:
        'pool_in_use="200/200", error_rate_60s="54.5%", api_p95_ms=2494, cumulative_affected_reservations=490.',
      measureName: 'reservation_error_rate_60s',
      measureValue: '54.5% (200/200 pool saturated)',
    },
  ],

  'act-observe': [
    {
      id: 'ev-log-450-obs',
      simTimeSeconds: 450,
      formattedTime: formatSimTime(450),
      service: 'reservation-service',
      type: 'log',
      severity: 'warn',
      title: 'Observation mode: no deployment or configuration changes applied',
      summary: 'System held in observation mode past 06:00; 82 leaked handles remain open in v2.14.0 pods.',
      detail:
        'WARN [ops-audit] intervention="act-observe" pool_in_use="100/100" leaked_idle_handles=82 usable_handles=18',
    },
    {
      id: 'ev-met-630-obs',
      simTimeSeconds: 630,
      formattedTime: formatSimTime(630),
      service: 'api-gateway',
      type: 'metric',
      severity: 'error',
      title: 'Sustained reservation failures (>55% error rate, p95 > 2,480 ms)',
      summary: 'Unmitigated pool exhaustion continues failing over half of all reservation attempts.',
      detail:
        'Trailing 60s reservation error rate remains above 55% with p95 latency at 2,494 ms. Visitors retrying failed attempts add gateway load while unique affected reservations climb.',
      measureName: 'reservation_error_rate_60s',
      measureValue: '58.0% (p95: 2,494 ms)',
    },
    {
      id: 'ev-log-900-obs',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'reservation-service',
      type: 'log',
      severity: 'error',
      title: 'Outcome @ 15:00: Incident unresolved (63.6% error rate, 658 affected reservations)',
      summary: 'Nine minutes of continued observation confirmed leaked connections never self-evict.',
      detail:
        'ERROR [health] release="v2.14.0" pool_in_use="100/100" error_rate_60s="63.6%" api_p95_ms=2494 cumulative_affected_reservations=658 status="UNRESOLVED"',
    },
  ],
};

export const INCIDENT_001_DEFINITION: ScenarioDefinition = {
  incidentId: 'incident-001',
  symptomTitle: 'Reservations are timing out',
  oneSentenceJourney:
    'Visitors reserve an event spot through the API gateway and reservation service (persisted in the inventory database), then receive an asynchronous ticket confirmation via the queue, worker, and notification provider.',
  scenarioVersion: '1.0.0',
  defaultSeed: 1001,
  systemDescription: SHARED_SYSTEM_DESCRIPTION,
  topology: SHARED_TOPOLOGY,
  interventions: INCIDENT_001_INTERVENTIONS,
  buildEvidenceCatalog: (selectedInterventionId: string | null): EvidenceItem[] => {
    const branchItems =
      selectedInterventionId && BRANCH_EVIDENCE_ITEMS[selectedInterventionId]
        ? BRANCH_EVIDENCE_ITEMS[selectedInterventionId]
        : [];
    return [...BASE_EVIDENCE_ITEMS, ...branchItems].sort(
      (a, b) => a.simTimeSeconds - b.simTimeSeconds || a.id.localeCompare(b.id),
    );
  },
  walkthroughs: INCIDENT_001_WALKTHROUGHS,
  debrief: INCIDENT_001_DEBRIEF,
};
