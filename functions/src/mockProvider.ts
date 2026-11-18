import { ALL_SCENARIOS, type CanonicalAIPacket } from '@chaos-room/shared';
import { DEFAULT_MOCK_MODEL_VERSION } from './config.js';
import type {
  ModelProvider,
  ProviderGenerationOptions,
  ProviderGenerationResponse,
  TokenUsageFixture,
} from './types.js';

export type MockProviderBehavior =
  | { kind: 'success'; usage?: TokenUsageFixture }
  | { kind: 'delay'; delayMs: number; then?: 'success' | 'provider_error'; usage?: TokenUsageFixture }
  | { kind: 'ignore_abort_resolve_late'; delayMs: number; usage?: TokenUsageFixture }
  | { kind: 'ignore_abort_reject_late'; delayMs: number; message?: string; usage?: TokenUsageFixture | null }
  | { kind: 'never_settle' }
  | { kind: 'malformed_json'; usage?: TokenUsageFixture | null }
  | { kind: 'oversized_fields'; usage?: TokenUsageFixture | null }
  | { kind: 'invalid_citations'; usage?: TokenUsageFixture | null }
  | { kind: 'alert_with_recommendations'; usage?: TokenUsageFixture | null }
  | { kind: 'cross_scenario_intervention'; usage?: TokenUsageFixture | null }
  | { kind: 'invented_provenance'; usage?: TokenUsageFixture }
  | { kind: 'provider_error'; message?: string; usage?: TokenUsageFixture | null }
  | { kind: 'unknown_usage'; usage?: TokenUsageFixture | null };

export const DEFAULT_MOCK_USAGE_FIXTURE: TokenUsageFixture = {
  inputTokens: 3_200,
  outputTokens: 640,
  thinkingTokens: 260,
};

