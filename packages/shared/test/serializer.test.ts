import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALL_SCENARIOS,
  buildCanonicalCheckpointSnapshot,
  buildSnapshot,
  CHECKPOINT_TIMES,
  computeBackendCacheDocId,
  computeCanonicalCacheKey,
  computeCanonicalPacketDigest,
  enumerateCanonicalAnalysisStates,
  INCIDENT_001_DEFINITION,
  serializeEvidenceForAI,
  sha256Hex,
  stableStringify,
  validateAnalysisResult,
} from '../src/index.js';

describe('AC-06, AC-07 & AC-18: Canonical AI serializer, Alert schema, and cache key', () => {
  it('uses opaque incident-001 identifier and excludes ground truth and future evidence', () => {
    const alertSnap = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: null,
    });

    const packet = serializeEvidenceForAI(INCIDENT_001_DEFINITION, alertSnap);
    const serializedJson = JSON.stringify(packet);

    expect(packet.incidentId).toBe('incident-001');
    expect(packet.symptomTitle).toBe('Reservations are timing out');
    expect(packet.checkpoint).toBe('alert');
    expect(packet.visibleInterventions).toEqual([]);
    expect(packet.appliedInterventionId).toBeNull();

    // Must not leak ground truth or future evidence IDs
    expect(serializedJson).not.toContain('actualRootCause');
    expect(serializedJson).not.toContain('conn.Release()');
    expect(serializedJson).not.toContain('ev-log-270');
    expect(serializedJson).not.toContain('isAlternativeClue');
  });

  it('reconstructs the canonical checkpoint snapshot instead of serializing arbitrary playback measures', () => {
    const midPlaybackSnap = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: 240, // 04:00 mid-playback between Alert (180s) and Evidence (360s)
      selectedInterventionId: null,
    });
    const canonicalAlertSnap = buildCanonicalCheckpointSnapshot(
      INCIDENT_001_DEFINITION,
      'alert',
      null,
    );

    expect(midPlaybackSnap.simTimeSeconds).toBe(240);
    expect(midPlaybackSnap.measures).not.toEqual(canonicalAlertSnap.measures);

    const packetFromPlayback = serializeEvidenceForAI(INCIDENT_001_DEFINITION, midPlaybackSnap);
    const packetFromCanonical = serializeEvidenceForAI(INCIDENT_001_DEFINITION, canonicalAlertSnap);
    expect(packetFromPlayback.simTimeSeconds).toBe(CHECKPOINT_TIMES.alert);
    expect(packetFromPlayback.measures).toEqual(canonicalAlertSnap.measures);
    expect(packetFromPlayback).toEqual(packetFromCanonical);

    const midPostDecisionSnap = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: 450, // 07:30 mid-recovery after Evidence (360s)
      selectedInterventionId: 'act-rollback-drain',
    });
    const canonicalEvidenceSnap = buildCanonicalCheckpointSnapshot(
      INCIDENT_001_DEFINITION,
      'evidence',
      null,
    );
    const packetFromMidRecovery = serializeEvidenceForAI(
      INCIDENT_001_DEFINITION,
      midPostDecisionSnap,
    );
    expect(packetFromMidRecovery.checkpoint).toBe('evidence');
    expect(packetFromMidRecovery.simTimeSeconds).toBe(CHECKPOINT_TIMES.evidence);
    expect(packetFromMidRecovery.appliedInterventionId).toBeNull();
    expect(packetFromMidRecovery.measures).toEqual(canonicalEvidenceSnap.measures);
  });

  it('enumerates exactly 15 canonical public analysis states across all 3 scenarios', () => {
    const states = enumerateCanonicalAnalysisStates(ALL_SCENARIOS);
    expect(states.length).toBe(15);

    const keys = states.map(
      (s) => `${s.incidentId}:${s.checkpoint}:${s.simTimeSeconds}:${s.selectedInterventionId ?? 'none'}`,
    );
    expect(new Set(keys).size).toBe(15);
    for (const state of states) {
      const snap = buildCanonicalCheckpointSnapshot(
        state.scenario,
        state.checkpoint,
        state.selectedInterventionId,
      );
      expect(snap.simTimeSeconds).toBe(state.simTimeSeconds);
    }
  });

  it('validates all 5 authored walkthroughs for incident-001 against their canonical snapshots', () => {
    const alertSnap = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: null,
    });
    const alertValidation = validateAnalysisResult(
      INCIDENT_001_DEFINITION.walkthroughs.alert,
      alertSnap,
    );
    expect(alertValidation.errors).toEqual([]);
    expect(alertValidation.valid).toBe(true);
    expect(INCIDENT_001_DEFINITION.walkthroughs.alert.recommendedInterventions).toEqual([]);

    const evidenceSnap = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    const evidenceValidation = validateAnalysisResult(
      INCIDENT_001_DEFINITION.walkthroughs.evidence,
      evidenceSnap,
    );
    expect(evidenceValidation.errors).toEqual([]);
    expect(evidenceValidation.valid).toBe(true);

    for (const branch of ['act-rollback-drain', 'act-increase-pool', 'act-observe'] as const) {
      const outcomeSnap = buildSnapshot({
        scenario: INCIDENT_001_DEFINITION,
        simTimeSeconds: CHECKPOINT_TIMES.outcome,
        selectedInterventionId: branch,
      });
      const walkthrough = INCIDENT_001_DEFINITION.walkthroughs.outcomes[branch]!;
      const outcomeValidation = validateAnalysisResult(walkthrough, outcomeSnap);
      expect(outcomeValidation.errors).toEqual([]);
      expect(outcomeValidation.valid).toBe(true);
    }
  });

  it('rejects non-empty recommendedInterventions at Alert or bogus citation IDs', () => {
    const alertSnap = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: null,
    });

    const invalidAlertResult = {
      ...INCIDENT_001_DEFINITION.walkthroughs.alert,
      observedFacts: [{ text: 'Bogus citation fact', citationIds: ['ev-nonexistent-999'] }],
      recommendedInterventions: [
        {
          interventionId: 'act-rollback-drain',
          rationale: 'Not allowed at Alert',
          keyRisk: 'None',
        },
      ],
    };

    const validation = validateAnalysisResult(invalidAlertResult, alertSnap);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      'recommendedInterventions must be empty [] at the Alert checkpoint',
    );
    expect(
      validation.errors.some((e) => e.includes('ev-nonexistent-999')),
    ).toBe(true);
  });

  it('computes FIPS 180-4 SHA-256 digests and invalidates cache on evidence text or version edits', () => {
    for (const sample of ['', 'abc', 'Chaos Room — UTF-8 ✓ payload 🚀']) {
      const expected = createHash('sha256').update(sample, 'utf8').digest('hex');
      expect(sha256Hex(sample)).toBe(expected);
    }

    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));

    const snap1 = buildCanonicalCheckpointSnapshot(INCIDENT_001_DEFINITION, 'evidence', null);
    const packet1 = serializeEvidenceForAI(INCIDENT_001_DEFINITION, snap1);
    const opts = { modelVersion: 'mock-v1', promptVersion: '1.0.0', schemaVersion: '1.0.0' };

    const key1 = computeCanonicalCacheKey(packet1, opts);
    const docId1 = computeBackendCacheDocId(packet1, opts);
    const digest1 = computeCanonicalPacketDigest(packet1, opts);

    expect(digest1).toMatch(/^[0-9a-f]{64}$/);
    expect(key1).toContain(`sha256:${digest1}`);
    expect(docId1).toContain(digest1);

    // Identical canonical state produces identical cache identity
    const snap2 = buildCanonicalCheckpointSnapshot(INCIDENT_001_DEFINITION, 'evidence', null);
    expect(computeCanonicalCacheKey(serializeEvidenceForAI(INCIDENT_001_DEFINITION, snap2), opts)).toBe(
      key1,
    );

    // Changing evidence detail text while keeping identical evidence IDs invalidates cache identity
    const packetTextChanged = {
      ...packet1,
      visibleEvidence: packet1.visibleEvidence.map((item, idx) =>
        idx === 0 ? { ...item, detail: `${item.detail} [updated]` } : item,
      ),
    };
    expect(computeCanonicalCacheKey(packetTextChanged, opts)).not.toBe(key1);
    expect(computeBackendCacheDocId(packetTextChanged, opts)).not.toBe(docId1);

    // Changing model, prompt, or schema version invalidates cache identity
    expect(
      computeCanonicalCacheKey(packet1, { ...opts, modelVersion: 'mock-v2' }),
    ).not.toBe(key1);
    expect(
      computeCanonicalCacheKey(packet1, { ...opts, promptVersion: '1.0.1' }),
    ).not.toBe(key1);
    expect(
      computeCanonicalCacheKey(packet1, { ...opts, schemaVersion: '1.0.1' }),
    ).not.toBe(key1);
  });
});
