import type { EvidenceItem, InterventionOption, ScenarioDefinition } from '../../contracts/index.js';
import { formatSimTime } from '../../engine/prng.js';
import { SHARED_SYSTEM_DESCRIPTION, SHARED_TOPOLOGY } from '../topology.js';
import { INCIDENT_003_WALKTHROUGHS } from './walkthroughs.js';
import { INCIDENT_003_DEBRIEF } from './debrief.js';

const RQR_PLANNED_STAGES = [
  '06:00 (Planned) — Roll back reservation-service pods from v2.15.0 to v2.14.2, drain in-flight v2.0 publishes, and quarantine incompatible v2.0 messages in confirmation-queue to stop retry churn while retaining backlog accounting',
  'Initial replay phase (Planned) — Adapt nested reservation.id to top-level reservationId (retaining original eventId and enqueue time) and begin paced 20-msg/tick FIFO replay of quarantined messages',
  'Replay completion (Planned) — Complete FIFO adapted replay of remaining quarantined messages under reservationId-keyed idempotency checks until queue backlog clears',
  'Verification (Planned) — Confirm worker validation errors remain at 0 and all quarantined confirmations deliver cleanly without duplicates',
] as const;

const RPO_PLANNED_STAGES = [
  '06:00 (Planned) — Roll back reservation-service pods from v2.15.0 to v2.14.2',
  'Post-rollback (Planned) — Verify newly created reservations emit v1.0 events and confirm normally',
  'Mid-incident monitoring (Planned) — Track previously queued v2.0 cohort age and worker validation failures in confirmation-queue',
  'Follow-up risk — Unadapted v2.0 messages may remain unconfirmed in queue until a dedicated quarantine and replay runs',
] as const;

const RWO_PLANNED_STAGES = [
  '06:00 (Planned) — Perform rolling restart of confirmation-worker v1.8.0 instances',
  'Post-restart (Planned) — Monitor worker validation logs and confirmation queue depth to see if restarts clear errors',
  'Mid-incident monitoring (Planned) — Track confirmation backlog growth and trailing 60s validation failures across queued messages',
  'Follow-up risk — If errors stem from a persistent producer schema mismatch, restarted workers may continue rejecting v2.0 payloads',
] as const;

