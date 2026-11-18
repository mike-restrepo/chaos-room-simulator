import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  CHECKPOINT_TIMES,
  clampSimulationTime,
  computeCanonicalCacheKey,
  fnv1aHex,
  getNextCheckpointTarget,
  INCIDENT_002_DEFINITION,
  serializeEvidenceForAI,
} from '../src/index.js';

describe('Scenario 2 (incident-002): “Reservations succeed, confirmations stall”', () => {
  it('guarantees deterministic execution across multiple runs', () => {
    const snap1 = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    const snap2 = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));
    expect(fnv1aHex(JSON.stringify(snap1))).toBe(fnv1aHex(JSON.stringify(snap2)));
  });

  it('enforces 06:00 decision gate when no intervention is selected', () => {
    const clampedPastEvidence = clampSimulationTime(600, INCIDENT_002_DEFINITION, null);
    expect(clampedPastEvidence).toBe(CHECKPOINT_TIMES.evidence);

    const targetAtEvidence = getNextCheckpointTarget(
      CHECKPOINT_TIMES.evidence,
      INCIDENT_002_DEFINITION,
      null,
    );
    expect(targetAtEvidence.blockedByDecision).toBe(true);
    expect(targetAtEvidence.targetSeconds).toBe(CHECKPOINT_TIMES.evidence);
  });

  it('preserves upstream reservation health (0% errors) while confirmations stall', () => {
    // Alert checkpoint (03:00)
    const alertSnap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: null,
    });
    expect(alertSnap.measures.reservationErrorRate).toBe(0);
    expect(alertSnap.measures.apiP95LatencyMs).toBeLessThan(150);
    expect(alertSnap.measures.confirmationBacklog).toBeGreaterThan(50);
    expect(alertSnap.measures.retryAmplification).toBeGreaterThan(2.0);
    expect(alertSnap.measures.providerP95LatencyMs).toBeGreaterThanOrEqual(2500);

    // Evidence checkpoint (06:00)
    const evidenceSnap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    expect(evidenceSnap.measures.reservationErrorRate).toBe(0);
    expect(evidenceSnap.measures.apiP95LatencyMs).toBeLessThan(150);
    expect(evidenceSnap.measures.confirmationBacklog).toBeGreaterThanOrEqual(150);
    expect(evidenceSnap.measures.retryAmplification).toBeGreaterThanOrEqual(3.5);
    expect(evidenceSnap.measures.affectedReservations).toBeGreaterThan(100);
  });

  it('verifies distinct causal outcomes across the three interventions at 15:00', () => {
    // 1. Backoff + circuit breaker recovers provider and drains queue
    const backoffSnap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-backoff-circuit-breaker',
    });

    // 2. Increase concurrency backfires and worsens provider failure
    const concurrencySnap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-increase-concurrency',
    });

    // 3. Observe leaves incident unresolved
    const observeSnap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-observe',
    });

    expect(backoffSnap.severity).toBe('resolved');
    expect(backoffSnap.measures.confirmationBacklog).toBeLessThanOrEqual(2);
    expect(backoffSnap.measures.providerP95LatencyMs).toBeLessThan(200);
    expect(backoffSnap.measures.retryAmplification).toBeLessThanOrEqual(1.2);

    expect(concurrencySnap.severity).toBe('critical');
    expect(concurrencySnap.measures.confirmationBacklog).toBeGreaterThan(320);
    expect(concurrencySnap.measures.retryAmplification).toBeGreaterThan(5.0);
    expect(concurrencySnap.measures.providerP95LatencyMs).toBeGreaterThan(3500);

    expect(observeSnap.severity).toBe('high');
    expect(observeSnap.measures.confirmationBacklog).toBeGreaterThan(250);
    expect(observeSnap.measures.retryAmplification).toBeGreaterThan(3.0);
    expect(observeSnap.measures.affectedReservations).toBeGreaterThan(300);

    // Verify debrief agreement with 15:00 snapshot measures
    for (const [branchId, debriefItem] of Object.entries(
      INCIDENT_002_DEFINITION.debrief.outcomeComparisons,
    )) {
      const snap = buildSnapshot({
        scenario: INCIDENT_002_DEFINITION,
        simTimeSeconds: CHECKPOINT_TIMES.outcome,
        selectedInterventionId: branchId,
      });
      expect(debriefItem.totalAffectedReservations).toBe(snap.measures.affectedReservations);
      expect(debriefItem.finalErrorRatePercent).toBe(
        Number((snap.measures.reservationErrorRate * 100).toFixed(1)),
      );
      expect(debriefItem.finalP95LatencyMs).toBe(snap.measures.apiP95LatencyMs);
      expect(debriefItem.finalBacklog).toBe(snap.measures.confirmationBacklog);
      expect(debriefItem.finalRetryAmplification).toBe(snap.measures.retryAmplification);
      expect(debriefItem.finalProviderP95Ms).toBe(snap.measures.providerP95LatencyMs);
      expect(debriefItem.finalQueueAgeP95Seconds).toBe(snap.measures.queueAgeP95Seconds);
    }
  });

  it('validates all evidence citations across all 5 authored walkthroughs', () => {
    const { walkthroughs } = INCIDENT_002_DEFINITION;

    // Alert walkthrough
    const alertCatalog = INCIDENT_002_DEFINITION.buildEvidenceCatalog(null).filter(
      (e) => e.simTimeSeconds <= CHECKPOINT_TIMES.alert,
    );
    const alertIds = new Set(alertCatalog.map((e) => e.id));
    expect(walkthroughs.alert.recommendedInterventions).toHaveLength(0); // MUST be empty at Alert!
    expect(walkthroughs.alert.verificationChecks.length).toBeGreaterThan(0);
    for (const fact of walkthroughs.alert.observedFacts) {
      for (const id of fact.citationIds) {
        expect(alertIds.has(id)).toBe(true);
      }
    }

    // Evidence walkthrough
    const evidenceCatalog = INCIDENT_002_DEFINITION.buildEvidenceCatalog(null).filter(
      (e) => e.simTimeSeconds <= CHECKPOINT_TIMES.evidence,
    );
    const evidenceIds = new Set(evidenceCatalog.map((e) => e.id));
    expect(walkthroughs.evidence.recommendedInterventions.length).toBeGreaterThan(0);
    for (const fact of walkthroughs.evidence.observedFacts) {
      for (const id of fact.citationIds) {
        expect(evidenceIds.has(id)).toBe(true);
      }
    }

    // Outcome walkthroughs
    for (const [actionId, outcomeWalkthrough] of Object.entries(walkthroughs.outcomes)) {
      const outcomeCatalog = INCIDENT_002_DEFINITION.buildEvidenceCatalog(actionId).filter(
        (e) => e.simTimeSeconds <= CHECKPOINT_TIMES.outcome,
      );
      const outcomeIds = new Set(outcomeCatalog.map((e) => e.id));
      for (const fact of outcomeWalkthrough.observedFacts) {
        for (const id of fact.citationIds) {
          expect(outcomeIds.has(id)).toBe(true);
        }
      }
    }
  });

  it('verifies reservation conservation, unique delivery, and zero discarded messages across all three branches', () => {
    // Total simulation ticks: 181 ticks (t=0..900, step 5s)
    // 24 ticks * 9 reqs + 157 ticks * 11 reqs = 216 + 1727 = 1943 total reservations
    const EXPECTED_TOTAL_ACCEPTED = 1943;

    // 1. Backoff & circuit breaker branch: queue fully drains
    const backoffSnap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: 900,
      selectedInterventionId: 'act-backoff-circuit-breaker',
    });
    expect(backoffSnap.measures.confirmationBacklog).toBe(0);
    expect(backoffSnap.measures.affectedReservations).toBe(661);
    const deliveredBackoff = EXPECTED_TOTAL_ACCEPTED - backoffSnap.measures.confirmationBacklog;
    expect(deliveredBackoff).toBe(1943);
    // Conservation: delivered + pending === accepted
    expect(deliveredBackoff + backoffSnap.measures.confirmationBacklog).toBe(EXPECTED_TOTAL_ACCEPTED);

    // 2. Increase concurrency branch: severe stall
    const concSnap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: 900,
      selectedInterventionId: 'act-increase-concurrency',
    });
    expect(concSnap.measures.confirmationBacklog).toBe(1287);
    expect(concSnap.measures.affectedReservations).toBe(1612);
    const deliveredConc = EXPECTED_TOTAL_ACCEPTED - concSnap.measures.confirmationBacklog;
    expect(deliveredConc).toBe(656);
    expect(deliveredConc + concSnap.measures.confirmationBacklog).toBe(EXPECTED_TOTAL_ACCEPTED);

    // 3. Observe branch: sustained stall
    const obsSnap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: 900,
      selectedInterventionId: 'act-observe',
    });
    expect(obsSnap.measures.confirmationBacklog).toBe(1071);
    expect(obsSnap.measures.affectedReservations).toBe(1612);
    const deliveredObs = EXPECTED_TOTAL_ACCEPTED - obsSnap.measures.confirmationBacklog;
    expect(deliveredObs).toBe(872);
    expect(deliveredObs + obsSnap.measures.confirmationBacklog).toBe(EXPECTED_TOTAL_ACCEPTED);
  });

  it('generates valid canonical AI serialization packets and cache keys for incident-002', () => {
    const snap = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-backoff-circuit-breaker',
    });
    const packet = serializeEvidenceForAI(INCIDENT_002_DEFINITION, snap);
    expect(packet.incidentId).toBe('incident-002');
    expect(packet.checkpoint).toBe('outcome');
    expect(packet.appliedInterventionId).toBe('act-backoff-circuit-breaker');

    const cacheKey = computeCanonicalCacheKey(packet, {
      modelVersion: 'gemini-2.5-pro',
      promptVersion: '1.0.0',
      schemaVersion: '1.0.0',
    });
    expect(cacheKey).toContain('incident-002');
    expect(cacheKey).toContain('act-backoff-circuit-breaker');
  });

  it('validates that chart domain accommodates all branch trajectories without clipping', () => {
    const chartConfig = INCIDENT_002_DEFINITION.chartConfig;
    expect(chartConfig.layout).toBe('stacked');
    expect(chartConfig.series1Ticks).toEqual([
      { ratio: 1.0, label: '1400 msgs' },
      { ratio: 0.5, label: '700 msgs' },
      { ratio: 0.0, label: '0 msgs' },
    ]);
    expect(chartConfig.series2Ticks).toEqual([
      { ratio: 1.0, label: '7.0x' },
      { ratio: 0.5, label: '4.0x' },
      { ratio: 0.0, label: '1.0x' },
    ]);

    const branches = ['act-backoff-circuit-breaker', 'act-increase-concurrency', 'act-observe'];
    for (const branchId of branches) {
      const snap = buildSnapshot({
        scenario: INCIDENT_002_DEFINITION,
        simTimeSeconds: CHECKPOINT_TIMES.outcome,
        selectedInterventionId: branchId,
      });

      for (const pt of snap.timelineSeries) {
        // Confirmation backlog must fit within the 0..1400 msgs domain without clipping
        expect(pt.confirmationBacklog).toBeLessThanOrEqual(1400);
        const r1 = chartConfig.getSeries1Ratio(pt);
        expect(r1).toBeGreaterThanOrEqual(0);
        expect(r1).toBeLessThan(1.0); // Never pins or flattens at top ceiling

        // Retry amplification must fit within the 1.0x..7.0x domain without clipping
        expect(pt.retryAmplification).toBeLessThanOrEqual(7.0);
        expect(pt.retryAmplification).toBeGreaterThanOrEqual(1.0);
        const r2 = chartConfig.getSeries2Ratio(pt);
        expect(r2).toBeGreaterThanOrEqual(0);
        expect(r2).toBeLessThan(1.0);
      }
    }
  });

  it('verifies authored numerical claims, citations, and timestamps against engine state', () => {
    const parseIntToken = (text: string, pattern: RegExp, label: string): number => {
      const match = text.match(pattern);
      expect(match?.[1], `Missing ${label} in "${text}"`).toBeTruthy();
      return Number(match![1]!.replace(/,/g, ''));
    };

    const parseFloatToken = (text: string, pattern: RegExp, label: string): number => {
      const match = text.match(pattern);
      expect(match?.[1], `Missing ${label} in "${text}"`).toBeTruthy();
      return Number(match![1]!);
    };

    const getAuthoredItem = (branchId: string | null, itemId: string) => {
      const item = INCIDENT_002_DEFINITION.buildEvidenceCatalog(branchId).find(
        (entry) => entry.id === itemId,
      );
      expect(item, `Expected evidence item ${itemId} for branch ${String(branchId)}`).toBeTruthy();
      return item!;
    };

    const getSnapAtItem = (branchId: string | null, simTimeSeconds: number) =>
      buildSnapshot({
        scenario: INCIDENT_002_DEFINITION,
        simTimeSeconds,
        selectedInterventionId: branchId,
      });

    // 1. Check all evidence items across branches: no pre-15:00 item claims "at 15:00"
    for (const branch of [null, 'act-backoff-circuit-breaker', 'act-increase-concurrency', 'act-observe']) {
      for (const item of INCIDENT_002_DEFINITION.buildEvidenceCatalog(branch)) {
        if (item.simTimeSeconds < CHECKPOINT_TIMES.outcome) {
          expect(item.title).not.toContain('at 15:00');
          expect(item.detail).not.toContain('at 15:00');
        }
      }
    }

    // 2. Compare authored pre-decision measurements directly against engine snapshots
    const ev090 = getAuthoredItem(null, 'ev-met-090');
    expect(ev090.measureName).toBe('provider_p95_latency_ms');
    const snap090 = getSnapAtItem(null, ev090.simTimeSeconds);
    expect(snap090.measures.providerP95LatencyMs).toBe(
      parseIntToken(ev090.measureValue!, /^(\d+)\s*ms/, 'ev-met-090 provider p95'),
    );

    const ev180 = getAuthoredItem(null, 'ev-met-180');
    expect(ev180.measureName).toBe('confirmation_queue_backlog');
    const snap180 = getSnapAtItem(null, ev180.simTimeSeconds);
    expect(snap180.measures.confirmationBacklog).toBe(
      parseIntToken(ev180.measureValue!, /^([\d,]+)\s*messages/, 'ev-met-180 backlog'),
    );
    expect(snap180.measures.queueAgeP95Seconds).toBe(
      parseIntToken(ev180.measureValue!, /p95 age:\s*(\d+)s/, 'ev-met-180 p95 age'),
    );
    expect(snap180.measures.affectedReservations).toBe(
      parseIntToken(ev180.detail, /(\d+)\s+reservations have experienced/, 'ev-met-180 affected'),
    );

    const ev240 = getAuthoredItem(null, 'ev-met-240');
    expect(ev240.measureName).toBe('inventory_db_active_connections');
    const snap240 = getSnapAtItem(null, ev240.simTimeSeconds);
    expect(snap240.measures.activeDbConnections).toBe(
      parseIntToken(ev240.measureValue!, /^(\d+)\s*\//, 'ev-met-240 active pool'),
    );
    expect(snap240.measures.maxDbConnections).toBe(
      parseIntToken(ev240.measureValue!, /\/\s*(\d+)/, 'ev-met-240 max pool'),
    );
    expect(snap240.measures.dbCpuPercent).toBe(
      parseIntToken(ev240.measureValue!, /CPU:\s*(\d+)%/, 'ev-met-240 db cpu'),
    );
    expect(Number((snap240.measures.reservationErrorRate * 100).toFixed(1))).toBe(
      parseFloatToken(ev240.detail, /reports\s+([\d.]+)%\s+reservation error rate/, 'ev-met-240 error rate'),
    );

    // 3. Compare Backoff branch authored outcome items (intermediate + 15:00) against snapshots
    const bbBranch = 'act-backoff-circuit-breaker';
    const bb420 = getAuthoredItem(bbBranch, 'ev-out-bb-420');
    expect(bb420.measureName).toBe('retry_amplification_ratio');
    const snapBb420 = getSnapAtItem(bbBranch, bb420.simTimeSeconds);
    expect(snapBb420.measures.retryAmplification).toBeCloseTo(
      parseFloatToken(bb420.measureValue!, /^([\d.]+)x/, 'ev-out-bb-420 retry amp'),
      2,
    );
    expect(Number(snapBb420.measures.retryAmplification.toFixed(1))).toBe(
      parseFloatToken(bb420.title, /to\s+([\d.]+)x/, 'ev-out-bb-420 title retry amp'),
    );

    const bb540 = getAuthoredItem(bbBranch, 'ev-out-bb-540');
    expect(bb540.measureName).toBe('provider_p95_latency_ms');
    const snapBb540 = getSnapAtItem(bbBranch, bb540.simTimeSeconds);
    expect(snapBb540.measures.providerP95LatencyMs).toBe(
      parseIntToken(bb540.measureValue!, /^(\d+)\s*ms/, 'ev-out-bb-540 provider p95'),
    );

    // Modeled queue drain timing for Backoff: fully drained by 08:00 (480s)
    const snapBb480 = getSnapAtItem(bbBranch, 480);
    expect(snapBb480.measures.confirmationBacklog).toBe(0);
    expect(snapBb480.measures.queueAgeP95Seconds).toBe(0);

    const bb720 = getAuthoredItem(bbBranch, 'ev-out-bb-720');
    expect(bb720.measureName).toBe('confirmation_queue_backlog');
    const snapBb720 = getSnapAtItem(bbBranch, bb720.simTimeSeconds);
    expect(snapBb720.measures.confirmationBacklog).toBe(
      parseIntToken(bb720.measureValue!, /^([\d,]+)\s*messages/, 'ev-out-bb-720 backlog'),
    );
    expect(snapBb720.measures.queueAgeP95Seconds).toBe(
      parseIntToken(bb720.measureValue!, /p95 age:\s*(\d+)s/, 'ev-out-bb-720 p95 age'),
    );
    expect(snapBb720.measures.affectedReservations).toBe(
      parseIntToken(bb720.detail, /([\d,]+)\s+reservations experienced/, 'ev-out-bb-720 affected'),
    );

    const bb900 = getAuthoredItem(bbBranch, 'ev-out-bb-900');
    expect(bb900.measureName).toBe('provider_p95_latency_ms');
    const snapBb900 = getSnapAtItem(bbBranch, bb900.simTimeSeconds);
    expect(snapBb900.measures.providerP95LatencyMs).toBe(
      parseIntToken(bb900.measureValue!, /^(\d+)\s*ms/, 'ev-out-bb-900 provider p95'),
    );
    expect(snapBb900.measures.retryAmplification).toBeCloseTo(
      parseFloatToken(bb900.measureValue!, /retry amp:\s*([\d.]+)x/, 'ev-out-bb-900 retry amp'),
      2,
    );
    expect(snapBb900.measures.confirmationBacklog).toBe(
      parseIntToken(bb900.detail, /backlog is\s+([\d,]+)\s+messages/, 'ev-out-bb-900 detail backlog'),
    );
    expect(snapBb900.measures.apiP95LatencyMs).toBe(
      parseIntToken(bb900.detail, /errors,\s*(\d+)\s*ms p95/, 'ev-out-bb-900 detail api p95'),
    );
    expect(snapBb900.measures.affectedReservations).toBe(
      parseIntToken(bb900.detail, /([\d,]+)\s+unique reservations/, 'ev-out-bb-900 detail affected'),
    );

    // 4. Compare Increase Concurrency branch authored outcome items against engine snapshots
    const incBranch = 'act-increase-concurrency';
    const inc450 = getAuthoredItem(incBranch, 'ev-out-inc-450');
    expect(inc450.measureName).toBe('retry_amplification_ratio');
    const snapInc450 = getSnapAtItem(incBranch, inc450.simTimeSeconds);
    expect(snapInc450.measures.retryAmplification).toBeCloseTo(
      parseFloatToken(inc450.measureValue!, /^([\d.]+)x/, 'ev-out-inc-450 retry amp'),
      2,
    );
    expect(snapInc450.measures.providerP95LatencyMs).toBe(
      parseIntToken(inc450.measureValue!, /provider p95:\s*([\d,]+)\s*ms/, 'ev-out-inc-450 provider p95'),
    );
    expect(Number(snapInc450.measures.retryAmplification.toFixed(1))).toBe(
      parseFloatToken(inc450.title, /retry amp\s+([\d.]+)x/, 'ev-out-inc-450 title retry amp'),
    );
    expect(snapInc450.measures.confirmationBacklog).toBe(
      parseIntToken(inc450.detail, /\(([\d,]+)\s+messages queued/, 'ev-out-inc-450 detail backlog'),
    );
    expect(snapInc450.measures.queueAgeP95Seconds).toBe(
      parseIntToken(inc450.detail, /p95 age\s+(\d+)s\)/, 'ev-out-inc-450 detail p95 age'),
    );

    const inc600 = getAuthoredItem(incBranch, 'ev-out-inc-600');
    expect(inc600.measureName).toBe('confirmation_queue_backlog');
    const snapInc600 = getSnapAtItem(incBranch, inc600.simTimeSeconds);
    expect(snapInc600.measures.confirmationBacklog).toBe(
      parseIntToken(inc600.measureValue!, /^([\d,]+)\s*messages/, 'ev-out-inc-600 backlog'),
    );
    expect(snapInc600.measures.queueAgeP95Seconds).toBe(
      parseIntToken(inc600.measureValue!, /p95 age:\s*(\d+)s/, 'ev-out-inc-600 p95 age'),
    );
    expect(snapInc600.measures.affectedReservations).toBe(
      parseIntToken(inc600.detail, /([\d,]+)\s+cumulative reservations/, 'ev-out-inc-600 affected'),
    );

    const inc900 = getAuthoredItem(incBranch, 'ev-out-inc-900');
    expect(inc900.measureName).toBe('confirmation_queue_backlog');
    const snapInc900 = getSnapAtItem(incBranch, inc900.simTimeSeconds);
    expect(snapInc900.measures.confirmationBacklog).toBe(
      parseIntToken(inc900.measureValue!, /^([\d,]+)\s*messages/, 'ev-out-inc-900 backlog'),
    );
    expect(snapInc900.measures.queueAgeP95Seconds).toBe(
      parseIntToken(inc900.measureValue!, /p95 age:\s*(\d+)s/, 'ev-out-inc-900 p95 age'),
    );
    expect(snapInc900.measures.providerP95LatencyMs).toBe(
      parseIntToken(inc900.detail, /pegged at\s+([\d,]+)\s*ms/, 'ev-out-inc-900 detail provider p95'),
    );
    expect(snapInc900.measures.retryAmplification).toBeCloseTo(
      parseFloatToken(inc900.detail, /with\s+([\d.]+)x\s+retry amplification/, 'ev-out-inc-900 detail retry amp'),
      2,
    );
    expect(snapInc900.measures.affectedReservations).toBe(
      parseIntToken(inc900.detail, /([\d,]+)\s+cumulative reservations/, 'ev-out-inc-900 detail affected'),
    );

    // 5. Compare Observe branch authored outcome items against engine snapshots
    const obsBranch = 'act-observe';
    const obs480 = getAuthoredItem(obsBranch, 'ev-out-obs-480');
    expect(obs480.measureName).toBe('retry_amplification_ratio');
    const snapObs480 = getSnapAtItem(obsBranch, obs480.simTimeSeconds);
    expect(snapObs480.measures.retryAmplification).toBeCloseTo(
      parseFloatToken(obs480.measureValue!, /^([\d.]+)x/, 'ev-out-obs-480 retry amp'),
      2,
    );
    expect(snapObs480.measures.providerP95LatencyMs).toBe(
      parseIntToken(obs480.measureValue!, /provider p95:\s*([\d,]+)\s*ms/, 'ev-out-obs-480 provider p95'),
    );
    expect(Number(snapObs480.measures.retryAmplification.toFixed(1))).toBe(
      parseFloatToken(obs480.title, /amplification\s+([\d.]+)x/, 'ev-out-obs-480 title retry amp'),
    );

    const obs720 = getAuthoredItem(obsBranch, 'ev-out-obs-720');
    expect(obs720.measureName).toBe('confirmation_queue_backlog');
    const snapObs720 = getSnapAtItem(obsBranch, obs720.simTimeSeconds);
    expect(snapObs720.measures.confirmationBacklog).toBe(
      parseIntToken(obs720.measureValue!, /^([\d,]+)\s*messages/, 'ev-out-obs-720 backlog'),
    );
    expect(snapObs720.measures.queueAgeP95Seconds).toBe(
      parseIntToken(obs720.measureValue!, /p95 age:\s*(\d+)s/, 'ev-out-obs-720 p95 age'),
    );
    expect(snapObs720.measures.affectedReservations).toBe(
      parseIntToken(obs720.detail, /([\d,]+)\s+cumulative reservations/, 'ev-out-obs-720 affected'),
    );

    const obs900 = getAuthoredItem(obsBranch, 'ev-out-obs-900');
    expect(obs900.measureName).toBe('confirmation_queue_backlog');
    const snapObs900 = getSnapAtItem(obsBranch, obs900.simTimeSeconds);
    expect(snapObs900.measures.confirmationBacklog).toBe(
      parseIntToken(obs900.measureValue!, /^([\d,]+)\s*messages/, 'ev-out-obs-900 backlog'),
    );
    expect(snapObs900.measures.queueAgeP95Seconds).toBe(
      parseIntToken(obs900.measureValue!, /p95 age:\s*(\d+)s/, 'ev-out-obs-900 p95 age'),
    );
    expect(snapObs900.measures.providerP95LatencyMs).toBe(
      parseIntToken(obs900.measureValue!, /provider p95:\s*([\d,]+)\s*ms/, 'ev-out-obs-900 provider p95'),
    );
    expect(snapObs900.measures.affectedReservations).toBe(
      parseIntToken(obs900.detail, /([\d,]+)\s+cumulative unique reservations/, 'ev-out-obs-900 detail affected'),
    );

    // 6. Verify 15:00 evidence visibility gating: absent at 14:55 (895s), visible at 15:00 (900s)
    const outcome900Pairs = [
      ['act-backoff-circuit-breaker', 'ev-out-bb-900'],
      ['act-increase-concurrency', 'ev-out-inc-900'],
      ['act-observe', 'ev-out-obs-900'],
    ] as const;

    for (const [branchId, evId] of outcome900Pairs) {
      const snap1455 = buildSnapshot({
        scenario: INCIDENT_002_DEFINITION,
        simTimeSeconds: 895,
        selectedInterventionId: branchId,
      });
      const snap1500 = buildSnapshot({
        scenario: INCIDENT_002_DEFINITION,
        simTimeSeconds: 900,
        selectedInterventionId: branchId,
      });
      expect(snap1455.visibleEvidence.some((e) => e.id === evId)).toBe(false);
      expect(snap1500.visibleEvidence.some((e) => e.id === evId)).toBe(true);
    }

    // 7. Citations in Backoff walkthrough explicitly support claimed values
    const backoffWalkthrough =
      INCIDENT_002_DEFINITION.walkthroughs.outcomes['act-backoff-circuit-breaker'];
    const facts = backoffWalkthrough.observedFacts;
    expect(facts[0].citationIds).toEqual(['ev-out-bb-420', 'ev-out-bb-900']);
    expect(facts[1].citationIds).toEqual(['ev-out-bb-540', 'ev-out-bb-900']);
    expect(facts[2].citationIds).toEqual(['ev-out-bb-720']);
  });

  it('maintains observational pre-assessment status banner without causal diagnosis spoilers', () => {
    const snapEvidence = buildSnapshot({
      scenario: INCIDENT_002_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    expect(snapEvidence.customerImpactBanner).toContain('Active incident — Confirmation queue backlogged at 207 messages');
    expect(snapEvidence.customerImpactBanner).toContain('confirmations delayed for 424 reservations');
    expect(snapEvidence.customerImpactBanner).toContain('Upstream reservations 100% operational');
    expect(snapEvidence.customerImpactBanner).not.toContain('retry storm');
  });
});
