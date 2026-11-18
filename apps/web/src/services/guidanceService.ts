import { CHECKPOINT_TIMES } from '@chaos-room/shared';

export type GuidancePhase =
  | 'pre_alert'
  | 'investigation'
  | 'awaiting_decision'
  | 'post_decision'
  | 'outcome';

export interface ResolvedNextStepGuidance {
  phase: GuidancePhase;
  stepLabel: string;
  message: string;
  isDecisionGate: boolean;
  thirdOptionLabel: string | null;
}

export function resolveNextStepGuidance(params: {
  simTimeSeconds: number;
  isPlaying: boolean;
  selectedInterventionId: string | null;
  awaitingInterventionDecision: boolean;
  decisionGatePrompted: boolean;
  thirdInterventionLabel?: string;
}): ResolvedNextStepGuidance {
  const {
    simTimeSeconds,
    isPlaying,
    selectedInterventionId,
    awaitingInterventionDecision,
    decisionGatePrompted,
    thirdInterventionLabel,
  } = params;

  if (simTimeSeconds < CHECKPOINT_TIMES.alert) {
    return {
      phase: 'pre_alert',
      stepLabel: '00:00 / Pre-alert',
      message: isPlaying
        ? 'Playback running — watching the incident develop. We’ll pause at the first alert.'
        : 'Start playback to watch the incident develop. We’ll pause at the first alert.',
      isDecisionGate: false,
      thirdOptionLabel: null,
    };
  }

  if (simTimeSeconds < CHECKPOINT_TIMES.evidence) {
    return {
      phase: 'investigation',
      stepLabel: '03:00 / Investigation',
      message: isPlaying
        ? 'Playback running — check customer impact and incoming evidence before the 06:00 pause.'
        : 'Check customer impact, then inspect the evidence. What changed before the alert?',
      isDecisionGate: false,
      thirdOptionLabel: null,
    };
  }

  if (
    awaitingInterventionDecision ||
    decisionGatePrompted ||
    selectedInterventionId === null
  ) {
    return {
      phase: 'awaiting_decision',
      stepLabel: 'Decision Checkpoint at 06:00',
      message: 'Compare the evidence and assessment, then choose a response.',
      isDecisionGate: true,
      thirdOptionLabel: thirdInterventionLabel ?? null,
    };
  }

  if (simTimeSeconds >= CHECKPOINT_TIMES.outcome) {
    return {
      phase: 'outcome',
      stepLabel: '15:00 / Outcome',
      message: 'Check the outcome, then open the debrief to understand the result.',
      isDecisionGate: false,
      thirdOptionLabel: null,
    };
  }

  return {
    phase: 'post_decision',
    stepLabel: '06:00+ / Response active',
    message: isPlaying
      ? 'Following your response — watch whether customer impact improves through 15:00.'
      : 'Follow your response and check whether customer impact improves.',
    isDecisionGate: false,
    thirdOptionLabel: null,
  };
}
