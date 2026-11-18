import type { AnalysisResult } from '../../contracts/index.js';

const MOCK_TIMESTAMP = '2026-11-13T12:00:00.000Z';

export const INCIDENT_003_WALKTHROUGHS: {
  alert: AnalysisResult;
  evidence: AnalysisResult;
  outcomes: Record<string, AnalysisResult>;
} = {
  alert: {
    incidentId: 'incident-003',
    scenarioVersion: '1.0.0',
    checkpoint: 'alert',
    selectedInterventionId: null,
    sourceMode: 'authored_walkthrough',
    sourceBadgeLabel: 'Authored walkthrough',
    isPreviewMock: false,
    modelVersion: 'gemini-2.5-pro',
    promptVersion: '1.0.0',
    generatedAtIso: MOCK_TIMESTAMP,
    conciseAssessment:
      'Following the 01:30 deployment of reservation-service v2.15.0 to 3 of 4 pods, confirmation-worker began failing schema validation on events carrying schemaVersion "2.0" because top-level reservationId moved to nested reservation.id. Compatible v1.0 events still confirm normally, creating a selective backlog of 140 outstanding confirmations (p95 age 85s) while 219 v1.0 confirmations delivered cleanly.',
    observedFacts: [
      {
        text: 'reservation-service v2.15.0 rolled out at 01:30 with an event contract change moving top-level reservationId into nested reservation.id (schemaVersion "2.0").',
        citationIds: ['ev-dep-090'],
      },
      {
        text: 'confirmation-worker v1.8.0 logs report SchemaValidationError for missing required root field "reservationId" on v2.0 events and NACK them with a 30s retry delay.',
        citationIds: ['ev-log-150'],
      },
      {
        text: 'At 03:00, 140 outstanding confirmations are retained in queue (p95 age 85s) with 246 validation failure attempts across 140 unique messages in trailing 60s and 84 reservations delayed over 30s.',
        citationIds: ['ev-met-180'],
      },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement:
          'Breaking producer event schema change in reservation-service v2.15.0 (schemaVersion "2.0") is rejected by confirmation-worker v1.8.0 validation.',
        likelihood: 'Primary',
        supportingCitationIds: ['ev-dep-090', 'ev-log-150', 'ev-met-180'],
      },
      {
        rank: 2,
        statement:
          'Promotional traffic bump (+22.2%, 108 to 132 req/min arrival rate; 119 attempts in trailing 60s) exceeded worker or notification provider capacity.',
        likelihood: 'Plausible alternative',
        supportingCitationIds: ['ev-met-120', 'ev-met-180'],
      },
    ],
    alternativeExplanations: [
      {
        explanation:
          'Promotional traffic bump (+22.2% to 132 req/min arrival rate; 119 attempts / 60s, 133 ms API p95) overloading workers.',
        whyLessLikely:
          'Validation logs specifically fail on missing "reservationId" field in schemaVersion "2.0" payloads rather than timeouts or worker saturation.',
        citationIds: ['ev-met-120', 'ev-log-150'],
      },
    ],
    missingInformation: [
      'Side-by-side distributed trace comparing a failing v2.0 event against a succeeding v1.0 event.',
      'Inventory database and external notification-provider health checks to rule out infrastructure faults.',
      'Exact cohort size of accepted reservations awaiting confirmations.',
    ],
    confidence: {
      level: 'Medium',
      justification:
        'Deployment and validation error logs directly implicate schemaVersion "2.0", pending paired trace confirmation of v1.0 success and provider health.',
    },
    recommendedInterventions: [],
    verificationChecks: [
      'Compare distributed traces for a reservation emitted by v2.15.0 vs the remaining v2.14.2 pod.',
      'Verify notification-provider HTTP delivery status codes and inventory-db pool health.',
      'Audit whether delayed support reports correlate exclusively with the post-01:30 v2.15.0 cohort.',
    ],
    stakeholderUpdate:
      'Reservations are succeeding reliably (0% API errors), though a subset of bookings since 01:30 are experiencing delayed confirmation emails while other bookings confirm on time. Engineering is investigating worker validation errors.',
  },

  evidence: {
    incidentId: 'incident-003',
    scenarioVersion: '1.0.0',
    checkpoint: 'evidence',
    selectedInterventionId: null,
    sourceMode: 'authored_walkthrough',
    sourceBadgeLabel: 'Authored walkthrough',
    isPreviewMock: false,
    modelVersion: 'gemini-2.5-pro',
    promptVersion: '1.0.0',
    generatedAtIso: MOCK_TIMESTAMP,
    conciseAssessment:
      'Paired traces and support cohort audits confirm an incompatible producer event contract change: reservation-service v2.15.0 publishes schemaVersion "2.0" (nested reservation.id), failing confirmation-worker v1.8.0 schema validation while v1.0 events continue confirming through a completely healthy database and notification provider. At 06:00, 428 accepted reservations remain unconfirmed in confirmation-queue (p95 age 255s; 870 validation failures across 428 unique messages in 60s), requiring both stopping new incompatible events and adapting/replaying the stranded cohort.',
    observedFacts: [
      {
        text: 'Paired trace confirms both reservations return HTTP 201 in ~118 ms, v1.0 event evt-0423 delivers via notification-provider in 122 ms, and v2.0 event evt-0415 fails worker validation.',
        citationIds: ['ev-trc-210'],
      },
      {
        text: 'Upstream API (0.0% errors), inventory-db (21/100 pool, 31% CPU), and notification-provider (122 ms p95, 100% HTTP 200 on valid sends) are completely healthy.',
        citationIds: ['ev-met-240'],
      },
      {
        text: 'Support cohort audit confirms all missing confirmation emails trace exclusively to post-01:30 v2.0 events retained in queue.',
        citationIds: ['ev-log-300'],
      },
      {
        text: 'At 06:00, 428 outstanding confirmations remain unconfirmed (p95 age 255s), generating 870 validation failure attempts across 428 unique messages in trailing 60s, with 372 reservations delayed > 30s.',
        citationIds: ['ev-met-360'],
      },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement:
          'Breaking v2.15.0 contract change (moving reservationId to reservation.id) strands v2.0 messages in confirmation-queue while v1.0 continues processing normally.',
        likelihood: 'Primary',
        supportingCitationIds: ['ev-dep-090', 'ev-log-150', 'ev-trc-210', 'ev-log-300', 'ev-met-360'],
      },
      {
        rank: 2,
        statement:
          'Traffic increase (+22.2% arrival step to 132 req/min; 119 attempts / 60s) or downstream provider degradation caused selective backlog.',
        likelihood: 'Unlikely',
        supportingCitationIds: ['ev-met-120', 'ev-trc-210', 'ev-met-240'],
      },
    ],
    alternativeExplanations: [
      {
        explanation:
          'Capacity overload from the +22.2% promotional traffic bump (108 to 132 req/min arrival; 133 ms API p95).',
        whyLessLikely:
          'inventory-db sits at 21/100 connections, notification-provider delivers v1.0 payloads in 122 ms HTTP 200, and validation failures are deterministically keyed to schemaVersion "2.0".',
        citationIds: ['ev-met-120', 'ev-met-240', 'ev-trc-210'],
      },
    ],
    missingInformation: [],
    confidence: {
      level: 'High',
      justification:
        'Root cause and disconfirming evidence are conclusive: compatible v1.0 messages succeed through the exact same infrastructure while v2.0 messages deterministically fail schema validation.',
    },
    recommendedInterventions: [
      {
        interventionId: 'act-rollback-quarantine-replay',
        rationale:
          'Rolls back reservation-service to v2.14.2 to restore v1.0 compatibility for new bookings, quarantines incompatible v2.0 payloads to stop validation loops while keeping backlog accounting intact, and adapts + replays stranded messages retaining original eventId and enqueue timestamps under reservationId-keyed idempotency.',
        keyRisk:
          'Paced 20-msg/tick FIFO replay runs serially after rollback and quarantine; queued confirmations remain delayed while the adapter processes the backlog, with additional delay risk if adapter mapping fails.',
      },
      {
        interventionId: 'act-rollback-producer-only',
        rationale: 'Reverts reservation-service to v2.14.2 so newly accepted bookings confirm immediately.',
        keyRisk:
          'Incomplete recovery: leaves previously queued incompatible v2.0 events unconfirmed until quarantine, adaptation, and replay are executed.',
      },
      {
        interventionId: 'act-restart-workers-only',
        rationale: 'Restarts confirmation-worker instances to clear transient runtime state.',
        keyRisk:
          'Counter-productive: workers resume with the same v1.8.0 schema validator while v2.15.0 continues publishing incompatible v2.0 events.',
      },
    ],
    verificationChecks: [
      'Confirm v2.0 event publication drops to 0 after rolling back reservation-service pods.',
      'Verify quarantined messages remain counted in outstanding backlog until replayed with reservationId-keyed idempotency checks.',
      'Verify validation failures drop to 0 and outstanding confirmations drain to 0 without duplicates.',
    ],
    stakeholderUpdate:
      'All customer reservations remain safely committed. Engineering isolated stalled confirmation emails to a schema mismatch introduced in the 01:30 release and recommends rolling back the producer, quarantining incompatible messages, and adapting and replaying them to deliver delayed confirmations.',
  },

  outcomes: {
    'act-rollback-quarantine-replay': {
      incidentId: 'incident-003',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-rollback-quarantine-replay',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored walkthrough',
      isPreviewMock: false,
      modelVersion: 'gemini-2.5-pro',
      promptVersion: '1.0.0',
      generatedAtIso: MOCK_TIMESTAMP,
      conciseAssessment:
        'Producer rollback combined with quarantine, schema adaptation, and idempotent replay fully resolved the incident. Quarantining halted validation errors while accounting for all 436 affected v2.0 messages [ev-out-rqr-390], FIFO adaptation replayed them smoothly with zero duplicates [ev-out-rqr-450, ev-out-rqr-540], and by 15:00 all 1,943 accepted reservations were confirmed with 0 outstanding messages [ev-out-rqr-900].',
      observedFacts: [
        {
          text: 'At 06:30, producer rollback to v2.14.2 completed and all 436 incompatible v2.0 messages were quarantined while remaining counted in outstanding backlog (p95 age 285s).',
          citationIds: ['ev-out-rqr-390'],
        },
        {
          text: 'At 07:30, validation failures dropped to 0/60s and 220 adapted messages had been replayed cleanly (retaining original eventId and enqueue times under reservationId idempotency; 216 remaining in quarantine, p95 age 210s).',
          citationIds: ['ev-out-rqr-450'],
        },
        {
          text: 'By 09:00, all 436 adapted messages completed reservationId-idempotent replay with 0 duplicates and 0 outstanding confirmations.',
          citationIds: ['ev-out-rqr-540'],
        },
        {
          text: 'At 15:00, conservation holds at 1,943 accepted = 1,943 delivered + 0 outstanding, with 436 cumulative reservations delayed > 30s and 0 validation errors.',
          citationIds: ['ev-out-rqr-900'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Producer rollback stopped new incompatible events while quarantine, adaptation, and idempotent replay repaired all accumulated v2.0 confirmations.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-out-rqr-390', 'ev-out-rqr-450', 'ev-out-rqr-540', 'ev-out-rqr-900'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [],
      confidence: {
        level: 'High',
        justification:
          'Full reconciliation verified: 1,943 accepted = 1,943 delivered (1,507 native v1.0 + 436 replayed), 0 duplicates, 0 backlog.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-quarantine-replay',
          rationale:
            'Validated complete recovery: addressed both forward code compatibility and stranded queue data.',
          keyRisk: 'None remaining; deploy contract tests and additive schemas before future v2 rollout.',
        },
      ],
      verificationChecks: [
        'Confirm reservation-service stays on v2.14.2 until dual-write/consumer compatibility ships.',
        'Verify consumer contract tests and dead-letter quarantine alerting are active in CI/CD.',
      ],
      stakeholderUpdate:
        'Incident resolved. All delayed confirmation emails and SMS from the affected cohort have been delivered without duplicates, and new reservations are confirming immediately.',
    },

    'act-rollback-producer-only': {
      incidentId: 'incident-003',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-rollback-producer-only',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored walkthrough',
      isPreviewMock: false,
      modelVersion: 'gemini-2.5-pro',
      promptVersion: '1.0.0',
      generatedAtIso: MOCK_TIMESTAMP,
      conciseAssessment:
        'Rolling back the producer only restored confirmations for newly created bookings, achieving only partial recovery. The 436 schemaVersion "2.0" messages queued between 01:30 and 06:10 were never adapted or replayed; at 15:00 they remain unconfirmed in confirmation-queue with p95 age reaching 795s and 950 validation failure attempts per 60s window.',
      observedFacts: [
        {
          text: 'At 07:30 after rollback-only, new v1.0 confirmations succeeded while all 436 previously queued v2.0 events stayed stuck in confirmation-queue (p95 age 345s, 950 validation failures across 436 unique messages per 60s).',
          citationIds: ['ev-out-rpo-450'],
        },
        {
          text: 'At 10:00, all 436 incompatible cohort messages remained stranded with p95 queue age climbing to 495s and 950 validation failure attempts / 60s.',
          citationIds: ['ev-out-rpo-600'],
        },
        {
          text: 'At 15:00, 1,507 of 1,943 reservations were delivered, leaving 436 cohort confirmations still unconfirmed in queue and requiring additional recovery (p95 age 795s, 950 validation failures across 436 unique msgs).',
          citationIds: ['ev-out-rpo-900'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Code rollback alone repaired future event production but left previously published v2.0 payloads unprocessable in persistent storage.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-out-rpo-450', 'ev-out-rpo-600', 'ev-out-rpo-900'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [],
      confidence: {
        level: 'High',
        justification:
          'Queue metrics confirm zero net reduction in the 436-message v2.0 backlog from 06:15 through 15:00 despite healthy live traffic.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-quarantine-replay',
          rationale:
            'Next response required: producer rollback stopped new v2.0 events, so quarantining, adapting reservation.id to reservationId, and replaying the 436 remaining v2.0 messages is required to complete delivery.',
          keyRisk:
            'Until quarantine, adaptation, and replay run, 436 customers remain without confirmations (795s p95 queue age).',
        },
      ],
      verificationChecks: [
        'Quarantine the 436 stranded v2.0 events, adapt reservation.id -> reservationId retaining original eventId/enqueue time, and replay with reservationId idempotency.',
      ],
      stakeholderUpdate:
        'New reservations are confirming normally again after rolling back the producer, but 436 bookings placed earlier remain without confirmation emails as of 15:00. Engineering proposes quarantining, adapting, and replaying those queued events as the next recovery step.',
    },

    'act-restart-workers-only': {
      incidentId: 'incident-003',
      scenarioVersion: '1.0.0',
      checkpoint: 'outcome',
      selectedInterventionId: 'act-restart-workers-only',
      sourceMode: 'authored_walkthrough',
      sourceBadgeLabel: 'Authored walkthrough',
      isPreviewMock: false,
      modelVersion: 'gemini-2.5-pro',
      promptVersion: '1.0.0',
      generatedAtIso: MOCK_TIMESTAMP,
      conciseAssessment:
        'Restarting workers left the incident completely unresolved. Workers came back online with the exact same v1.8.0 schema validator while reservation-service v2.15.0 continued emitting incompatible v2.0 payloads. By 15:00, 1,292 reservations remain stranded in queue (p95 age 765s), generating 2,742 validation failures across 1,292 unique messages per 60s and delaying 1,236 cumulative reservations past the 30s SLA.',
      observedFacts: [
        {
          text: 'At 07:30 after worker restarts, v1.8.0 workers immediately resumed rejecting v2.0 payloads as backlog climbed to 572 messages (p95 age 340s) and 1,182 validation failures / 60s.',
          citationIds: ['ev-out-rwo-450'],
        },
        {
          text: 'By 12:00, outstanding confirmations reached 1,004 messages (p95 age 595s) and validation failures hit 2,118 attempts across 1,004 unique messages.',
          citationIds: ['ev-out-rwo-720'],
        },
        {
          text: 'At 15:00, only 651 native v1.0 confirmations delivered out of 1,943 accepted reservations, leaving 1,292 unconfirmed (p95 age 765s, 2,742 failures / 60s, 1,236 delayed > 30s).',
          citationIds: ['ev-out-rwo-900'],
        },
      ],
      rankedHypotheses: [
        {
          rank: 1,
          statement:
            'Stateless worker restarts cannot repair a deterministic contract incompatibility between active producer v2.15.0 and worker v1.8.0.',
          likelihood: 'Primary',
          supportingCitationIds: ['ev-out-rwo-450', 'ev-out-rwo-720', 'ev-out-rwo-900'],
        },
      ],
      alternativeExplanations: [],
      missingInformation: [],
      confidence: {
        level: 'High',
        justification:
          'Backlog and validation failures climbed linearly through 15:00 with unchanged schema rejection signatures.',
      },
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-quarantine-replay',
          rationale:
            'Immediate next response required: restarting workers left the schema mismatch unchanged; rolling back reservation-service to v2.14.2, quarantining failed v2.0 messages, and running an adapted FIFO replay repairs both live traffic and stranded messages.',
          keyRisk:
            'Unconfirmed bookings will continue accumulating (1,292 unconfirmed at 15:00) while v2.15.0 remains deployed without rollback and replay.',
        },
      ],
      verificationChecks: [
        'Propose rolling back reservation-service v2.15.0, quarantining all v2.0 events, adapting schemas, and replaying with reservationId idempotency.',
      ],
      stakeholderUpdate:
        'Restarting confirmation workers did not resolve email delays, and affected bookings remain unconfirmed (~73% of volume; 1,292 queued at 15:00). Engineering recommends rolling back the 01:30 producer release, quarantining affected messages, and executing a schema-adaptation replay.',
    },
  },
};
