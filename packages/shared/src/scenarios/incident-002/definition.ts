import type { EvidenceItem, InterventionOption, ScenarioDefinition } from '../../contracts/index.js';
import { formatSimTime } from '../../engine/prng.js';
import { SHARED_SYSTEM_DESCRIPTION, SHARED_TOPOLOGY } from '../topology.js';
import { INCIDENT_002_WALKTHROUGHS } from './walkthroughs.js';
import { INCIDENT_002_DEBRIEF } from './debrief.js';

export const INCIDENT_002_INTERVENTIONS: InterventionOption[] = [
  {
    id: 'act-backoff-circuit-breaker',
    label: 'Apply bounded exponential backoff with jitter and a circuit-breaker policy',
    shortLabel: 'Backoff, jitter & circuit breaker',
    summary:
      'Configure confirmation-worker with 1s base exponential backoff, full jitter up to 30s ceiling, max 3 retry attempts per message budget, and a circuit breaker that trips upon 50% provider timeouts.',
    immediateTradeoff:
      'Attempt pressure falls immediately; confirmations temporarily remain queued until the provider recovers from load.',
    stages: [
      '06:00 — Activate circuit breaker, 3-retry budget, and exponential backoff with jitter',
      '07:00 — Circuit breaker trips OPEN; attempt amplification drops to 1.3x and provider latency recovers to 135 ms',
      '08:00 — Confirmation backlog fully cleared (0 queued messages, queue age p95 0s) as worker smoothly drains events',
      '15:00 — Full recovery maintained; provider p95 is 129 ms, retry amplification is 1.00x, and 0 messages are queued',
    ],
  },
  {
    id: 'act-increase-concurrency',
    label: 'Increase worker concurrency',
    shortLabel: 'Increase worker concurrency (4 → 12 threads)',
    summary:
      'Triple confirmation-worker execution threads from 4 to 12 in an attempt to process the accumulating queue faster.',
    immediateTradeoff:
      'Dispatches 3x more concurrent attempts into the already failing notification provider, triggering aggressive rate limits and worsening delivery delays.',
    stages: [
      '06:00 — Scale worker pool to 12 concurrent delivery threads',
      '07:30 — Concurrency surge overwhelms provider; retry amplification jumps to 6.18x and provider p95 reaches 3,825 ms (387 messages queued)',
      '10:00 — Provider rate-limits aggressively; queue backlog reaches 687 messages (p95 age 295s)',
      '15:00 — Severe persistent delay: 1,287 messages stranded in queue with queue age p95 at 555 seconds (> 9 minutes)',
    ],
  },
  {
    id: 'act-observe',
    label: 'Observe without changing anything',
    shortLabel: 'Observe without changing anything',
    summary:
      'Maintain existing unbounded immediate retry policy and monitor provider and queue telemetry through 15:00.',
    immediateTradeoff:
      'Zero deployment risk, but ongoing retry pressure prevents downstream provider recovery and leaves customer confirmations stalled.',
    stages: [
      '06:00 — Hold current configuration and continue observation',
      '08:00 — Continuous unconstrained retries lock provider in degraded state with amplification at 3.73x',
      '12:00 — Backlog accumulates to 783 messages with p95 queue age exceeding 5 minutes (335s)',
      '15:00 — Persistent stall: 1,071 messages delayed in queue; 1,612 reservations delayed past 30s SLA',
    ],
  },
];