export const INCIDENT_003_INTERVENTIONS: InterventionOption[] = [
  {
    id: 'act-rollback-quarantine-replay',
    label:
      'Roll back the producer, quarantine incompatible messages, then adapt and replay them with original event IDs',
    shortLabel: 'Rollback, quarantine & replay',
    summary:
      'Revert reservation-service from v2.15.0 to v2.14.2 to restore v1.0 compatibility for new bookings, quarantine failing v2.0 messages to stop retry churn without dropping backlog, adapt reservation.id to top-level reservationId while retaining original eventId and enqueue timestamps, and replay FIFO with reservationId-keyed idempotency checks.',
    immediateTradeoff:
      'Requires coordinated producer rollback, queue quarantine, and paced 20-msg/tick FIFO replay; recovery duration depends on quarantine sweep and adapter throughput, with risk of extended confirmation delay if adapter validation or delivery stalls.',
    stages: [...RQR_PLANNED_STAGES],
    stageSchedule: [
      {
        unlocksAtSeconds: 390,
        plannedText: RQR_PLANNED_STAGES[0],
        observedText:
          '06:00–06:30 — Rolled back reservation-service pods to v2.14.2 (8 final v2.0 events drained by 06:10); quarantined all 436 incompatible v2.0 events (p95 age 285s)',
      },
      {
        unlocksAtSeconds: 450,
        plannedText: RQR_PLANNED_STAGES[1],
        observedText:
          '06:40–07:30 — Adapted reservation.id -> reservationId (retaining original eventId and enqueue time) and replayed 220/436 quarantined messages cleanly (216 remaining, p95 age 210s, 0 val fails)',
      },
      {
        unlocksAtSeconds: 540,
        plannedText: RQR_PLANNED_STAGES[2],
        observedText:
          '07:35–08:25 — Completed FIFO adapted replay of all 436 quarantined messages by 08:25 under reservationId idempotency with 0 duplicates (0 outstanding backlog)',
      },
      {
        unlocksAtSeconds: 900,
        plannedText: RQR_PLANNED_STAGES[3],
        observedText:
          '15:00 — Full recovery verified: 1,943/1,943 confirmations delivered (1,507 native v1.0 + 436 adapted replays, 0 duplicates, 0 backlog)',
      },
    ],
  },
  {
    id: 'act-rollback-producer-only',
    label: 'Roll back the producer only',
    shortLabel: 'Roll back producer only',
    summary:
      'Revert reservation-service pods from v2.15.0 back to v2.14.2 without quarantining, adapting, or replaying messages already in confirmation-queue.',
    immediateTradeoff:
      'Stops new incompatible publishes so incoming bookings confirm cleanly, but risks leaving previously queued v2.0 messages unprocessable and failing worker validation unless a separate quarantine and replay runs.',
    stages: [...RPO_PLANNED_STAGES],
    stageSchedule: [
      {
        unlocksAtSeconds: 390,
        plannedText: RPO_PLANNED_STAGES[0],
        observedText:
          '06:00–06:30 — Rolled back reservation-service pods from v2.15.0 to v2.14.2; new bookings emit compatible v1.0 events after final 06:10 pod drain',
      },
      {
        unlocksAtSeconds: 450,
        plannedText: RPO_PLANNED_STAGES[1],
        observedText:
          '06:15–07:30 — New v1.0 bookings confirm cleanly, while 436 earlier v2.0 events remain queued (p95 age 345s; 950 failures / 60s)',
      },
      {
        unlocksAtSeconds: 600,
        plannedText: RPO_PLANNED_STAGES[2],
        observedText:
          '07:30–10:00 — Stranded 436-message v2.0 cohort reaches 495s p95 queue age with 950 validation failures / 60s',
      },
      {
        unlocksAtSeconds: 900,
        plannedText: RPO_PLANNED_STAGES[3],
        observedText:
          '15:00 — Partial recovery only: 1,507/1,943 delivered; 436 reservations remain unconfirmed in queue (p95 age 795s) awaiting quarantine and replay',
      },
    ],
  },
  {
    id: 'act-restart-workers-only',
    label: 'Restart workers only',
    shortLabel: 'Restart workers only',
    summary:
      'Perform a rolling restart of confirmation-worker v1.8.0 instances without changing the producer deployment or worker contract parser.',
    immediateTradeoff:
      'Leaves v1.8.0 schema validation and v2.15.0 producer payloads unchanged, risking continued rejection of v2.0 events while consuming worker capacity during restarts.',
    stages: [...RWO_PLANNED_STAGES],
    stageSchedule: [
      {
        unlocksAtSeconds: 390,
        plannedText: RWO_PLANNED_STAGES[0],
        observedText:
          '06:00–06:30 — Restarted confirmation-worker v1.8.0 instances; workers resumed polling confirmation-queue',
      },
      {
        unlocksAtSeconds: 450,
        plannedText: RWO_PLANNED_STAGES[1],
        observedText:
          '06:30–07:30 — Restarted workers resumed rejecting v2.0 events; outstanding confirmations grew to 572 (p95 age 340s; 1,182 failures / 60s)',
      },
      {
        unlocksAtSeconds: 720,
        plannedText: RWO_PLANNED_STAGES[2],
        observedText:
          '07:30–12:00 — Backlog reached 1,004 messages (p95 age 595s; 2,118 validation failures / 60s)',
      },
      {
        unlocksAtSeconds: 900,
        plannedText: RWO_PLANNED_STAGES[3],
        observedText:
          '15:00 — Unresolved impact: 1,292 unconfirmed reservations (2,742 validation failures across 1,292 unique msgs; p95 age 765s)',
      },
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
    title: 'Deploy reservation-service v2.15.0 (3/4 pods; event schemaVersion "2.0")',
    summary:
      'Rolled out reservation-service v2.15.0 to 3 of 4 pods while 1 canary hold pod remained on v2.14.2.',
    detail:
      'Release v2.15.0 updated ReservationConfirmed event payload to schemaVersion "2.0", nesting top-level "reservationId" inside "reservation.id" while preserving "eventId" and commit behavior. Pod reservation-svc-4 stayed on v2.14.2 (schemaVersion "1.0").',
    correlationId: 'rel-v2.15.0',
  },
  {
    id: 'ev-met-120',
    simTimeSeconds: 120,
    formattedTime: formatSimTime(120),
    service: 'api-gateway',
    type: 'metric',
    severity: 'info',
    title: 'Promotional campaign traffic bump (+22.2%, 132 req/min arrival rate)',
    summary:
      'Instantaneous arrival rate stepped from 108 to 132 req/min (+22.2%; 119 attempts in trailing 60s window); API p95 is 133 ms with 0.0% errors.',
    detail:
      'At 02:00, api-gateway instantaneous arrival rate stepped from 108 req/min (9 req/5s tick) to 132 req/min (11 req/5s tick, +22.2%), with 119 attempts completed in the trailing 60s window (01:00–02:00 transition), 0.0% HTTP 5xx errors, and 133 ms trailing 60s API p95 latency. reservation-service and confirmation-worker CPU remain below 28%.',
    measureName: 'gateway_requests_per_min',
    measureValue: '132 req/min arrival (+22.2%; 119 / 60s window, p95: 133 ms)',
    isAlternativeClue: true,
  },
  {
    id: 'ev-log-150',
    simTimeSeconds: 150,
    formattedTime: formatSimTime(150),
    service: 'confirmation-worker',
    type: 'log',
    severity: 'error',
    title: 'Worker validation error: missing required root field "reservationId"',
    summary:
      'confirmation-worker v1.8.0 rejects schemaVersion "2.0" payload and NACKs message back to queue with 30s retry delay.',
    detail:
      'ERROR [confirmation-worker v1.8.0] eventId="evt-0283" schemaVersion="2.0" err="SchemaValidationError: missing required root field reservationId (found nested reservation.id=res-0283)" action="NACK_RETAIN" retry_backoff="30s"',
    correlationId: 'evt-0283',
  },
  {
    id: 'ev-met-180',
    simTimeSeconds: 180,
    formattedTime: formatSimTime(180),
    service: 'confirmation-queue',
    type: 'metric',
    severity: 'warn',
    title: 'Confirmation backlog alert @ 03:00 (140 outstanding, p95 age 85s)',
    summary:
      '140 accepted reservations await confirmation while 219 v1.0 bookings confirmed on time; 246 validation failures in 60s.',
    detail:
      'confirmation-queue outstanding=140 messages (p95 age: 85s). confirmation-worker logged 246 validation failures across 140 unique messages in trailing 60s. 84 reservations delayed > 30s; 219 v1.0 confirmations delivered cleanly (359 total accepted).',
    measureName: 'confirmation_queue_backlog',
    measureValue: '140 messages (p95 age: 85s, val fails: 246/60s)',
  },
  {
    id: 'ev-trc-210',
    simTimeSeconds: 210,
    formattedTime: formatSimTime(210),
    service: 'confirmation-worker',
    type: 'trace',
    severity: 'warn',
    title: 'Paired trace: v1.0 event confirms in 122 ms while v2.0 event fails validation',
    summary:
      'Both reservations succeed at HTTP 201, but only schemaVersion "1.0" clears confirmation-worker schema check.',
    detail:
      'Trace comparison at 03:30: evt-0423 (res-0423, v2.14.2 pod, schemaVersion "1.0") passed worker validation and delivered via notification-provider HTTP 200 in 122 ms. evt-0415 (res-0415, v2.15.0 pod, schemaVersion "2.0") committed HTTP 201 in 118 ms, failed worker validation on missing root "reservationId", and was NACKed with retain=true.',
    correlationId: 'evt-0415',
    traceSpans: [
      {
        spanId: 'sp-3-1',
        service: 'reservation-service',
        operation: 'commit res-0415 + publish evt-0415 (schema v2.0)',
        startOffsetMs: 0,
        durationMs: 118,
        status: 'ok',
        note: 'HTTP 201 Created; reservation persisted cleanly',
      },
      {
        spanId: 'sp-3-2',
        service: 'confirmation-worker',
        operation: 'validate evt-0415 (expected root reservationId)',
        startOffsetMs: 124,
        durationMs: 6,
        status: 'error',
        note: 'NACK retain=true (found nested reservation.id)',
      },
      {
        spanId: 'sp-3-3',
        service: 'confirmation-worker',
        operation: 'validate evt-0423 (schema v1.0 from v2.14.2)',
        startOffsetMs: 140,
        durationMs: 4,
        status: 'ok',
        note: 'Schema v1.0 valid; non-blocking dispatch',
      },
      {
        spanId: 'sp-3-4',
        service: 'notification-provider',
        operation: 'POST /v1/send (res-0423)',
        startOffsetMs: 146,
        durationMs: 122,
        status: 'ok',
        note: 'HTTP 200 OK delivered cleanly',
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
    title: 'API, database, and notification provider completely healthy',
    summary:
      'Reservation error rate is 0.0%, inventory-db pool is 21 / 100 (31% CPU), and provider returns 100% HTTP 200 in 122 ms p95.',
    detail:
      'Upstream reservation-service reports 0.0% API error rate. inventory-db has 21 / 100 active connections with 31% CPU. notification-provider responds at 122 ms p95 with 100% HTTP 200 on all valid sends.',
    measureName: 'inventory_db_active_connections',
    measureValue: '21 / 100 (CPU: 31%, provider p95: 122 ms)',
  },
  {
    id: 'ev-log-300',
    simTimeSeconds: 300,
    formattedTime: formatSimTime(300),
    service: 'visitor',
    type: 'log',
    severity: 'warn',
    title: 'Support audit: missing confirmations map 1:1 to v2.15.0 cohort',
    summary:
      'Customer tickets cite missing confirmation emails for bookings processed by v2.15.0 pods, while v2.14.2 bookings receive emails promptly.',
    detail:
      'Cohort correlation check across 01:30–05:00 bookings: reservations handled by v2.15.0 pods (e.g. res-0163, res-0283, res-0415) remain persisted in inventory-db without confirmation delivery; concurrent v2.14.2 bookings (e.g. res-0169, res-0291, res-0423) confirm within 1s.',
    correlationId: 'cohort-audit-01',
  },
  {
    id: 'ev-met-360',
    simTimeSeconds: 360,
    formattedTime: formatSimTime(360),
    service: 'confirmation-queue',
    type: 'metric',
    severity: 'error',
    title: 'Evidence checkpoint @ 06:00 (428 outstanding, 870 val fails / 60s)',
    summary:
      '428 accepted reservations remain unconfirmed in queue (p95 age 255s); 327 v1.0 confirmations delivered out of 755 accepted.',
    detail:
      'At 06:00: accepted=755, delivered=327, outstanding=428 (p95 age: 255s). Trailing 60s worker validation failures: 870 attempts across 428 unique messages. Cumulative reservations delayed > 30s: 372.',
    measureName: 'confirmation_queue_backlog',
    measureValue: '428 messages (p95 age: 255s, val fails: 870 / 428 uniq)',
  },
];

const OUTCOME_EVIDENCE_MAP: Record<string, EvidenceItem[]> = {
  'act-rollback-quarantine-replay': [
    {
      id: 'ev-out-rqr-390',
      simTimeSeconds: 390,
      formattedTime: formatSimTime(390),
      service: 'confirmation-queue',
      type: 'deployment',
      severity: 'info',
      title: 'Producer rolled back; 436 v2.0 events quarantined without hiding backlog',
      summary:
        'reservation-service v2.14.2 restored and all 436 failed v2.0 messages moved to quarantine awaiting adaptation.',
      detail:
        'At 06:30: producer rollback to v2.14.2 finished after 8 final drain events (436 total v2.0 cohort). Quarantine sweep moved all 436 unconfirmed messages out of the live retry loop (quarantined: 436, outstanding backlog: 436 messages, p95 age: 285s preserved from original enqueue times).',
      measureName: 'quarantined_backlog',
      measureValue: '436 quarantined (436 outstanding, p95 age: 285s)',
      correlationId: 'quarantine-sweep-01',
    },
    {
      id: 'ev-out-rqr-450',
      simTimeSeconds: 450,
      formattedTime: formatSimTime(450),
      service: 'confirmation-worker',
      type: 'metric',
      severity: 'info',
      title: 'Adapted replay draining backlog (220 replayed, 216 remaining, 0 val fails)',
      summary:
        'Adapter maps nested reservation.id back to root reservationId while retaining original eventId and enqueuedAt under reservationId-keyed idempotency; 220 replayed cleanly.',
      detail:
        'At 07:30: schema adapter + reservationId-keyed idempotent replay delivered 220 quarantined messages cleanly; 216 messages remain in quarantine (outstanding: 216 messages, p95 age: 210s). Trailing 60s worker validation failures: 0 attempts across 0 unique messages.',
      measureName: 'replayed_deliveries',
      measureValue: '220 replayed (216 outstanding, p95 age: 210s, val fails: 0)',
    },
    {
      id: 'ev-out-rqr-540',
      simTimeSeconds: 540,
      formattedTime: formatSimTime(540),
      service: 'confirmation-queue',
      type: 'metric',
      severity: 'info',
      title: 'Replay complete by 08:25 (436 replayed, 0 outstanding, 0 duplicates)',
      summary:
        'All 436 adapted v2.0 messages delivered without duplicates under reservationId idempotency while retaining original eventId and enqueuedAt; queue cleared to 0 outstanding messages.',
      detail:
        'By 08:25 (maintained at 09:00): all 436 quarantined messages were adapted (retaining original eventId and enqueuedAt) and confirmed (436 replayed deliveries, 0 duplicates via reservationId idempotency guard). Outstanding backlog: 0 messages (p95 age: 0s). Cumulative delayed > 30s remains 436.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '0 messages (436 replayed, p95 age: 0s)',
    },
    {
      id: 'ev-out-rqr-900',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'confirmation-queue',
      type: 'metric',
      severity: 'info',
      title: 'Outcome @ 15:00: Full recovery (1,943/1,943 delivered, 0 outstanding)',
      summary:
        'All accepted reservations confirmed cleanly with conservation verified and zero validation failures.',
      detail:
        'Outcome status at 15:00: accepted=1,943, delivered=1,943 (1,507 native v1.0 + 436 adapted replays), outstanding=0 messages, quarantined=0, replayed=436, p95 queue age=0s, trailing 60s validation failures=0 attempts (0 unique), cumulative delayed > 30s=436 reservations.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '0 messages (1,943 delivered, 436 replayed, val fails: 0)',
      correlationId: 'outcome-rqr-900',
    },
  ],

  'act-rollback-producer-only': [
    {
      id: 'ev-out-rpo-450',
      simTimeSeconds: 450,
      formattedTime: formatSimTime(450),
      service: 'confirmation-worker',
      type: 'metric',
      severity: 'warn',
      title: 'Producer rollback stopped new v2.0 events, but 436 older events stay stranded',
      summary:
        'New v1.0 bookings deliver immediately while the 436 pre-rollback v2.0 events loop in validation failure.',
      detail:
        'At 07:30: reservation-service v2.14.2 emits 100% compatible v1.0 events, but the 436 previously queued v2.0 messages remain stuck in confirmation-queue (outstanding: 436 messages, p95 age: 345s), logging 950 validation failure attempts across 436 unique messages in 60s.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '436 messages (p95 age: 345s, val fails: 950 / 436 uniq)',
    },
    {
      id: 'ev-out-rpo-600',
      simTimeSeconds: 600,
      formattedTime: formatSimTime(600),
      service: 'confirmation-queue',
      type: 'metric',
      severity: 'warn',
      title: 'At 10:00: 436 cohort events remain unconfirmed (p95 age 495s)',
      summary:
        'Queue age of stranded reservations reaches 8+ minutes while live traffic continues confirming cleanly.',
      detail:
        'At 10:00: outstanding=436 messages (p95 age: 495s), quarantined=0, replayed=0, trailing 60s validation failures=950 attempts across 436 unique messages. 436 reservations remain delayed > 30s with no confirmation sent.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '436 messages (p95 age: 495s, val fails: 950 / 436 uniq)',
    },
    {
      id: 'ev-out-rpo-900',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'confirmation-queue',
      type: 'log',
      severity: 'warn',
      title: 'Outcome @ 15:00: Partial recovery only (436 reservations still unconfirmed)',
      summary:
        '1,507 native v1.0 bookings delivered, leaving the 436-reservation v2.0 cohort stranded at 795s p95 age.',
      detail:
        'Outcome status at 15:00: accepted=1,943, delivered=1,507, outstanding=436 messages (p95 age: 795s, quarantined=0, replayed=0), trailing 60s validation failures=950 attempts across 436 unique messages, affected reservations > 30s=436.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '436 messages (p95 age: 795s, val fails: 950 / 436 uniq)',
      correlationId: 'outcome-rpo-900',
    },
  ],

  'act-restart-workers-only': [
    {
      id: 'ev-out-rwo-450',
      simTimeSeconds: 450,
      formattedTime: formatSimTime(450),
      service: 'confirmation-worker',
      type: 'metric',
      severity: 'error',
      title: 'Workers restarted onto identical v1.8.0 validator; backlog climbs to 572',
      summary:
        'Restarting workers failed to restore compatibility as v2.15.0 keeps emitting v2.0 events.',
      detail:
        'At 07:30: restarted confirmation-worker v1.8.0 pods continue rejecting schemaVersion "2.0" events. Outstanding confirmations rose to 572 messages (p95 age: 340s) with 1,182 validation failure attempts across 572 unique messages in trailing 60s.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '572 messages (p95 age: 340s, val fails: 1,182 / 572 uniq)',
    },
    {
      id: 'ev-out-rwo-720',
      simTimeSeconds: 720,
      formattedTime: formatSimTime(720),
      service: 'confirmation-queue',
      type: 'metric',
      severity: 'error',
      title: 'At 12:00: 1,004 unconfirmed messages (2,118 validation failures / 60s)',
      summary:
        'Incompatible cohort surpasses 1,000 reservations as queue age reaches 595s p95.',
      detail:
        'At 12:00: outstanding=1,004 messages (p95 age: 595s), trailing 60s validation failures=2,118 attempts across 1,004 unique messages. Cumulative reservations delayed > 30s: 948.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '1,004 messages (p95 age: 595s, val fails: 2,118 / 1,004 uniq)',
    },
    {
      id: 'ev-out-rwo-900',
      simTimeSeconds: 900,
      formattedTime: formatSimTime(900),
      service: 'confirmation-queue',
      type: 'log',
      severity: 'error',
      title: 'Outcome @ 15:00: Unresolved impact (1,292 unconfirmed, 2,742 failures / 60s)',
      summary:
        'Only 651 v1.0 confirmations delivered out of 1,943 bookings; 1,292 incompatible messages remain stalled.',
      detail:
        'Outcome status at 15:00: accepted=1,943, delivered=651, outstanding=1,292 messages (p95 age: 765s, quarantined=0, replayed=0), trailing 60s validation failures=2,742 attempts across 1,292 unique messages, cumulative reservations delayed > 30s=1,236.',
      measureName: 'confirmation_queue_backlog',
      measureValue: '1,292 messages (p95 age: 765s, val fails: 2,742 / 1,292 uniq)',
      correlationId: 'outcome-rwo-900',
    },
  ],
};

export const INCIDENT_003_DEFINITION: ScenarioDefinition = {
  incidentId: 'incident-003',
  symptomTitle: 'A release leaves confirmations behind',
  oneSentenceJourney:
    'Visitors reserve event spots through the API gateway and reservation service (persisted in the inventory database), while confirmation events published to the queue are validated by workers before external notification delivery.',
  scenarioVersion: '1.0.0',
  defaultSeed: 3003,
  systemDescription: SHARED_SYSTEM_DESCRIPTION,
  topology: SHARED_TOPOLOGY,
  interventions: INCIDENT_003_INTERVENTIONS,
  chartConfig: {
    layout: 'stacked',
    series1Label: '━ Outstanding Confirmations (queued + quarantined)',
    series1Color: 'var(--color-amber)',
    series2Label: '━ Validation Failures (attempts / 60s window)',
    series2Color: 'var(--color-cyan-bright)',
    getSeries1Ratio: (pt) => Math.min(1, pt.confirmationBacklog / 1400),
    getSeries2Ratio: (pt) => Math.min(1, (pt.validationErrorAttempts ?? 0) / 3000),
    series1Ticks: [
      { ratio: 1.0, label: '1400 msgs' },
      { ratio: 0.5, label: '700 msgs' },
      { ratio: 0.0, label: '0 msgs' },
    ],
    series2Ticks: [
      { ratio: 1.0, label: '3000 fails' },
      { ratio: 0.5, label: '1500 fails' },
      { ratio: 0.0, label: '0 fails' },
    ],
    formatSeries1Value: (pt) =>
      typeof pt.confirmationBacklog === 'number' ? `${pt.confirmationBacklog} msgs` : 'Unavailable',
    formatSeries2Value: (pt) =>
      typeof pt.validationErrorAttempts === 'number' &&
      typeof pt.validationErrorUniqueMessages === 'number'
        ? `${pt.validationErrorAttempts} fails (${pt.validationErrorUniqueMessages} uniq)`
        : 'Unavailable',
    formatCaption: (pt) => {
      const backlog =
        typeof pt.confirmationBacklog === 'number' ? `${pt.confirmationBacklog} msgs` : 'Unavailable';
      const quarantined =
        typeof pt.quarantinedBacklog === 'number' ? `${pt.quarantinedBacklog} quarantined` : 'quarantine n/a';
      const replayed =
        typeof pt.replayedDeliveries === 'number' ? `${pt.replayedDeliveries} replayed` : 'replay n/a';
      const valAttempts =
        typeof pt.validationErrorAttempts === 'number'
          ? `${pt.validationErrorAttempts} attempts`
          : 'Unavailable';
      const valUniq =
        typeof pt.validationErrorUniqueMessages === 'number'
          ? `${pt.validationErrorUniqueMessages} uniq msgs`
          : 'n/a';
      const queueAge =
        typeof pt.queueAgeP95Seconds === 'number' ? `${pt.queueAgeP95Seconds}s` : 'Unavailable';
      return `Current (${pt.formattedTime}): Outstanding ${backlog} (${quarantined} · ${replayed}) · Val fails ${valAttempts} (${valUniq}) · Queue p95 ${queueAge}`;
    },
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
  walkthroughs: INCIDENT_003_WALKTHROUGHS,
  debrief: INCIDENT_003_DEBRIEF,
};
