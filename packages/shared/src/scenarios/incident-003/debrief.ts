import type { ScenarioDebrief } from '../../contracts/index.js';

export const INCIDENT_003_DEBRIEF: ScenarioDebrief = {
  incidentId: 'incident-003',
  technicalTitle: 'Producer Schema Breakage Leaving Incompatible Confirmation Cohort Stranded',
  actualRootCause:
    'At 01:30, reservation-service v2.15.0 rolled out to 3 of 4 pods with a breaking confirmation event envelope change (schemaVersion "2.0" moved top-level reservationId into nested reservation.id) without updating confirmation-worker v1.8.0 or using an additive expand-and-contract transition. Compatible v1.0 events from the remaining v2.14.2 pod continued confirming normally while v2.0 messages repeatedly failed schema validation and remained retained in confirmation-queue.',
  causalChain: [
    '01:30 — reservation-service v2.15.0 deploys to 3 of 4 pods (leaving 1 pod on v2.14.2) and begins publishing schemaVersion "2.0" events with nested reservation.id instead of top-level reservationId.',
    '01:30–02:30 — confirmation-worker v1.8.0 rejects v2.0 payloads with SchemaValidationError on missing root reservationId and NACKs them with retain=true and a 30s retry delay, while v1.0 events bypass and deliver normally.',
    '03:00 (Alert) — 140 unconfirmed v2.0 reservations accumulate in confirmation-queue (p95 age 85s; 246 validation failures across 140 unique messages in 60s); 84 reservations exceed the 30s confirmation SLA.',
    '03:30–06:00 (Evidence) — Upstream reservation API (0.0% errors), inventory-db (21/100 pool), and notification-provider (122 ms p95, HTTP 200) remain healthy while outstanding confirmations reach 428 (p95 age 255s; 870 validation failures across 428 unique msgs in 60s).',
    'Divergence at 06:00 — Rolling back the producer alone stops new v2.0 events but leaves 436 queued v2.0 reservations stranded through 15:00; restarting workers keeps failing; only producer rollback + quarantine + adapted replay clears all 1,943 confirmations with 0 duplicates.',
  ],
  customerImpactSummary:
    'All 1,943 accepted reservations persisted cleanly in inventory-db (0.0% reservation API error rate). However, the cohort of customers whose bookings emitted schemaVersion "2.0" events experienced missing confirmation emails/SMS until adaptation and replay completed (436 affected reservations under full recovery; 436 remaining unconfirmed at 15:00 under rollback-only and requiring follow-up recovery; 1,292 unconfirmed under worker restart). Replay with reservationId-keyed idempotency (retaining original eventId and enqueue timestamps) prevented duplicate confirmations or bookings.',
  alternativeClueExplanation:
    'At 02:00 a promotional traffic bump (+22.2%, from 108 to 132 req/min instantaneous arrival rate; 119 attempts in trailing 60s window and 133 ms API p95) coincided with growing confirmation queue depth, initially raising suspicion of capacity exhaustion or a downstream notification-provider stall. However, distributed traces and telemetry disproved both: compatible v1.0 events from v2.14.2 completed end-to-end delivery through notification-provider in 122 ms (HTTP 200), worker CPU/threads were healthy, and 100% of failures occurred inside schema validation on schemaVersion "2.0" payloads.',
  outcomeComparisons: {
    'act-rollback-quarantine-replay': {
      interventionId: 'act-rollback-quarantine-replay',
      label:
        'Roll back the producer, quarantine incompatible messages, then adapt and replay them with original event IDs',
      verdict: 'Recommended resolution',
      whatHappened:
        'Rolling back reservation-service to v2.14.2 halted new v2.0 events after 8 final in-flight pod-drain events (436 total v2.0 cohort). Quarantining stopped futile worker retries while preserving all 436 outstanding obligations and their original enqueue timestamps. Adapting reservation.id to reservationId and replaying with original eventId and enqueue times under reservationId-keyed idempotency drained all 436 stranded confirmations by 08:25 with 0 duplicates, reaching 1,943/1,943 delivered by 15:00.',
      tradeoffLesson:
        'Restoring producer code compatibility protects new traffic, but repairing accumulated incompatible data requires an explicit quarantine, schema adaptation, and idempotent replay step.',
      finalErrorRatePercent: 0,
      finalP95LatencyMs: 133,
      totalAffectedReservations: 436,
      finalBacklog: 0,
      finalQueueAgeP95Seconds: 0,
      finalValidationErrorAttempts: 0,
      finalValidationErrorUniqueMsgs: 0,
      finalQuarantinedBacklog: 0,
      finalReplayedDeliveries: 436,
      finalDeliveredConfirmations: 1943,
      finalAcceptedReservations: 1943,
    },
    'act-rollback-producer-only': {
      interventionId: 'act-rollback-producer-only',
      label: 'Roll back the producer only',
      verdict: 'Partial recovery only',
      whatHappened:
        'Reverting reservation-service to v2.14.2 restored timely confirmations for all 1,507 compatible v1.0 reservations. However, the 436 v2.0 events already emitted remained stranded in confirmation-queue through 15:00, looping every 30s on worker validation failures (950 attempts / 436 unique msgs per 60s) with p95 queue age reaching 795s.',
      tradeoffLesson:
        'Code rollback fixes future writes—it does not repair or replay incompatible messages already written to persistent queues. Without adaptation and replay, an entire customer cohort stays abandoned.',
      finalErrorRatePercent: 0,
      finalP95LatencyMs: 133,
      totalAffectedReservations: 436,
      finalBacklog: 436,
      finalQueueAgeP95Seconds: 795,
      finalValidationErrorAttempts: 950,
      finalValidationErrorUniqueMsgs: 436,
      finalQuarantinedBacklog: 0,
      finalReplayedDeliveries: 0,
      finalDeliveredConfirmations: 1507,
      finalAcceptedReservations: 1943,
    },
    'act-restart-workers-only': {
      interventionId: 'act-restart-workers-only',
      label: 'Restart workers only',
      verdict: 'Unresolved impact',
      whatHappened:
        'Restarting confirmation-worker pods reloaded the exact same v1.8.0 schema validator while reservation-service v2.15.0 continued publishing incompatible v2.0 events. By 15:00, 1,292 reservations remained stranded unconfirmed (765s p95 queue age) while generating 2,742 validation failure attempts across 1,292 unique messages per 60s.',
      tradeoffLesson:
        'Restarting stateless consumers never cures a deterministic schema mismatch—workers come back with the same parser and reject the same payloads.',
      finalErrorRatePercent: 0,
      finalP95LatencyMs: 133,
      totalAffectedReservations: 1236,
      finalBacklog: 1292,
      finalQueueAgeP95Seconds: 765,
      finalValidationErrorAttempts: 2742,
      finalValidationErrorUniqueMsgs: 1292,
      finalQuarantinedBacklog: 0,
      finalReplayedDeliveries: 0,
      finalDeliveredConfirmations: 651,
      finalAcceptedReservations: 1943,
    },
  },
  preventionOpportunities: [
    {
      category: 'Consumer Contract Tests',
      recommendation:
        'Gate producer releases with automated consumer-driven schema contract verification in CI.',
      whyItMatters:
        'Validates that every field confirmation-worker expects in v1.0 remains present and readable before any producer deployment reaches production.',
    },
    {
      category: 'Additive Schema Changes',
      recommendation:
        'Enforce expand-and-contract schema evolution instead of renaming or nesting fields in place.',
      whyItMatters:
        'Dual-writing both top-level reservationId and nested reservation.id lets older consumers succeed while new consumers migrate safely.',
    },
    {
      category: 'Version-Aware Validation',
      recommendation:
        'Route unknown schemaVersion payloads cleanly to a monitored dead-letter quarantine with explicit schema-mismatch alerting.',
      whyItMatters:
        'Prevents permanent infinite retry churn on deterministic contract errors while keeping incompatible events visible and accounted for.',
    },
    {
      category: 'Safe Replay Procedures',
      recommendation:
        'Maintain tested transform-and-replay runbooks preserving original eventId and enqueue timestamps alongside reservationId-keyed idempotency checks.',
      whyItMatters:
        'Enables rapid recovery of stranded event cohorts without losing SLA visibility or sending duplicate customer notifications.',
    },
  ],
};
