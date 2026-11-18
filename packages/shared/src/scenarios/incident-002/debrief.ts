import type { ScenarioDebrief } from '../../contracts/index.js';

export const INCIDENT_002_DEBRIEF: ScenarioDebrief = {
  incidentId: 'incident-002',
  technicalTitle: 'Downstream notification provider slowdown amplified by unconstrained worker retry storm',
  actualRootCause:
    'An external notification provider latency degradation was compounded into an aggressive retry storm because the confirmation worker was configured without exponential backoff, jitter, retry limits, or a circuit breaker. Outbound attempt amplification overwhelmed the provider with duplicate requests, triggering rate-limiting that halted ticket delivery while upstream reservation transactions remained completely unaffected.',
  causalChain: [
    '01:15 — External notification provider experienced downstream carrier queue latency, increasing response times from 125 ms to 950 ms.',
    '02:15 — Provider latency breached the confirmation worker 2,500 ms HTTP request timeout, causing delivery attempts to fail.',
    '02:30 — Confirmation worker retried failed deliveries immediately with 0ms delay across all threads, multiplying outbound attempt rate by 2.5x–3.8x.',
    '03:30 — Amplified attempt volume exceeded external provider ingress capacity, prompting HTTP 429 Too Many Requests responses with Retry-After headers.',
    '05:00 — Confirmation queue backlog mounted past 180 messages with p95 queue age reaching 75s (reaching 207 messages and 85s p95 age by 06:00), causing visitor confirmation emails to stall.',
    'Divergence — Throughout the incident, upstream reservation-service and inventory-db operated at 0.0% error rate and 115–133 ms latency, proving reservations succeeded even while confirmations stalled.',
  ],
  customerImpactSummary:
    'All customer event spot reservations safely succeeded and were persisted in the inventory database with 0% transaction loss. Customer impact was strictly confined to asynchronous notification delivery: visitors saw booking confirmations on screen but experienced delayed email/SMS ticket deliveries (up to 5–9 minutes depending on response). Retries did not create duplicate bookings or duplicate ticket deliveries.',
  alternativeClueExplanation:
    'During initial triage, the rapid buildup of the confirmation queue raised suspicion that upstream reservation services were flooding workers with invalid events or that worker threads were crashing. However, distributed trace telemetry and database pool metrics proved that reservation commits completed in 18 ms with 0.0% error rate and healthy 21/100 pool utilization. The root failure was isolated exclusively to downstream delivery latency and worker retry policy.',
  outcomeComparisons: {
    'act-backoff-circuit-breaker': {
      interventionId: 'act-backoff-circuit-breaker',
      label: 'Apply bounded exponential backoff with jitter and a circuit-breaker policy',
      verdict: 'Recommended resolution',
      whatHappened:
        'Tripping the circuit breaker and engaging exponential backoff with full jitter cut outbound attempt amplification to 1.30x at 07:00 and 1.00x baseline. Relieved of retry pressure, the downstream provider recovered to 131 ms at 09:00 and 129 ms at 15:00. The worker then sustainably drained the backlogged queue, achieving 0 backlog and full delivery by 08:00.',
      tradeoffLesson:
        'Backpressure containment requires accepting a brief, controlled delivery delay to eliminate self-inflicted retry storms. Downstream dependencies cannot recover while being continuously bombarded with immediate retries.',
      finalErrorRatePercent: 0,
      finalP95LatencyMs: 133,
      totalAffectedReservations: 661,
      finalBacklog: 0,
      finalQueueAgeP95Seconds: 0,
      finalRetryAmplification: 1.0,
      finalProviderP95Ms: 129,
    },
    'act-increase-concurrency': {
      interventionId: 'act-increase-concurrency',
      label: 'Increase worker concurrency',
      verdict: 'Unresolved impact',
      whatHappened:
        'Tripling worker threads from 4 to 12 multiplied concurrent connections against the struggling provider, driving retry amplification to 6.18x and triggering 78% HTTP 429 and 503 errors. The provider firewall ultimately blocked worker egress traffic, causing backlog to surge to 1,287 messages with provider latency pinned at 4,200 ms.',
      tradeoffLesson:
        'Adding consumer concurrency when downstream dependencies are failing is a dangerous antipattern. More workers simply deliver more failure faster, transforming a mild dependency degradation into total delivery collapse.',
      finalErrorRatePercent: 0,
      finalP95LatencyMs: 133,
      totalAffectedReservations: 1612,
      finalBacklog: 1287,
      finalQueueAgeP95Seconds: 555,
      finalRetryAmplification: 6.18,
      finalProviderP95Ms: 4200,
    },
    'act-observe': {
      interventionId: 'act-observe',
      label: 'Observe without changing anything',
      verdict: 'Unresolved impact',
      whatHappened:
        'Maintaining the unconstrained immediate retry configuration kept provider p95 latency pinned above 3,300 ms and retry amplification at 3.73x. Over 1,070 messages remained backlogged in queue at 15:00 (1,071 messages), with 1,612 cumulative reservations delayed past the 30s confirmation SLA.',
      tradeoffLesson:
        'Passive observation has high customer cost during self-perpetuating retry storms. Without backoff or rate shedding, arriving work plus continuous retries consistently exceed downstream processing capacity.',
      finalErrorRatePercent: 0,
      finalP95LatencyMs: 133,
      totalAffectedReservations: 1612,
      finalBacklog: 1071,
      finalQueueAgeP95Seconds: 460,
      finalRetryAmplification: 3.73,
      finalProviderP95Ms: 3310,
    },
  },
  preventionOpportunities: [
    {
      category: 'Resilience Engineering',
      recommendation: 'Enforce standard exponential backoff with full jitter and a bounded retry budget on all egress workers.',
      whyItMatters:
        'Prevents failing external dependencies from experiencing destructive retry multiplication during transient slow periods.',
    },
    {
      category: 'Circuit Breaking',
      recommendation: 'Deploy circuit breakers that fast-fail egress requests when downstream error/timeout rate exceeds 30%.',
      whyItMatters:
        'Allows downstream providers necessary idle headroom to recover while shedding load predictably and preserving worker threads.',
    },
    {
      category: 'Telemetry & Alerting',
      recommendation: 'Alert on confirmation queue message age (p95 > 30s) and outbound retry amplification ratio (> 1.5x).',
      whyItMatters:
        'Detects asynchronous pipeline stalls immediately, long before customer support tickets accumulate.',
    },
    {
      category: 'Customer Experience',
      recommendation: 'Implement explicit UI messaging confirming spot security: "Booking confirmed! Ticket email will arrive in 2–5 minutes."',
      whyItMatters:
        'Clearly separates transactional booking success from notification delivery status, preventing anxious customers from submitting duplicate reservations.',
    },
  ],
};
