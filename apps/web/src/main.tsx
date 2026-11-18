import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildSnapshot,
  CHECKPOINT_TIMES,
  fnv1aHex,
  INCIDENT_001_DEFINITION,
} from '@chaos-room/shared';
import { App } from './App.js';
import './styles/index.css';

declare global {
  interface Window {
    __CHAOS_ROOM_DIAGNOSTICS__?: {
      computeCanonicalSnapshots: () => Record<
        string,
        { digest: string; jsonLength: number; measures: unknown; simTimeSeconds: number }
      >;
    };
  }
}

window.__CHAOS_ROOM_DIAGNOSTICS__ = {
  computeCanonicalSnapshots: () => {
    const states = [
      { key: 'alert@03:00', time: CHECKPOINT_TIMES.alert, action: null },
      { key: 'evidence@06:00', time: CHECKPOINT_TIMES.evidence, action: null },
      {
        key: 'outcome@15:00:act-rollback-drain',
        time: CHECKPOINT_TIMES.outcome,
        action: 'act-rollback-drain',
      },
      {
        key: 'outcome@15:00:act-increase-pool',
        time: CHECKPOINT_TIMES.outcome,
        action: 'act-increase-pool',
      },
      {
        key: 'outcome@15:00:act-observe',
        time: CHECKPOINT_TIMES.outcome,
        action: 'act-observe',
      },
    ] as const;

    const out: Record<
      string,
      { digest: string; jsonLength: number; measures: unknown; simTimeSeconds: number }
    > = {};

    for (const st of states) {
      const snap = buildSnapshot({
        scenario: INCIDENT_001_DEFINITION,
        seed: INCIDENT_001_DEFINITION.defaultSeed,
        simTimeSeconds: st.time,
        selectedInterventionId: st.action,
      });
      const serialized = JSON.stringify(snap);
      out[st.key] = {
        digest: fnv1aHex(serialized),
        jsonLength: serialized.length,
        measures: snap.measures,
        simTimeSeconds: snap.simTimeSeconds,
      };
    }

    return out;
  },
};

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
