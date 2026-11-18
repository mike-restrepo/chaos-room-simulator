import { describe, expect, it } from 'vitest';
import {
  ALL_SCENARIOS,
  buildSnapshot,
  CHECKPOINT_TIMES,
  clampSimulationTime,
  computeCanonicalCacheKey,
  deliverIncident003Message,
  fnv1aHex,
  getNextCheckpointTarget,
  INCIDENT_001_DEFINITION,
  INCIDENT_002_DEFINITION,
  INCIDENT_003_DEFINITION,
  MAX_SIMULATION_SECONDS,
  serializeEvidenceForAI,
  TICK_STEP_SECONDS,
  validateAnalysisResult,
  type Incident003DeliveryState,
  type Incident003MessageItem,
} from '../src/index.js';

function parseIntToken(text: string, regex: RegExp, label: string): number {
  const match = text.match(regex);
  if (!match?.[1]) {
    throw new Error(`Could not extract integer for ${label} from: ${text}`);
  }
  return Number.parseInt(match[1].replace(/,/g, ''), 10);
}

describe('Scenario 3 (incident-003): “A release leaves confirmations behind”', () => {
  it('guarantees deterministic execution across multiple runs', () => {
    const snap1 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    const snap2 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));
    expect(fnv1aHex(JSON.stringify(snap1))).toBe(fnv1aHex(JSON.stringify(snap2)));
  });

  it('enforces the 06:00 decision gate when no intervention is selected', () => {
    const clampedPastEvidence = clampSimulationTime(600, INCIDENT_003_DEFINITION, null);
    expect(clampedPastEvidence).toBe(CHECKPOINT_TIMES.evidence);

    const atEvidence = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    expect(atEvidence.awaitingInterventionDecision).toBe(true);

    const targetAtEvidence = getNextCheckpointTarget(
      CHECKPOINT_TIMES.evidence,
      INCIDENT_003_DEFINITION,
      null,
    );
    expect(targetAtEvidence.blockedByDecision).toBe(true);
    expect(targetAtEvidence.targetSeconds).toBe(CHECKPOINT_TIMES.evidence);
  });

  it('keeps compatible v1.0 events delivering while incompatible v2.0 cohort stalls under healthy infra', () => {
    const alertSnap = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: null,
    });
    expect(alertSnap.measures.reservationErrorRate).toBe(0);
    expect(alertSnap.measures.apiP95LatencyMs).toBeLessThan(150);
    expect(alertSnap.measures.activeDbConnections).toBe(21);
    expect(alertSnap.measures.providerP95LatencyMs).toBeLessThanOrEqual(125);
    expect(alertSnap.measures.acceptedReservationsTotal).toBe(359);
    expect(alertSnap.measures.deliveredConfirmationsTotal).toBe(219);
    expect(alertSnap.measures.confirmationBacklog).toBe(140);
    expect(alertSnap.measures.affectedReservations).toBe(84);
    expect(alertSnap.measures.queueAgeP95Seconds).toBe(85);
    expect(alertSnap.measures.validationErrorAttempts).toBe(246);
    expect(alertSnap.measures.validationErrorUniqueMessages).toBe(140);

    const evidenceSnap = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    expect(evidenceSnap.measures.reservationErrorRate).toBe(0);
    expect(evidenceSnap.measures.apiP95LatencyMs).toBeLessThan(150);
    expect(evidenceSnap.measures.activeDbConnections).toBe(21);
    expect(evidenceSnap.measures.providerP95LatencyMs).toBeLessThanOrEqual(125);
    expect(evidenceSnap.measures.acceptedReservationsTotal).toBe(755);
    expect(evidenceSnap.measures.deliveredConfirmationsTotal).toBe(327);
    expect(evidenceSnap.measures.confirmationBacklog).toBe(428);
    expect(evidenceSnap.measures.affectedReservations).toBe(372);
    expect(evidenceSnap.measures.queueAgeP95Seconds).toBe(255);
    expect(evidenceSnap.measures.validationErrorAttempts).toBe(870);
    expect(evidenceSnap.measures.validationErrorUniqueMessages).toBe(428);
  });

  it('supports backward scrubbing and branch switching with zero leaked state', () => {
    const snapRestart900 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-restart-workers-only',
    });
    expect(snapRestart900.measures.confirmationBacklog).toBe(1292);

    const snapScrubbedBack = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    const snapCleanEvidence = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    expect(snapScrubbedBack.measures).toEqual(snapCleanEvidence.measures);
    expect(snapScrubbedBack.timelineSeries).toEqual(snapCleanEvidence.timelineSeries);
  });

  it('produces three distinct 15:00 outcomes: full recovery, partial cohort recovery, and unresolved stall', () => {
    const rqr = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    const rpo = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-rollback-producer-only',
    });
    const rwo = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-restart-workers-only',
    });

    // Full recovery via rollback + quarantine + adapted replay
    expect(rqr.measures.acceptedReservationsTotal).toBe(1943);
    expect(rqr.measures.deliveredConfirmationsTotal).toBe(1943);
    expect(rqr.measures.confirmationBacklog).toBe(0);
    expect(rqr.measures.quarantinedBacklog).toBe(0);
    expect(rqr.measures.replayedDeliveries).toBe(436);
    expect(rqr.measures.queueAgeP95Seconds).toBe(0);
    expect(rqr.measures.validationErrorAttempts).toBe(0);
    expect(rqr.measures.validationErrorUniqueMessages).toBe(0);
    expect(rqr.measures.affectedReservations).toBe(436);

    // Partial recovery via producer rollback only (new traffic fixed; old 436 cohort stranded)
    expect(rpo.measures.acceptedReservationsTotal).toBe(1943);
    expect(rpo.measures.deliveredConfirmationsTotal).toBe(1507);
    expect(rpo.measures.confirmationBacklog).toBe(436);
    expect(rpo.measures.quarantinedBacklog).toBe(0);
    expect(rpo.measures.replayedDeliveries).toBe(0);
    expect(rpo.measures.queueAgeP95Seconds).toBe(795);
    expect(rpo.measures.validationErrorAttempts).toBe(950);
    expect(rpo.measures.validationErrorUniqueMessages).toBe(436);
    expect(rpo.measures.affectedReservations).toBe(436);

    // Unresolved worker restart (same incompatible validator continues failing)
    expect(rwo.measures.acceptedReservationsTotal).toBe(1943);
    expect(rwo.measures.deliveredConfirmationsTotal).toBe(651);
    expect(rwo.measures.confirmationBacklog).toBe(1292);
    expect(rwo.measures.quarantinedBacklog).toBe(0);
    expect(rwo.measures.replayedDeliveries).toBe(0);
    expect(rwo.measures.queueAgeP95Seconds).toBe(765);
    expect(rwo.measures.validationErrorAttempts).toBe(2742);
    expect(rwo.measures.validationErrorUniqueMessages).toBe(1292);
    expect(rwo.measures.affectedReservations).toBe(1236);
  });

  it('enforces exact conservation, quarantine accounting, original queue age, and duplicate-safe replay across all ticks', () => {
    const branches = [
      'act-rollback-quarantine-replay',
      'act-rollback-producer-only',
      'act-restart-workers-only',
    ] as const;

    for (const branch of branches) {
      let prevAccepted = 0;
      let prevDelivered = 0;
      let prevAffected = 0;
      for (let t = 0; t <= MAX_SIMULATION_SECONDS; t += TICK_STEP_SECONDS) {
        const snap = buildSnapshot({
          scenario: INCIDENT_003_DEFINITION,
          simTimeSeconds: t,
          selectedInterventionId: branch,
        });
        const accepted = snap.measures.acceptedReservationsTotal ?? 0;
        const delivered = snap.measures.deliveredConfirmationsTotal ?? 0;
        const outstanding = snap.measures.confirmationBacklog;
        const quarantined = snap.measures.quarantinedBacklog ?? 0;

        // Exact conservation: every accepted reservation is either delivered or outstanding
        expect(accepted).toBe(delivered + outstanding);
        expect(quarantined).toBeLessThanOrEqual(outstanding);
        expect(accepted).toBeGreaterThanOrEqual(prevAccepted);
        expect(delivered).toBeGreaterThanOrEqual(prevDelivered);
        expect(snap.measures.affectedReservations).toBeGreaterThanOrEqual(prevAffected);

        prevAccepted = accepted;
        prevDelivered = delivered;
        prevAffected = snap.measures.affectedReservations;
      }
    }

    // Quarantine does NOT zero confirmationBacklog and preserves original enqueuedAt for queue age
    const quarantineSnap390 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: 390,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    expect(quarantineSnap390.measures.quarantinedBacklog).toBe(436);
    expect(quarantineSnap390.measures.confirmationBacklog).toBe(436);
    expect(quarantineSnap390.measures.queueAgeP95Seconds).toBe(285);
    expect(quarantineSnap390.measures.replayedDeliveries).toBe(0);

    // Mid-replay at 07:30 (450s): 220 replayed, 216 quarantined & still counted in backlog, 0 val fails
    const replaySnap450 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: 450,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    expect(replaySnap450.measures.replayedDeliveries).toBe(220);
    expect(replaySnap450.measures.quarantinedBacklog).toBe(216);
    expect(replaySnap450.measures.confirmationBacklog).toBe(216);
    expect(replaySnap450.measures.queueAgeP95Seconds).toBe(210);
    expect(replaySnap450.measures.validationErrorAttempts).toBe(0);

    // Replay finishes completely with 0 duplicates (1507 native + 436 replayed = 1943 unique)
    const replayDone505 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: 505,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    expect(replayDone505.measures.confirmationBacklog).toBe(0);
    expect(replayDone505.measures.quarantinedBacklog).toBe(0);
    expect(replayDone505.measures.replayedDeliveries).toBe(436);
    expect(replayDone505.measures.deliveredConfirmationsTotal).toBe(
      replayDone505.measures.acceptedReservationsTotal,
    );
  });

  it('verifies authored evidence numerical values and debrief comparisons match engine snapshots', () => {
    const getItem = (branch: string | null, id: string) => {
      const item = INCIDENT_003_DEFINITION.buildEvidenceCatalog(branch).find((e) => e.id === id);
      if (!item) throw new Error(`Missing evidence item ${id} for branch ${branch}`);
      return item;
    };

    const snapAt = (branch: string | null, simTime: number) =>
      buildSnapshot({
        scenario: INCIDENT_003_DEFINITION,
        simTimeSeconds: simTime,
        selectedInterventionId: branch,
      });

    // Base evidence items
    const ev120 = getItem(null, 'ev-met-120');
    const s120 = snapAt(null, ev120.simTimeSeconds);
    expect(s120.measures.apiP95LatencyMs).toBe(
      parseIntToken(ev120.measureValue!, /p95:\s*(\d+)\s*ms/, 'ev-met-120 p95'),
    );
    expect(s120.measures.windowAttempts).toBe(
      parseIntToken(ev120.measureValue!, /(\d+)\s*\/\s*60s window/, 'ev-met-120 window attempts'),
    );
    expect(ev120.title).toContain('+22.2%');
    expect(ev120.detail).toContain('108 req/min');
    expect(ev120.detail).toContain('132 req/min');
    expect(ev120.detail).not.toContain('18%');
    expect(ev120.detail).not.toContain('121 ms');

    const ev180 = getItem(null, 'ev-met-180');
    const s180 = snapAt(null, ev180.simTimeSeconds);
    expect(s180.measures.confirmationBacklog).toBe(
      parseIntToken(ev180.measureValue!, /^([\d,]+)\s*messages/, 'ev-met-180 backlog'),
    );
    expect(s180.measures.queueAgeP95Seconds).toBe(
      parseIntToken(ev180.measureValue!, /p95 age:\s*(\d+)s/, 'ev-met-180 p95 age'),
    );
    expect(s180.measures.validationErrorAttempts).toBe(
      parseIntToken(ev180.measureValue!, /val fails:\s*([\d,]+)\/60s/, 'ev-met-180 val fails'),
    );
    expect(s180.measures.affectedReservations).toBe(
      parseIntToken(ev180.detail, /([\d,]+)\s*reservations delayed > 30s/, 'ev-met-180 affected'),
    );
    expect(s180.measures.deliveredConfirmationsTotal).toBe(
      parseIntToken(ev180.detail, /([\d,]+)\s*v1\.0 confirmations delivered/, 'ev-met-180 delivered'),
    );
    expect(s180.measures.acceptedReservationsTotal).toBe(
      parseIntToken(ev180.detail, /\(([\d,]+)\s*total accepted\)/, 'ev-met-180 accepted'),
    );

    const ev240 = getItem(null, 'ev-met-240');
    const s240 = snapAt(null, ev240.simTimeSeconds);
    expect(s240.measures.activeDbConnections).toBe(
      parseIntToken(ev240.measureValue!, /^(\d+)\s*\/\s*\d+/, 'ev-met-240 db pool'),
    );
    expect(s240.measures.providerP95LatencyMs).toBe(
      parseIntToken(ev240.measureValue!, /provider p95:\s*(\d+)\s*ms/, 'ev-met-240 provider p95'),
    );
    expect(s240.measures.reservationErrorRate).toBe(0);

    const ev360 = getItem(null, 'ev-met-360');
    const s360 = snapAt(null, ev360.simTimeSeconds);
    expect(s360.measures.confirmationBacklog).toBe(
      parseIntToken(ev360.measureValue!, /^([\d,]+)\s*messages/, 'ev-met-360 backlog'),
    );
    expect(s360.measures.queueAgeP95Seconds).toBe(
      parseIntToken(ev360.measureValue!, /p95 age:\s*(\d+)s/, 'ev-met-360 p95 age'),
    );
    expect(s360.measures.validationErrorAttempts).toBe(
      parseIntToken(ev360.measureValue!, /val fails:\s*([\d,]+)/, 'ev-met-360 val fails'),
    );
    expect(s360.measures.validationErrorUniqueMessages).toBe(
      parseIntToken(ev360.measureValue!, /\/\s*([\d,]+)\s*uniq/, 'ev-met-360 val uniq'),
    );
    expect(s360.measures.affectedReservations).toBe(
      parseIntToken(ev360.detail, /delayed > 30s:\s*([\d,]+)/, 'ev-met-360 affected'),
    );

    // Branch 1: act-rollback-quarantine-replay
    const rqr = 'act-rollback-quarantine-replay';
    const evRqr390 = getItem(rqr, 'ev-out-rqr-390');
    const sRqr390 = snapAt(rqr, evRqr390.simTimeSeconds);
    expect(sRqr390.measures.quarantinedBacklog).toBe(
      parseIntToken(evRqr390.measureValue!, /^([\d,]+)\s*quarantined/, 'ev-out-rqr-390 quarantined'),
    );
    expect(sRqr390.measures.confirmationBacklog).toBe(
      parseIntToken(evRqr390.measureValue!, /\(([\d,]+)\s*outstanding/, 'ev-out-rqr-390 backlog'),
    );
    expect(sRqr390.measures.queueAgeP95Seconds).toBe(
      parseIntToken(evRqr390.measureValue!, /p95 age:\s*(\d+)s/, 'ev-out-rqr-390 p95 age'),
    );

    const evRqr450 = getItem(rqr, 'ev-out-rqr-450');
    const sRqr450 = snapAt(rqr, evRqr450.simTimeSeconds);
    expect(sRqr450.measures.replayedDeliveries).toBe(
      parseIntToken(evRqr450.measureValue!, /^([\d,]+)\s*replayed/, 'ev-out-rqr-450 replayed'),
    );
    expect(sRqr450.measures.confirmationBacklog).toBe(
      parseIntToken(evRqr450.measureValue!, /\(([\d,]+)\s*outstanding/, 'ev-out-rqr-450 backlog'),
    );
    expect(sRqr450.measures.queueAgeP95Seconds).toBe(
      parseIntToken(evRqr450.measureValue!, /p95 age:\s*(\d+)s/, 'ev-out-rqr-450 p95 age'),
    );
    expect(sRqr450.measures.validationErrorAttempts).toBe(
      parseIntToken(evRqr450.measureValue!, /val fails:\s*(\d+)/, 'ev-out-rqr-450 val fails'),
    );

    const evRqr540 = getItem(rqr, 'ev-out-rqr-540');
    const sRqr540 = snapAt(rqr, evRqr540.simTimeSeconds);
    expect(sRqr540.measures.confirmationBacklog).toBe(
      parseIntToken(evRqr540.measureValue!, /^([\d,]+)\s*messages/, 'ev-out-rqr-540 backlog'),
    );
    expect(sRqr540.measures.replayedDeliveries).toBe(
      parseIntToken(evRqr540.measureValue!, /\(([\d,]+)\s*replayed/, 'ev-out-rqr-540 replayed'),
    );
    expect(sRqr540.measures.queueAgeP95Seconds).toBe(
      parseIntToken(evRqr540.measureValue!, /p95 age:\s*(\d+)s/, 'ev-out-rqr-540 p95 age'),
    );

    const evRqr900 = getItem(rqr, 'ev-out-rqr-900');
    const sRqr900 = snapAt(rqr, evRqr900.simTimeSeconds);
    expect(sRqr900.measures.confirmationBacklog).toBe(
      parseIntToken(evRqr900.measureValue!, /^([\d,]+)\s*messages/, 'ev-out-rqr-900 backlog'),
    );
    expect(sRqr900.measures.deliveredConfirmationsTotal).toBe(
      parseIntToken(evRqr900.measureValue!, /\(([\d,]+)\s*delivered/, 'ev-out-rqr-900 delivered'),
    );
    expect(sRqr900.measures.replayedDeliveries).toBe(
      parseIntToken(evRqr900.measureValue!, /([\d,]+)\s*replayed/, 'ev-out-rqr-900 replayed'),
    );
    expect(sRqr900.measures.affectedReservations).toBe(
      parseIntToken(evRqr900.detail, /delayed > 30s=([\d,]+)/, 'ev-out-rqr-900 affected'),
    );

    // Branch 2: act-rollback-producer-only
    const rpo = 'act-rollback-producer-only';
    for (const evId of ['ev-out-rpo-450', 'ev-out-rpo-600', 'ev-out-rpo-900'] as const) {
      const ev = getItem(rpo, evId);
      const s = snapAt(rpo, ev.simTimeSeconds);
      expect(s.measures.confirmationBacklog).toBe(
        parseIntToken(ev.measureValue!, /^([\d,]+)\s*messages/, `${evId} backlog`),
      );
      expect(s.measures.queueAgeP95Seconds).toBe(
        parseIntToken(ev.measureValue!, /p95 age:\s*(\d+)s/, `${evId} p95 age`),
      );
      expect(s.measures.validationErrorAttempts).toBe(
        parseIntToken(ev.measureValue!, /val fails:\s*([\d,]+)/, `${evId} val fails`),
      );
      expect(s.measures.validationErrorUniqueMessages).toBe(
        parseIntToken(ev.measureValue!, /\/\s*([\d,]+)\s*uniq/, `${evId} val uniq`),
      );
    }

    // Branch 3: act-restart-workers-only
    const rwo = 'act-restart-workers-only';
    for (const evId of ['ev-out-rwo-450', 'ev-out-rwo-720', 'ev-out-rwo-900'] as const) {
      const ev = getItem(rwo, evId);
      const s = snapAt(rwo, ev.simTimeSeconds);
      expect(s.measures.confirmationBacklog).toBe(
        parseIntToken(ev.measureValue!, /^([\d,]+)\s*messages/, `${evId} backlog`),
      );
      expect(s.measures.queueAgeP95Seconds).toBe(
        parseIntToken(ev.measureValue!, /p95 age:\s*(\d+)s/, `${evId} p95 age`),
      );
      expect(s.measures.validationErrorAttempts).toBe(
        parseIntToken(ev.measureValue!, /val fails:\s*([\d,]+)/, `${evId} val fails`),
      );
      expect(s.measures.validationErrorUniqueMessages).toBe(
        parseIntToken(ev.measureValue!, /\/\s*([\d,]+)\s*uniq/, `${evId} val uniq`),
      );
    }

    // Verify 15:00 evidence gating: absent at 14:55 (895s), visible at 15:00 (900s)
    for (const [branchId, evId] of [
      ['act-rollback-quarantine-replay', 'ev-out-rqr-900'],
      ['act-rollback-producer-only', 'ev-out-rpo-900'],
      ['act-restart-workers-only', 'ev-out-rwo-900'],
    ] as const) {
      expect(snapAt(branchId, 895).visibleEvidence.some((e) => e.id === evId)).toBe(false);
      expect(snapAt(branchId, 900).visibleEvidence.some((e) => e.id === evId)).toBe(true);
    }

    // Verify debrief.outcomeComparisons match 15:00 engine snapshots for every branch
    for (const [branchId, comp] of Object.entries(INCIDENT_003_DEFINITION.debrief.outcomeComparisons)) {
      const finalSnap = snapAt(branchId, CHECKPOINT_TIMES.outcome);
      expect(comp.finalErrorRatePercent).toBe(finalSnap.measures.reservationErrorRate * 100);
      expect(comp.finalP95LatencyMs).toBe(finalSnap.measures.apiP95LatencyMs);
      expect(comp.totalAffectedReservations).toBe(finalSnap.measures.affectedReservations);
      expect(comp.finalBacklog).toBe(finalSnap.measures.confirmationBacklog);
      expect(comp.finalQueueAgeP95Seconds).toBe(finalSnap.measures.queueAgeP95Seconds);
      expect(comp.finalValidationErrorAttempts).toBe(finalSnap.measures.validationErrorAttempts);
      expect(comp.finalValidationErrorUniqueMsgs).toBe(
        finalSnap.measures.validationErrorUniqueMessages,
      );
      expect(comp.finalQuarantinedBacklog).toBe(finalSnap.measures.quarantinedBacklog);
      expect(comp.finalReplayedDeliveries).toBe(finalSnap.measures.replayedDeliveries);
      expect(comp.finalDeliveredConfirmations).toBe(
        finalSnap.measures.deliveredConfirmationsTotal,
      );
      expect(comp.finalAcceptedReservations).toBe(finalSnap.measures.acceptedReservationsTotal);
    }
  });

  it('prevents chart clipping across every branch trajectory', () => {
    const chartConfig = INCIDENT_003_DEFINITION.chartConfig!;
    const branches = [
      'act-rollback-quarantine-replay',
      'act-rollback-producer-only',
      'act-restart-workers-only',
    ] as const;

    for (const branch of branches) {
      const snap = buildSnapshot({
        scenario: INCIDENT_003_DEFINITION,
        simTimeSeconds: CHECKPOINT_TIMES.outcome,
        selectedInterventionId: branch,
      });
      for (const pt of snap.timelineSeries) {
        expect(pt.confirmationBacklog).toBeLessThanOrEqual(1400);
        expect(pt.validationErrorAttempts ?? 0).toBeLessThanOrEqual(3000);
        expect(chartConfig.getSeries1Ratio(pt)).toBeLessThan(1);
        expect(chartConfig.getSeries1Ratio(pt)).toBeGreaterThanOrEqual(0);
        expect(chartConfig.getSeries2Ratio(pt)).toBeLessThan(1);
        expect(chartConfig.getSeries2Ratio(pt)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps pre-assessment title, journey summary, and 06:00 banner purely observational without root-cause spoilers', () => {
    expect(INCIDENT_003_DEFINITION.symptomTitle).toBe('A release leaves confirmations behind');
    expect(INCIDENT_003_DEFINITION.symptomTitle.toLowerCase()).not.toContain('schema');
    expect(INCIDENT_003_DEFINITION.symptomTitle.toLowerCase()).not.toContain('contract');

    expect(INCIDENT_003_DEFINITION.oneSentenceJourney).not.toMatch(
      /schemaVersion|reservation\.id|SchemaValidationError|schema breakage|contract change/i,
    );

    const evidenceSnap = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    expect(evidenceSnap.customerImpactBanner).toContain('428 confirmations remain pending');
    expect(evidenceSnap.customerImpactBanner).toContain('870 worker validation failures');
    expect(evidenceSnap.customerImpactBanner).toContain('reservation API stays 100% operational');
    expect(evidenceSnap.customerImpactBanner).not.toMatch(
      /schemaVersion|reservation\.id|v2\.15|contract breakage/i,
    );
  });

  it('produces isolated canonical AI serialization packets and distinct cache keys across scenarios', () => {
    const snap1 = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    const snap2 = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    const snap3 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });

    const packet3 = serializeEvidenceForAI(INCIDENT_003_DEFINITION, snap3);
    expect(packet3.incidentId).toBe('incident-003');
    expect(packet3.checkpoint).toBe('evidence');
    expect(packet3.visibleEvidence.some((e) => e.id === 'ev-trc-210')).toBe(true);

    const cacheKeyOptions = {
      modelVersion: 'gemini-2.5-pro',
      promptVersion: '1.0.0',
      schemaVersion: '1.0.0',
    };
    const key1 = computeCanonicalCacheKey(
      serializeEvidenceForAI(INCIDENT_001_DEFINITION, snap1),
      cacheKeyOptions,
    );
    const key2 = computeCanonicalCacheKey(
      serializeEvidenceForAI(INCIDENT_002_DEFINITION, snap2),
      cacheKeyOptions,
    );
    const key3 = computeCanonicalCacheKey(packet3, cacheKeyOptions);
    expect(key3).toContain('incident-003');
    expect(key3).not.toBe(key1);
    expect(key3).not.toBe(key2);
  });

  it('validates all 15 authored assessments across Scenarios 1, 2, and 3 against live snapshots', () => {
    expect(ALL_SCENARIOS.length).toBe(3);

    for (const scenario of ALL_SCENARIOS) {
      const alertSnap = buildSnapshot({
        scenario,
        simTimeSeconds: CHECKPOINT_TIMES.alert,
        selectedInterventionId: null,
      });
      const alertCheck = validateAnalysisResult(scenario.walkthroughs.alert, alertSnap);
      expect(alertCheck.errors, `${scenario.incidentId} alert validation`).toEqual([]);
      expect(alertCheck.valid).toBe(true);

      const evidenceSnap = buildSnapshot({
        scenario,
        simTimeSeconds: CHECKPOINT_TIMES.evidence,
        selectedInterventionId: null,
      });
      const evidenceCheck = validateAnalysisResult(scenario.walkthroughs.evidence, evidenceSnap);
      expect(evidenceCheck.errors, `${scenario.incidentId} evidence validation`).toEqual([]);
      expect(evidenceCheck.valid).toBe(true);

      for (const intervention of scenario.interventions) {
        const outcomeSnap = buildSnapshot({
          scenario,
          simTimeSeconds: CHECKPOINT_TIMES.outcome,
          selectedInterventionId: intervention.id,
        });
        const assessment = scenario.walkthroughs.outcomes[intervention.id];
        expect(assessment, `missing outcome assessment ${scenario.incidentId}/${intervention.id}`).toBeDefined();
        const outcomeCheck = validateAnalysisResult(assessment!, outcomeSnap);
        expect(
          outcomeCheck.errors,
          `${scenario.incidentId}/${intervention.id} outcome validation`,
        ).toEqual([]);
        expect(outcomeCheck.valid).toBe(true);
      }
    }
  });

  it('keeps future outcomes out of 06:00 states, serializeEvidenceForAI packets, and clock-gated stages across scrubs', () => {
    const forbiddenAt0600 = [
      '08:25',
      '2.5 simulated',
      '1,943',
      '1943',
      '436',
      '1,507',
      '1507',
      '1,292',
      '1292',
      '2,742',
      '2742',
      '572',
      '1,004',
      '1004',
    ];

    for (const selectedId of [null, 'act-rollback-quarantine-replay'] as const) {
      const snap360 = buildSnapshot({
        scenario: INCIDENT_003_DEFINITION,
        simTimeSeconds: CHECKPOINT_TIMES.evidence,
        selectedInterventionId: selectedId,
      });

      // Preserves all 3 legitimate intervention descriptions and qualified tradeoffs
      expect(snap360.availableInterventions.length).toBe(3);
      for (const opt of snap360.availableInterventions) {
        expect(opt.summary.length).toBeGreaterThan(20);
        expect(opt.immediateTradeoff.length).toBeGreaterThan(20);
        expect('stageSchedule' in opt).toBe(false);
      }

      const interventionsJson = JSON.stringify(snap360.availableInterventions);
      for (const token of forbiddenAt0600) {
        expect(interventionsJson, `06:00 availableInterventions leaked "${token}"`).not.toContain(
          token,
        );
      }

      const packet360 = serializeEvidenceForAI(INCIDENT_003_DEFINITION, snap360);
      expect(packet360.visibleInterventions.length).toBe(3);
      for (const vi of packet360.visibleInterventions) {
        expect(vi.summary.length).toBeGreaterThan(20);
        expect(vi.immediateTradeoff.length).toBeGreaterThan(20);
      }
      const packetJson = JSON.stringify(packet360);
      for (const token of forbiddenAt0600) {
        expect(packetJson, `06:00 CanonicalAIPacket leaked "${token}"`).not.toContain(token);
      }
    }

    // Clock-gated stages on active branch unlock progressively and revert cleanly on backward scrub
    const snap390 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: 390,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    const rqr390 = snap390.availableInterventions.find(
      (i) => i.id === 'act-rollback-quarantine-replay',
    )!;
    const rpo390 = snap390.availableInterventions.find(
      (i) => i.id === 'act-rollback-producer-only',
    )!;
    expect(rqr390.stages![0]).toContain('06:00–06:30');
    expect(rqr390.stages![0]).toContain('436');
    expect(rqr390.stages![0]).toContain('quarantined all 436');
    expect(rqr390.stages![1]).toContain('(Planned)');
    expect(rqr390.stages![1]).toContain('Initial replay phase (Planned)');
    expect(rqr390.stages![1]).not.toMatch(/Quarantine incompatible/i);
    expect(rqr390.stages!.slice(1).join(' ')).not.toContain('08:25');
    expect(rqr390.stages!.slice(1).join(' ')).not.toContain('1,943');
    expect(rpo390.stages!.every((s) => !s.includes('06:00–06:30'))).toBe(true);

    const snap450 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: 450,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    const rqr450 = snap450.availableInterventions.find(
      (i) => i.id === 'act-rollback-quarantine-replay',
    )!;
    expect(rqr450.stages![1]).toContain('220/436');
    expect(rqr450.stages![2]).toContain('(Planned)');
    expect(rqr450.stages![2]).not.toContain('08:25');

    const snap540 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: 540,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    const rqr540 = snap540.availableInterventions.find(
      (i) => i.id === 'act-rollback-quarantine-replay',
    )!;
    expect(rqr540.stages![2]).toContain('08:25');
    expect(rqr540.stages![3]).toContain('(Planned)');
    expect(rqr540.stages![3]).not.toContain('1,943');

    const snap900 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: 900,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    const rqr900 = snap900.availableInterventions.find(
      (i) => i.id === 'act-rollback-quarantine-replay',
    )!;
    expect(rqr900.stages![3]).toContain('1,943/1,943');

    // Backward scrub from 15:00 to 06:00 removes all completed-stage facts
    const scrubbedBack360 = buildSnapshot({
      scenario: INCIDENT_003_DEFINITION,
      simTimeSeconds: 360,
      selectedInterventionId: 'act-rollback-quarantine-replay',
    });
    const rqrScrubbed = scrubbedBack360.availableInterventions.find(
      (i) => i.id === 'act-rollback-quarantine-replay',
    )!;
    expect(rqrScrubbed.stages!.every((s) => !s.includes('08:25') && !s.includes('1,943'))).toBe(true);
  });

  it('enforces reservationId-keyed duplicate safety directly without mutating eventId, enqueuedAt, or backlog accounting', () => {
    const queue: Incident003MessageItem[] = [
      {
        eventId: 'evt-0100',
        reservationId: 'res-0100',
        schemaVersion: '2.0',
        enqueuedAt: 100,
        quarantined: true,
        quarantinedAt: 365,
        replayed: false,
        completedAt: null,
      },
    ];
    const deliveryState: Incident003DeliveryState = {
      deliveredReservationIds: new Set<string>(),
      deliveredConfirmationsTotal: 0,
      replayedDeliveriesTotal: 0,
      deliveredMsgIdsInTick: [],
    };

    const countOutstandingAt = (t: number) =>
      queue.filter((m) => m.enqueuedAt <= t && (m.completedAt === null || m.completedAt > t)).length;

    expect(countOutstandingAt(400)).toBe(1);

    // First adapted replay delivers cleanly while preserving original eventId, reservationId, and enqueuedAt
    const first = deliverIncident003Message(queue[0]!, 400, true, deliveryState);
    expect(first).toBe(true);
    expect(deliveryState.deliveredConfirmationsTotal).toBe(1);
    expect(deliveryState.replayedDeliveriesTotal).toBe(1);
    expect(deliveryState.deliveredMsgIdsInTick).toEqual(['evt-0100']);
    expect(queue[0]!.eventId).toBe('evt-0100');
    expect(queue[0]!.reservationId).toBe('res-0100');
    expect(queue[0]!.enqueuedAt).toBe(100);
    expect(countOutstandingAt(400)).toBe(0);

    // Repeating delivery of the same original event (even with a distinct message copy sharing reservationId) is suppressed
    deliveryState.deliveredMsgIdsInTick = [];
    const duplicateReplayCopy: Incident003MessageItem = {
      ...queue[0]!,
      quarantined: true,
      replayed: false,
      completedAt: null,
    };
    const duplicateResult = deliverIncident003Message(duplicateReplayCopy, 405, true, deliveryState);
    expect(duplicateResult).toBe(false);
    expect(deliveryState.deliveredConfirmationsTotal).toBe(1);
    expect(deliveryState.replayedDeliveriesTotal).toBe(1);
    expect(deliveryState.deliveredMsgIdsInTick).toEqual([]);
    expect(duplicateReplayCopy.eventId).toBe('evt-0100');
    expect(duplicateReplayCopy.reservationId).toBe('res-0100');
    expect(duplicateReplayCopy.enqueuedAt).toBe(100);
    expect(countOutstandingAt(405)).toBe(0);

    // Repeating replay when a native v1.0 confirmation already delivered for the same reservationId is also ignored
    const nativeMsg: Incident003MessageItem = {
      eventId: 'evt-0101',
      reservationId: 'res-0101',
      schemaVersion: '1.0',
      enqueuedAt: 105,
      quarantined: false,
      quarantinedAt: null,
      replayed: false,
      completedAt: null,
    };
    queue.push(nativeMsg);
    expect(deliverIncident003Message(nativeMsg, 105, false, deliveryState)).toBe(true);
    expect(deliveryState.deliveredConfirmationsTotal).toBe(2);
    expect(deliveryState.replayedDeliveriesTotal).toBe(1);

    const lateDuplicateReplay = deliverIncident003Message(
      { ...nativeMsg, schemaVersion: '2.0', completedAt: null },
      410,
      true,
      deliveryState,
    );
    expect(lateDuplicateReplay).toBe(false);
    expect(deliveryState.deliveredConfirmationsTotal).toBe(2);
    expect(deliveryState.replayedDeliveriesTotal).toBe(1);
    expect(countOutstandingAt(410)).toBe(0);
  });

  it('keeps Scenario 3 assessments and walkthrough recommendations accurate without premature execution claims', () => {
    const wt = INCIDENT_003_DEFINITION.walkthroughs;

    // 06:00 evidence walkthrough frames rollback/replay as recommendation and omits ~2.5 simulated / 08:25
    expect(wt.evidence.stakeholderUpdate).toMatch(/recommend/i);
    expect(wt.evidence.stakeholderUpdate).not.toMatch(/We are rolling back/i);
    expect(JSON.stringify(wt.evidence)).not.toContain('2.5 simulated');
    expect(JSON.stringify(wt.evidence)).not.toContain('08:25');
    expect(JSON.stringify(wt.evidence)).not.toContain('18%');

    // Outcome for rollback-only recommends the follow-up quarantine+replay response and does not say "permanently"
    const rpo = wt.outcomes['act-rollback-producer-only']!;
    expect(rpo.recommendedInterventions.map((r) => r.interventionId)).toEqual([
      'act-rollback-quarantine-replay',
    ]);
    expect(rpo.stakeholderUpdate).toMatch(/proposes/i);
    expect(rpo.stakeholderUpdate).not.toMatch(/Engineering is preparing/i);
    expect(JSON.stringify(rpo)).not.toMatch(/permanently/i);

    // Outcome for restart-workers-only recommends full rollback+quarantine+replay and does not claim it is executing
    const rwo = wt.outcomes['act-restart-workers-only']!;
    expect(rwo.recommendedInterventions.map((r) => r.interventionId)).toEqual([
      'act-rollback-quarantine-replay',
    ]);
    expect(rwo.stakeholderUpdate).toMatch(/recommends rolling back/i);
    expect(rwo.stakeholderUpdate).not.toMatch(/Engineering is executing/i);

    // Debrief avoids "permanently" and "+18%" and documents reservationId-keyed idempotency accurately
    const debriefJson = JSON.stringify(INCIDENT_003_DEFINITION.debrief);
    expect(debriefJson).not.toMatch(/permanently/i);
    expect(debriefJson).not.toContain('18%');
    expect(debriefJson).toContain('+22.2%');
    expect(debriefJson).toContain('reservationId');
  });
});
