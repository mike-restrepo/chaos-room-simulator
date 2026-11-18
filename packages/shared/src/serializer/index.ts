import {
  CHECKPOINT_TIMES,
  type AnalysisResult,
  type CanonicalAIPacket,
  type CheckpointId,
  type ScenarioDefinition,
  type Snapshot,
} from '../contracts/index.js';
import { buildSnapshot, isValidInterventionId } from '../engine/simulator.js';

export interface CanonicalAnalysisStateSpec {
  scenario: ScenarioDefinition;
  incidentId: string;
  checkpoint: CheckpointId;
  simTimeSeconds: number;
  selectedInterventionId: string | null;
}

/**
 * Resolves the canonical checkpoint for AI analysis from a snapshot.
 */
export function resolveSnapshotCheckpoint(snapshot: Snapshot): CheckpointId {
  if (
    snapshot.simTimeSeconds >= CHECKPOINT_TIMES.outcome &&
    snapshot.selectedInterventionId !== null
  ) {
    return 'outcome';
  }
  if (snapshot.simTimeSeconds >= CHECKPOINT_TIMES.evidence) {
    return 'evidence';
  }
  return 'alert';
}

/**
 * Reconstructs the exact canonical Snapshot for one of the bounded public checkpoint states:
 * - Alert: 180s, no intervention
 * - Evidence: 360s, no intervention
 * - Outcome: 900s, one valid scenario-specific intervention
 */
export function buildCanonicalCheckpointSnapshot(
  scenario: ScenarioDefinition,
  checkpoint: CheckpointId,
  selectedInterventionId: string | null = null,
): Snapshot {
  if (checkpoint === 'alert' || checkpoint === 'evidence') {
    if (selectedInterventionId !== null) {
      throw new Error(
        `Canonical checkpoint "${checkpoint}" does not allow an intervention (received "${selectedInterventionId}")`,
      );
    }
    return buildSnapshot({
      scenario,
      seed: scenario.defaultSeed,
      simTimeSeconds: CHECKPOINT_TIMES[checkpoint],
      selectedInterventionId: null,
    });
  }

  if (!isValidInterventionId(scenario, selectedInterventionId)) {
    throw new Error(
      `Canonical checkpoint "outcome" requires a valid intervention ID for scenario "${scenario.incidentId}"`,
    );
  }

  return buildSnapshot({
    scenario,
    seed: scenario.defaultSeed,
    simTimeSeconds: CHECKPOINT_TIMES.outcome,
    selectedInterventionId,
  });
}

/**
 * Enumerates all canonical public analysis states across a set of scenarios
 * (5 per scenario: Alert, Evidence, and 3 Outcome branches).
 */
export function enumerateCanonicalAnalysisStates(
  scenarios: readonly ScenarioDefinition[],
): CanonicalAnalysisStateSpec[] {
  const states: CanonicalAnalysisStateSpec[] = [];
  for (const scenario of scenarios) {
    states.push({
      scenario,
      incidentId: scenario.incidentId,
      checkpoint: 'alert',
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: null,
    });
    states.push({
      scenario,
      incidentId: scenario.incidentId,
      checkpoint: 'evidence',
      simTimeSeconds: CHECKPOINT_TIMES.evidence,
      selectedInterventionId: null,
    });
    for (const intervention of scenario.interventions) {
      states.push({
        scenario,
        incidentId: scenario.incidentId,
        checkpoint: 'outcome',
        simTimeSeconds: CHECKPOINT_TIMES.outcome,
        selectedInterventionId: intervention.id,
      });
    }
  }
  return states;
}

/**
 * Serializes a Snapshot into a CanonicalAIPacket for AI analysis.
 * Always reconstructs the exact canonical checkpoint snapshot first so arbitrary
 * playback measures/ticks cannot be serialized as though they were checkpoint evidence.
 * Strictly strips ground truth, future evidence, isAlternativeClue flags,
 * visitor pins, and intervention options at the Alert checkpoint.
 */
export function serializeEvidenceForAI(
  scenario: ScenarioDefinition,
  snapshot: Snapshot,
): CanonicalAIPacket {
  const checkpoint = resolveSnapshotCheckpoint(snapshot);
  const rawIntervention =
    checkpoint === 'outcome' && isValidInterventionId(scenario, snapshot.selectedInterventionId)
      ? snapshot.selectedInterventionId
      : null;

  const canonicalCheckpoint: CheckpointId =
    checkpoint === 'outcome' && rawIntervention === null ? 'evidence' : checkpoint;
  const canonicalSnapshot = buildCanonicalCheckpointSnapshot(
    scenario,
    canonicalCheckpoint,
    canonicalCheckpoint === 'outcome' ? rawIntervention : null,
  );
  const maxAllowedTick = CHECKPOINT_TIMES[canonicalCheckpoint];

  const visibleEvidence = canonicalSnapshot.visibleEvidence
    .filter((ev) => ev.simTimeSeconds <= maxAllowedTick)
    .map((ev) => ({
      id: ev.id,
      simTimeSeconds: ev.simTimeSeconds,
      service: ev.service,
      type: ev.type,
      severity: ev.severity,
      title: ev.title,
      summary: ev.summary,
      detail: ev.detail,
    }));

  const visibleInterventions =
    canonicalCheckpoint === 'alert'
      ? []
      : scenario.interventions.map((option) => ({
          id: option.id,
          label: option.label,
          summary: option.summary,
          immediateTradeoff: option.immediateTradeoff,
          // Intentionally omit `stages`, `stageSchedule`, and post-decision outcomes.
        }));

  return {
    incidentId: scenario.incidentId,
    symptomTitle: scenario.symptomTitle,
    scenarioVersion: scenario.scenarioVersion,
    engineVersion: canonicalSnapshot.engineVersion,
    checkpoint: canonicalCheckpoint,
    simTimeSeconds: maxAllowedTick,
    systemDescription: scenario.systemDescription,
    topology: scenario.topology,
    measures: canonicalSnapshot.measures,
    visibleEvidence,
    visibleInterventions,
    appliedInterventionId:
      canonicalCheckpoint === 'outcome' ? canonicalSnapshot.selectedInterventionId : null,
  };
}