const BASE_EVIDENCE_ITEMS: EvidenceItem[] = [
  {
    id: 'ev-dep-060',
    simTimeSeconds: 60,
    formattedTime: formatSimTime(60),
    service: 'confirmation-worker',
    type: 'deployment',
    severity: 'info',
    title: 'Worker configuration audit (immediate retries, no backoff)',
    summary: 'Audit of confirmation-worker service configuration shows no backoff or retry budget configured.',
    detail:
      'confirmation-worker is configured with concurrency: 4 threads, request_timeout: 2500ms, retry_policy: immediate (0ms delay), max_retries: unlimited, retry_budget: none. When send calls time out, workers re-enqueue or retry immediately.',
    correlationId: 'cfg-worker-audit',
  },
  {
    id: 'ev-met-090',
    simTimeSeconds: 90,
    formattedTime: formatSimTime(90),
    service: 'notification-provider',
    type: 'metric',
    severity: 'warn',
    title: 'Notification provider p95 latency climbing (125 ms → 950 ms)',
    summary: 'External notification provider egress latency begins climbing while HTTP status codes remain 200 OK.',
    detail:
      'notification-provider p95 latency rose from 125 ms to 950 ms. Downstream status reports carrier queue delay at external vendor. Upstream reservation API and database continue operating normally at 115 ms p95.',
    measureName: 'provider_p95_latency_ms',
    measureValue: '950 ms (baseline: 125 ms)',
  },
  {
    id: 'ev-met-135',
    simTimeSeconds: 135,
    formattedTime: formatSimTime(135),
    service: 'confirmation-worker',
    type: 'metric',
    severity: 'warn',
    title: 'Delivery attempts multiplying (amplification 2.5x)',
    summary: 'Outbound delivery attempts are growing significantly faster than unique confirmation messages.',
    detail:
      'confirmation-worker sent 28 delivery attempts in trailing 60s for 11 unique confirmation messages (retry amplification: 2.55x). As provider response times approach the 2,500 ms worker timeout, failed attempts trigger instant retries.',
    measureName: 'retry_amplification_ratio',
    measureValue: '2.55x (28 attempts / 11 unique messages)',
  },
  {
    id: 'ev-log-165',
    simTimeSeconds: 165,
    formattedTime: formatSimTime(165),
    service: 'confirmation-worker',
    type: 'log',
    severity: 'error',
    title: 'Worker timeout on notify-partner endpoint (HTTP timeout > 2,500 ms)',
    summary: 'Confirmation delivery worker encountered deadline exceeded while calling external notification API.',
    detail:
      'WARN [DeliveryWorker-2] POST https://api.notify-partner.internal/v1/send timed out after 2,500 ms for msg-0038 (res-0038). Response: ClientTimeout (no bytes received). Retrying immediately (attempt 3 of unbounded)...',
    correlationId: 'msg-0038',
  },
  {
    id: 'ev-met-180',
    simTimeSeconds: 180,
    formattedTime: formatSimTime(180),
    service: 'confirmation-queue',
    type: 'metric',
    severity: 'warn',
    title: 'Confirmation queue backlog alert (99 messages, p95 age 40s)',
    summary:
      'Confirmation queue depth breached warning threshold of 50 messages; p95 queue age is 40 seconds (exceeding 30s customer SLA).',
    detail:
      'confirmation-queue depth: 99 messages. Enqueue rate from reservation-service is steady at 11 msgs/5s (~132 msgs/min), but successful worker ack rate dropped to 2 msgs/5s due to timeouts. Queue age p95 reached 40s (customer SLA: 30s). 28 reservations have experienced confirmation delays exceeding 30 seconds.',
    measureName: 'confirmation_queue_backlog',
    measureValue: '99 messages (p95 age: 40s)',
  },
  {
    id: 'ev-trc-210',
    simTimeSeconds: 210,
    formattedTime: formatSimTime(210),
    service: 'reservation-service',
    type: 'trace',
    severity: 'info',
    title: 'Trace: Successful reservation commit vs stalled notification delivery',
    summary: 'End-to-end trace confirms reservation succeeds in 118 ms; delay is isolated to downstream worker delivery.',
    detail:
      'Distributed trace for reservation res-0072: api-gateway received POST /reservations, reservation-service committed row to inventory-db in 18 ms, enqueued confirmation event to confirmation-queue in 4 ms, and returned HTTP 201 to visitor in 118 ms total. Downstream worker attempt 1 timed out after 2,500 ms, followed immediately by attempt 2 timing out.',
    correlationId: 'trace-res-0072',
    traceSpans: [
      {
        spanId: 'sp-1',
        service: 'visitor',
        operation: 'POST /api/v1/reservations',
        startOffsetMs: 0,
        durationMs: 118,
        status: 'ok',
        note: 'HTTP 201 Created returned to visitor',
      },
      {
        spanId: 'sp-2',
        service: 'api-gateway',
        operation: 'route /reservations',
        startOffsetMs: 2,
        durationMs: 114,
        status: 'ok',
      },
      {
        spanId: 'sp-3',
        service: 'reservation-service',
        operation: 'createReservation',
        startOffsetMs: 6,
        durationMs: 106,
        status: 'ok',
      },
      {
        spanId: 'sp-4',
        service: 'inventory-db',
        operation: 'INSERT reservation INTO inventory',
        startOffsetMs: 12,
        durationMs: 18,
        status: 'ok',
        note: 'Reservation record committed successfully',
      },
      {
        spanId: 'sp-5',
        service: 'confirmation-queue',
        operation: 'ENQUEUE confirmation_event',
        startOffsetMs: 34,
        durationMs: 4,
        status: 'ok',
        note: 'msg-0072 enqueued',
      },
      {
        spanId: 'sp-6',
        service: 'confirmation-worker',
        operation: 'POST https://api.notify-partner.internal/v1/send (attempt 1)',
        startOffsetMs: 45,
        durationMs: 2500,
        status: 'timeout',
        note: 'Worker timeout exceeded (2,500 ms)',
      },
      {
        spanId: 'sp-7',
        service: 'confirmation-worker',
        operation: 'POST https://api.notify-partner.internal/v1/send (attempt 2 immediate)',
        startOffsetMs: 2546,
        durationMs: 2500,
        status: 'timeout',
        note: 'Immediate retry timed out',
      },
    ],
  },
  {
    id: 'ev-met-240',
    simTimeSeconds: 240,
    formattedTime: formatSimTime(240),
    service: 'inventory-db',
    type: 'metric',
    severity: 'info',
    title: 'Upstream health normal (DB pool: 21/100, API error rate: 0.0%)',
    summary: 'Upstream reservation services, database pool, and API gateway show completely normal health metrics.',
    detail:
      'inventory-db connection pool has 21 active / 100 max connections. DB CPU is 31%. API gateway reports 0.0% reservation error rate and 119 ms p95 latency. Upstream reservation path is unaffected by downstream confirmation stalls.',
    measureName: 'inventory_db_active_connections',
    measureValue: '21 / 100 (CPU: 31%)',
    isAlternativeClue: true,
  },
  {
    id: 'ev-log-300',
    simTimeSeconds: 300,
    formattedTime: formatSimTime(300),
    service: 'visitor',
    type: 'log',
    severity: 'warn',
    title: 'Support reports: "Reservation succeeded on screen, but email missing"',
    summary: 'Customer support tickets indicate visitors see booking confirmation screens but do not receive emails.',
    detail:
      'Customer support log: Multiple visitors reporting valid booking confirmation numbers (e.g. res-0052, res-0061) on web UI, but confirmation email and SMS tickets have not arrived after 4+ minutes. Database verification confirms reservations are securely held.',
    correlationId: 'sup-ticket-batch-1',
  },
  {
    id: 'ev-met-345',
    simTimeSeconds: 345,
    formattedTime: formatSimTime(345),
    service: 'notification-provider',
    type: 'metric',
    severity: 'error',
    title: 'Provider rate-limiting: HTTP 429 Too Many Requests returned',
    summary: 'External notification provider has begun rejecting requests with HTTP 429 due to retry storm volume.',
    detail:
      'notification-provider returned HTTP 429 Too Many Requests for 42% of inbound attempts. Response header: "Retry-After: 15". Outbound attempt rate from confirmation-worker is 48 attempts/min against a provider quota of 20 req/min.',
    measureName: 'provider_http_429_rate',
    measureValue: '42% rate-limited (Retry-After: 15s)',
  },
];

