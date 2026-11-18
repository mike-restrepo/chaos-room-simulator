import type { AnalysisResult } from '../../contracts/index.js';

export const INCIDENT_001_WALKTHROUGHS: {
  alert: AnalysisResult;
  evidence: AnalysisResult;
  outcomes: Record<string, AnalysisResult>;
} = {
  alert: {
    incidentId: 'incident-001',
    scenarioVersion: '1.0.0',
    checkpoint: 'alert',
    selectedInterventionId: null,
    sourceMode: 'authored_walkthrough',
    sourceBadgeLabel: 'Authored walkthrough',
    isPreviewMock: false,
    modelVersion: 'authored-v1',
    promptVersion: 'prompt-v1.0',
    generatedAtIso: '2026-11-12T00:03:00.000Z',
    conciseAssessment:
      'Reservation attempts are timing out at the API gateway and p95 latency has spiked to 2,493 ms shortly after reservation-service v2.14.0 deployed and a modest promotional traffic bump arrived. Active inventory database connections climbed sharply to 78–94/100 even though database CPU remains moderate (~36%).',
    observedFacts: [
      {
        text: 'Trailing 60-second reservation error rate reached 30.1% while API p95 latency rose to 2,493 ms.',
        citationIds: ['ev-met-180', 'ev-log-165'],
      },
      {
        text: 'Active database connections climbed from a baseline of 20/100 to 94/100 while database CPU remained moderate (36%).',
        citationIds: ['ev-met-150', 'ev-met-180'],
      },
      {
        text: 'Two recent changes occurred near the onset: reservation-service v2.14.0 deployed at 01:30 and promotional traffic rose +18% at 02:00.',
        citationIds: ['ev-dep-090', 'ev-met-120'],
      },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement:
          'Connection pool exhaustion or connection leak in reservation-service v2.14.0 is starving incoming requests of database handles.',
        likelihood: 'Primary',
        supportingCitationIds: ['ev-dep-090', 'ev-met-150', 'ev-met-180'],
      },
      {
        rank: 2,
        statement:
          'Slow database queries or lock contention under the +18% promotional traffic increase are holding connections longer than normal.',
        likelihood: 'Plausible alternative',
        supportingCitationIds: ['ev-met-120', 'ev-met-150'],
      },
    ],
    alternativeExplanations: [
      {
        explanation: 'Pure traffic overload from the promotional newsletter send at 02:00.',
        whyLessLikely:
          'Traffic rose only 18% (to ~130 req/min), well within platform baseline capacity, and database CPU is only 38%.',
        citationIds: ['ev-met-120', 'ev-met-150'],
      },
    ],
    missingInformation: [
      'Request trace breakdown showing whether latency is spent waiting to acquire a DB connection versus executing SQL queries.',
      'Reservation-service application logs showing whether connections are being released when requests time out or cancel.',
      'Confirmation worker and notification provider health to verify whether the issue is isolated to the reservation write path.',
    ],
    confidence: {
      level: 'Low',
      justification:
        'At 03:00 we see rising pool usage and gateway timeouts following both a deployment and a traffic bump, but we have not yet inspected traces or service error logs to confirm a connection leak versus slow queries.',
    },
    recommendedInterventions: [],
    verificationChecks: [
      'Inspect reservation-service request traces to compare db.pool.acquire wait time against actual SQL query execution time.',
      'Check reservation-service error logs for connection pool timeout or context-cancellation errors introduced in v2.14.0.',
      'Verify inventory-db CPU and confirmation-worker backlog to rule out a database compute bottleneck or downstream stall.',
    ],
    stakeholderUpdate:
      'We are investigating elevated reservation timeouts that began around 02:45. Existing confirmed bookings and confirmation delivery remain healthy while we isolate whether the recent reservation-service release is exhausting database connections.',
  },

  evidence: {
    incidentId: 'incident-001',
    scenarioVersion: '1.0.0',
    checkpoint: 'evidence',
    selectedInterventionId: null,
    sourceMode: 'authored_walkthrough',
    sourceBadgeLabel: 'Authored walkthrough',
    isPreviewMock: false,
    modelVersion: 'authored-v1',
    promptVersion: 'prompt-v1.0',
    generatedAtIso: '2026-11-12T00:06:00.000Z',
    conciseAssessment:
      'Evidence confirms a database connection leak in reservation-service v2.14.0. When a request hits the timeout/cancellation path in reserveWithTimeout, the function returns before calling conn.Release(), permanently stranding pooled connections until the 100-connection ceiling saturates.',
    observedFacts: [
      {
        text: 'Inventory DB connection pool is pinned at 100/100 active connections while DB CPU remains low (38%), proving connections are held idle rather than executing expensive queries.',
        citationIds: ['ev-met-225', 'ev-log-360'],
      },
      {
        text: 'Application logs explicitly report early return before conn.Release() on canceled contexts in reservation-service v2.14.0, leaving 82 leaked handles in the pool.',
        citationIds: ['ev-log-270', 'ev-log-360'],
      },
      {
        text: 'Trace trc-8841 shows 2,410 ms stalled in db.pool.acquire before any query runs, while confirmation pipeline metrics remain healthy.',
        citationIds: ['ev-trc-315', 'ev-met-345'],
      },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement:
          'A regression in reservation-service v2.14.0 fails to release pooled DB connections on the cancellation path, starving subsequent reservation attempts.',
        likelihood: 'Primary',
        supportingCitationIds: ['ev-dep-090', 'ev-log-270', 'ev-trc-315', 'ev-log-360'],
      },
      {
        rank: 2,
        statement:
          'The 100-connection pool ceiling is simply undersized for the +18% promotional traffic increase.',
        likelihood: 'Unlikely',
        supportingCitationIds: ['ev-met-120', 'ev-met-225'],
      },
    ],
    alternativeExplanations: [
      {
        explanation: 'Database CPU saturation or slow confirmation worker backpressure.',
        whyLessLikely:
          'Database CPU is 38%, SQL execution takes ~14–16 ms once a handle is acquired, and confirmation worker backlog is 1 with 110 ms provider latency.',
        citationIds: ['ev-met-225', 'ev-trc-315', 'ev-met-345'],
      },
    ],
    missingInformation: [
      'Post-rollback confirmation that draining v2.14.0 pods closes all stranded handles and restores normal pool utilization.',
    ],
    confidence: {
      level: 'High',
      justification:
        'Deployment timing, explicit conn.Release() cancellation logs, 2,410 ms pool acquisition traces, and low DB CPU all converge on a connection leak in v2.14.0.',
    },
    recommendedInterventions: [
      {
        interventionId: 'act-rollback-drain',
        rationale:
          'Removes the leaking v2.14.0 code path and recycles affected pods so stranded DB connections are closed and returned to the pool.',
        keyRisk:
          'Brief (~60–90 simulated seconds) capacity reduction while v2.14.0 pods drain in-flight requests.',
      },
      {
        interventionId: 'act-increase-pool',
        rationale:
          'Not recommended as a primary fix: raising the pool limit from 100 to 200 only buys a few minutes before leaked handles exhaust the new ceiling.',
        keyRisk:
          'Conceals the leak temporarily while allowing v2.14.0 to keep stranding connections until failures resume.',
      },
    ],
    verificationChecks: [
      'After initiating rollback and drain, verify active DB connections drop from 100/100 back toward the ~20/100 baseline.',
      'Confirm db.pool.acquire span duration returns below 10 ms and trailing 60s reservation error rate reaches 0%.',
    ],
    stakeholderUpdate:
      'Root cause identified: reservation-service release v2.14.0 fails to release database connections when requests time out, exhausting the 100-connection pool. We recommend rolling back to v2.13.4 and draining affected instances, with full recovery expected within two minutes of rollback.',
  },

  outcomes: {
    'act-rollback-drain': {
      incidentId: 'incident-001',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-rollback-drain',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored walkthrough',
      isPreviewMock: false,
      modelVersion: 'authored-v1',
      promptVersion: 'prompt-v1.0',
      generatedAtIso: '2026-11-12T00:15:00.000Z',
      conciseAssessment:
        'Rolling back reservation-service to v2.13.4 and draining affected instances resolved the incident. After a brief 90-second drain transition, stranded DB connections closed, active pool utilization stabilized around 20/100, and reservation error rate returned to 0%.',
      observedFacts: [
        {
          text: 'Draining v2.14.0 pods released leaked handles, dropping active DB connections from 100/100 at 06:00 to 22/100 by 07:30.',
          citationIds: ['ev-dep-390-rb', 'ev-met-450-rb'],
        },
        {
          text: 'End-to-end reservation traces recovered to 84 ms total duration (3 ms pool acquire, 16 ms SQL query).',
          citationIds: ['ev-trc-600-rb'],
        },
        {
          text: 'Trailing 60-second reservation error rate held at 0.0% with p95 latency at ~145 ms through 15:00.',
          citationIds: ['ev-log-900-rb'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Connection leak in reservation-service v2.14.0 caused the outage and was fully remediated by rolling back and draining instances.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-dep-390-rb', 'ev-met-450-rb', 'ev-log-900-rb'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [
        'Regression test coverage on reserveWithTimeout cancellation paths before re-attempting the v2.14.0 release.',
      ],
      confidence: {
        level: 'High',
        justification:
          'Both symptom metrics (error rate, p95 latency) and the underlying resource indicator (active pool connections) returned to healthy baseline and remained stable through 15:00.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-drain',
          rationale: 'Already applied and verified: service health and pool headroom are fully restored.',
          keyRisk: 'Ensure v2.14.0 remains blocked in CI until defer conn.Release() is covered by cancellation tests.',
        },
      ],
      verificationChecks: [
        'Confirm zero new affected reservation IDs accumulated after 07:30.',
        'Add a CI unit test asserting connection release on context cancellation before re-deploying v2.14.x.',
      ],
      stakeholderUpdate:
        'Incident resolved. Rolling back reservation-service to v2.13.4 and recycling instances released all stranded database connections. Reservation error rate is 0% and confirmation delivery is operating normally.',
    },

    'act-increase-pool': {
      incidentId: 'incident-001',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-increase-pool',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored walkthrough',
      isPreviewMock: false,
      modelVersion: 'authored-v1',
      promptVersion: 'prompt-v1.0',
      generatedAtIso: '2026-11-12T00:15:00.000Z',
      conciseAssessment:
        'Increasing the database connection limit from 100 to 200 provided only temporary relief (~06:30–08:30). Because reservation-service v2.14.0 continued leaking connections on timeout paths, unreleased handles filled all 200 slots by 10:00 and severe reservation timeouts returned.',
      observedFacts: [
        {
          text: 'Raising max_connections to 200 at 06:30 briefly reduced pool wait times, but active connections climbed past 158/200 by 08:00.',
          citationIds: ['ev-dep-390-pool', 'ev-met-480-pool'],
        },
        {
          text: 'By 10:00 the expanded 200-connection pool re-saturated (200/200 active) as v2.14.0 continued leaking handles.',
          citationIds: ['ev-log-600-pool'],
        },
        {
          text: 'At 15:00 reservation error rate remains above 40% with p95 latency near the 2,500 ms gateway timeout ceiling.',
          citationIds: ['ev-met-900-pool'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Scaling pool capacity masked the symptom briefly without stopping the v2.14.0 connection leak, leading to renewed saturation.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-met-480-pool', 'ev-log-600-pool', 'ev-met-900-pool'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [],
      confidence: {
        level: 'High',
        justification:
          'Active connections grew monotonically from 100 to 200 at the same leak rate until timeouts resumed at full severity.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-drain',
          rationale:
            'Still required: roll back reservation-service v2.14.0 and recycle instances to stop the leak and release the 160+ stranded handles.',
          keyRisk: 'Brief drain dip during pod replacement.',
        },
      ],
      verificationChecks: [
        'Compare the temporary dip at 07:00–08:00 against the re-saturation at 10:00 to see why capacity increases do not fix resource leaks.',
      ],
      stakeholderUpdate:
        'Increasing the database connection pool limit to 200 provided ~3 minutes of partial relief, but leaked connections from v2.14.0 have now exhausted the larger pool. Rolling back v2.14.0 is required to restore service.',
    },

    'act-observe': {
      incidentId: 'incident-001',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-observe',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored walkthrough',
      isPreviewMock: false,
      modelVersion: 'authored-v1',
      promptVersion: 'prompt-v1.0',
      generatedAtIso: '2026-11-12T00:15:00.000Z',
      conciseAssessment:
        'Observing without intervening left the connection pool pinned at 100/100 through 15:00. Because leaked handles in v2.14.0 have no idle eviction timeout, the system did not self-recover and customer reservation failures compounded continuously.',
      observedFacts: [
        {
          text: 'No deployment or configuration change was applied at 06:00; 82+ pool handles remained stranded in reservation-service v2.14.0 pods.',
          citationIds: ['ev-log-450-obs'],
        },
        {
          text: 'Reservation error rate remained near 45% with API p95 latency above 2,450 ms from 06:00 through 15:00.',
          citationIds: ['ev-met-630-obs', 'ev-log-900-obs'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Unbounded connection leak in v2.14.0 persists indefinitely until affected processes are rolled back and recycled.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-log-450-obs', 'ev-met-630-obs', 'ev-log-900-obs'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [],
      confidence: {
        level: 'High',
        justification:
          'Nine additional simulated minutes of observation confirmed zero natural recovery of leaked pool connections.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-drain',
          rationale:
            'Immediate rollback to v2.13.4 and pod drain is required to terminate leaked handles and restore reservation capacity.',
          keyRisk: 'Brief drain window during rollback.',
        },
      ],
      verificationChecks: [
        'Review cumulative affected reservations at 15:00 versus 06:00 to quantify the customer cost of delayed intervention.',
      ],
      stakeholderUpdate:
        'Reservation service remains severely degraded (~45% failure rate) as database connections stay pinned at 100/100. We need immediate approval to roll back release v2.14.0 and drain affected instances.',
    },
  },
};