/**
 * Computes a deterministic FNV-1a 32-bit hex digest for a string.
 * Used for lightweight client-side UI snapshot digest diagnostics (not backend cache identity).
 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Deterministic JSON serialization with sorted object keys so object key insertion
 * order never alters cryptographic digests across browser/Node runtimes.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${entries.join(',')}}`;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Pure TypeScript FIPS 180-4 SHA-256 hex digest over UTF-8 encoded text.
 * Runs synchronously in both browser and Node without platform-specific imports.
 */
export function sha256Hex(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const bitLen = utf8.length * 8;
  const paddedLen = Math.ceil((utf8.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(utf8);
  padded[utf8.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

export interface CacheIdentityOptions {
  modelVersion: string;
  promptVersion: string;
  schemaVersion: string;
}

/**
 * Computes the collision-resistant SHA-256 digest over the complete CanonicalAIPacket
 * plus model, prompt, and output-schema versions using stable key-sorted serialization.
 */
export function computeCanonicalPacketDigest(
  packet: CanonicalAIPacket,
  options: CacheIdentityOptions,
): string {
  const canonicalPayload = stableStringify({
    packet,
    modelVersion: options.modelVersion,
    promptVersion: options.promptVersion,
    schemaVersion: options.schemaVersion,
  });
  return sha256Hex(canonicalPayload);
}

/**
 * Builds the shared backend cache key from the complete canonical packet SHA-256 digest.
 * Excludes visitor ID, request ID, wall-clock time, playback speed, active tab, and pinned items.
 */
export function computeCanonicalCacheKey(
  packet: CanonicalAIPacket,
  options: CacheIdentityOptions,
): string {
  const packetDigest = computeCanonicalPacketDigest(packet, options);
  return [
    packet.incidentId,
    `sv:${packet.scenarioVersion}`,
    `ev:${packet.engineVersion}`,
    `cp:${packet.checkpoint}`,
    `act:${packet.appliedInterventionId ?? 'none'}`,
    `sha256:${packetDigest}`,
    `mv:${options.modelVersion}`,
    `pv:${options.promptVersion}`,
    `sc:${options.schemaVersion}`,
  ].join('|');
}

/**
 * Computes a Firestore-safe cache document ID from the full canonical packet SHA-256 digest.
 */
export function computeBackendCacheDocId(
  packet: CanonicalAIPacket,
  options: CacheIdentityOptions,
): string {
  const packetDigest = computeCanonicalPacketDigest(packet, options);
  const safeAction = (packet.appliedInterventionId ?? 'none').replace(/[^A-Za-z0-9_-]/g, '_');
  return `${packet.incidentId}_${packet.checkpoint}_${safeAction}_${packetDigest}`;
}

export interface ValidationOutcome {
  valid: boolean;
  errors: string[];
}

/**
 * Validates an AnalysisResult against the current Snapshot and Section 7 guardrails.
 */
export function validateAnalysisResult(
  result: AnalysisResult,
  snapshot: Snapshot,
): ValidationOutcome {
  const errors: string[] = [];
  const validEvidenceIds = new Set(snapshot.visibleEvidence.map((e) => e.id));
  const validInterventionIds = new Set(snapshot.availableInterventions.map((i) => i.id));

  if (!result.conciseAssessment.trim()) {
    errors.push('conciseAssessment must not be empty');
  }

  if (result.observedFacts.length === 0) {
    errors.push('observedFacts must contain at least one item');
  }

  for (const fact of result.observedFacts) {
    if (fact.citationIds.length === 0) {
      errors.push(`Observed fact "${fact.text}" is missing evidence citations`);
    }
    for (const cid of fact.citationIds) {
      if (!validEvidenceIds.has(cid)) {
        errors.push(`Observed fact citation "${cid}" does not exist in snapshot visibleEvidence`);
      }
    }
  }

  for (const hyp of result.rankedHypotheses) {
    for (const cid of hyp.supportingCitationIds) {
      if (!validEvidenceIds.has(cid)) {
        errors.push(`Hypothesis citation "${cid}" does not exist in snapshot visibleEvidence`);
      }
    }
  }

  for (const alt of result.alternativeExplanations) {
    for (const cid of alt.citationIds) {
      if (!validEvidenceIds.has(cid)) {
        errors.push(
          `Alternative explanation citation "${cid}" does not exist in snapshot visibleEvidence`,
        );
      }
    }
  }

  if (result.checkpoint === 'alert') {
    if (result.recommendedInterventions.length > 0) {
      errors.push('recommendedInterventions must be empty [] at the Alert checkpoint');
    }
    if (result.verificationChecks.length === 0) {
      errors.push('verificationChecks must supply investigation checks at the Alert checkpoint');
    }
  } else {
    for (const rec of result.recommendedInterventions) {
      if (!validInterventionIds.has(rec.interventionId)) {
        errors.push(
          `Recommended intervention "${rec.interventionId}" is not in snapshot availableInterventions`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