const OUTCOME_EVIDENCE_MAP: Record<string, EvidenceItem[]> = {
  'act-backoff-circuit-breaker': [
    {
      id: 'ev-out-bb-420',
      simTimeSeconds: 420,
      formattedTime: formatSimTime(420),
      service: 'confirmation-worker',
      type: 'log',
      severity: 'info',
      title: 'Circuit breaker trips OPEN; retry amplification drops to 1.3x',
      summary:
        'Confirmation worker circuit breaker tripped on failure threshold; exponential backoff reduced retry amplification to 1.3x.',
      detail:
        'INFO [CircuitBreaker] Notification provider failure rate reached 54%. State transitioned to OPEN. In-flight retry storm halted. Next retry scheduled in 8.4s (exponential backoff base 1s, factor 2, full jitter). Outbound attempt amplification dropped from 3.63x to 1.30x (instantaneous dispatch rate 1.1x).',
      measureName: 'retry_amplification_ratio',
      measureValue: '1.30x (down from 3.63x)',
      correlationId: 'cb-trip-001',
    },
    {
      id: 'ev-out-bb-540',
      simTimeSeconds: 540,
      formattedTime: formatSimTime(540),
      service: 'notification-provider',
      type: 'metric',
      severity: 'info',
      title: 'Notification provider latency recovers (131 ms); circuit breaker closes',
      summary:
        'With downstream retry pressure eliminated, notification provider latency recovered to 131 ms.',
      detail:
        'notification-provider p95 latency recovered from 3,450 ms down to 131 ms. Probe requests succeeded with HTTP 200 OK. Circuit breaker transitioned through HALF-OPEN to CLOSED, permitting normal delivery dispatch.',
      measureName: 'provider_p95_latency_ms',
      measureValue: '131 ms (baseline: 125 ms)',
    },
    {
      id: 'ev-out-bb-720',
      simTimeSeconds: 720,
      formattedTime: formatSimTime(720),
      service: 'confirmation-queue',
      type: 'metric',
      severity: 'info',
      title: 'Confirmation queue drained (backlog: 0, queue age p95: 0s)',
      summary:
        'All accumulated confirmation messages have been dispatched and confirmed; queue drained cleanly.',
      detail:
        'confirmation-queue depth returned to 0 messages. Backlog cleared smoothly by 08:00 without message loss or duplicates. 661 reservations experienced confirmation delays over 30 seconds during the incident.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '0 messages (p95 age: 0s)',
    },
    {
      id: 'ev-out-bb-900',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'notification-provider',
      type: 'metric',
      severity: 'info',
      title: 'Steady-state operations confirmed at 15:00 (provider p95: 129 ms, retry amp: 1.00x)',
      summary:
        'Final checkpoint telemetry confirms full recovery with 129 ms provider latency and 1.00x retry amplification.',
      detail:
        'At 15:00 simulated time, all metrics confirm healthy steady-state: notification provider p95 is 129 ms, retry amplification is 1.00x (zero redundant retries), confirmation queue backlog is 0 messages, and upstream reservations remain 100% operational (0.0% errors, 133 ms p95). 661 unique reservations experienced confirmation delays over 30 seconds.',
      measureName: 'provider_p95_latency_ms',
      measureValue: '129 ms (retry amp: 1.00x)',
    },
  ],
  'act-increase-concurrency': [
    {
      id: 'ev-out-inc-450',
      simTimeSeconds: 450,
      formattedTime: formatSimTime(450),
      service: 'confirmation-worker',
      type: 'metric',
      severity: 'error',
      title: 'Tripled worker concurrency triggers provider collapse (retry amp 6.2x)',
      summary:
        'Scaling confirmation worker threads from 4 to 12 amplified outbound retry traffic to 6.18x.',
      detail:
        'Tripling worker concurrency caused an immediate surge in simultaneous outbound connections (387 messages queued at 07:30, p95 age 165s). With no backoff, each timeout retries immediately across 12 threads, driving retry amplification to 6.18x. Provider response breakdown: 78% HTTP 429/503, provider p95 latency at 3,825 ms.',
      measureName: 'retry_amplification_ratio',
      measureValue: '6.18x (provider p95: 3,825 ms)',
    },
    {
      id: 'ev-out-inc-600',
      simTimeSeconds: 600,
      formattedTime: formatSimTime(600),
      service: 'confirmation-queue',
      type: 'metric',
      severity: 'error',
      title: 'Confirmation backlog escalates to 687 messages; queue age p95 reaches 295s',
      summary:
        'Queue depth surges as provider rate limits reject 78% of concurrent worker attempts at 10:00.',
      detail:
        'confirmation-queue depth reached 687 messages at 10:00. P95 queue age climbed to 295 seconds (~5 minutes). 952 cumulative reservations have experienced confirmation delays exceeding 30 seconds.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '687 messages (p95 age: 295s)',
    },
    {
      id: 'ev-out-inc-900',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'confirmation-queue',
      type: 'metric',
      severity: 'error',
      title: 'Severe persistent stall at 15:00: 1,287 messages queued, queue age 555s',
      summary:
        'Outcome status at 15:00 shows partner provider hard-blocking worker traffic; 1,612 reservations affected.',
      detail:
        'Outcome status at 15:00: confirmation backlog reached 1,287 messages with p95 queue age of 555 seconds (> 9 minutes). Provider p95 latency pegged at 4,200 ms with 6.18x retry amplification. 1,612 cumulative reservations delayed past 30s SLA.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '1,287 messages (p95 age: 555s)',
      correlationId: 'prov-block-001',
    },
  ],
  'act-observe': [
    {
      id: 'ev-out-obs-480',
      simTimeSeconds: 480,
      formattedTime: formatSimTime(480),
      service: 'confirmation-worker',
      type: 'metric',
      severity: 'warn',
      title: 'Sustained immediate retries lock provider in degraded state (amplification 3.7x)',
      summary:
        'Without backoff, constant retry pressure prevents notification provider from clearing internal queues.',
      detail:
        'confirmation-worker continues retrying failed delivery attempts with 0ms delay across 4 threads. Downstream provider p95 latency remains degraded at 3,315 ms. Retry amplification remains steady at 3.73x.',
      measureName: 'retry_amplification_ratio',
      measureValue: '3.73x (provider p95: 3,315 ms)',
    },
    {
      id: 'ev-out-obs-720',
      simTimeSeconds: 720,
      formattedTime: formatSimTime(720),
      service: 'confirmation-queue',
      type: 'metric',
      severity: 'warn',
      title: 'Confirmation backlog reaches 783 messages at 12:00; queue age p95 > 5 minutes',
      summary:
        'Backlog steadily accumulates as incoming reservations exceed degraded delivery throughput.',
      detail:
        'confirmation-queue depth reached 783 messages at 12:00. 68% of delivery attempts time out. P95 queue age is 335 seconds. 1,216 cumulative reservations have experienced confirmation delays exceeding 30 seconds.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '783 messages (p95 age: 335s)',
    },
    {
      id: 'ev-out-obs-900',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'visitor',
      type: 'log',
      severity: 'warn',
      title: 'Customer impact ongoing at 15:00: 1,612 reservations delayed past 30s confirmation SLA',
      summary:
        'Incident remains completely unresolved through 15:00 with extensive customer support queue buildup.',
      detail:
        'Visitor experience summary at 15:00: 1,612 cumulative unique reservations have suffered confirmation delays exceeding 30 seconds. Upstream reservation writes remain healthy (0.0% error rate), but 1,071 tickets remain stalled in queue with provider p95 at 3,310 ms.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '1,071 messages (p95 age: 460s, provider p95: 3,310 ms)',
      correlationId: 'sup-ticket-batch-3',
    },
  ],
};

