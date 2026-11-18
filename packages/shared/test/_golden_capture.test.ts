import { it } from 'vitest';
import {
  buildSnapshot,
  CHECKPOINT_TIMES,
  fnv1aHex,
  INCIDENT_001_DEFINITION,
  serializeEvidenceForAI,
  computeCanonicalCacheKey,
} from '../src/index.js';

it('captures scenario-1 golden digests (baseline)', () => {
  const canonical = [
    ['alert', CHECKPOINT_TIMES.alert, null],
    ['evidence', CHECKPOINT_TIMES.evidence, null],
    ['rollback', CHECKPOINT_TIMES.outcome, 'act-rollback-drain'],
    ['pool', CHECKPOINT_TIMES.outcome, 'act-increase-pool'],
    ['observe', CHECKPOINT_TIMES.outcome, 'act-observe'],
  ] as const;
  const out: Record<string, string> = {};
  for (const [name, t, act] of canonical) {
    const snap = buildSnapshot({ scenario: INCIDENT_001_DEFINITION, simTimeSeconds: t, selectedInterventionId: act });
    const json = JSON.stringify(snap);
    out[name] = `${fnv1aHex(json)}:${json.length}`;
  }
  let combined = '';
  for (const act of [null, 'act-rollback-drain', 'act-increase-pool', 'act-observe']) {
    for (let t = 0; t <= 900; t += 30) {
      combined += JSON.stringify(
        buildSnapshot({ scenario: INCIDENT_001_DEFINITION, simTimeSeconds: t, selectedInterventionId: act }),
      );
    }
  }
  out.grid = `${fnv1aHex(combined)}:${combined.length}`;
  const pkt = serializeEvidenceForAI(
    INCIDENT_001_DEFINITION,
    buildSnapshot({ scenario: INCIDENT_001_DEFINITION, simTimeSeconds: 900, selectedInterventionId: 'act-observe' }),
  );
  out.packetJson = fnv1aHex(JSON.stringify(pkt));
  out.cacheKey = computeCanonicalCacheKey(pkt, { modelVersion: 'm', promptVersion: 'p', schemaVersion: 's' });
  console.log('GOLDEN=' + JSON.stringify(out, null, 2));
});