function buildGroundedPayloadFromPacket(packet: CanonicalAIPacket): Record<string, unknown> {
  const scenario = ALL_SCENARIOS.find((s) => s.incidentId === packet.incidentId);
  const walkthrough = scenario
    ? packet.checkpoint === 'alert'
      ? scenario.walkthroughs.alert
      : packet.checkpoint === 'evidence'
        ? scenario.walkthroughs.evidence
        : (scenario.walkthroughs.outcomes[packet.appliedInterventionId ?? ''] ??
          scenario.walkthroughs.evidence)
    : undefined;

  if (walkthrough) {
    // Return only the analysis payload (server owns all provenance fields).
    return {
      conciseAssessment: `[Mocked Phase 3A Analysis] ${walkthrough.conciseAssessment}`.slice(0, 790),
      observedFacts: walkthrough.observedFacts,
      rankedHypotheses: walkthrough.rankedHypotheses,
      alternativeExplanations: walkthrough.alternativeExplanations,
      missingInformation: walkthrough.missingInformation,
      confidence: walkthrough.confidence,
      recommendedInterventions:
        packet.checkpoint === 'alert' ? [] : walkthrough.recommendedInterventions,
      verificationChecks: walkthrough.verificationChecks,
      stakeholderUpdate: walkthrough.stakeholderUpdate,
    };
  }

  const firstEvidenceId = packet.visibleEvidence[0]?.id ?? 'ev-missing';
  const firstIntervention = packet.visibleInterventions[0]?.id;
  return {
    conciseAssessment: `[Mocked Phase 3A Analysis] Grounded assessment for ${packet.incidentId} at ${packet.checkpoint}.`,
    observedFacts: [
      {
        text: `Observed ${packet.visibleEvidence[0]?.title ?? 'canonical telemetry'} at ${packet.simTimeSeconds}s.`,
        citationIds: [firstEvidenceId],
      },
    ],
    rankedHypotheses: [
      {
        rank: 1,
        statement: `Primary hypothesis grounded in ${firstEvidenceId} for ${packet.symptomTitle}.`,
        likelihood: 'Primary',
        supportingCitationIds: [firstEvidenceId],
      },
    ],
    alternativeExplanations: [],
    missingInformation: ['Further telemetry verification pending next checkpoint.'],
    confidence: {
      level: 'Medium',
      justification: `Grounded in ${packet.visibleEvidence.length} visible evidence items.`,
    },
    recommendedInterventions:
      packet.checkpoint === 'alert' || !firstIntervention
        ? []
        : [
            {
              interventionId: firstIntervention,
              rationale: 'Selected from canonical visible interventions.',
              keyRisk: 'Subject to scenario-specific tradeoffs.',
            },
          ],
    verificationChecks: ['Verify telemetry metrics at the next checkpoint.'],
    stakeholderUpdate: `Investigation active for "${packet.symptomTitle}" at ${packet.checkpoint}.`,
  };
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error('Provider call aborted before start'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Provider deadline exceeded (aborted)'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitUnconditional(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Controllable Phase 3A mock provider supporting success, delay/timeout, malformed JSON,
 * oversized fields, invalid citations/actions, spoofed provenance, failures, and unknown usage.
 */
export class MockModelProvider implements ModelProvider {
  readonly providerName = 'mock-phase3a-provider';
  readonly isMock = true;

  private nextBehaviors: MockProviderBehavior[] = [];
  private defaultBehavior: MockProviderBehavior = { kind: 'success' };
  public callCount = 0;

  constructor(defaultBehavior?: MockProviderBehavior) {
    if (defaultBehavior) {
      this.defaultBehavior = defaultBehavior;
    }
  }

  setDefaultBehavior(behavior: MockProviderBehavior): void {
    this.defaultBehavior = behavior;
  }

  enqueueBehavior(...behaviors: MockProviderBehavior[]): void {
    this.nextBehaviors.push(...behaviors);
  }

  reset(): void {
    this.nextBehaviors = [];
    this.defaultBehavior = { kind: 'success' };
    this.callCount = 0;
  }

  async generateAnalysis(
    packet: CanonicalAIPacket,
    options: ProviderGenerationOptions,
    abortSignal: AbortSignal,
  ): Promise<ProviderGenerationResponse> {
    this.callCount += 1;
    const behavior = this.nextBehaviors.shift() ?? this.defaultBehavior;
    const modelVersion = options.modelVersion || DEFAULT_MOCK_MODEL_VERSION;

    if (behavior.kind === 'delay') {
      await waitWithAbort(behavior.delayMs, abortSignal);
      if (behavior.then === 'provider_error') {
        throw new Error('Mock provider error after delay');
      }
      return {
        rawOutput: buildGroundedPayloadFromPacket(packet),
        usage: behavior.usage ?? DEFAULT_MOCK_USAGE_FIXTURE,
        modelVersion,
      };
    }

    if (behavior.kind === 'ignore_abort_resolve_late') {
      await waitUnconditional(behavior.delayMs);
      return {
        rawOutput: buildGroundedPayloadFromPacket(packet),
        usage: behavior.usage ?? DEFAULT_MOCK_USAGE_FIXTURE,
        modelVersion,
      };
    }

    if (behavior.kind === 'ignore_abort_reject_late') {
      await waitUnconditional(behavior.delayMs);
      const err = new Error(behavior.message ?? 'Late rejection from uncooperative provider') as Error & {
        usage?: TokenUsageFixture | null;
      };
      if (behavior.usage !== undefined) {
        err.usage = behavior.usage;
      }
      throw err;
    }

    if (behavior.kind === 'never_settle') {
      return new Promise<ProviderGenerationResponse>(() => {
        // Intentionally never resolves or rejects even when AbortSignal fires.
      });
    }

    if (abortSignal.aborted) {
      throw new Error('Provider deadline exceeded');
    }

    switch (behavior.kind) {
      case 'success':
        return {
          rawOutput: buildGroundedPayloadFromPacket(packet),
          usage: behavior.usage ?? DEFAULT_MOCK_USAGE_FIXTURE,
          modelVersion,
        };

      case 'unknown_usage':
        return {
          rawOutput: buildGroundedPayloadFromPacket(packet),
          usage: behavior.usage ?? null,
          modelVersion,
        };

      case 'malformed_json':
        return {
          rawOutput: '{"conciseAssessment": "Truncated output before closing...',
          usage: behavior.usage === undefined ? DEFAULT_MOCK_USAGE_FIXTURE : behavior.usage,
          modelVersion,
        };

      case 'oversized_fields': {
        const base = buildGroundedPayloadFromPacket(packet);
        return {
          rawOutput: {
            ...base,
            conciseAssessment: 'X'.repeat(1_200),
          },
          usage: behavior.usage === undefined ? DEFAULT_MOCK_USAGE_FIXTURE : behavior.usage,
          modelVersion,
        };
      }

      case 'invalid_citations': {
        const base = buildGroundedPayloadFromPacket(packet);
        return {
          rawOutput: {
            ...base,
            observedFacts: [
              {
                text: 'Hallucinated future or nonexistent citation check.',
                citationIds: ['ev-nonexistent-999'],
              },
            ],
          },
          usage: behavior.usage === undefined ? DEFAULT_MOCK_USAGE_FIXTURE : behavior.usage,
          modelVersion,
        };
      }

      case 'alert_with_recommendations': {
        const base = buildGroundedPayloadFromPacket(packet);
        return {
          rawOutput: {
            ...base,
            recommendedInterventions: [
              {
                interventionId: 'act-rollback-drain',
                rationale: 'Illegal recommendation at alert checkpoint.',
                keyRisk: 'Violates alert constraint.',
              },
            ],
          },
          usage: behavior.usage === undefined ? DEFAULT_MOCK_USAGE_FIXTURE : behavior.usage,
          modelVersion,
        };
      }

      case 'cross_scenario_intervention': {
        const base = buildGroundedPayloadFromPacket(packet);
        const otherScenario = ALL_SCENARIOS.find((s) => s.incidentId !== packet.incidentId);
        const crossId = otherScenario?.interventions[0]?.id ?? 'act-cross-scenario-invalid';
        return {
          rawOutput: {
            ...base,
            recommendedInterventions: [
              {
                interventionId: crossId,
                rationale: 'Intervention from another scenario.',
                keyRisk: 'Invalid cross-scenario reference.',
              },
            ],
          },
          usage: behavior.usage === undefined ? DEFAULT_MOCK_USAGE_FIXTURE : behavior.usage,
          modelVersion,
        };
      }

      case 'invented_provenance': {
        const base = buildGroundedPayloadFromPacket(packet);
        return {
          rawOutput: {
            ...base,
            incidentId: 'spoofed-incident-999',
            scenarioVersion: '9.9.9',
            checkpoint: 'outcome',
            selectedInterventionId: 'spoofed-action',
            sourceMode: 'authored_walkthrough',
            sourceBadgeLabel: 'Live Gemini Pro (Spoofed)',
            isPreviewMock: false,
            modelVersion: 'gemini-live-spoof',
            promptVersion: '9.9.9',
            generatedAtIso: '1999-01-01T00:00:00.000Z',
          },
          usage: behavior.usage ?? DEFAULT_MOCK_USAGE_FIXTURE,
          modelVersion,
        };
      }

      case 'provider_error': {
        const err = new Error(behavior.message ?? 'Mock provider transient failure') as Error & {
          usage?: TokenUsageFixture | null;
        };
        if (behavior.usage !== undefined) {
          err.usage = behavior.usage;
        }
        throw err;
      }
    }
  }
}