export const INCIDENT_002_DEFINITION: ScenarioDefinition = {
  incidentId: 'incident-002',
  symptomTitle: 'Reservations succeed, confirmations stall',
  oneSentenceJourney:
    'An external notification provider slowdown combined with unconstrained confirmation worker retries creates a downstream retry storm that halts ticket delivery while upstream reservations remain completely healthy.',
  scenarioVersion: '1.0.0',
  defaultSeed: 42,
  systemDescription: SHARED_SYSTEM_DESCRIPTION,
  topology: SHARED_TOPOLOGY,
  interventions: INCIDENT_002_INTERVENTIONS,
  chartConfig: {
    layout: 'stacked',
    series1Label: '━ Confirmation Backlog (queued messages)',
    series1Color: 'var(--color-amber)',
    series2Label: '━ Delivery Retry Amplification (attempts / unique msg)',
    series2Color: 'var(--color-cyan-bright)',
    getSeries1Ratio: (pt) => Math.min(1, pt.confirmationBacklog / 1400),
    getSeries2Ratio: (pt) => Math.min(1, Math.max(0, (pt.retryAmplification - 1) / 6)),
    series1Ticks: [
      { ratio: 1.0, label: '1400 msgs' },
      { ratio: 0.5, label: '700 msgs' },
      { ratio: 0.0, label: '0 msgs' },
    ],
    series2Ticks: [
      { ratio: 1.0, label: '7.0x' },
      { ratio: 0.5, label: '4.0x' },
      { ratio: 0.0, label: '1.0x' },
    ],
  },
  buildEvidenceCatalog: (selectedInterventionId: string | null): EvidenceItem[] => {
    const branchItems =
      selectedInterventionId && OUTCOME_EVIDENCE_MAP[selectedInterventionId]
        ? OUTCOME_EVIDENCE_MAP[selectedInterventionId]!
        : [];
    return [...BASE_EVIDENCE_ITEMS, ...branchItems].sort(
      (a, b) => a.simTimeSeconds - b.simTimeSeconds,
    );
  },
  walkthroughs: INCIDENT_002_WALKTHROUGHS,
  debrief: INCIDENT_002_DEBRIEF,
};
