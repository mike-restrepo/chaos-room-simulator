import {
  buildCanonicalCheckpointSnapshot,
  computeBackendCacheDocId,
  computeCanonicalCacheKey,
  computeCanonicalPacketDigest,
  serializeEvidenceForAI,
  type CheckpointId,
  type ScenarioDefinition,
} from '@chaos-room/shared';
import {
  CURRENT_PROMPT_VERSION,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MOCK_MODEL_VERSION,
} from './config.js';
import type { ReconstructedState } from './types.js';

export interface ReconstructionOptions {
  modelVersion?: string;
  promptVersion?: string;
  schemaVersion?: string;
}

/**
 * Rebuilds the canonical snapshot server-side at exact checkpoint ticks
 * (Alert=180s, Evidence=360s, Outcome=900s), serializes the CanonicalAIPacket,
 * and derives the collision-resistant SHA-256 backend cache identity.
 */
export function reconstructCanonicalState(
  scenario: ScenarioDefinition,
  checkpoint: CheckpointId,
  selectedInterventionId: string | null,
  options: ReconstructionOptions = {},
): ReconstructedState {
  const modelVersion = options.modelVersion ?? DEFAULT_MOCK_MODEL_VERSION;
  const promptVersion = options.promptVersion ?? CURRENT_PROMPT_VERSION;
  const schemaVersion = options.schemaVersion ?? CURRENT_SCHEMA_VERSION;

  const snapshot = buildCanonicalCheckpointSnapshot(scenario, checkpoint, selectedInterventionId);
  const packet = serializeEvidenceForAI(scenario, snapshot);
  const identityOptions = { modelVersion, promptVersion, schemaVersion };
  const packetSha256 = computeCanonicalPacketDigest(packet, identityOptions);
  const cacheKey = computeCanonicalCacheKey(packet, identityOptions);
  const cacheDocId = computeBackendCacheDocId(packet, identityOptions);

  return {
    scenario,
    checkpoint,
    selectedInterventionId: checkpoint === 'outcome' ? selectedInterventionId : null,
    snapshot,
    packet,
    packetSha256,
    cacheKey,
    cacheDocId,
    modelVersion,
    promptVersion,
    schemaVersion,
  };
}
