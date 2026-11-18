import type { ScenarioDebrief } from '../../contracts/index.js';

export const INCIDENT_001_DEBRIEF: ScenarioDebrief = {
  incidentId: 'incident-001',
  technicalTitle: 'Scenario 1: Database Connection Pool Exhaustion via Cancellation Leak',
  actualRootCause:
    'Release v2.14.0 of reservation-service wrapped inventory lock queries in a new helper (reserveWithTimeout) that returned early when a request context expired or was canceled, skipping the deferred conn.Release() call. Each timeout leaked an open database handle back to neither the pool nor the OS, rapidly exhausting the 100-connection ceiling.',
  causalChain: [
    '01:30 — reservation-service v2.14.0 deploys with an early return on context cancellation before conn.Release().',
    '02:00 — A benign +18% promotional traffic bump slightly increases tail latency, causing a handful of requests to hit the cancellation path.',
    '02:30–03:45 — Each canceled request leaks a pooled connection; fewer available connections increase acquisition wait times, causing more timeouts and accelerating the leak (positive feedback loop).',
    '03:45–06:00 — Pool saturates at 100/100 active handles (82 stranded idle-in-pool, ~18 serving live traffic) while inventory-db CPU remains low (~38%).',
    '06:00–15:00 — Only rolling back v2.14.0 and draining pods releases the leaked handles; raising the pool ceiling to 200 re-saturates within minutes, and passive observation leaves customers blocked.',
  ],
  customerImpactSummary:
    'Visitors attempting to reserve event spots experienced 2.5-second gateway timeouts once pool acquisition stalled. Retries increased total attempt volume, which we tracked separately from unique affected reservation IDs. Completed reservations continued to receive timely confirmations because the asynchronous confirmation queue, worker, and notification provider were unaffected.',
  alternativeClueExplanation:
    'At 02:00 a scheduled promotional newsletter increased incoming reservation requests by 18% (from ~110 to ~130 req/min). While that bump nudged the first few tail requests into the timeout path, the platform is sized for 250+ req/min and database CPU never exceeded 39%. Treating it as a traffic/capacity incident (by raising max_connections to 200) failed because the leak consumed the extra 100 slots within three minutes.',
  outcomeComparisons: {
    'act-rollback-drain': {
      interventionId: 'act-rollback-drain',
      label: 'Roll back the recent release and drain/recycle affected instances',
      verdict: 'Recommended resolution',
      whatHappened:
        'Cordoning v2.14.0 pods caused a brief 90-second capacity dip while in-flight work drained, then closed all 82 stranded handles. Active connections returned to 22/100 and error rate dropped to 0.0% from 07:30 onward.',
      tradeoffLesson:
        'Remove the root cause and verify that both the customer symptom (error rate / latency) and the underlying resource state (pooled connections) recover.',
      finalErrorRatePercent: 0,
      finalP95LatencyMs: 147,
      totalAffectedReservations: 187,
    },
    'act-increase-pool': {
      interventionId: 'act-increase-pool',
      label: 'Increase the connection limit',
      verdict: 'Temporary relief only',
      whatHappened:
        'Doubling the pool limit from 100 to 200 gave incoming requests fresh handles between 06:30 and 08:00, briefly lowering the error rate. However, v2.14.0 kept leaking ~18 connections/minute until all 200 slots saturated around 09:35 and severe timeouts resumed.',
      tradeoffLesson:
        'Adding capacity can conceal a resource leak for a few minutes without fixing it—and can leave a larger blast radius when the higher ceiling saturates.',
      finalErrorRatePercent: 54.5,
      finalP95LatencyMs: 2494,
      totalAffectedReservations: 490,
    },
    'act-observe': {
      interventionId: 'act-observe',
      label: 'Observe without changing anything',
      verdict: 'Unresolved impact',
      whatHappened:
        'Because leaked connections were held open by live v2.14.0 processes with no idle handle reaper, the pool stayed pinned at 100/100 for the entire remaining 9 minutes and reservation failures accumulated continuously.',
      tradeoffLesson:
        'Investigation time has a direct customer cost once evidence is decisive; waiting for a leak to self-heal without an eviction mechanism prolongs the outage.',
      finalErrorRatePercent: 63.6,
      finalP95LatencyMs: 2494,
      totalAffectedReservations: 658,
    },
  },
  preventionOpportunities: [
    {
      category: 'Testing & Code Hygiene',
      recommendation: 'Add cancellation-path unit and integration tests for database helper wrappers.',
      whyItMatters:
        'Asserting that pool.InUse() returns to 0 after a canceled context catches missing defer conn.Release() calls in CI before deployment.',
    },
    {
      category: 'Observability & Alerting',
      recommendation: 'Alert on connection pool saturation and db.pool.acquire wait duration separately from DB CPU.',
      whyItMatters:
        'A saturated pool with 38% DB CPU immediately distinguishes handle starvation in the caller from a database compute bottleneck.',
    },
    {
      category: 'Resilience & Guardrails',
      recommendation: 'Enforce a bounded max-connection-hold lifetime and automated canary rollback on pool wait spikes.',
      whyItMatters:
        'Reaping handles held longer than the gateway deadline prevents a single bad release from permanently wedging the pool.',
    },
  ],
};
