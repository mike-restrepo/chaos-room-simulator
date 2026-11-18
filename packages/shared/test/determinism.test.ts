import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  CHECKPOINT_TIMES,
  clampSimulationTime,
  getNextCheckpointTarget,
  INCIDENT_001_DEFINITION,
} from '../src/index.js';

describe('AC-02 & AC-03: Deterministic simulation and 06:00 decision gate', () => {
  it('produces identical serialized snapshots for identical inputs across runs', () => {
    const snapA = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      seed: 1001,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-rollback-drain',
    });
    const snapB = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      seed: 1001,
      simTimeSeconds: CHECKPOINT_TIMES.outcome,
      selectedInterventionId: 'act-rollback-drain',
    });

    expect(JSON.stringify(snapA)).toBe(JSON.stringify(snapB));
  });

  it('clamps forward progression at 06:00 (360s) when no intervention is selected', () => {
    expect(clampSimulationTime(600, INCIDENT_001_DEFINITION, null)).toBe(
      CHECKPOINT_TIMES.evidence,
    );
    expect(clampSimulationTime(900, INCIDENT_001_DEFINITION, 'invalid-action')).toBe(
      CHECKPOINT_TIMES.evidence,
    );

    const unclampedAttempt = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: 900,
      selectedInterventionId: null,
    });

    expect(unclampedAttempt.simTimeSeconds).toBe(CHECKPOINT_TIMES.evidence);
    expect(unclampedAttempt.formattedTime).toBe('06:00');
    expect(unclampedAttempt.awaitingInterventionDecision).toBe(true);
    expect(unclampedAttempt.selectedInterventionId).toBeNull();
  });

  it('blocks checkpoint jump past 06:00 until an explicit intervention (including act-observe) is selected', () => {
    const blockedTarget = getNextCheckpointTarget(
      CHECKPOINT_TIMES.evidence,
      INCIDENT_001_DEFINITION,
      null,
    );
    expect(blockedTarget.blockedByDecision).toBe(true);
    expect(blockedTarget.targetSeconds).toBe(CHECKPOINT_TIMES.evidence);

    const observeUnlocked = getNextCheckpointTarget(
      CHECKPOINT_TIMES.evidence,
      INCIDENT_001_DEFINITION,
      'act-observe',
    );
    expect(observeUnlocked.blockedByDecision).toBe(false);
    expect(observeUnlocked.checkpoint).toBe('outcome');
    expect(observeUnlocked.targetSeconds).toBe(CHECKPOINT_TIMES.outcome);
  });

  it('hides future evidence and post-06:00 branch state when scrubbing backward before 06:00', () => {
    const atAlertWithChoice = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: 'act-rollback-drain',
    });

    const atAlertWithoutChoice = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: null,
    });

    // Scrubbing before 06:00 must not leak post-06:00 evidence or branch state
    expect(atAlertWithChoice.selectedInterventionId).toBeNull();
    expect(atAlertWithChoice.availableInterventions).toEqual([]);
    expect(
      atAlertWithChoice.visibleEvidence.every(
        (ev) => ev.simTimeSeconds <= CHECKPOINT_TIMES.alert,
      ),
    ).toBe(true);
    expect(JSON.stringify(atAlertWithChoice)).toBe(JSON.stringify(atAlertWithoutChoice));
  });
});
