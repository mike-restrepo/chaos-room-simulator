import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  CHECKPOINT_TIMES,
  INCIDENT_001_DEFINITION,
  TICK_STEP_SECONDS,
} from '../src/index.js';

describe('AC-04 & AC-05: Causal branch behavior and metric invariants', () => {
  it('verifies Rollback & Drain recovers after temporary drain disruption', () => {
    const atEvidence = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: 'act-rollback-drain',
    });
    const duringDrain = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: 380, // 06:20 during pod drain
      selectedInterventionId: 'act-rollback-drain',
    });
    const postDrainRecovered = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: 480, // 08:00 after trailing 60s window clears drain failures
      selectedInterventionId: 'act-rollback-drain',
    });
    const atOutcome = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-rollback-drain',
    });

    // Saturated at 06:00
    expect(atEvidence.measures.activeDbConnections).toBe(100);
    expect(atEvidence.measures.reservationErrorRate).toBeGreaterThan(0.35);

    // During drain (06:20), error rate is still non-zero while connections are draining
    expect(duringDrain.measures.reservationErrorRate).toBeGreaterThan(0.1);
    expect(duringDrain.measures.activeDbConnections).toBeLessThan(100);
    expect(duringDrain.measures.activeDbConnections).toBeGreaterThan(40);

    // By 08:00 and through 15:00, error rate recovers to 0% and latency returns to baseline
    expect(postDrainRecovered.measures.reservationErrorRate).toBe(0);
    expect(atOutcome.measures.reservationErrorRate).toBe(0);
    expect(atOutcome.measures.apiP95LatencyMs).toBeLessThan(180);
    expect(atOutcome.measures.activeDbConnections).toBeLessThanOrEqual(24);
    expect(atOutcome.severity).toBe('resolved');

    // Cumulative affected reservations stops growing once recovered
    expect(atOutcome.measures.affectedReservations).toBe(
      postDrainRecovered.measures.affectedReservations,
    );
  });

  it('verifies debrief outcome numbers agree with the 15:00 snapshot measures across all three branches', () => {
    for (const branch of ['act-rollback-drain', 'act-increase-pool', 'act-observe'] as const) {
      const snap = buildSnapshot({
        scenario: INCIDENT_001_DEFINITION,
        simTimeSeconds: CHECKPOINT_TIMES.outcome,
        selectedInterventionId: branch,
      });
      const debriefOutcome = INCIDENT_001_DEFINITION.debrief.outcomeComparisons[branch]!;

      expect(debriefOutcome.totalAffectedReservations).toBe(snap.measures.affectedReservations);
      expect(debriefOutcome.finalErrorRatePercent).toBe(
        Number((snap.measures.reservationErrorRate * 100).toFixed(1)),
      );
      expect(debriefOutcome.finalP95LatencyMs).toBe(snap.measures.apiP95LatencyMs);
    }
  });

  it('verifies Increase Pool Limit improves temporarily and then deteriorates as the larger pool saturates', () => {
    const atEvidence = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: 'act-increase-pool',
    });
    const temporaryRelief = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: 440, // 07:20 temporary relief window
      selectedInterventionId: 'act-increase-pool',
    });
    const atOutcome = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-increase-pool',
    });

    // Temporary improvement at 07:20 compared to 06:00
    expect(temporaryRelief.measures.maxDbConnections).toBe(200);
    expect(temporaryRelief.measures.reservationErrorRate).toBeLessThan(0.08);
    expect(temporaryRelief.measures.reservationErrorRate).toBeLessThan(
      atEvidence.measures.reservationErrorRate,
    );
    expect(temporaryRelief.measures.apiP95LatencyMs!).toBeLessThan(400);

    // Deterioration by 15:00 as all 200 connections saturate
    expect(atOutcome.measures.activeDbConnections).toBe(200);
    expect(atOutcome.measures.maxDbConnections).toBe(200);
    expect(atOutcome.measures.reservationErrorRate).toBeGreaterThan(0.35);
    expect(atOutcome.measures.apiP95LatencyMs!).toBeGreaterThan(2400);
    expect(atOutcome.measures.affectedReservations).toBeGreaterThan(
      temporaryRelief.measures.affectedReservations + 100,
    );
    expect(atOutcome.severity).toBe('critical');
  });

  it('verifies Observe leaves the incident unresolved continuously from 06:00 to 15:00', () => {
    const atEvidence = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: 'act-observe',
    });
    const midObserve = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: 600,
      selectedInterventionId: 'act-observe',
    });
    const atOutcome = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-observe',
    });

    expect(midObserve.measures.activeDbConnections).toBe(100);
    expect(midObserve.measures.reservationErrorRate).toBeGreaterThan(0.4);
    expect(atOutcome.measures.activeDbConnections).toBe(100);
    expect(atOutcome.measures.reservationErrorRate).toBeGreaterThan(0.4);
    expect(atOutcome.measures.apiP95LatencyMs!).toBeGreaterThan(2400);
    expect(atOutcome.measures.affectedReservations).toBeGreaterThan(
      atEvidence.measures.affectedReservations + 200,
    );
    expect(atOutcome.severity).toBe('critical');
  });

  it('maintains metric invariants across all ticks and branches', () => {
    for (const branch of ['act-rollback-drain', 'act-increase-pool', 'act-observe'] as const) {
      let prevAffected = 0;
      for (let t = 0; t <= CHECKPOINT_TIMES.outcome; t += TICK_STEP_SECONDS * 6) {
        const snap = buildSnapshot({
          scenario: INCIDENT_001_DEFINITION,
          simTimeSeconds: t,
          selectedInterventionId: branch,
        });

        expect(snap.measures.reservationErrorRate).toBeGreaterThanOrEqual(0);
        expect(snap.measures.reservationErrorRate).toBeLessThanOrEqual(1);
        expect(snap.measures.confirmationBacklog).toBeGreaterThanOrEqual(0);
        expect(snap.measures.retryAmplification).toBeGreaterThanOrEqual(1);
        expect(snap.measures.affectedReservations).toBeGreaterThanOrEqual(prevAffected);
        prevAffected = snap.measures.affectedReservations;

        // Visible evidence never contains future items
        for (const item of snap.visibleEvidence) {
          expect(item.simTimeSeconds).toBeLessThanOrEqual(t);
        }
      }
    }
  });
});
