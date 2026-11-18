import type { AnalysisResult } from '../../contracts/index.js';

const MOCK_TIMESTAMP = '2026-11-13T12:00:00.000Z';

export const INCIDENT_002_WALKTHROUGHS: {
  alert: AnalysisResult;
  evidence: AnalysisResult;
  outcomes: Record<string, AnalysisResult>;
} = {
  alert: {
    incidentId: 'incident-002',
    scenarioVersion: '1.0.0',
    checkpoint: 'alert',
    selectedInterventionId: null,
    sourceMode: 'authored_walkthrough',
    sourceBadgeLabel: 'Authored Walkthrough',
    isPreviewMock: false,
    modelVersion: 'gemini-2.5-pro',
    promptVersion: '1.0.0',
    generatedAtIso: MOCK_TIMESTAMP,
    conciseAssessment:
      'Notification provider latency has climbed significantly, triggering worker request timeouts. Because confirmation-worker lacks a retry delay or retry budget, failed delivery attempts are re-attempting immediately, multiplying outbound attempts by 2.1x and causing a 99-message confirmation backlog. Importantly, the upstream reservation API and database remain completely healthy, confirming that customer reservations are succeeding while ticket notifications are delayed.',
    observedFacts: [
      {
        text: 'Confirmation worker audit confirms no backoff policy, unbounded retries, and a 2,500 ms request timeout.',
        citationIds: ['ev-dep-060'],
      },
      {
        text: 'External notification provider latency climbed from 125 ms to 950 ms before worker timeouts began.',
        citationIds: ['ev-met-090'],
      },
      {
        text: 'Outbound delivery attempts multiplied to 2.1x relative to unique confirmation messages.',
        citationIds: ['ev-met-135'],
      },
      {
        text: 'Worker logs report repeated 2,500 ms HTTP client timeouts when calling the external notification endpoint.',
        citationIds: ['ev-log-165'],
      },
      {
        text: 'Confirmation queue depth breached alert threshold at 99 messages with p95 queue age reaching 40 seconds.',
        citationIds: ['ev-met-180'],
      },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement:
          'External notification provider slowdown is being amplified into a self-inflicted retry storm by immediate, unbounded confirmation worker retries.',
        likelihood: 'Primary',
        supportingCitationIds: ['ev-dep-060', 'ev-met-090', 'ev-met-135', 'ev-log-165'],
      },
      {
        rank: 2,
        statement:
          'Worker instances are experiencing internal thread starvation or CPU exhaustion preventing timely message processing.',
        likelihood: 'Plausible alternative',
        supportingCitationIds: ['ev-dep-060', 'ev-met-180'],
      },
      {
        rank: 3,
        statement:
          'Upstream reservation pipeline or database lock contention is blocking confirmation message production.',
        likelihood: 'Unlikely',
        supportingCitationIds: ['ev-met-090'],
      },
    ],
    alternativeExplanations: [
      {
        explanation: 'Platform-wide outage or upstream inventory database degradation.',
        whyLessLikely:
          'Upstream reservation request rate is steady and provider latency degraded first; database and gateway metrics show normal operation.',
        citationIds: ['ev-met-090'],
      },
    ],
    missingInformation: [
      'Downstream notification provider status page or external incident confirmation.',
      'Distributed traces separating reservation write time from notification delivery time.',
      'Customer support queue volume to confirm whether visitors see successful reservation confirmations on screen.',
    ],
    confidence: {
      level: 'Medium',
      justification:
        'Telemetry clearly demonstrates downstream provider latency and retry multiplication, but verification of upstream reservation health and downstream provider status requires further evidence.',
    },
    // MUST BE EMPTY AT ALERT
    recommendedInterventions: [],
    verificationChecks: [
      'Inspect end-to-end distributed traces for reservation requests to confirm database commit latency vs worker delivery latency.',
      'Audit upstream reservation-service error rate and inventory-db connection pool metrics.',
      'Check external notification provider HTTP status response codes for potential rate-limiting (HTTP 429).',
    ],
    stakeholderUpdate:
      'Customer spot reservations continue to succeed normally. However, ticket confirmation emails and SMS are experiencing delivery delays due to an external notification provider slowdown and internal worker retry backpressure. Bookings remain safely held in the system. Engineering is actively investigating delivery throttling.',
  },

  evidence: {
    incidentId: 'incident-002',
    scenarioVersion: '1.0.0',
    checkpoint: 'evidence',
    selectedInterventionId: null,
    sourceMode: 'authored_walkthrough',
    sourceBadgeLabel: 'Authored Walkthrough',
    isPreviewMock: false,
    modelVersion: 'gemini-2.5-pro',
    promptVersion: '1.0.0',
    generatedAtIso: MOCK_TIMESTAMP,
    conciseAssessment:
      'Comprehensive telemetry confirms the incident is an unconstrained retry storm triggered by downstream notification provider degradation. Distributed traces prove that customer spot reservations commit and succeed in under 120 ms (0.0% error rate), but confirmation workers retry timed-out deliveries immediately in a tight loop. Outbound attempt amplification has triggered HTTP 429 rate-limiting from the provider, driving confirmation backlog to 207 messages and p95 queue age to 85 seconds (delaying 424 customer confirmations past the 30-second SLA).',
    observedFacts: [
      {
        text: 'Distributed trace demonstrates reservation-service writes to inventory-db in 18 ms and returns HTTP 201 in 118 ms; delivery timeout is entirely isolated to confirmation-worker.',
        citationIds: ['ev-trc-210'],
      },
      {
        text: 'Upstream inventory database connection pool is healthy at 21 / 100 connections with 0.0% error rate.',
        citationIds: ['ev-met-240'],
      },
      {
        text: 'Visitor support inquiries confirm bookings are visible on screen while email notifications are missing.',
        citationIds: ['ev-log-300'],
      },
      {
        text: 'Notification provider is now returning HTTP 429 Too Many Requests (Retry-After: 15s) for 42% of attempts due to retry volume.',
        citationIds: ['ev-met-345'],
      },
      {
        text: 'Delivery attempt amplification has grown to 3.6x with confirmation queue backlog reaching 207 messages (p95 age: 85s).',
        citationIds: ['ev-met-135', 'ev-met-180'],
      },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement:
          'Downstream notification provider slowdown amplified into a cascading retry storm by immediate worker retries without backoff or retry budget.',
        likelihood: 'Primary',
        supportingCitationIds: ['ev-dep-060', 'ev-met-090', 'ev-trc-210', 'ev-met-345'],
      },
      {
        rank: 2,
        statement:
          'Worker capacity deficit requiring higher worker thread concurrency.',
        likelihood: 'Plausible alternative',
        supportingCitationIds: ['ev-met-180'],
      },
      {
        rank: 3,
        statement:
          'Upstream reservation failure or database lock contention.',
        likelihood: 'Unlikely',
        supportingCitationIds: ['ev-trc-210', 'ev-met-240'],
      },
    ],
    alternativeExplanations: [
      {
        explanation: 'Worker capacity shortfall solvable by increasing thread concurrency.',
        whyLessLikely:
          'Provider is already rejecting traffic with HTTP 429. Tripling worker threads would inject more concurrent requests into an overloaded downstream dependency, worsening rate limits.',
        citationIds: ['ev-met-345'],
      },
      {
        explanation: 'Database connection exhaustion or upstream reservation drop.',
        whyLessLikely:
          'Trace and metric telemetry prove 0.0% reservation errors, 21/100 active DB pool handles, and 118 ms API p95 latency.',
        citationIds: ['ev-trc-210', 'ev-met-240'],
      },
    ],
    missingInformation: [
      'ETA on upstream provider infrastructure stabilization.',
      'Automated customer banner notification acknowledging delivery delays in the booking confirmation web UI.',
    ],
    confidence: {
      level: 'High',
      justification:
        'Causal path is verified: upstream reservations succeed with 0% error rate, while downstream worker immediate retries have created an amplifying retry storm that tripped provider rate limits.',
    },
    recommendedInterventions: [
      {
        interventionId: 'act-backoff-circuit-breaker',
        rationale:
          'Applying exponential backoff with full jitter and a circuit breaker immediately relieves downstream provider pressure, stops HTTP 429 rejections, and allows queued confirmations to drain sustainably.',
        keyRisk:
          'Confirmations will remain queued temporarily while backoff intervals elapse and the provider stabilizes.',
      },
      {
        interventionId: 'act-increase-concurrency',
        rationale:
          'Attempts to process the accumulating queue faster by allocating more worker threads.',
        keyRisk:
          'High risk: Dispatches more simultaneous attempts into an already rate-limiting provider (HTTP 429), triggering total IP rejection and worsening queue depth.',
      },
      {
        interventionId: 'act-observe',
        rationale:
          'Monitors telemetry without making operational configuration changes.',
        keyRisk:
          'Ongoing retry storm maintains provider overload, leaving customer confirmations stalled indefinitely.',
      },
    ],
    verificationChecks: [
      'Monitor outbound attempt amplification ratio (target: < 1.2x) following intervention.',
      'Track notification provider p95 response time and HTTP 429 response rate.',
      'Verify confirmation queue depth steadily decreases to zero without message loss.',
    ],
    stakeholderUpdate:
      'All customer reservations remain securely confirmed in the database (0% loss). Stalled confirmation delivery has been traced to a downstream retry storm against our notification partner. Applying exponential backoff and circuit-breaking will relieve partner pressure and allow the confirmation backlog to drain cleanly.',
  },

  outcomes: {
    'act-backoff-circuit-breaker': {
      incidentId: 'incident-002',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-backoff-circuit-breaker',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored Walkthrough',
      isPreviewMock: false,
      modelVersion: 'gemini-2.5-pro',
      promptVersion: '1.0.0',
      generatedAtIso: MOCK_TIMESTAMP,
      conciseAssessment:
        'Applying exponential backoff, jitter, and a circuit breaker successfully resolved the confirmation stall. Halting unconstrained retries dropped attempt amplification from 3.63x to 1.30x at 07:00 (stabilizing at 1.00x), allowing the external notification provider to clear internal congestion and recover to 131 ms at 09:00 (129 ms at 15:00). The worker drained the backlogged confirmations smoothly by 08:00. By 15:00, queue depth returned to 0, p95 queue age is 0s, and all customer confirmations have been delivered without loss or duplication (661 reservations experienced confirmation delays over 30 seconds during the incident).',
      observedFacts: [
        {
          text: 'Circuit breaker opened at 07:00, reducing retry amplification to 1.3x [ev-out-bb-420] before stabilizing at 1.00x baseline at 15:00 [ev-out-bb-900].',
          citationIds: ['ev-out-bb-420', 'ev-out-bb-900'],
        },
        {
          text: 'Notification provider latency recovered from 3,450 ms down to 131 ms at 09:00 [ev-out-bb-540] and settled at 129 ms at 15:00 [ev-out-bb-900].',
          citationIds: ['ev-out-bb-540', 'ev-out-bb-900'],
        },
        {
          text: 'Confirmation queue drained completely to 0 messages with p95 queue age recovering to 0s [ev-out-bb-720].',
          citationIds: ['ev-out-bb-720'],
        },
        {
          text: 'Upstream reservation path remained 100% operational throughout with 0.0% error rate [ev-met-240].',
          citationIds: ['ev-met-240'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Downstream provider degradation was remediated by containing outbound retry amplification via backoff and circuit breaking.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-out-bb-420', 'ev-out-bb-540', 'ev-out-bb-720', 'ev-out-bb-900'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [],
      confidence: {
        level: 'High',
        justification:
          'Full recovery verified: queue backlog is 0, provider latency is 135 ms, and all unique confirmations have been delivered.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-backoff-circuit-breaker',
          rationale: 'Validated optimal resolution: restored delivery health with zero message loss.',
          keyRisk: 'None remaining; permanent policy should be committed to codebase.',
        },
      ],
      verificationChecks: [
        'Confirm confirmation queue depth remains at 0–1 under ongoing traffic.',
        'Codify exponential backoff, full jitter, and 3-attempt retry budget in worker deployment templates.',
      ],
      stakeholderUpdate:
        'Incident fully resolved. All delayed confirmation emails and SMS have been successfully delivered to customers. System throughput is normal, queue backlog is cleared, and safeguards have been established to prevent future retry amplification.',
    },

    'act-increase-concurrency': {
      incidentId: 'incident-002',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-increase-concurrency',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored Walkthrough',
      isPreviewMock: false,
      modelVersion: 'gemini-2.5-pro',
      promptVersion: '1.0.0',
      generatedAtIso: MOCK_TIMESTAMP,
      conciseAssessment:
        'Increasing worker concurrency backfired severely. Tripling worker threads from 4 to 12 flooded the impaired notification provider, escalating retry amplification to 6.18x at 07:30 and holding 6.18x through 15:00. The external provider responded with 78% HTTP 429 and 503 errors and ultimately blocked worker egress traffic. By 15:00, confirmation backlog escalated to 1,287 messages, p95 queue age reached 555 seconds (> 9 minutes), and 1,612 customer reservations experienced severe notification delays.',
      observedFacts: [
        {
          text: 'Tripling worker threads caused retry amplification to surge to 6.18x at 07:30, with provider p95 latency reaching 3,825 ms and 387 messages queued.',
          citationIds: ['ev-out-inc-450'],
        },
        {
          text: 'Confirmation queue backlog mounted to 687 messages at 10:00 with p95 queue age reaching 295 seconds.',
          citationIds: ['ev-out-inc-600'],
        },
        {
          text: 'By 15:00, backlog escalated to 1,287 messages with p95 queue age at 555 seconds and 1,612 reservations delayed past SLA.',
          citationIds: ['ev-out-inc-900'],
        },
        {
          text: 'Upstream reservation path remained healthy with 0.0% error rate despite catastrophic downstream queue failure.',
          citationIds: ['ev-met-240'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Adding concurrency to an overloaded downstream dependency amplified the retry storm and triggered defensive provider rate-limiting.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-out-inc-450', 'ev-out-inc-600', 'ev-out-inc-900'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [],
      confidence: {
        level: 'High',
        justification:
          'Clear negative causal outcome: increased worker concurrency directly triggered downstream provider IP block and severe backlog growth.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-increase-concurrency',
          rationale: 'Proved highly counter-productive; exacerbated downstream collapse.',
          keyRisk: 'Immediate revert required; worker threads must be reduced and backoff applied.',
        },
      ],
      verificationChecks: [
        'Immediately scale worker concurrency down and engage backoff policy to lift provider block.',
      ],
      stakeholderUpdate:
        'Incident status is Critical. Attempting to accelerate processing by increasing worker concurrency overwhelmed our notification partner, resulting in temporary IP throttling. Over 1,280 customer confirmations are delayed. Technical teams are reverting worker threads and implementing request backoff.',
    },

    'act-observe': {
      incidentId: 'incident-002',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-observe',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored Walkthrough',
      isPreviewMock: false,
      modelVersion: 'gemini-2.5-pro',
      promptVersion: '1.0.0',
      generatedAtIso: MOCK_TIMESTAMP,
      conciseAssessment:
        'Observing without changing configuration left the incident unresolved. Sustained immediate retries maintained constant pressure on the degraded notification provider, keeping retry amplification at 3.73x and provider p95 latency at 3,310 ms. Confirmation backlog climbed to 1,071 messages with p95 queue age reaching 460 seconds (> 7 minutes). While upstream reservations continued without error, 1,612 customers suffered prolonged confirmation delivery delays.',
      observedFacts: [
        {
          text: 'Sustained immediate retries kept attempt amplification at 3.73x, preventing downstream provider recovery.',
          citationIds: ['ev-out-obs-480'],
        },
        {
          text: 'Confirmation backlog accumulated to 783 messages at 12:00 with p95 queue age exceeding 5 minutes (335s).',
          citationIds: ['ev-out-obs-720'],
        },
        {
          text: 'At 15:00, 1,071 messages remain stalled in queue with 1,612 cumulative reservations delayed past 30s confirmation SLA.',
          citationIds: ['ev-out-obs-900'],
        },
        {
          text: 'Upstream reservation path maintained 0.0% errors throughout the observation period.',
          citationIds: ['ev-met-240'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Unbounded immediate retries sustained artificial downstream overload, preventing autonomous provider recovery.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-out-obs-480', 'ev-out-obs-720', 'ev-out-obs-900'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [],
      confidence: {
        level: 'High',
        justification:
          'Passive observation confirmed that retry storms do not self-heal while arrival rate and unconstrained retries exceed downstream capacity.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-observe',
          rationale: 'Passive monitoring failed to resolve customer impact.',
          keyRisk: 'Customer confusion and support ticket volume will continue to escalate.',
        },
      ],
      verificationChecks: [
        'Apply backoff and jitter policy immediately to allow provider recovery and drain queue.',
      ],
      stakeholderUpdate:
        'Incident remains active. Customer confirmations remain delayed by over 5 minutes due to downstream notification partner throttling. Engineering intervention to implement backoff is required to restore timely delivery.',
    },
  },
};
