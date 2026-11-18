// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  CHECKPOINT_TIMES,
  INCIDENT_001_DEFINITION,
  INCIDENT_002_DEFINITION,
  INCIDENT_003_DEFINITION,
  buildSnapshot,
  ENGINE_VERSION,
  type PublicAnalyzeRequest,
  type AnalyzeIncidentResponse,
} from '@chaos-room/shared';
import { App } from './App.js';
import { CHAOS_PRODUCTION_FIREBASE_CONFIG } from './config/firebase.js';
import { saveMissionBriefingDismissed } from './services/onboardingPreferences.js';
import {
  MockAnalyzeIncidentTransport,
  OfflineUnconfiguredTransport,
  FirebaseCallableTransport,
  validateUnknownResponse,
  normalizeValidatedResponse,
  isConfirmedTerminalBackendStatus,
  type AnalyzeIncidentTransport,
  type MockTransportScenario,
  type FirebaseSdkModules,
} from './services/aiClient.js';

beforeEach(() => {
  window.localStorage.clear();
  saveMissionBriefingDismissed();
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

function createValidAlertResponse(): AnalyzeIncidentResponse {
  const alertWalkthrough = INCIDENT_001_DEFINITION.walkthroughs.alert;
  return {
    status: 'ok',
    incidentId: 'incident-001',
    checkpoint: 'alert',
    selectedInterventionId: null,
    cacheHit: false,
    isMockProvider: false,
    serverTimeIso: new Date().toISOString(),
    message: 'Valid generated analysis',
    result: {
      ...alertWalkthrough,
      sourceMode: 'live_generated',
      sourceBadgeLabel: 'Live AI analysis (Gemini)',
      isPreviewMock: false,
      confidence: {
        level: alertWalkthrough.confidence.level,
        justification: alertWalkthrough.confidence.justification,
      },
      observedFacts: alertWalkthrough.observedFacts.map((f) => ({
        text: f.text,
        citationIds: [...f.citationIds],
      })),
      rankedHypotheses: alertWalkthrough.rankedHypotheses.map((h) => ({
        rank: h.rank,
        statement: h.statement,
        likelihood: h.likelihood,
        supportingCitationIds: [...h.supportingCitationIds],
      })),
      verificationChecks: [...alertWalkthrough.verificationChecks],
      recommendedInterventions: [],
      alternativeExplanations: alertWalkthrough.alternativeExplanations.map((a) => ({
        explanation: a.explanation,
        whyLessLikely: a.whyLessLikely,
        citationIds: [...a.citationIds],
      })),
      missingInformation: [...alertWalkthrough.missingInformation],
    },
  };
}

function createValidEvidenceResponse(): AnalyzeIncidentResponse {
  const evidenceWalkthrough = INCIDENT_001_DEFINITION.walkthroughs.evidence;
  return {
    status: 'ok',
    incidentId: 'incident-001',
    checkpoint: 'evidence',
    selectedInterventionId: null,
    cacheHit: false,
    isMockProvider: false,
    serverTimeIso: new Date().toISOString(),
    message: 'Valid generated evidence analysis',
    result: {
      ...evidenceWalkthrough,
      sourceMode: 'live_generated',
      sourceBadgeLabel: 'Live AI analysis (Gemini)',
      isPreviewMock: false,
      confidence: {
        level: evidenceWalkthrough.confidence.level,
        justification: evidenceWalkthrough.confidence.justification,
      },
      observedFacts: evidenceWalkthrough.observedFacts.map((f) => ({
        text: f.text,
        citationIds: [...f.citationIds],
      })),
      rankedHypotheses: evidenceWalkthrough.rankedHypotheses.map((h) => ({
        rank: h.rank,
        statement: h.statement,
        likelihood: h.likelihood,
        supportingCitationIds: [...h.supportingCitationIds],
      })),
      verificationChecks: [...evidenceWalkthrough.verificationChecks],
      recommendedInterventions: evidenceWalkthrough.recommendedInterventions.map((r) => ({
        interventionId: r.interventionId,
        rationale: r.rationale,
        keyRisk: r.keyRisk,
      })),
      alternativeExplanations: evidenceWalkthrough.alternativeExplanations.map((a) => ({
        explanation: a.explanation,
        whyLessLikely: a.whyLessLikely,
        citationIds: [...a.citationIds],
      })),
      missingInformation: [...evidenceWalkthrough.missingInformation],
    },
  };
}

describe('Phase 4A: Visitor-facing AI integration for Chaos Room', () => {
  // Requirement 1: Deliberate analysis requests and successful live-shaped response
  it('renders deliberate "Request AI analysis" button and completes successful live-shaped AI request', async () => {
    let capturedRequest: PublicAnalyzeRequest | null = null;
    const mockTransport = new MockAnalyzeIncidentTransport((req) => {
      capturedRequest = req;
      return {
        status: 'ok',
        cacheHit: false,
        isMockProvider: false,
        result: {
          ...INCIDENT_001_DEFINITION.walkthroughs.alert,
          conciseAssessment: 'Custom live AI hypothesis: thread pool exhaustion in inventory-db.',
          sourceMode: 'live_generated',
          sourceBadgeLabel: 'Live AI analysis (Gemini)',
          isPreviewMock: false,
        },
      };
    });

    render(<App transportOverride={mockTransport} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    // Initially displays the deterministic authored baseline walkthrough
    expect(screen.getAllByText(/Authored baseline walkthrough/i).length).toBeGreaterThan(0);
    const requestBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
    expect(requestBtn).toBeTruthy();

    // Click to deliberately request AI analysis
    fireEvent.click(requestBtn);

    await waitFor(() => {
      expect(screen.getAllByText(/Live AI analysis \(Gemini\)/i).length).toBeGreaterThan(0);
    });

    expect(capturedRequest).not.toBeNull();
    const req = capturedRequest as unknown as PublicAnalyzeRequest;
    expect(req.incidentId).toBe('incident-001');
    expect(req.checkpoint).toBe('alert');
    expect(req.selectedInterventionId).toBeNull(); // Alert is branch-free
    expect(typeof req.requestId).toBe('string');
    expect(screen.getByText(/Custom live AI hypothesis: thread pool exhaustion in inventory-db/i)).toBeTruthy();

    // Visitor can toggle back to authored walkthrough
    const authoredToggleBtn = screen.getByRole('button', { name: /Authored walkthrough/i });
    fireEvent.click(authoredToggleBtn);
    expect(screen.getAllByText(/Authored baseline walkthrough/i).length).toBeGreaterThan(0);

    // Visitor can toggle back to AI analysis
    const aiToggleBtn = screen.getByRole('button', { name: /AI analysis/i });
    fireEvent.click(aiToggleBtn);
    expect(screen.getByText(/Custom live AI hypothesis/i)).toBeTruthy();
  });

  // Requirement 2: Cached responses
  it('handles shared cached AI analysis responses correctly', async () => {
    const mockTransport = new MockAnalyzeIncidentTransport(() => ({
      status: 'cached',
      cacheHit: true,
      isMockProvider: false,
      result: {
        ...INCIDENT_001_DEFINITION.walkthroughs.alert,
        conciseAssessment: 'Cached analysis served from Firestore shared cache.',
        sourceMode: 'preview_cached_ai',
        sourceBadgeLabel: 'Shared cached AI analysis (Gemini)',
        isPreviewMock: false,
      },
    }));

    render(<App transportOverride={mockTransport} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    const requestBtn = screen.getByRole('button', { name: /Request AI analysis/i });
    fireEvent.click(requestBtn);

    await waitFor(() => {
      expect(screen.getAllByText(/Shared cached AI analysis \(Gemini\)/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/Cached analysis served from Firestore shared cache/i)).toBeTruthy();
    });
  });

  // Requirement 3: Honest status badges and authored fallback preservation
  it('handles disabled, quota, timeout, invalid-output, version-mismatch, and unavailable statuses with authored fallbacks', async () => {
    const statuses = [
      { status: 'disabled' as const, expectedBadge: /AI generation disabled/i },
      { status: 'quota_reached' as const, expectedBadge: /AI generation limit reached/i },
      { status: 'timeout' as const, expectedBadge: /AI request timed out/i },
      { status: 'invalid_output' as const, expectedBadge: /Model output rejected by validator/i },
      { status: 'version_mismatch' as const, expectedBadge: /Scenario\/Engine version mismatch/i },
      { status: 'unavailable' as const, expectedBadge: /AI service unavailable/i },
    ];

    for (const item of statuses) {
      const mockTransport = new MockAnalyzeIncidentTransport(() => ({
        status: item.status,
        message: `Simulated failure for status: ${item.status}`,
      }));

      const { unmount } = render(<App transportOverride={mockTransport} />);
      fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

      const requestBtn = screen.getByRole('button', { name: /Request AI analysis/i });
      fireEvent.click(requestBtn);

      await waitFor(() => {
        expect(screen.getAllByText(item.expectedBadge).length).toBeGreaterThan(0);
      });

      // Crucial: authored walkthrough content remains accessible
      expect(screen.getByText(/Assessment Summary \(Hypothesis — Not Ground Truth\)/i)).toBeTruthy();
      expect(screen.getByText(INCIDENT_001_DEFINITION.walkthroughs.alert.conciseAssessment)).toBeTruthy();

      unmount();
    }
  }, 15000);

  // Review Item 1: Transport ignores cancellation; A starts, visitor leaves/returns, B starts, then A resolves/rejects. B remains unaffected.
  it('ensures B remains completely unaffected when transport ignores cancellation, visitor leaves and returns, B starts, and A resolves or rejects late', async () => {
    let resolveA: ((val: MockTransportScenario) => void) | null = null;
    let resolveB: ((val: MockTransportScenario) => void) | null = null;
    let invocationCount = 0;

    const mockTransport = new MockAnalyzeIncidentTransport(() => {
      invocationCount++;
      if (invocationCount === 1) {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveB = resolve;
      });
    });

    render(<App transportOverride={mockTransport} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    // 1. Request A starts at Alert (03:00)
    fireEvent.click(screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i }));
    expect(invocationCount).toBe(1);

    // 2. Visitor leaves Alert to Evidence (06:00)
    const scrubber = screen.getByLabelText(/03:00 \/ 15:00/i);
    fireEvent.change(scrubber, { target: { value: String(CHECKPOINT_TIMES.evidence) } });

    // 3. Visitor returns to Alert (03:00)
    fireEvent.change(scrubber, { target: { value: String(CHECKPOINT_TIMES.alert) } });

    // 4. Request B starts at Alert (03:00)
    const requestBtnB = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
    fireEvent.click(requestBtnB);
    expect(invocationCount).toBe(2);

    // 5. Request A resolves late with stale data
    if (resolveA) {
      const resolver = resolveA as (val: MockTransportScenario) => void;
      resolver({
        status: 'ok',
        cacheHit: false,
        isMockProvider: false,
        result: {
          ...INCIDENT_001_DEFINITION.walkthroughs.alert,
          conciseAssessment: 'STALE LEAKED RESULT A',
          sourceMode: 'live_generated',
          sourceBadgeLabel: 'Live AI analysis (A)',
          isPreviewMock: false,
        },
      });
    }

    // A's late resolution MUST NOT publish or clear B's in-flight loading state!
    expect(screen.queryByText(/STALE LEAKED RESULT A/i)).toBeNull();

    // 6. Request B now resolves with legitimate data
    if (resolveB) {
      const resolver = resolveB as (val: MockTransportScenario) => void;
      resolver({
        status: 'ok',
        cacheHit: false,
        isMockProvider: false,
        result: {
          ...INCIDENT_001_DEFINITION.walkthroughs.alert,
          conciseAssessment: 'VALID FRESH RESULT B',
          sourceMode: 'live_generated',
          sourceBadgeLabel: 'Live AI analysis (B)',
          isPreviewMock: false,
        },
      });
    }

    // Verify B's result is published and A's was ignored
    await waitFor(() => {
      expect(screen.getByText(/VALID FRESH RESULT B/i)).toBeTruthy();
    });
    expect(screen.queryByText(/STALE LEAKED RESULT A/i)).toBeNull();
  });

  // Review Item 2a: Invalidation on Reset individually
  it('invalidates in-flight request on reset and ignores late settlement', async () => {
    let resolveCall: ((val: MockTransportScenario) => void) | null = null;
    const mockTransport = new MockAnalyzeIncidentTransport(() => {
      return new Promise((resolve) => {
        resolveCall = resolve;
      });
    });

    render(<App transportOverride={mockTransport} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    // Start request at Alert
    fireEvent.click(screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i }));

    // Click Reset
    fireEvent.click(screen.getByRole('button', { name: /Reset/i }));

    // Request settles late
    if (resolveCall) {
      const resolver = resolveCall as (val: MockTransportScenario) => void;
      resolver({
        status: 'ok',
        cacheHit: false,
        isMockProvider: false,
        result: {
          ...INCIDENT_001_DEFINITION.walkthroughs.alert,
          conciseAssessment: 'LATE RESET LEAK',
          sourceMode: 'live_generated',
          sourceBadgeLabel: 'Live AI analysis',
          isPreviewMock: false,
        },
      });
    }

    // Advance back to Alert to inspect state
    const scrubber = screen.getByLabelText(/00:00 \/ 15:00/i);
    fireEvent.change(scrubber, { target: { value: String(CHECKPOINT_TIMES.alert) } });

    // Late result was never published
    expect(screen.queryByText(/LATE RESET LEAK/i)).toBeNull();
  });

  // Review Item 2b: Invalidation on Backward Navigation individually
  it('invalidates in-flight request on backward navigation and ignores late settlement', async () => {
    let resolveCall: ((val: MockTransportScenario) => void) | null = null;
    const mockTransport = new MockAnalyzeIncidentTransport(() => {
      return new Promise((resolve) => {
        resolveCall = resolve;
      });
    });

    render(<App transportOverride={mockTransport} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    // Advance to Evidence and select intervention to reach Outcome
    const scrubber = screen.getByLabelText(/03:00 \/ 15:00/i);
    fireEvent.change(scrubber, { target: { value: String(CHECKPOINT_TIMES.evidence) } });
    const applyBtns = screen.getAllByRole('button', { name: /Apply & Jump to Outcome \(15:00\)/i });
    fireEvent.click(applyBtns[0]!);

    // Start request at Outcome (15:00)
    const requestOutcomeBtn = screen.getByRole('button', { name: /Request AI analysis \(OUTCOME\)/i });
    fireEvent.click(requestOutcomeBtn);

    // Visitor navigates backward to Alert (03:00)
    const outcomeScrubber = screen.getByLabelText(/15:00 \/ 15:00/i);
    fireEvent.change(outcomeScrubber, { target: { value: String(CHECKPOINT_TIMES.alert) } });

    // Outcome request resolves late
    if (resolveCall) {
      const resolver = resolveCall as (val: MockTransportScenario) => void;
      resolver({
        status: 'ok',
        cacheHit: false,
        isMockProvider: false,
        result: {
          ...INCIDENT_001_DEFINITION.walkthroughs.alert,
          conciseAssessment: 'LATE OUTCOME LEAK AT ALERT',
          sourceMode: 'live_generated',
          sourceBadgeLabel: 'Live AI analysis',
          isPreviewMock: false,
        },
      });
    }

    // Outcome analysis MUST NOT appear at Alert
    expect(screen.queryByText(/LATE OUTCOME LEAK AT ALERT/i)).toBeNull();
  });

  // Review Item 2c: Invalidation on Outcome Branch Changes individually
  it('invalidates in-flight request on outcome branch change and ignores late settlement', async () => {
    let resolveCall: ((val: MockTransportScenario) => void) | null = null;
    const mockTransport = new MockAnalyzeIncidentTransport(() => {
      return new Promise((resolve) => {
        resolveCall = resolve;
      });
    });

    render(<App transportOverride={mockTransport} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    // Advance to Evidence and select first intervention
    const scrubber = screen.getByLabelText(/03:00 \/ 15:00/i);
    fireEvent.change(scrubber, { target: { value: String(CHECKPOINT_TIMES.evidence) } });
    const applyBtns = screen.getAllByRole('button', { name: /Apply & Jump to Outcome \(15:00\)/i });
    fireEvent.click(applyBtns[0]!); // increase_pool_size

    // Start request for Branch 1
    const requestOutcomeBtn = screen.getByRole('button', { name: /Request AI analysis \(OUTCOME\)/i });
    fireEvent.click(requestOutcomeBtn);

    // Switch branch to second intervention via Debrief comparison card
    const branchSwitchBtns = screen.getAllByRole('button', { name: /Inspect this branch at 15:00/i });
    fireEvent.click(branchSwitchBtns[0]!);

    // Resolve Branch 1 late
    if (resolveCall) {
      const resolver = resolveCall as (val: MockTransportScenario) => void;
      resolver({
        status: 'ok',
        cacheHit: false,
        isMockProvider: false,
        result: {
          ...INCIDENT_001_DEFINITION.walkthroughs.alert,
          conciseAssessment: 'LATE BRANCH 1 RESULT',
          sourceMode: 'live_generated',
          sourceBadgeLabel: 'Live AI analysis',
          isPreviewMock: false,
        },
      });
    }

    // Branch 1 late response must not display on Branch 2
    expect(screen.queryByText(/LATE BRANCH 1 RESULT/i)).toBeNull();
  });

  // Review Item 3: Never-settling transport and late response after client deadline
  it('times out cleanly on never-settling transport and ignores late response arriving after client deadline', async () => {
    let resolveLate: ((val: MockTransportScenario) => void) | null = null;
    const mockTransport = new MockAnalyzeIncidentTransport(() => {
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    });

    // Bounded client deadline set to 40ms for test
    render(<App transportOverride={mockTransport} clientDeadlineMs={40} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    fireEvent.click(screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i }));

    // Await client deadline timeout
    await waitFor(() => {
      expect(screen.getAllByText(/AI request timed out/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/Request exceeded client deadline \(40ms\)/i)).toBeTruthy();
    });

    // Authored fallback remains fully usable
    expect(screen.getByText(INCIDENT_001_DEFINITION.walkthroughs.alert.conciseAssessment)).toBeTruthy();

    // Now transport late resolves
    if (resolveLate) {
      const resolver = resolveLate as (val: MockTransportScenario) => void;
      resolver({
        status: 'ok',
        cacheHit: false,
        isMockProvider: false,
        result: {
          ...INCIDENT_001_DEFINITION.walkthroughs.alert,
          conciseAssessment: 'LATE SETTLEMENT AFTER TIMEOUT',
          sourceMode: 'live_generated',
          sourceBadgeLabel: 'Live AI analysis',
          isPreviewMock: false,
        },
      });
    }

    // Late response must be ignored
    expect(screen.queryByText(/LATE SETTLEMENT AFTER TIMEOUT/i)).toBeNull();
  });

  // Review Item 4: Retry semantics across ambiguous failures vs confirmed terminal outcomes
  it('preserves requestId across client deadline timeout recovery and network failure recovery, but generates new requestId for confirmed terminal failure retry', async () => {
    const capturedRequests: PublicAnalyzeRequest[] = [];
    let callIndex = 0;

    const mockTransport = new MockAnalyzeIncidentTransport((req) => {
      capturedRequests.push(req);
      callIndex++;
      if (callIndex === 1) {
        // First call: client deadline will expire via App clientDeadlineMs: 40ms
        return new Promise(() => {}); // never settles
      }
      if (callIndex === 2) {
        // Second call (recovery after timeout): fails with network transport drop (ambiguous)
        throw new Error('Network transport drop');
      }
      if (callIndex === 3) {
        // Third call (recovery after network drop): fails with confirmed terminal failure (quota reached)
        return {
          status: 'quota_reached',
          reasonCode: 'daily_budget_exhausted',
          message: 'Daily generation quota exceeded.',
        };
      }
      // Fourth call (explicit new attempt after terminal failure): successful
      return {
        status: 'ok',
        result: {
          ...INCIDENT_001_DEFINITION.walkthroughs.alert,
          conciseAssessment: 'Recovered in fresh attempt.',
          sourceMode: 'live_generated',
          sourceBadgeLabel: 'Live AI analysis (Gemini)',
          isPreviewMock: false,
        },
      };
    });

    render(<App transportOverride={mockTransport} clientDeadlineMs={40} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    // 1. Call 1: Start request at Alert (03:00) -> times out on client deadline
    fireEvent.click(screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i }));
    await waitFor(() => {
      expect(screen.getAllByText(/AI request timed out/i).length).toBeGreaterThan(0);
    });
    expect(capturedRequests.length).toBe(1);
    const initialRequestId = capturedRequests[0]!.requestId;

    // 2. Call 2: Recover from client timeout -> MUST preserve initial requestId!
    const retryTimeoutBtn = screen.getByRole('button', { name: /Retry request \(ALERT\)/i });
    fireEvent.click(retryTimeoutBtn);
    await waitFor(() => {
      expect(screen.getAllByText(/AI service unavailable/i).length).toBeGreaterThan(0);
    });
    expect(capturedRequests.length).toBe(2);
    expect(capturedRequests[1]!.requestId).toBe(initialRequestId);

    // 3. Call 3: Recover from network transport failure -> MUST preserve initial requestId!
    const retryNetworkBtn = screen.getByRole('button', { name: /Retry request \(ALERT\)/i });
    fireEvent.click(retryNetworkBtn);
    await waitFor(() => {
      expect(screen.getAllByText(/AI generation limit reached/i).length).toBeGreaterThan(0);
    });
    expect(capturedRequests.length).toBe(3);
    expect(capturedRequests[2]!.requestId).toBe(initialRequestId);

    // 4. Call 4: Confirmed terminal failure (quota_reached) -> explicit new attempt MUST generate a NEW requestId!
    const newAttemptBtn = screen.getByRole('button', { name: /Retry AI analysis \(ALERT\)/i });
    fireEvent.click(newAttemptBtn);
    await waitFor(() => {
      expect(screen.getByText('Recovered in fresh attempt.')).toBeTruthy();
    });
    expect(capturedRequests.length).toBe(4);
    expect(capturedRequests[3]!.requestId).not.toBe(initialRequestId);
  });

  // Review Item 5: Complete runtime result validation
  describe('Runtime result validation', () => {
    const validSnap = buildSnapshot({
      scenario: INCIDENT_001_DEFINITION,
      seed: INCIDENT_001_DEFINITION.defaultSeed,
      simTimeSeconds: CHECKPOINT_TIMES.alert,
      selectedInterventionId: null,
    });

    const expectedState = {
      incidentId: 'incident-001',
      scenarioVersion: '1.0.0',
      engineVersion: ENGINE_VERSION,
      checkpoint: 'alert' as const,
      selectedInterventionId: null,
    };

    it('accepts a fully valid envelope and result', () => {
      const valid = createValidAlertResponse();
      const val = validateUnknownResponse(valid, expectedState, validSnap);
      expect(val.valid).toBe(true);
      expect(val.errors).toEqual([]);
    });

    it('safely handles normalizeValidatedResponse with result: {} without throwing on trim', () => {
      const emptyResultEnvelope = {
        ...createValidAlertResponse(),
        result: {},
      };
      // Must not throw TypeError (.trim() on undefined)
      const res = normalizeValidatedResponse(emptyResultEnvelope, expectedState, validSnap);
      expect(res.status).toBe('invalid_output');
      expect(res.reasonCode).toBe('client_validation_failed');
      expect(res.message).toContain('result.conciseAssessment must be a non-empty string');
    });

    it('rejects a valid result with confidence removed with specific error', () => {
      const withoutConfidence = createValidAlertResponse();
      delete (withoutConfidence.result as unknown as Record<string, unknown>).confidence;
      const val = validateUnknownResponse(withoutConfidence, expectedState, validSnap);
      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('result.confidence must be an object'))).toBe(true);

      const norm = normalizeValidatedResponse(withoutConfidence, expectedState, validSnap);
      expect(norm.status).toBe('invalid_output');
    });

    it('rejects confidence with an invalid level with specific error', () => {
      const badLevel = createValidAlertResponse();
      if (badLevel.result) {
        (badLevel.result.confidence as unknown as { level: string }).level = 'Extreme';
      }
      const val = validateUnknownResponse(badLevel, expectedState, validSnap);
      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('result.confidence.level must be "Low", "Medium", or "High"'))).toBe(true);
    });

    it('rejects empty or whitespace-only conciseAssessment with specific error', () => {
      const emptyConcise = createValidAlertResponse();
      emptyConcise.result!.conciseAssessment = '   ';
      const val = validateUnknownResponse(emptyConcise, expectedState, validSnap);
      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('result.conciseAssessment must be a non-empty string'))).toBe(true);
    });

    it('rejects nested checkpoint and incidentId mismatches with specific errors', () => {
      const mismatchedCp = createValidAlertResponse();
      mismatchedCp.result!.checkpoint = 'outcome' as any;
      const val1 = validateUnknownResponse(mismatchedCp, expectedState, validSnap);
      expect(val1.valid).toBe(false);
      expect(val1.errors.some((e) => e.includes('Nested result.checkpoint'))).toBe(true);

      const mismatchedInc = createValidAlertResponse();
      mismatchedInc.result!.incidentId = 'incident-002';
      const val2 = validateUnknownResponse(mismatchedInc, expectedState, validSnap);
      expect(val2.valid).toBe(false);
      expect(val2.errors.some((e) => e.includes('Nested result.incidentId'))).toBe(true);
    });

    it('rejects non-existent citation in observedFacts[0].citationIds with specific error', () => {
      const badCitation = createValidAlertResponse();
      badCitation.result!.observedFacts[0]!.citationIds = ['nonexistent_fake_evidence_id_404'];
      const val = validateUnknownResponse(badCitation, expectedState, validSnap);
      expect(val.valid).toBe(false);
      expect(
        val.errors.some((e) =>
          e.includes('Observed fact citation "nonexistent_fake_evidence_id_404" does not exist in snapshot visibleEvidence'),
        ),
      ).toBe(true);
    });

    it('validates citations against reconstructed canonical checkpoint snapshot, not arbitrary playback tick', () => {
      // Reconstructed canonical snapshot at 03:00 has evidence cards up to 03:00 (including ev-met-150)
      const canonicalAlertSnap = buildSnapshot({
        scenario: INCIDENT_001_DEFINITION,
        seed: INCIDENT_001_DEFINITION.defaultSeed,
        simTimeSeconds: CHECKPOINT_TIMES.alert, // 180s
        selectedInterventionId: null,
      });

      // An arbitrary scrubbed playback tick snapshot at 01:00 (60s) where ev-met-150 is NOT yet visible
      const earlyPlaybackTickSnap = buildSnapshot({
        scenario: INCIDENT_001_DEFINITION,
        seed: INCIDENT_001_DEFINITION.defaultSeed,
        simTimeSeconds: 60,
        selectedInterventionId: null,
      });

      const alertAnalysis = createValidAlertResponse();

      // Validating against early playback tick snapshot fails because 03:00 evidence is not yet visible at 01:00
      const earlyVal = validateUnknownResponse(alertAnalysis, expectedState, earlyPlaybackTickSnap);
      expect(earlyVal.valid).toBe(false);

      // Validating against reconstructed canonical Alert checkpoint snapshot succeeds cleanly!
      const canonicalVal = validateUnknownResponse(alertAnalysis, expectedState, canonicalAlertSnap);
      expect(canonicalVal.valid).toBe(true);
    });

    it('rejects recommendedInterventions with non-string rationale and keyRisk with specific errors', () => {
      const evidenceSnap = buildSnapshot({
        scenario: INCIDENT_001_DEFINITION,
        seed: INCIDENT_001_DEFINITION.defaultSeed,
        simTimeSeconds: CHECKPOINT_TIMES.evidence,
        selectedInterventionId: null,
      });

      const expectedEvidenceState = {
        incidentId: 'incident-001',
        scenarioVersion: '1.0.0',
        engineVersion: ENGINE_VERSION,
        checkpoint: 'evidence' as const,
        selectedInterventionId: null,
      };

      const validEvidence = createValidEvidenceResponse();
      const valClean = validateUnknownResponse(validEvidence, expectedEvidenceState, evidenceSnap);
      expect(valClean.valid).toBe(true);

      // Malformed rationale: object instead of string
      const badRationale = createValidEvidenceResponse();
      (badRationale.result!.recommendedInterventions[0] as unknown as { rationale: unknown }).rationale = { nested: 'bad object' };
      const val1 = validateUnknownResponse(badRationale, expectedEvidenceState, evidenceSnap);
      expect(val1.valid).toBe(false);
      expect(val1.errors.some((e) => e.includes('result.recommendedInterventions[0].rationale must be a string'))).toBe(true);
      const norm1 = normalizeValidatedResponse(badRationale, expectedEvidenceState, evidenceSnap);
      expect(norm1.status).toBe('invalid_output');

      // Malformed keyRisk: object instead of string
      const badKeyRisk = createValidEvidenceResponse();
      (badKeyRisk.result!.recommendedInterventions[0] as unknown as { keyRisk: unknown }).keyRisk = { nested: 'bad object' };
      const val2 = validateUnknownResponse(badKeyRisk, expectedEvidenceState, evidenceSnap);
      expect(val2.valid).toBe(false);
      expect(val2.errors.some((e) => e.includes('result.recommendedInterventions[0].keyRisk must be a string'))).toBe(true);
      const norm2 = normalizeValidatedResponse(badKeyRisk, expectedEvidenceState, evidenceSnap);
      expect(norm2.status).toBe('invalid_output');
    });

    it('renders invalid_output honest fallback in UI when response has malformed intervention fields and remains usable', async () => {
      const badInterventionResponse: AnalyzeIncidentResponse = {
        ...createValidEvidenceResponse(),
      };
      (badInterventionResponse.result!.recommendedInterventions[0] as unknown as { rationale: unknown }).rationale = { bad: 'object' };

      const mockTransport = new MockAnalyzeIncidentTransport(() => badInterventionResponse);

      render(<App transportOverride={mockTransport} />);

      // Jump to 06:00 Evidence
      fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence/i }));

      const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(EVIDENCE\)/i });
      fireEvent.click(reqBtn);

      // Await honest fallback banner
      await waitFor(() => {
        expect(screen.getAllByText(/Model output rejected by validator/i).length).toBeGreaterThan(0);
      });

      // Crucial: Assessment and investigation controls remain fully usable
      expect(screen.getByText(/Authored baseline walkthrough/i)).toBeTruthy();
      expect(screen.getByText(/Reservation attempts timing out/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /03:00 Alert/i })).toBeTruthy();
    });
  });

  // Review Item 6: Firebase initialization recovery and error handling
  describe('Firebase initialization recovery', () => {
    const validConfig = {
      projectId: 'test-project',
      apiKey: 'test-key',
      appId: 'test-app',
      recaptchaSiteKey: 'test-site-key',
      region: 'us-central1',
    };

    const dummyRequest: PublicAnalyzeRequest = {
      incidentId: 'incident-001',
      scenarioVersion: '1.0.0',
      engineVersion: ENGINE_VERSION,
      checkpoint: 'alert',
      selectedInterventionId: null,
      requestId: 'test-req-1',
    };

    it('clears failed initialization so subsequent deliberate retry can succeed, while deduplicating concurrent calls', async () => {
      let loaderCallCount = 0;
      let shouldFail = true;

      const dynamicLoader = async (): Promise<FirebaseSdkModules> => {
        loaderCallCount++;
        if (shouldFail) {
          throw new Error('Transient SDK network error');
        }
        return {
          initializeApp: () => ({ name: '[CHAOS_ROOM]', options: validConfig }),
          getApps: () => [],
          getAuth: () => ({ currentUser: { uid: 'anon-123' } }),
          signInAnonymously: async () => ({ user: { uid: 'anon-123' } }),
          initializeAppCheck: () => ({}),
          ReCaptchaEnterpriseProvider: class {} as unknown as new (siteKey: string) => unknown,
          getFunctions: () => ({}),
          httpsCallable: () => async () => ({
            data: {
              status: 'ok',
              incidentId: 'incident-001',
              checkpoint: 'alert',
              selectedInterventionId: null,
              message: 'Recovered after transient error',
            },
          }),
        };
      };

      const transport = new FirebaseCallableTransport(validConfig, dynamicLoader);

      // Call 1 & Call 2: concurrent callers during failure
      const [res1, res2] = await Promise.all([
        transport.analyzeIncident(dummyRequest),
        transport.analyzeIncident(dummyRequest),
      ]);

      // Both receive the failure
      expect(res1.status).toBe('unavailable');
      expect(res1.reasonCode).toBe('initialization_failure');
      expect(res2.status).toBe('unavailable');
      expect(res2.reasonCode).toBe('initialization_failure');
      // Crucial: loader was invoked only ONCE for the concurrent pair (deduplication verified)
      expect(loaderCallCount).toBe(1);

      // Call 3: deliberate retry after transient failure resolved
      shouldFail = false;
      const res3 = await transport.analyzeIncident(dummyRequest);
      expect(res3.status).toBe('ok');
      expect(res3.message).toBe('Recovered after transient error');
      // Loader was called a second time (cleared initPromise allowed fresh initialization)
      expect(loaderCallCount).toBe(2);
    });

    it('enforces named app verification, App Check requirement, and Auth error handling', async () => {
      // Missing recaptcha site key
      const configNoRecaptcha = { ...validConfig, recaptchaSiteKey: '' };
      const transportNoKey = new FirebaseCallableTransport(configNoRecaptcha);
      const resKey = await transportNoKey.analyzeIncident(dummyRequest);
      expect(resKey.status).toBe('unavailable');
      expect(resKey.reasonCode).toBe('app_check_required');

      // Auth error
      const authFailLoader = async (): Promise<FirebaseSdkModules> => ({
        initializeApp: () => ({ name: '[CHAOS_ROOM]', options: validConfig }),
        getApps: () => [],
        getAuth: () => ({ currentUser: null }),
        signInAnonymously: async () => {
          throw new Error('Firebase Auth network blocked');
        },
        initializeAppCheck: () => ({}),
        ReCaptchaEnterpriseProvider: class {} as unknown as new (siteKey: string) => unknown,
        getFunctions: () => ({}),
        httpsCallable: () => async () => ({ data: {} }),
      });
      const transportAuth = new FirebaseCallableTransport(validConfig, authFailLoader);
      const resAuth = await transportAuth.analyzeIncident(dummyRequest);
      expect(resAuth.status).toBe('unavailable');
      expect(resAuth.reasonCode).toBe('auth_failure');
    });
  });

  // Review Item 7: Offline completion of each of the three scenarios
  it('completes offline investigation for Scenario 1, Scenario 2, and Scenario 3 without errors', async () => {
    const offlineTransport = new OfflineUnconfiguredTransport();

    // Scenario 1
    const { unmount: unmount1 } = render(<App transportOverride={offlineTransport} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));
    const scrubber1 = screen.getByLabelText(/03:00 \/ 15:00/i);
    fireEvent.change(scrubber1, { target: { value: String(CHECKPOINT_TIMES.evidence) } });
    const applyBtns1 = screen.getAllByRole('button', { name: /Apply & Jump to Outcome \(15:00\)/i });
    fireEvent.click(applyBtns1[0]!);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: new RegExp(INCIDENT_001_DEFINITION.debrief.technicalTitle, 'i'),
        }),
      ).toBeTruthy();
    });
    unmount1();

    // Scenario 2
    const { unmount: unmount2 } = render(<App transportOverride={offlineTransport} />);
    const scenarioSelect2 = screen.getByLabelText(/Select incident scenario to investigate/i);
    fireEvent.change(scenarioSelect2, { target: { value: 'incident-002' } });
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));
    const scrubber2 = screen.getByLabelText(/03:00 \/ 15:00/i);
    fireEvent.change(scrubber2, { target: { value: String(CHECKPOINT_TIMES.evidence) } });
    const applyBtns2 = screen.getAllByRole('button', { name: /Apply & Jump to Outcome \(15:00\)/i });
    fireEvent.click(applyBtns2[0]!);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: new RegExp(INCIDENT_002_DEFINITION.debrief.technicalTitle, 'i'),
        }),
      ).toBeTruthy();
    });
    unmount2();

    // Scenario 3
    const { unmount: unmount3 } = render(<App transportOverride={offlineTransport} />);
    const scenarioSelect3 = screen.getByLabelText(/Select incident scenario to investigate/i);
    fireEvent.change(scenarioSelect3, { target: { value: 'incident-003' } });
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));
    const scrubber3 = screen.getByLabelText(/03:00 \/ 15:00/i);
    fireEvent.change(scrubber3, { target: { value: String(CHECKPOINT_TIMES.evidence) } });
    const applyBtns3 = screen.getAllByRole('button', { name: /Apply & Jump to Outcome \(15:00\)/i });
    fireEvent.click(applyBtns3[0]!);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: new RegExp(INCIDENT_003_DEFINITION.debrief.technicalTitle, 'i'),
        }),
      ).toBeTruthy();
    });
    unmount3();
  }, 15000);

  // Decision Gate & Branch-free preservation
  it('keeps Alert and Evidence requests strictly branch-free', async () => {
    const requests: PublicAnalyzeRequest[] = [];
    const mockTransport = new MockAnalyzeIncidentTransport((req) => {
      requests.push(req);
      return { status: 'ok', isMockProvider: true };
    });

    render(<App transportOverride={mockTransport} />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    // Request at Alert (03:00)
    fireEvent.click(screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i }));

    await waitFor(() => {
      expect(requests.length).toBe(1);
    });
    expect(requests[0]!.checkpoint).toBe('alert');
    expect(requests[0]!.selectedInterventionId).toBeNull();

    // Advance to Evidence (06:00)
    const scrubber = screen.getByLabelText(/03:00 \/ 15:00/i);
    fireEvent.change(scrubber, { target: { value: String(CHECKPOINT_TIMES.evidence) } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Request AI analysis \(EVIDENCE\)/i })).toBeTruthy();
    });

    // Request at Evidence (06:00)
    fireEvent.click(screen.getByRole('button', { name: /Request AI analysis \(EVIDENCE\)/i }));

    await waitFor(() => {
      expect(requests.length).toBe(2);
    });
    expect(requests[1]!.checkpoint).toBe('evidence');
    expect(requests[1]!.selectedInterventionId).toBeNull(); // Strictly null as required by backend contract
  });

  it('enforces 06:00 decision gate: cannot advance to outcome without intervention', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    // Advance to 06:00
    const scrubber = screen.getByLabelText(/03:00 \/ 15:00/i);
    fireEvent.change(scrubber, { target: { value: String(CHECKPOINT_TIMES.evidence) } });

    // Scrubber is clamped to 06:00 when attempting to scrub to 15:00 without intervention
    fireEvent.change(scrubber, { target: { value: String(CHECKPOINT_TIMES.outcome) } });
    expect(screen.getByText(/06:00 \/ 15:00/i)).toBeTruthy();
  });

  // Review Item: Restrict screenshot/mock transport injection
  describe('Global transport override restrictions', () => {
    it('completely ignores window.__CHAOS_TRANSPORT_OVERRIDE__ in production environment', async () => {
      const originalDev = import.meta.env.DEV;
      const originalMode = import.meta.env.MODE;

      try {
        // Simulate production environment
        (import.meta.env as unknown as { DEV: boolean; MODE: string }).DEV = false;
        (import.meta.env as unknown as { DEV: boolean; MODE: string }).MODE = 'production';

        const spyFn = vi.fn().mockResolvedValue({
          status: 'ok',
          incidentId: 'incident-001',
          checkpoint: 'alert',
          selectedInterventionId: null,
          cacheHit: false,
          isMockProvider: true,
          serverTimeIso: new Date().toISOString(),
          message: 'Fabricated mock should never be called in production',
        });

        (window as unknown as { __CHAOS_TRANSPORT_OVERRIDE__?: { analyzeIncident: typeof spyFn } }).__CHAOS_TRANSPORT_OVERRIDE__ = {
          analyzeIncident: spyFn,
        };

        // Render App in production mode with NO transportOverride prop
        render(<App environmentOverride={{ DEV: false, MODE: 'production' }} />);
        fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

        const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
        fireEvent.click(reqBtn);

        // Await resolution
        await waitFor(() => {
          // In production with unconfigured Firebase, it falls back to OfflineUnconfiguredTransport
          expect(screen.getAllByText(/AI backend connection is not configured/i).length).toBeGreaterThan(0);
        });

        // The global override spy MUST NOT have been called!
        expect(spyFn).not.toHaveBeenCalled();
      } finally {
        (import.meta.env as unknown as { DEV: boolean; MODE: string }).DEV = originalDev;
        (import.meta.env as unknown as { DEV: boolean; MODE: string }).MODE = originalMode;
        delete (window as unknown as { __CHAOS_TRANSPORT_OVERRIDE__?: unknown }).__CHAOS_TRANSPORT_OVERRIDE__;
      }
    });

    it('forces mock provenance on injected override in review mode', async () => {
      const originalDev = import.meta.env.DEV;
      const originalMode = import.meta.env.MODE;

      try {
        const validAlert = createValidAlertResponse();
        // Fabricate as live Gemini
        validAlert.isMockProvider = false;
        validAlert.result!.isPreviewMock = false;
        validAlert.result!.sourceMode = 'live_generated';
        validAlert.result!.sourceBadgeLabel = 'Live AI analysis (Gemini)';

        (window as unknown as { __CHAOS_TRANSPORT_OVERRIDE__?: { analyzeIncident: () => Promise<AnalyzeIncidentResponse> } }).__CHAOS_TRANSPORT_OVERRIDE__ = {
          analyzeIncident: async () => validAlert,
        };

        render(<App environmentOverride={{ DEV: false, MODE: 'review' }} />);
        fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

        const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
        fireEvent.click(reqBtn);

        await waitFor(() => {
          // App.tsx must have forced mock provenance!
          expect(screen.getByText(/Showing mocked UI state/i)).toBeTruthy();
        });
      } finally {
        (import.meta.env as unknown as { DEV: boolean; MODE: string }).DEV = originalDev;
        (import.meta.env as unknown as { DEV: boolean; MODE: string }).MODE = originalMode;
        delete (window as unknown as { __CHAOS_TRANSPORT_OVERRIDE__?: unknown }).__CHAOS_TRANSPORT_OVERRIDE__;
      }
    });

    it('uses MockAnalyzeIncidentTransport in development mode even if window.__CHAOS_FIREBASE_CONFIG__ is present', async () => {
      try {
        (window as unknown as { __CHAOS_FIREBASE_CONFIG__?: unknown }).__CHAOS_FIREBASE_CONFIG__ =
          CHAOS_PRODUCTION_FIREBASE_CONFIG;

        render(<App environmentOverride={{ DEV: true, MODE: 'development' }} />);
        fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

        const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
        fireEvent.click(reqBtn);

        await waitFor(() => {
          expect(screen.getAllByText(/Local mock: Generated AI analysis/i).length).toBeGreaterThan(0);
          expect(screen.getByText(/Showing mocked UI state/i)).toBeTruthy();
        });
      } finally {
        delete (window as unknown as { __CHAOS_FIREBASE_CONFIG__?: unknown }).__CHAOS_FIREBASE_CONFIG__;
      }
    });

    it('uses live Firebase client config in production mode when configured and retains valid CHAOS_PRODUCTION_FIREBASE_CONFIG', async () => {
      expect(CHAOS_PRODUCTION_FIREBASE_CONFIG.projectId).toBe('mikerestrepo-chaos-room');
      expect(CHAOS_PRODUCTION_FIREBASE_CONFIG.functionsRegion).toBe('us-central1');
      expect(CHAOS_PRODUCTION_FIREBASE_CONFIG.appId.trim().length).toBeGreaterThan(0);
      expect(CHAOS_PRODUCTION_FIREBASE_CONFIG.apiKey.trim().length).toBeGreaterThan(0);
      expect((CHAOS_PRODUCTION_FIREBASE_CONFIG.recaptchaSiteKey ?? '').trim().length).toBeGreaterThan(0);

      const analyzeSpy = vi
        .spyOn(FirebaseCallableTransport.prototype, 'analyzeIncident')
        .mockResolvedValueOnce(createValidAlertResponse());

      try {
        (window as unknown as { __CHAOS_FIREBASE_CONFIG__?: unknown }).__CHAOS_FIREBASE_CONFIG__ =
          CHAOS_PRODUCTION_FIREBASE_CONFIG;

        render(<App environmentOverride={{ DEV: false, MODE: 'production' }} />);
        fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

        const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
        fireEvent.click(reqBtn);

        await waitFor(() => {
          expect(screen.getAllByText(/Live AI analysis \(Gemini\)/i).length).toBeGreaterThan(0);
        });
        expect(analyzeSpy).toHaveBeenCalledTimes(1);
      } finally {
        analyzeSpy.mockRestore();
        delete (window as unknown as { __CHAOS_FIREBASE_CONFIG__?: unknown }).__CHAOS_FIREBASE_CONFIG__;
      }
    });
  });

  describe('Timing instrumentation, non-blocking UI during loading, and stale response prevention', () => {
    it('populates window.__CHAOS_AI_LAST_TIMING__ with observable stages upon analysis completion', async () => {
      const validAlert = createValidAlertResponse();
      const mockTransport = new MockAnalyzeIncidentTransport(() => ({
        status: 'ok',
        cacheHit: false,
        isMockProvider: false,
        result: validAlert.result,
      }));

      render(<App transportOverride={mockTransport} />);
      fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

      const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
      fireEvent.click(reqBtn);

      await waitFor(() => {
        expect(screen.getAllByText(/Live AI analysis \(Gemini\)/i).length).toBeGreaterThan(0);
      });

      const timing = (window as unknown as { __CHAOS_AI_LAST_TIMING__?: {
        requestId: string;
        checkpoint: string;
        clickTimestampMs: number;
        transportDurationMs: number;
        validationDurationMs: number;
        stageObservability: Record<string, string>;
      } }).__CHAOS_AI_LAST_TIMING__;

      expect(timing).toBeDefined();
      expect(timing?.checkpoint).toBe('alert');
      expect(typeof timing?.clickTimestampMs).toBe('number');
      expect(typeof timing?.transportDurationMs).toBe('number');
      expect(typeof timing?.validationDurationMs).toBe('number');
      expect(timing?.stageObservability.sdkImport).toBe('observable');
      expect(timing?.stageObservability.authAndAppCheck).toContain('observable_aggregate');
      expect(timing?.stageObservability.callableAndTokenExecution).toContain('observable');
      expect(timing?.stageObservability.validation).toBe('observable');
    });

    it('records invocation-specific timing for first vs repeat FirebaseCallableTransport calls', async () => {
      const testConfig = {
        projectId: 'test-project',
        apiKey: 'test-key',
        appId: 'test-app',
        recaptchaSiteKey: 'test-site-key',
      };
      let callCount = 0;
      const mockLoader = async (): Promise<FirebaseSdkModules> => ({
        initializeApp: () => ({ name: '[CHAOS_ROOM]', options: testConfig }),
        getApps: () => [],
        getAuth: () => ({ currentUser: null }),
        signInAnonymously: async () => ({ user: { uid: 'anon-user-123' } }),
        initializeAppCheck: () => ({}),
        ReCaptchaEnterpriseProvider: class {} as unknown as FirebaseSdkModules['ReCaptchaEnterpriseProvider'],
        getFunctions: () => ({}),
        httpsCallable: () => async () => {
          callCount++;
          return {
            data: {
              status: 'ok',
              incidentId: 'incident-001',
              checkpoint: 'alert',
              selectedInterventionId: null,
              cacheHit: false,
              isMockProvider: false,
              serverTimeIso: new Date().toISOString(),
              message: `Success call ${callCount}`,
              result: INCIDENT_001_DEFINITION.walkthroughs.alert,
            },
          };
        },
      });

      const transport = new FirebaseCallableTransport(testConfig, mockLoader);

      const req1: PublicAnalyzeRequest = {
        incidentId: 'incident-001',
        scenarioVersion: '1.0.0',
        engineVersion: ENGINE_VERSION,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-first-call-001',
      };
      const res1 = await transport.analyzeIncident(req1);
      expect(res1.status).toBe('ok');

      const timing1 = transport.getTimingForRequest('req-first-call-001');
      expect(timing1).toBeDefined();
      expect(timing1?.requestId).toBe('req-first-call-001');
      expect(timing1?.isFirstTransportCall).toBe(true);
      expect(timing1?.isColdSdk).toBe(true);
      expect(timing1?.isColdAuth).toBe(true);
      expect(typeof timing1?.sdkImportMs).toBe('number');
      expect(typeof timing1?.authAppCheckMs).toBe('number');
      expect(typeof timing1?.callableAndTokenExecutionMs).toBe('number');

      // Second call (repeat call on existing warm transport)
      const req2: PublicAnalyzeRequest = {
        incidentId: 'incident-001',
        scenarioVersion: '1.0.0',
        engineVersion: ENGINE_VERSION,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: 'req-repeat-call-002',
      };
      const res2 = await transport.analyzeIncident(req2);
      expect(res2.status).toBe('ok');

      const timing2 = transport.getTimingForRequest('req-repeat-call-002');
      expect(timing2).toBeDefined();
      expect(timing2?.requestId).toBe('req-repeat-call-002');
      expect(timing2?.isFirstTransportCall).toBe(false);
      expect(timing2?.isColdSdk).toBe(false);
      expect(timing2?.isColdAuth).toBe(false);
      // Repeat calls MUST NOT reuse initialization durations or cold flags!
      expect(timing2?.sdkImportMs).toBe(0);
      expect(timing2?.authAppCheckMs).toBe(0);
      expect(typeof timing2?.callableAndTokenExecutionMs).toBe('number');

      // Verify timing1 was not mutated or overwritten by timing2
      expect(transport.getTimingForRequest('req-first-call-001')?.isFirstTransportCall).toBe(true);
    });

    it('distinguishes transport invocations when retries reuse a request ID and records DOM commit timing', async () => {
      const testConfig = {
        projectId: 'test-project',
        apiKey: 'test-key',
        appId: 'test-app',
        recaptchaSiteKey: 'test-site-key',
      };
      let callCount = 0;
      const mockLoader = async (): Promise<FirebaseSdkModules> => ({
        initializeApp: () => ({ name: '[CHAOS_ROOM]', options: testConfig }),
        getApps: () => [],
        getAuth: () => ({ currentUser: null }),
        signInAnonymously: async () => ({ user: { uid: 'anon-user-123' } }),
        initializeAppCheck: () => ({}),
        ReCaptchaEnterpriseProvider: class {} as unknown as FirebaseSdkModules['ReCaptchaEnterpriseProvider'],
        getFunctions: () => ({}),
        httpsCallable: () => async () => {
          callCount++;
          if (callCount === 1) {
            // First invocation fails with an internal network error (retryable)
            throw new Error('Transient network error');
          }
          return {
            data: {
              status: 'ok',
              incidentId: 'incident-001',
              checkpoint: 'alert',
              selectedInterventionId: null,
              cacheHit: false,
              isMockProvider: false,
              serverTimeIso: new Date().toISOString(),
              message: `Success retry call ${callCount}`,
              result: INCIDENT_001_DEFINITION.walkthroughs.alert,
            },
          };
        },
      });

      const transport = new FirebaseCallableTransport(testConfig, mockLoader);
      const sharedRequestId = 'req-retry-shared-001';
      const req: PublicAnalyzeRequest = {
        incidentId: 'incident-001',
        scenarioVersion: '1.0.0',
        engineVersion: ENGINE_VERSION,
        checkpoint: 'alert',
        selectedInterventionId: null,
        requestId: sharedRequestId,
      };

      // Invocation 1: Fails
      const res1 = await transport.analyzeIncident(req);
      expect(res1.status).toBe('unavailable');

      // Invocation 2: Retried with same requestId
      const res2 = await transport.analyzeIncident(req);
      expect(res2.status).toBe('ok');

      // Verify both invocations are recorded separately under the same requestId
      const allTimings = transport.getAllTimingsForRequest(sharedRequestId);
      expect(allTimings).toHaveLength(2);
      expect(allTimings[0]!.transportInvocationId).toBe(1);
      expect(allTimings[0]!.isFirstTransportCall).toBe(true);
      expect(allTimings[1]!.transportInvocationId).toBe(2);
      expect(allTimings[1]!.isFirstTransportCall).toBe(false);

      // Verify lookup by invocationId
      expect(transport.getTimingForInvocation(1)?.transportInvocationId).toBe(1);
      expect(transport.getTimingForInvocation(2)?.transportInvocationId).toBe(2);

      // Verify getTimingForRequest returns the latest (invocation 2)
      expect(transport.getTimingForRequest(sharedRequestId)?.transportInvocationId).toBe(2);
    });

    it('correlates timing with request identity, clears stale timing on new request, and ignores cancelled requests', async () => {
      let resolveFirstReq: (resp: AnalyzeIncidentResponse) => void = () => {};
      let reqCount = 0;
      const multiTransport: AnalyzeIncidentTransport = {
        transportName: 'concurrent_test_transport',
        analyzeIncident: () => {
          reqCount++;
          if (reqCount === 1) {
            return new Promise((resolve) => {
              resolveFirstReq = resolve;
            });
          }
          return Promise.resolve({
            ...createValidAlertResponse(),
            message: 'Second request completed immediately',
          });
        },
      };

      render(<App transportOverride={multiTransport} />);
      fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

      // Step 1: Start first request
      const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
      fireEvent.click(reqBtn);

      const inFlightTiming = (window as unknown as { __CHAOS_AI_LAST_TIMING__?: {
        status: string;
        requestId: string;
        invocationId: number;
      } }).__CHAOS_AI_LAST_TIMING__;

      expect(inFlightTiming).toBeDefined();
      expect(inFlightTiming?.status).toBe('in_flight');
      const firstRequestId = inFlightTiming?.requestId;
      const firstInvocationId = inFlightTiming?.invocationId;
      expect(typeof firstRequestId).toBe('string');
      expect(typeof firstInvocationId).toBe('number');

      // Step 2: Navigate away to Orient before first request settles
      const orientPill = screen.getByRole('button', { name: /00:00 Orient/i });
      fireEvent.click(orientPill);

      const cancelledTiming = (window as unknown as { __CHAOS_AI_LAST_TIMING__?: {
        status: string;
      } }).__CHAOS_AI_LAST_TIMING__;
      expect(cancelledTiming?.status).toBe('cancelled');

      // Step 3: Now resolve the slow first request
      resolveFirstReq(createValidAlertResponse());
      await new Promise((r) => setTimeout(r, 50));

      // The late-resolving response must NOT set status to 'completed'
      const lateCheckTiming = (window as unknown as { __CHAOS_AI_LAST_TIMING__?: {
        status: string;
      } }).__CHAOS_AI_LAST_TIMING__;
      expect(lateCheckTiming?.status).not.toBe('completed');

      // Step 4: Return to Alert and fire a fresh second request
      const alertPill = screen.getByRole('button', { name: /03:00 Alert/i });
      fireEvent.click(alertPill);

      const reqBtn2 = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
      fireEvent.click(reqBtn2);

      await waitFor(() => {
        const completedTiming = (window as unknown as { __CHAOS_AI_LAST_TIMING__?: {
          status: string;
          requestId: string;
          invocationId: number;
          domCommittedMs?: number | null;
        } }).__CHAOS_AI_LAST_TIMING__;
        expect(completedTiming?.status).toBe('completed');
        expect(completedTiming?.requestId).toBe(firstRequestId);
        expect(completedTiming?.invocationId).toBeGreaterThan(firstInvocationId!);
      });
    });

    it('keeps evidence tabs, system map nodes, and timeline controls interactive while request is in-flight', async () => {
      let resolveRequest: (resp: AnalyzeIncidentResponse) => void = () => {};
      const slowTransport: AnalyzeIncidentTransport = {
        transportName: 'slow_test_transport',
        analyzeIncident: () => new Promise((resolve) => {
          resolveRequest = resolve;
        }),
      };

      render(<App transportOverride={slowTransport} />);
      fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

      // Initiate request
      const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
      fireEvent.click(reqBtn);

      // Verify button is busy
      expect(screen.getByRole('button', { name: /Requesting AI analysis/i })).toBeTruthy();

      // 1. Evidence filter buttons remain interactive and clickable
      const logBtn = screen.getByRole('button', { name: 'Logs' });
      expect(logBtn.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(logBtn);
      expect(logBtn.getAttribute('aria-pressed')).toBe('true');

      // 2. System map nodes remain clickable and interactive
      const invDbNode = document.querySelector('[data-service-id="inventory-db"]') as HTMLElement;
      expect(invDbNode).toBeTruthy();
      expect(invDbNode.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(invDbNode);
      expect(invDbNode.getAttribute('aria-pressed')).toBe('true');

      // 3. Timeline controls remain clickable and enabled
      const playBtn = screen.getByRole('button', { name: '▶ Play' });
      expect(playBtn).toBeTruthy();
      expect((playBtn as HTMLButtonElement).disabled).toBe(false);

      const orientPill = screen.getByRole('button', { name: /00:00 Orient/i });
      expect(orientPill).toBeTruthy();
      expect((orientPill as HTMLButtonElement).disabled).toBe(false);

      // Clean up in-flight promise
      resolveRequest(createValidAlertResponse());
    });

    it('cancels in-flight request on checkpoint change and strictly prevents stale response leakage', async () => {
      let resolveAlertRequest: (resp: AnalyzeIncidentResponse) => void = () => {};
      const slowTransport: AnalyzeIncidentTransport = {
        transportName: 'slow_test_transport',
        analyzeIncident: () => new Promise((resolve) => {
          resolveAlertRequest = resolve;
        }),
      };

      render(<App transportOverride={slowTransport} />);
      fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

      // At 03:00 Alert, initiate analysis
      const reqBtn = screen.getByRole('button', { name: /Request AI analysis \(ALERT\)/i });
      fireEvent.click(reqBtn);
      expect(screen.getByRole('button', { name: /Requesting AI analysis/i })).toBeTruthy();

      // User jumps to 00:00 Orient while request is in-flight
      const orientPill = screen.getByRole('button', { name: /00:00 Orient/i });
      fireEvent.click(orientPill);

      // Now the late Alert response resolves
      const validAlert = createValidAlertResponse();
      validAlert.result!.conciseAssessment = 'UNIQUE_STALE_ALERT_MARKER_SHOULD_NEVER_APPEAR';
      resolveAlertRequest(validAlert);

      // Allow any microtasks to settle
      await new Promise((r) => setTimeout(r, 50));

      // Assert that the stale Alert response is NOT rendered in Orient!
      expect(screen.queryByText(/UNIQUE_STALE_ALERT_MARKER_SHOULD_NEVER_APPEAR/i)).toBeNull();

      // Return to Alert
      const alertPill = screen.getByRole('button', { name: /03:00 Alert/i });
      fireEvent.click(alertPill);

      // Alert view displays the authored baseline walkthrough rather than the discarded stale response
      expect(screen.getAllByText(/Authored baseline walkthrough/i).length).toBeGreaterThan(0);
      expect(screen.queryByText(/UNIQUE_STALE_ALERT_MARKER_SHOULD_NEVER_APPEAR/i)).toBeNull();
    });
  });
});
