// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CHECKPOINT_TIMES, INCIDENT_001_DEFINITION } from '@chaos-room/shared';
import { App } from './App.js';
import {
  GUIDED_TOUR_PREF_VERSION,
  GUIDED_TOUR_STORAGE_KEY,
  MISSION_BRIEFING_PREF_VERSION,
  MISSION_BRIEFING_STORAGE_KEY,
  getGuidedTourPreference,
  hasDismissedMissionBriefing,
  hasDismissedOrCompletedGuidedTour,
  saveGuidedTourPreference,
  saveMissionBriefingDismissed,
} from './services/onboardingPreferences.js';
import { GUIDED_TOUR_STEPS } from './components/Tour/GuidedTourDialog.js';
import { MockAnalyzeIncidentTransport } from './services/aiClient.js';

beforeEach(() => {
  window.localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AC-01, AC-03 & AC-11: End-to-end investigation UI flow & decision gate', () => {
  beforeEach(() => {
    saveMissionBriefingDismissed();
  });

  it('renders at Alert (03:00) with synthetic badge, opaque incident-001 ID, and investigation checks', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    expect(screen.getByText('Fictional system · Synthetic data')).toBeTruthy();
    expect(screen.getByText('incident-001')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: /Incident Investigation: “Reservations are timing out”/i }),
    ).toBeTruthy();

    // Shortened hierarchy headings
    expect(screen.getByRole('heading', { name: /^System map$/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Services$/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Evidence$/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Assessment & response$/i })).toBeTruthy();

    // At 03:00 Alert, Proposed Next Investigation Checks are shown (not recommended interventions)
    expect(
      screen.getByRole('heading', { name: /Proposed Next Investigation Checks/i }),
    ).toBeTruthy();
  });

  it('enforces the 06:00 decision gate when attempting to jump to 15:00 without choosing an intervention', () => {
    render(<App />);

    const outcomeBtn = screen.getByRole('button', { name: /15:00 Outcome & Debrief/i });
    fireEvent.click(outcomeBtn);

    // Should clamp to 06:00 and display the Decision Checkpoint notice
    expect(screen.getByText(/Decision Checkpoint at 06:00:/i)).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: /Action Required at 06:00: Select an Intervention/i }),
    ).toBeTruthy();
  });

  it('completes all three intervention branches through 15:00 Outcome and renders the Debrief', () => {
    render(<App />);

    // Advance to 06:00 Evidence
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));

    // Apply "Observe without changing anything" and jump to 15:00 Outcome
    const applyJumpButtons = screen.getAllByRole('button', {
      name: /Apply & Jump to Outcome \(15:00\)/i,
    });
    expect(applyJumpButtons.length).toBe(3);

    // Click 3rd intervention (Observe)
    fireEvent.click(applyJumpButtons[2]!);

    // Debrief is now unlocked at 15:00
    expect(
      screen.getByRole('heading', {
        name: /Scenario 1: Database Connection Pool Exhaustion via Cancellation Leak/i,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/\[Unresolved impact\]/i)).toBeTruthy();

    // Switch to Rollback & Drain from the Debrief comparison table
    const switchButtons = screen.getAllByRole('button', {
      name: /Inspect this branch at 15:00/i,
    });
    fireEvent.click(switchButtons[0]!);

    expect(screen.getByText(/\[Recommended resolution\]/i)).toBeTruthy();
  });

  it('switches between Scenario 1 and Scenario 2 cleanly via the scenario selector', () => {
    render(<App />);

    const scenarioSelect = screen.getByLabelText(/Select incident scenario to investigate/i);
    expect(scenarioSelect).toBeTruthy();

    // Initially Scenario 1
    expect(screen.getByText('incident-001')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: /Incident Investigation: “Reservations are timing out”/i }),
    ).toBeTruthy();

    // Verify selector has symptom-based labels only with zero diagnosis spoilers
    const options = screen.getAllByRole('option');
    const optionTexts = options.map((o) => o.textContent ?? '');
    expect(optionTexts).toContain('Incident 1: “Reservations are timing out”');
    expect(optionTexts).toContain('Incident 2: “Reservations succeed, confirmations stall”');
    expect(optionTexts).toContain('Incident 3: “A release leaves confirmations behind”');
    expect(
      optionTexts.some(
        (t) =>
          t.includes('Downstream Retry Storm') ||
          t.includes('DB Connection Leak') ||
          t.includes('Schema Breakage') ||
          t.includes('schemaVersion'),
      ),
    ).toBe(false);

    // Switch to Scenario 2
    fireEvent.change(scenarioSelect, { target: { value: 'incident-002' } });

    expect(screen.getByText('incident-002')).toBeTruthy();
    expect(
      screen.getByRole('heading', {
        name: /Incident Investigation: “Reservations succeed, confirmations stall”/i,
      }),
    ).toBeTruthy();

    // Verify 06:00 decision gate and interventions in Scenario 2
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));

    const backoffApplyBtns = screen.getAllByRole('button', {
      name: /Apply & Jump to Outcome \(15:00\)/i,
    });
    expect(backoffApplyBtns.length).toBe(3);
    fireEvent.click(backoffApplyBtns[0]!);

    // Unlocks Debrief for Scenario 2 with relevant incident columns and upstream context
    expect(
      screen.getByRole('heading', {
        name: /Downstream notification provider slowdown amplified by unconstrained worker retry storm/i,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Upstream Reservation Pipeline Context:/i)).toBeTruthy();
    expect(screen.getAllByText(/15:00 Backlog/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/15:00 Queue Age/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/15:00 Retry Amp/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/15:00 Provider p95/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Delayed > 30s/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/\[Recommended resolution\]/i)).toBeTruthy();

    // Switch back to Scenario 1 to verify clean state reset without leaking previous investigation state
    fireEvent.change(scenarioSelect, { target: { value: 'incident-001' } });
    expect(screen.getByText('incident-001')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: /Incident Investigation: “Reservations are timing out”/i }),
    ).toBeTruthy();
    // Reset to 00:00 with intervention cleared
    expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Database connection pool leak/i })).toBeNull();
  });

  it('keeps debrief branch outcome health independent of branch selection in both scenarios', () => {
    const { container } = render(<App />);

    const assertBranchHealthAndSelection = (
      activeBranchId: string,
      expectedHealthByBranch: Record<string, 'healthy' | 'degraded' | 'failing'>,
    ) => {
      for (const [branchId, expectedHealth] of Object.entries(expectedHealthByBranch)) {
        const card = container.querySelector(
          `.mobile-branch-cards .branch-comparison-card[data-branch-id="${branchId}"]`,
        );
        expect(card).toBeTruthy();
        expect(card?.getAttribute('data-outcome-health')).toBe(expectedHealth);
        expect(card?.getAttribute('data-user-choice')).toBe(
          branchId === activeBranchId ? 'true' : 'false',
        );

        const verdictBadge = container.querySelector(
          `.mobile-branch-cards [data-verdict-badge="${branchId}"]`,
        );
        expect(verdictBadge).toBeTruthy();
        expect(verdictBadge?.getAttribute('data-health')).toBe(expectedHealth);

        const row = container.querySelector(
          `.comparison-table tbody tr[data-branch-id="${branchId}"]`,
        );
        expect(row?.getAttribute('data-outcome-health')).toBe(expectedHealth);
        expect(row?.getAttribute('data-user-choice')).toBe(
          branchId === activeBranchId ? 'true' : 'false',
        );

        const activeIndicator = card?.querySelector(
          `[data-active-branch-indicator="${branchId}"]`,
        );
        if (branchId === activeBranchId) {
          expect(activeIndicator?.textContent).toBe('Currently inspecting this branch');
          expect(activeIndicator?.getAttribute('data-health')).toBeNull();
          expect(card?.textContent).toContain('★ Active branch');
        } else {
          expect(activeIndicator).toBeNull();
        }
      }
    };

    // Scenario 1: apply Observe at 06:00 and inspect all branches
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));
    const sc1ApplyButtons = screen.getAllByRole('button', {
      name: /Apply & Jump to Outcome \(15:00\)/i,
    });
    fireEvent.click(sc1ApplyButtons[2]!); // act-observe

    const sc1ExpectedHealth = {
      'act-rollback-drain': 'healthy',
      'act-increase-pool': 'degraded',
      'act-observe': 'failing',
    } as const;

    assertBranchHealthAndSelection('act-observe', sc1ExpectedHealth);

    // Switch through remaining Scenario 1 branches and confirm health never changes
    for (const branchId of ['act-increase-pool', 'act-rollback-drain', 'act-observe'] as const) {
      const switchBtn = container.querySelector(
        `.mobile-branch-cards button[data-intervention-id="${branchId}"]`,
      );
      if (switchBtn) fireEvent.click(switchBtn);
      assertBranchHealthAndSelection(branchId, sc1ExpectedHealth);
    }

    // Switch to Scenario 2, select Observe, and verify branch health stays independent of selection
    const scenarioSelect = screen.getByLabelText(/Select incident scenario to investigate/i);
    fireEvent.change(scenarioSelect, { target: { value: 'incident-002' } });
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));
    const sc2ApplyButtons = screen.getAllByRole('button', {
      name: /Apply & Jump to Outcome \(15:00\)/i,
    });
    fireEvent.click(sc2ApplyButtons[2]!); // act-observe

    const sc2ExpectedHealth = {
      'act-backoff-circuit-breaker': 'healthy',
      'act-increase-concurrency': 'failing',
      'act-observe': 'failing',
    } as const;

    assertBranchHealthAndSelection('act-observe', sc2ExpectedHealth);

    for (const branchId of [
      'act-backoff-circuit-breaker',
      'act-increase-concurrency',
      'act-observe',
    ] as const) {
      const switchBtn = container.querySelector(
        `.mobile-branch-cards button[data-intervention-id="${branchId}"]`,
      );
      if (switchBtn) fireEvent.click(switchBtn);
      assertBranchHealthAndSelection(branchId, sc2ExpectedHealth);
    }
  });

  it('clearly marks mocked AI preview states as non-live in the dev/review switcher', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));

    const modeSelect = screen.getByLabelText(/Assessment State Mode:/i);
    fireEvent.change(modeSelect, { target: { value: 'preview_cached_ai' } });

    expect(
      screen.getByText(
        /\[DEV \/ REVIEW PREVIEW ONLY\] Showing mocked UI state/i,
      ),
    ).toBeTruthy();
  });

  it('supports Scenario 3 selection, citation navigation, leak-free switching, and selection-independent outcome badges', () => {
    const { container } = render(<App />);
    const scenarioSelect = screen.getByLabelText(/Select incident scenario to investigate/i);

    // Default remains incident-001
    expect(screen.getByText('incident-001')).toBeTruthy();

    // Switch to incident-002 with filters/pins active, then switch to incident-003 to confirm reset
    fireEvent.change(scenarioSelect, { target: { value: 'incident-002' } });
    fireEvent.click(screen.getByRole('button', { name: /Logs/i }));
    fireEvent.change(scenarioSelect, { target: { value: 'incident-003' } });

    expect(screen.getByText('incident-003')).toBeTruthy();
    expect(
      screen.getByRole('heading', {
        name: /Incident Investigation: “A release leaves confirmations behind”/i,
      }),
    ).toBeTruthy();
    // Filter reset to All and timeline reset to 00:00
    expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /All \(/i }).getAttribute('aria-pressed'),
    ).toBe('true');

    // Verify 06:00 gate copy avoids Scenario 1/2 hardcoded Observe wording
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));
    const gateNotice = container.querySelector('.decision-gate-notice');
    expect(gateNotice?.textContent).toContain('including “Restart workers only”');
    expect(gateNotice?.textContent).not.toContain('Observe without changing anything');

    // Click citation pill for paired trace ev-trc-210 and verify matching evidence card focus
    const citationBtns = screen.getAllByRole('button', { name: /\[ev-trc-210\]/i });
    expect(citationBtns.length).toBeGreaterThan(0);
    fireEvent.click(citationBtns[0]!);
    const focusedCard = document.getElementById('evidence-card-ev-trc-210');
    expect(focusedCard).toBeTruthy();
    expect(focusedCard?.getAttribute('data-highlighted')).toBe('true');

    // Verify Scenario 3 secondary diagnostic metrics (non-zero at 06:00, not Scenario 1/2 labels)
    expect(screen.getByText(/Validation Failures \(60s\):/i)).toBeTruthy();
    expect(screen.getByText(/Quarantined \/ Replayed:/i)).toBeTruthy();

    // Apply partial recovery ("Roll back the producer only") and jump to 15:00
    const applyBtns = screen.getAllByRole('button', {
      name: /Apply & Jump to Outcome \(15:00\)/i,
    });
    expect(applyBtns.length).toBe(3);
    fireEvent.click(applyBtns[1]!);

    // Selected badge in AssessmentPanel uses neutral selection styling (no data-health="healthy")
    const selectedBadge = container.querySelector('[data-selected-badge="true"]');
    expect(selectedBadge).toBeTruthy();
    expect(selectedBadge?.getAttribute('data-health')).toBeNull();
    expect(selectedBadge?.textContent).toContain('Selected');

    // Scenario 3 debrief renders +22.2% distraction heading and Scenario 3 comparison headers
    expect(
      screen.getByRole('heading', {
        name: /Producer Schema Breakage Leaving Incompatible Confirmation Cohort Stranded/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', {
        name: /Why the \+22\.2% Traffic Bump Was a Plausible Distraction/i,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Upstream & Infrastructure Health Context:/i)).toBeTruthy();
    expect(screen.getAllByText(/15:00 Outstanding/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/15:00 Val Fails \(60s\)/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Replayed \/ Delivered/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/15:00 Error Rate \(60s\)/i)).toBeNull();

    // Verify all 3 verdicts map to independent health states and remain invariant under branch switch
    const sc3ExpectedHealth = {
      'act-rollback-quarantine-replay': 'healthy',
      'act-rollback-producer-only': 'degraded',
      'act-restart-workers-only': 'failing',
    } as const;

    const assertSc3Health = (activeBranchId: string) => {
      for (const [branchId, expectedHealth] of Object.entries(sc3ExpectedHealth)) {
        const card = container.querySelector(
          `.mobile-branch-cards .branch-comparison-card[data-branch-id="${branchId}"]`,
        );
        expect(card?.getAttribute('data-outcome-health')).toBe(expectedHealth);
        expect(card?.getAttribute('data-user-choice')).toBe(
          branchId === activeBranchId ? 'true' : 'false',
        );
        const badge = container.querySelector(
          `.mobile-branch-cards [data-verdict-badge="${branchId}"]`,
        );
        expect(badge?.getAttribute('data-health')).toBe(expectedHealth);
        const row = container.querySelector(
          `.comparison-table tbody tr[data-branch-id="${branchId}"]`,
        );
        expect(row?.getAttribute('data-outcome-health')).toBe(expectedHealth);
      }
    };

    assertSc3Health('act-rollback-producer-only');

    for (const nextBranch of [
      'act-rollback-quarantine-replay',
      'act-restart-workers-only',
      'act-rollback-producer-only',
    ] as const) {
      const btn = container.querySelector(
        `.mobile-branch-cards button[data-intervention-id="${nextBranch}"]`,
      );
      if (btn) fireEvent.click(btn);
      assertSc3Health(nextBranch);
    }

    // Switch back to incident-001 and verify Scenario 3 debrief disappears cleanly
    fireEvent.change(scenarioSelect, { target: { value: 'incident-001' } });
    expect(screen.getByText('incident-001')).toBeTruthy();
    expect(
      screen.queryByRole('heading', {
        name: /Producer Schema Breakage Leaving Incompatible Confirmation Cohort Stranded/i,
      }),
    ).toBeNull();
  });

  it('preserves mobile access to simulation controls across all mobile tabs without duplicate IDs', () => {
    const { container } = render(<App />);

    // Exactly one timeline scrubber ID across the entire DOM
    const scrubbers = container.querySelectorAll('#sim-timeline-scrubber');
    expect(scrubbers.length).toBe(1);

    // Switch to mobile tab 3: Assessment
    const tabAnalysis = screen.getByRole('tab', { name: /3\. Assessment/i });
    fireEvent.click(tabAnalysis);
    expect(tabAnalysis.getAttribute('aria-selected')).toBe('true');

    // Controls must NOT be hidden inside an inactive panel
    const timelineCard = container.querySelector('.timeline-card');
    expect(timelineCard).toBeTruthy();
    expect(timelineCard?.closest('[data-mobile-hidden="true"]')).toBeNull();

    // Advance to 06:00 using the shared checkpoint pill while on Assessment tab
    const evPill = screen.getByRole('button', { name: /06:00 Evidence & Intervene/i });
    fireEvent.click(evPill);
    expect(screen.getByText(/06:00 \/ 15:00/)).toBeTruthy();

    // Select an intervention while on Assessment tab
    const applyButtons = screen.getAllByRole('button', { name: /Apply & Play from 06:00/i });
    expect(applyButtons.length).toBeGreaterThan(0);
    fireEvent.click(applyButtons[0]!);

    // Play, Pause, and Reset can be operated directly without leaving the Assessment tab
    const playBtn = screen.getByRole('button', { name: /▶ Play|⏸ Pause/i });
    expect(playBtn).toBeTruthy();
    expect(playBtn.closest('[data-mobile-hidden="true"]')).toBeNull();

    const resetBtn = screen.getByRole('button', { name: /↺ Reset/i });
    expect(resetBtn.closest('[data-mobile-hidden="true"]')).toBeNull();
    fireEvent.click(resetBtn);

    // Verified: reset succeeded and clock returned to 00:00 while remaining on Assessment tab
    expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
    expect(tabAnalysis.getAttribute('aria-selected')).toBe('true');

    // Switch to mobile tab 2: Evidence and verify controls remain accessible
    const tabEvidence = screen.getByRole('tab', { name: /2\. Evidence/i });
    fireEvent.click(tabEvidence);
    expect(tabEvidence.getAttribute('aria-selected')).toBe('true');
    expect(timelineCard?.closest('[data-mobile-hidden="true"]')).toBeNull();
  });

  it('renders immediateTradeoff on every alternative response card when switching branches in Assessment', () => {
    const { container } = render(<App />);

    // Advance to 06:00
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));

    // Apply first intervention to lock in a branch
    const jumpButtons = screen.getAllByRole('button', { name: /Apply & Jump to Outcome \(15:00\)/i });
    fireEvent.click(jumpButtons[0]!);

    // Branch switcher is rendered for alternative options
    const switcher = container.querySelector('.branch-switcher-details');
    expect(switcher).toBeTruthy();

    const alternativeCards = container.querySelectorAll('.other-branches-stack .intervention-card');
    expect(alternativeCards.length).toBe(2);

    alternativeCards.forEach((card) => {
      const tradeoffEl = card.querySelector('.intervention-tradeoff-text');
      expect(tradeoffEl).toBeTruthy();
      expect(tradeoffEl?.textContent).toMatch(/Tradeoff:/i);
      expect(tradeoffEl?.textContent?.replace(/Tradeoff:\s*/i, '').trim().length).toBeGreaterThan(10);

      // Tradeoff must be positioned before the action buttons
      const actionsEl = card.querySelector('.intervention-actions');
      expect(actionsEl).toBeTruthy();
      expect(card.compareDocumentPosition(tradeoffEl!)).toBeTruthy();
      // Verify tradeoff precedes actions in DOM order
      expect(tradeoffEl!.compareDocumentPosition(actionsEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('renders system map with internal topology scroll wrapper, mobile hint, accessible drawer, and service node identifiers', () => {
    const { container } = render(<App />);

    const systemPanel = container.querySelector('#panel-system');
    expect(systemPanel).toBeTruthy();

    const svgWrap = systemPanel?.querySelector('.topology-svg-wrap');
    expect(svgWrap).toBeTruthy();

    const mobileHint = systemPanel?.querySelector('.mobile-map-hint');
    expect(mobileHint).toBeTruthy();
    expect(mobileHint?.textContent).toMatch(/Pan map to explore topology/i);

    const svg = svgWrap?.querySelector('svg.topology-svg');
    expect(svg).toBeTruthy();

    // Verify confirmation queue and confirmation worker nodes carry service IDs
    const queueNode = svg?.querySelector('[data-service-id="confirmation-queue"]');
    const workerNode = svg?.querySelector('[data-service-id="confirmation-worker"]');
    expect(queueNode).toBeTruthy();
    expect(workerNode).toBeTruthy();

    // Accessible services drawer is present
    const drawer = systemPanel?.querySelector('.services-accessible-drawer');
    expect(drawer).toBeTruthy();
    const servicesHeading = drawer?.querySelector('#services-heading');
    expect(servicesHeading?.textContent).toBe('Services');
  });
});

describe('Phase 6A: Mission Briefing, 00:00 Starting Point, Guidance & Opening Empty States', () => {
  it('shows mission briefing on fresh visit, starts paused at 00:00, remembers dismissal with versioned storage, and skips on return', () => {
    const { container, unmount } = render(<App />);

    // Simulation starts paused at 00:00 with accelerated time clarification
    expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect(
      screen.getByText(/Accelerated simulation time — not a countdown or real-time wait/i),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Playback pace: Standard/i })).toBeTruthy();
    expect(screen.queryByText(/Speed: 1x/i)).toBeNull();

    const playBtn = screen.getByRole('button', { name: /▶ Play/i });
    expect(playBtn.getAttribute('data-initial-play')).toBe('true');

    // Mission briefing dialog is open with scenario-agnostic, spoiler-free copy
    const dialog = container.querySelector('#mission-briefing-dialog') as HTMLDialogElement;
    expect(dialog).toBeTruthy();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('mission-briefing-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('mission-briefing-body');
    expect(
      screen.getByRole('heading', { name: /Your mission: investigate the incident/i }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Reservations are saved first; confirmations are delivered separately/i),
    ).toBeTruthy();
    expect(screen.getByText(/About 3–5 minutes • Fictional system and synthetic data/i)).toBeTruthy();
    expect(screen.getByText(/Pause or jump between checkpoints\./i)).toBeTruthy();

    const enterBtn = screen.getByRole('button', { name: /Enter investigation/i });
    expect(document.activeElement).toBe(enterBtn);

    // Dismiss via primary action
    fireEvent.click(enterBtn);
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();

    const stored = window.localStorage.getItem(MISSION_BRIEFING_STORAGE_KEY);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!) as { version: number; dismissed: boolean };
    expect(parsed.version).toBe(MISSION_BRIEFING_PREF_VERSION);
    expect(parsed.dismissed).toBe(true);

    unmount();

    // Returning visit remembers dismissal and enters directly at 00:00 paused
    const returning = render(<App />);
    const returningDialog = returning.container.querySelector(
      '#mission-briefing-dialog',
    ) as HTMLDialogElement;
    expect(returningDialog.hasAttribute('open')).toBe(false);
    expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
  });

  it('handles unavailable storage and mismatched preference versions gracefully', () => {
    const throwingStorage: Storage = {
      length: 0,
      clear: () => {},
      key: () => null,
      removeItem: () => {},
      getItem: () => {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    };

    expect(hasDismissedMissionBriefing(throwingStorage)).toBe(false);
    expect(saveMissionBriefingDismissed(throwingStorage)).toBe(false);

    // Mismatched version should not count as dismissed
    window.localStorage.setItem(
      MISSION_BRIEFING_STORAGE_KEY,
      JSON.stringify({ version: 999, dismissed: true }),
    );
    expect(hasDismissedMissionBriefing()).toBe(false);

    // Unavailable window.localStorage during App render and dismissal does not throw
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });

    try {
      const { container } = render(<App />);
      const dialog = container.querySelector('#mission-briefing-dialog') as HTMLDialogElement;
      expect(dialog.hasAttribute('open')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: /Enter investigation/i }));
      expect(dialog.hasAttribute('open')).toBe(false);
    } finally {
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  it('reopens briefing during playback, pauses and preserves investigation state, contains focus, and leaves playback paused on dismiss without triggering AI', () => {
    saveMissionBriefingDismissed();
    const transportSpy = vi.fn(() => ({
      status: 'ok' as const,
      cacheHit: false,
      isMockProvider: true,
      result: INCIDENT_001_DEFINITION.walkthroughs.alert,
    }));
    const mockTransport = new MockAnalyzeIncidentTransport(transportSpy);

    const { container } = render(<App transportOverride={mockTransport} />);

    // Switch to incident-002, jump to 06:00 Evidence, pin an item, filter by Logs, and Apply & Play from 06:00
    const scenarioSelect = screen.getByLabelText(/Select incident scenario to investigate/i);
    fireEvent.change(scenarioSelect, { target: { value: 'incident-002' } });
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));

    // Pin first evidence card
    const pinButtons = screen.getAllByRole('button', { name: /Pin evidence/i });
    fireEvent.click(pinButtons[0]!);
    expect(screen.getByRole('button', { name: /Pinned \(1\)/i })).toBeTruthy();

    // Filter to Logs
    const logsBtn = screen.getByRole('button', { name: /^Logs$/i });
    fireEvent.click(logsBtn);
    expect(logsBtn.getAttribute('aria-pressed')).toBe('true');

    // Switch dev preview mode to verify non-simulation UI analysis state is preserved
    const modeSelect = screen.getByLabelText(/Assessment State Mode:/i);
    fireEvent.change(modeSelect, { target: { value: 'preview_cached_ai' } });
    expect((modeSelect as HTMLSelectElement).value).toBe('preview_cached_ai');

    // Apply & Play from 06:00 (advances clock to 06:05 and starts playback)
    const applyPlayBtns = screen.getAllByRole('button', { name: /Apply & Play from 06:00/i });
    fireEvent.click(applyPlayBtns[0]!);
    expect(screen.getByText(/06:05 \/ 15:00/)).toBeTruthy();
    expect(screen.getByText(/▶ LIVE PLAYBACK/)).toBeTruthy();

    // Open Mission briefing during active playback
    const briefingBtn = screen.getByRole('button', { name: /Mission briefing/i });
    fireEvent.click(briefingBtn);

    const dialog = container.querySelector('#mission-briefing-dialog') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);
    // Playback paused immediately
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /▶ Play/i })).toBeTruthy();

    // Zero AI calls triggered
    expect(transportSpy).not.toHaveBeenCalled();

    // Focus containment inside dialog: Tab wraps from Enter investigation -> Close button, Shift+Tab wraps back
    const closeBtn = screen.getByRole('button', { name: /Close mission briefing/i });
    const enterBtn = screen.getByRole('button', { name: /Enter investigation/i });
    enterBtn.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(enterBtn);

    // Dismiss via Escape key
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(dialog, { key: 'Escape' });
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }

    expect(dialog.hasAttribute('open')).toBe(false);
    // Remains paused after closing briefing; does not auto-resume
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /▶ Play/i })).toBeTruthy();
    // Focus restored to Mission briefing trigger
    expect(document.activeElement).toBe(briefingBtn);

    // All investigation state preserved
    expect((scenarioSelect as HTMLSelectElement).value).toBe('incident-002');
    expect(screen.getByText(/06:05 \/ 15:00/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pinned \(1\)/i })).toBeTruthy();
    expect(logsBtn.getAttribute('aria-pressed')).toBe('true');
    expect((modeSelect as HTMLSelectElement).value).toBe('preview_cached_ai');
    expect(container.querySelector('[data-selected-badge="true"]')).toBeTruthy();

    // Reopen and dismiss via Close (✕) button consistently
    fireEvent.click(briefingBtn);
    expect(dialog.hasAttribute('open')).toBe(true);
    vi.useFakeTimers();
    try {
      fireEvent.click(closeBtn);
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect(document.activeElement).toBe(briefingBtn);
  });

  it('plays from 00:00, adapts pre-alert guidance, auto-pauses at 03:00 Alert and 06:00 Evidence decision gate', () => {
    saveMissionBriefingDismissed();
    vi.useFakeTimers();
    try {
      const { container } = render(<App />);

      const getGuidancePhase = () =>
        container.querySelector('.next-step-guidance')?.getAttribute('data-guidance-phase');
      const getGuidanceText = () =>
        container.querySelector('.next-step-guidance')?.textContent ?? '';

      expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
      expect(getGuidancePhase()).toBe('pre_alert');
      expect(getGuidanceText()).toContain(
        'Start playback to watch the incident develop. We’ll pause at the first alert.',
      );

      // Start playback at 00:00
      fireEvent.click(screen.getByRole('button', { name: /▶ Play/i }));
      expect(screen.getByText(/▶ LIVE PLAYBACK/)).toBeTruthy();
      expect(getGuidanceText()).not.toContain('Start playback');
      expect(getGuidanceText()).toContain('Playback running');

      // Advance 36 ticks (180s / 5s = 36 ticks at 350ms each) -> auto-pauses at 03:00
      for (let i = 0; i < 38; i++) {
        act(() => {
          vi.advanceTimersByTime(350);
        });
      }

      expect(screen.getByText(/03:00 \/ 15:00/)).toBeTruthy();
      expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
      expect(getGuidancePhase()).toBe('investigation');
      expect(getGuidanceText()).toContain(
        'Check customer impact, then inspect the evidence. What changed before the alert?',
      );

      // Resume playback from 03:00 -> auto-pauses at 06:00 Evidence decision gate
      fireEvent.click(screen.getByRole('button', { name: /▶ Play/i }));
      for (let i = 0; i < 38; i++) {
        act(() => {
          vi.advanceTimersByTime(350);
        });
      }

      expect(screen.getByText(/06:00 \/ 15:00/)).toBeTruthy();
      expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
      expect(getGuidancePhase()).toBe('awaiting_decision');
      expect(getGuidanceText()).toContain(
        'Compare the evidence and assessment, then choose a response.',
      );

      // Clicking Play at 06:00 without choosing a response stays blocked at 06:00
      fireEvent.click(screen.getByRole('button', { name: /▶ Play/i }));
      expect(screen.getByText(/06:00 \/ 15:00/)).toBeTruthy();
      expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('transitions guidance and opening empty states accurately across all 3 scenarios, scrubbing, jumps, branch changes, and resets', () => {
    saveMissionBriefingDismissed();
    const { container } = render(<App />);

    const scenarioSelect = screen.getByLabelText(/Select incident scenario to investigate/i);
    const getEmptyStateAttr = () =>
      container.querySelector('.evidence-empty-state')?.getAttribute('data-empty-state');
    const getGuidancePhase = () =>
      container.querySelector('.next-step-guidance')?.getAttribute('data-guidance-phase');
    const getGuidanceText = () =>
      container.querySelector('.next-step-guidance')?.textContent ?? '';

    for (const scenarioId of ['incident-001', 'incident-002', 'incident-003'] as const) {
      fireEvent.change(scenarioSelect, { target: { value: scenarioId } });

      // 1. Consistent 00:00 paused entry & pre-alert empty states
      expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
      expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
      expect(getGuidancePhase()).toBe('pre_alert');
      expect(getGuidanceText()).toContain(
        'Start playback to watch the incident develop. We’ll pause at the first alert.',
      );

      expect(getEmptyStateAttr()).toBe('no-evidence-yet');
      const noEvidenceBox = container.querySelector('[data-empty-state="no-evidence-yet"]');
      expect(noEvidenceBox?.textContent).toMatch(/No incident evidence recorded yet at 00:00/i);
      expect(noEvidenceBox?.textContent).not.toMatch(/operations are normal|healthy/i);
      expect(
        screen.getAllByText(/No incident evidence recorded yet at 00:00/i).length,
      ).toBeGreaterThanOrEqual(1);
      const preAlertAssessmentBox = container.querySelector(
        '[data-empty-state="pre-alert-assessment"]',
      );
      expect(preAlertAssessmentBox?.textContent).toMatch(
        /Structured assessment becomes available at Alert \(03:00\)/i,
      );
      expect(preAlertAssessmentBox?.textContent).toMatch(
        /Watch the system and incoming evidence as the simulation advances/i,
      );
      expect(preAlertAssessmentBox?.textContent).toMatch(/Evidence \(06:00\)/i);
      expect(preAlertAssessmentBox?.textContent).not.toMatch(/operations are normal|healthy/i);
      expect(screen.queryByRole('button', { name: /Request AI analysis/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Apply & Jump to Outcome/i })).toBeNull();

      // 2. Jump to 03:00 Alert -> investigation guidance + filter-empty distinction
      fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));
      expect(getGuidancePhase()).toBe('investigation');
      expect(getGuidanceText()).toContain(
        'Check customer impact, then inspect the evidence. What changed before the alert?',
      );
      expect(getEmptyStateAttr()).toBeUndefined();

      // Filter by Pinned (0 pinned yet) -> distinguishes active filter mismatch from no evidence yet
      fireEvent.click(screen.getByRole('button', { name: /Pinned \(0\)/i }));
      expect(getEmptyStateAttr()).toBe('filter-empty');
      expect(screen.getByText(/No evidence items match the active filter/i)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Reset evidence filters/i }));
      expect(getEmptyStateAttr()).toBeUndefined();

      // 3. Jump to 06:00 -> awaiting decision
      fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));
      expect(getGuidancePhase()).toBe('awaiting_decision');
      expect(getGuidanceText()).toContain(
        'Compare the evidence and assessment, then choose a response.',
      );

      // 4. Select response via Apply & Play (06:05) -> post_decision
      const applyPlayBtns = screen.getAllByRole('button', { name: /Apply & Play from 06:00/i });
      fireEvent.click(applyPlayBtns[0]!);
      // Pause immediately so we inspect paused post-decision text deterministically
      fireEvent.click(screen.getByRole('button', { name: /⏸ Pause/i }));
      expect(getGuidancePhase()).toBe('post_decision');
      expect(getGuidanceText()).toContain(
        'Follow your response and check whether customer impact improves.',
      );

      // 5. Advance to 15:00 Outcome -> outcome guidance
      fireEvent.click(screen.getByRole('button', { name: /15:00 Outcome & Debrief/i }));
      expect(getGuidancePhase()).toBe('outcome');
      expect(getGuidanceText()).toContain(
        'Check the outcome, then open the debrief to understand the result.',
      );

      // Branch switch at 15:00 preserves outcome guidance
      const switchBranchBtns = screen.getAllByRole('button', {
        name: /Inspect this branch at 15:00/i,
      });
      fireEvent.click(switchBranchBtns[0]!);
      expect(getGuidancePhase()).toBe('outcome');

      // Scrub backward to 02:00 (120s) -> pre_alert; scrub to 04:00 (240s) -> investigation
      const scrubber = container.querySelector('#sim-timeline-scrubber') as HTMLInputElement;
      fireEvent.change(scrubber, { target: { value: String(120) } });
      expect(getGuidancePhase()).toBe('pre_alert');
      fireEvent.change(scrubber, { target: { value: String(240) } });
      expect(getGuidancePhase()).toBe('investigation');

      // Reset returns to 00:00 paused with pre_alert guidance
      fireEvent.click(screen.getByRole('button', { name: /↺ Reset \(00:00\)/i }));
      expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
      expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
      expect(getGuidancePhase()).toBe('pre_alert');
    }

    expect(CHECKPOINT_TIMES.alert).toBe(180);
  }, 15000);

  it('at 02:45 in Incident 1 shows gateway-timeout evidence while keeping assessment locked with neutral non-health wording across all scenarios and backward navigation', () => {
    saveMissionBriefingDismissed();
    const { container } = render(<App />);

    const assertNeutralLockedAssessment = () => {
      const assessmentBox = container.querySelector(
        '[data-empty-state="pre-alert-assessment"]',
      );
      expect(assessmentBox).toBeTruthy();
      expect(assessmentBox?.textContent).toMatch(
        /Watch the system and incoming evidence as the simulation advances/i,
      );
      expect(assessmentBox?.textContent).toMatch(/Structured assessment.*Alert \(03:00\)/i);
      expect(assessmentBox?.textContent).toMatch(/Evidence \(06:00\)/i);
      expect(assessmentBox?.textContent).not.toMatch(/operations are normal|healthy/i);
      expect(screen.queryByRole('button', { name: /Request AI analysis/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Apply & Jump to Outcome/i })).toBeNull();
    };

    // Navigate Incident 1 to 02:45 (165s) before Alert (03:00)
    const scrubber = container.querySelector('#sim-timeline-scrubber') as HTMLInputElement;
    fireEvent.change(scrubber, { target: { value: '165' } });
    expect(screen.getByText(/02:45 \/ 15:00/)).toBeTruthy();

    // Gateway-timeout evidence at 02:45 and earlier warning evidence are already visible
    expect(document.getElementById('evidence-card-ev-log-165')).toBeTruthy();
    expect(
      screen.getByText(/Upstream deadline exceeded calling reservation-service \(2,500 ms\)/i),
    ).toBeTruthy();

    // Assessment remains locked until 03:00 and does NOT claim operations are normal
    assertNeutralLockedAssessment();

    // Verify across all three scenarios and backward navigation
    const scenarioSelect = screen.getByLabelText(/Select incident scenario to investigate/i);
    for (const scenarioId of ['incident-001', 'incident-002', 'incident-003'] as const) {
      fireEvent.change(scenarioSelect, { target: { value: scenarioId } });
      expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
      const emptyEv = container.querySelector('[data-empty-state="no-evidence-yet"]');
      expect(emptyEv?.textContent).toMatch(/No incident evidence recorded yet at 00:00/i);
      expect(emptyEv?.textContent).not.toMatch(/operations are normal|healthy/i);
      assertNeutralLockedAssessment();

      // Advance to 03:00 Alert (unlocks assessment), then 06:00 Evidence, then scrub backward to 02:45 and 00:00
      fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));
      expect(container.querySelector('[data-empty-state="pre-alert-assessment"]')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));

      const currentScrubber = container.querySelector('#sim-timeline-scrubber') as HTMLInputElement;
      fireEvent.change(currentScrubber, { target: { value: '165' } });
      expect(screen.getByText(/02:45 \/ 15:00/)).toBeTruthy();
      assertNeutralLockedAssessment();

      fireEvent.change(currentScrubber, { target: { value: '0' } });
      expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
      const backEmptyEv = container.querySelector('[data-empty-state="no-evidence-yet"]');
      expect(backEmptyEv?.textContent).toMatch(/No incident evidence recorded yet at 00:00/i);
      expect(backEmptyEv?.textContent).not.toMatch(/operations are normal|healthy/i);
      assertNeutralLockedAssessment();
    }
  }, 15000);
});

describe('Phase 6B: Workspace Clarity, Reading Order, Customer Journey & Opening State', () => {
  beforeEach(() => {
    saveMissionBriefingDismissed();
  });

  it('displays clearer headline metric labels, descriptions, windows, and failed-attempts vs unique-reservations precision', () => {
    const { container } = render(<App />);

    // Verify all four headline labels and plain-language descriptions
    expect(screen.getByText('Reservation failures')).toBeTruthy();
    expect(screen.getByText('Failed attempts in the trailing 60 seconds')).toBeTruthy();

    expect(screen.getByText('Response time')).toBeTruthy();
    expect(screen.getByText('API latency, 95th percentile')).toBeTruthy();
    expect(screen.getByText('Gateway timeout: 2,500 ms')).toBeTruthy();

    expect(screen.getByText('Pending confirmations')).toBeTruthy();
    expect(screen.getByText('Messages awaiting delivery')).toBeTruthy();

    expect(screen.getByText('Reservations impacted')).toBeTruthy();
    expect(screen.getByText('Unique reservations affected so far')).toBeTruthy();
    expect(screen.getByText('Unique IDs (retries deduplicated)')).toBeTruthy();

    // Advance Incident 1 to 06:00 and verify failed attempts vs unique affected reservations remain distinct
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));
    const metricCards = Array.from(container.querySelectorAll('.metric-card'));
    expect(metricCards.length).toBe(4);
    expect(metricCards[0]?.textContent).toContain('75 / 143 failed attempts');
    expect(metricCards[3]?.textContent).toContain('169');
    expect(metricCards[3]?.textContent).toContain('Unique IDs (retries deduplicated)');

    // Switch to Incident 2 and verify threshold note at 06:00
    const scenarioSelect = screen.getByLabelText(/Select incident scenario to investigate/i);
    fireEvent.change(scenarioSelect, { target: { value: 'incident-002' } });
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));
    expect(screen.getByText('Confirmation delay > 30s threshold')).toBeTruthy();
  });

  it('aligns DOM reading order and mobile tabs with System map -> Evidence -> Assessment & response', () => {
    const { container } = render(<App />);

    // Timeline precedes mobile tabs and workspace grid
    const timeline = container.querySelector('.timeline-card')!;
    const tablist = screen.getByRole('tablist', { name: /Investigation workspace sections/i });
    const grid = container.querySelector('.workspace-grid')!;
    expect(timeline.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tablist.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Workspace panels follow System map -> Evidence -> Assessment & response in DOM order
    const panelSystem = container.querySelector('#panel-system')!;
    const panelEvidence = container.querySelector('#panel-evidence')!;
    const panelAnalysis = container.querySelector('#panel-analysis')!;
    expect(panelSystem.compareDocumentPosition(panelEvidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panelEvidence.compareDocumentPosition(panelAnalysis) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Mobile tab order and default active tab (1. System map)
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.id)).toEqual(['tab-system', 'tab-evidence', 'tab-analysis']);
    expect(tabs[0]?.textContent).toMatch(/1\. System map/i);
    expect(tabs[1]?.textContent).toMatch(/2\. Evidence/i);
    expect(tabs[2]?.textContent).toMatch(/3\. Assessment & response/i);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(panelSystem.getAttribute('data-mobile-hidden')).toBe('false');
    expect(panelEvidence.getAttribute('data-mobile-hidden')).toBe('true');
    expect(panelAnalysis.getAttribute('data-mobile-hidden')).toBe('true');

    // Keyboard navigation across mobile tabs (ArrowRight, ArrowRight, Home, End, ArrowLeft)
    (tabs[0] as HTMLElement).focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);

    fireEvent.keyDown(tablist, { key: 'End' });
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[2]);

    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('shows the customer journey outside collapsed architecture notes without spoiling root causes', () => {
    const { container } = render(<App />);

    const journeyStrip = container.querySelector('[data-customer-journey="true"]');
    expect(journeyStrip).toBeTruthy();
    expect(journeyStrip?.textContent).toContain(
      'Customers reserve an event spot; the reservation is saved, then its confirmation is delivered separately.',
    );

    const drawer = container.querySelector('.services-accessible-drawer') as HTMLDetailsElement;
    expect(drawer).toBeTruthy();
    expect(drawer.open).toBe(false);
    // Journey strip lives outside the collapsed services/architecture details drawer
    expect(drawer.contains(journeyStrip)).toBe(false);
    expect(drawer.textContent).toContain('Request flow:');
  });

  it('simplifies the 00:00 opening state with Play as sole primary CTA and secondary Jump to Alert shortcut', () => {
    const { container } = render(<App />);

    // Provenance banner is not duplicated before Alert (03:00)
    expect(container.querySelector('.provenance-banner')).toBeNull();
    const lockedBox = container.querySelector('[data-empty-state="pre-alert-assessment"]');
    expect(lockedBox).toBeTruthy();

    // Play is the sole visible .btn-primary in the opening workspace (excluding closed briefing dialog)
    const primaryButtons = Array.from(container.querySelectorAll('button.btn-primary')).filter(
      (btn) => !btn.closest('dialog:not([open])'),
    );
    expect(primaryButtons.length).toBe(1);
    expect(primaryButtons[0]?.textContent).toMatch(/▶ Play/i);
    expect(primaryButtons[0]?.getAttribute('data-initial-play')).toBe('true');

    const jumpBtn = screen.getByRole('button', { name: /Jump to Alert Checkpoint \(03:00\)/i });
    expect(jumpBtn.classList.contains('btn-primary')).toBe(false);
    expect(jumpBtn.classList.contains('btn-secondary-shortcut')).toBe(true);

    // Clicking secondary Jump to Alert unlocks 03:00 assessment and restores provenance banner
    fireEvent.click(jumpBtn);
    expect(screen.getByText(/03:00 \/ 15:00/)).toBeTruthy();
    const banner = container.querySelector('.provenance-banner');
    expect(banner?.textContent).toContain('Authored baseline walkthrough');
  });

  it('preserves service filtering, pins, citation focus, gate focus, and debrief focus after panel reordering', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<App />);

      // Jump to 06:00 Evidence
      fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));

      // Gate CTA switches mobile tab to analysis and focuses intervention heading
      const chooseRespBtn = screen.getByRole('button', {
        name: /Choose response in Assessment & response/i,
      });
      fireEvent.click(chooseRespBtn);
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(screen.getByRole('tab', { name: /3\. Assessment & response/i }).getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(document.getElementById('intervention-decision-heading'));

      // Service node click filters evidence and switches mobile tab to evidence
      const dbNode = container.querySelector('[data-service-id="inventory-db"]') as HTMLElement;
      fireEvent.click(dbNode);
      expect(screen.getByRole('tab', { name: /2\. Evidence/i }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('button', { name: /Service: inventory-db/i })).toBeTruthy();

      // Citation click clears service filter, highlights/focuses card, and stays on evidence tab
      const citationBtns = screen.getAllByRole('button', { name: /Inspect citation ev-log-270/i });
      fireEvent.click(citationBtns[0]!);
      act(() => {
        vi.advanceTimersByTime(60);
      });
      const targetCard = document.getElementById('evidence-card-ev-log-270');
      expect(targetCard?.getAttribute('data-highlighted')).toBe('true');
      expect(document.activeElement).toBe(targetCard);

      // Pin evidence card and filter by Pinned
      const pinBtn = targetCard?.querySelector('button[aria-label*="Pin evidence"]') as HTMLElement;
      fireEvent.click(pinBtn);
      expect(screen.getByRole('button', { name: /Pinned \(1\)/i })).toBeTruthy();

      // Select response to jump to 15:00 Outcome, then Open debrief focuses debrief heading
      const applyJumpBtns = screen.getAllByRole('button', {
        name: /Apply & Jump to Outcome \(15:00\)/i,
      });
      fireEvent.click(applyJumpBtns[0]!);
      const openDebriefBtn = screen.getByRole('button', { name: /Open debrief/i });
      fireEvent.click(openDebriefBtn);
      expect(document.activeElement).toBe(document.getElementById('debrief-heading'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('has a single #investigation-main on <main> and focuses <main> when the skip link is activated via keyboard', () => {
    const { container } = render(<App />);

    const mainTargets = container.querySelectorAll('#investigation-main');
    expect(mainTargets.length).toBe(1);
    const mainEl = document.getElementById('investigation-main');
    expect(mainEl?.tagName).toBe('MAIN');

    const heading = screen.getByRole('heading', {
      name: /Incident Investigation: “Reservations are timing out”/i,
    });
    expect(heading.getAttribute('id')).toBeNull();

    const skipLink = screen.getByRole('link', { name: /Skip to investigation workspace/i });
    expect(skipLink.getAttribute('href')).toBe('#investigation-main');
    skipLink.focus();
    expect(document.activeElement).toBe(skipLink);

    // Keyboard activation of <a href="#investigation-main"> triggers click and focuses <main>
    fireEvent.keyDown(skipLink, { key: 'Enter', code: 'Enter' });
    fireEvent.click(skipLink);
    expect(document.activeElement).toBe(mainEl);
  });
});

describe('Phase 6C: Interactive Guided Tour', () => {
  it('never stacks on top of fresh-visit Mission Briefing and allows starting tour cleanly from Briefing', () => {
    const { container } = render(<App />);

    const briefingDialog = container.querySelector('#mission-briefing-dialog') as HTMLDialogElement;
    const tourDialog = container.querySelector('#guided-tour-dialog') as HTMLDialogElement;
    expect(briefingDialog).toBeTruthy();
    expect(tourDialog).toBeTruthy();

    // Fresh visit opens Mission Briefing only; Guided Tour remains closed
    expect(briefingDialog.hasAttribute('open')).toBe(true);
    expect(tourDialog.hasAttribute('open')).toBe(false);

    // Clicking secondary "Take guided tour" dismisses Briefing and opens Tour Step 1
    const takeTourBtn = screen.getByRole('button', { name: /Take guided tour/i });
    expect(takeTourBtn.classList.contains('btn-primary')).toBe(false);
    fireEvent.click(takeTourBtn);

    expect(briefingDialog.hasAttribute('open')).toBe(false);
    expect(hasDismissedMissionBriefing()).toBe(true);
    expect(tourDialog.hasAttribute('open')).toBe(true);
    expect(tourDialog.getAttribute('data-tour-step')).toBe('header-context');
    expect(screen.getAllByText(/Step 1 of 6/i).length).toBeGreaterThanOrEqual(1);

    const stepHeading = document.getElementById('guided-tour-step-title');
    expect(document.activeElement).toBe(stepHeading);
    expect(stepHeading?.textContent).toContain('Step 1 of 6');
    expect(stepHeading?.textContent).toContain('Incident header & mission context');

    // Dismissing restores focus to Play button and leaves simulation paused at 00:00
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(tourDialog, { key: 'Escape' });
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }

    expect(tourDialog.hasAttribute('open')).toBe(false);
    expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /▶ Play/i }));

    const saved = getGuidedTourPreference();
    expect(saved?.version).toBe(GUIDED_TOUR_PREF_VERSION);
    expect(saved?.status).toBe('dismissed');
    expect(saved?.lastStepId).toBe('header-context');
  });

  it('walks all 6 scenario-agnostic steps, switches and restores mobile tabs, persists completion, and can restart anytime', () => {
    saveMissionBriefingDismissed();
    const { container } = render(<App />);

    const tourTrigger = screen.getByRole('button', { name: /^Guided tour$/i });
    expect(tourTrigger.getAttribute('data-tour-trigger')).toBe('header');

    // Pre-select mobile tab 3 (Analysis) before starting tour to verify restoration on non-panel steps and exit
    const tabAnalysis = screen.getByRole('tab', { name: /3\. Assessment & response/i });
    fireEvent.click(tabAnalysis);
    expect(tabAnalysis.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(tourTrigger);

    const tourDialog = container.querySelector('#guided-tour-dialog') as HTMLDialogElement;
    expect(tourDialog.hasAttribute('open')).toBe(true);

    const spoilerPattern =
      /Cancellation Leak|Retry Storm|Schema Breakage|schemaVersion|Rollback|Observe without|circuit breaker|increase pool|quarantine/i;

    GUIDED_TOUR_STEPS.forEach((step, idx) => {
      expect(tourDialog.getAttribute('data-tour-step')).toBe(step.id);
      expect(
        screen.getAllByText(new RegExp(`Step ${idx + 1} of ${GUIDED_TOUR_STEPS.length}`, 'i'))
          .length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getByRole('heading', {
          name: new RegExp(`Step ${idx + 1} of ${GUIDED_TOUR_STEPS.length}.*${step.title}`),
        }),
      ).toBeTruthy();
      expect(step.copy).not.toMatch(spoilerPattern);

      const activeAnchors = container.querySelectorAll('[data-tour-active="true"]');
      expect(activeAnchors.length).toBe(1);
      expect(activeAnchors[0]?.id).toBe(step.anchorId);

      if (step.mobileTab) {
        const expectedTab = screen.getByRole('tab', {
          name:
            step.mobileTab === 'system'
              ? /1\. System map/i
              : step.mobileTab === 'evidence'
                ? /2\. Evidence/i
                : /3\. Assessment & response/i,
        });
        expect(expectedTab.getAttribute('aria-selected')).toBe('true');
      } else {
        expect(tabAnalysis.getAttribute('aria-selected')).toBe('true');
      }

      if (idx < GUIDED_TOUR_STEPS.length - 1) {
        fireEvent.click(screen.getByRole('button', { name: /Next step →/i }));
      }
    });

    // Step back from Step 6 -> Step 3 restores pre-tour mobile tab (Analysis), then step forward to Finish
    fireEvent.click(screen.getByRole('button', { name: /← Back/i }));
    expect(tourDialog.getAttribute('data-tour-step')).toBe('evidence-feed');
    expect(screen.getByRole('tab', { name: /2\. Evidence/i }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /← Back/i }));
    fireEvent.click(screen.getByRole('button', { name: /← Back/i }));
    expect(tourDialog.getAttribute('data-tour-step')).toBe('timeline-controls');
    expect(tabAnalysis.getAttribute('aria-selected')).toBe('true');

    // Jump directly to step 6 via progress dot and finish tour
    fireEvent.click(screen.getByRole('button', { name: /Step 6 of 6/i }));
    expect(tourDialog.getAttribute('data-tour-step')).toBe('assessment-gate');

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: /Finish tour/i }));
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }

    expect(tourDialog.hasAttribute('open')).toBe(false);
    expect(container.querySelectorAll('[data-tour-active="true"]').length).toBe(0);
    expect(tabAnalysis.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tourTrigger);

    const completedPref = getGuidedTourPreference();
    expect(completedPref?.status).toBe('completed');
    expect(completedPref?.lastStepId).toBe('assessment-gate');

    // Restarting tour anytime opens back at Step 1
    fireEvent.click(tourTrigger);
    expect(tourDialog.hasAttribute('open')).toBe(true);
    expect(tourDialog.getAttribute('data-tour-step')).toBe('header-context');
  });

  it('supports keyboard focus containment, Arrow step navigation, and clean dismissal at every step', () => {
    saveMissionBriefingDismissed();
    const { container } = render(<App />);

    const tourTrigger = screen.getByRole('button', { name: /^Guided tour$/i });
    const tourDialog = container.querySelector('#guided-tour-dialog') as HTMLDialogElement;

    for (let stepIdx = 0; stepIdx < GUIDED_TOUR_STEPS.length; stepIdx++) {
      fireEvent.click(tourTrigger);
      expect(tourDialog.hasAttribute('open')).toBe(true);

      // Navigate to target step using ArrowRight
      for (let step = 0; step < stepIdx; step++) {
        fireEvent.keyDown(tourDialog, { key: 'ArrowRight' });
      }
      expect(tourDialog.getAttribute('data-tour-step')).toBe(GUIDED_TOUR_STEPS[stepIdx]!.id);

      // Focus containment inside dialog: Tab wraps from last primary action -> Close button, Shift+Tab wraps back
      const closeBtn = screen.getByRole('button', { name: /Close guided tour/i });
      const primaryBtn = screen.getByRole('button', {
        name: stepIdx === GUIDED_TOUR_STEPS.length - 1 ? /Finish tour/i : /Next step →/i,
      });
      primaryBtn.focus();
      fireEvent.keyDown(tourDialog, { key: 'Tab' });
      expect(document.activeElement).toBe(closeBtn);
      fireEvent.keyDown(tourDialog, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(primaryBtn);

      vi.useFakeTimers();
      try {
        if (stepIdx % 3 === 0) {
          fireEvent.keyDown(tourDialog, { key: 'Escape' });
        } else if (stepIdx % 3 === 1) {
          fireEvent.click(closeBtn);
        } else {
          fireEvent.click(screen.getByRole('button', { name: /Dismiss tour/i }));
        }
        vi.runAllTimers();
      } finally {
        vi.useRealTimers();
      }

      expect(tourDialog.hasAttribute('open')).toBe(false);
      expect(container.querySelectorAll('[data-tour-active="true"]').length).toBe(0);
      expect(document.activeElement).toBe(tourTrigger);
      expect(getGuidedTourPreference()?.lastStepId).toBe(GUIDED_TOUR_STEPS[stepIdx]!.id);
    }

    // Verify ArrowLeft navigation and focus retention when Back disables on Step 1
    fireEvent.click(tourTrigger);
    fireEvent.keyDown(tourDialog, { key: 'ArrowRight' });
    expect(tourDialog.getAttribute('data-tour-step')).toBe('headline-metrics');

    const backBtn = screen.getByRole('button', { name: /← Back/i });
    backBtn.focus();
    fireEvent.click(backBtn);
    expect(tourDialog.getAttribute('data-tour-step')).toBe('header-context');
    expect(backBtn.hasAttribute('disabled')).toBe(true);
    expect(tourDialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('guided-tour-step-title'));
  });

  it('respects prefers-reduced-motion when scrolling off-screen anchors into view', () => {
    saveMissionBriefingDismissed();
    const originalMatchMedia = window.matchMedia;
    const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
    const scrollCalls: Array<ScrollIntoViewOptions | boolean | undefined> = [];

    window.HTMLElement.prototype.scrollIntoView = function (
      arg?: ScrollIntoViewOptions | boolean,
    ) {
      scrollCalls.push(arg);
    };
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

    try {
      const { container } = render(<App />);
      const tourTrigger = screen.getByRole('button', { name: /^Guided tour$/i });
      fireEvent.click(tourTrigger);

      const tourDialog = container.querySelector('#guided-tour-dialog') as HTMLDialogElement;
      expect(tourDialog.getAttribute('data-reduced-motion')).toBe('true');

      fireEvent.click(screen.getByRole('button', { name: /Step 6 of 6/i }));
      expect(scrollCalls.length).toBeGreaterThan(0);
      scrollCalls.forEach((opt) => {
        expect(typeof opt === 'object' && opt !== null && opt.behavior).toBe('auto');
      });
    } finally {
      window.matchMedia = originalMatchMedia;
      window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('pauses active playback without auto-resuming, preserves state, keeps 06:00 gate enforced, and triggers zero AI calls across 00:00, investigation, and 06:00', () => {
    saveMissionBriefingDismissed();
    const transportSpy = vi.fn(() => ({
      status: 'ok' as const,
      cacheHit: false,
      isMockProvider: true,
      result: INCIDENT_001_DEFINITION.walkthroughs.alert,
    }));
    const mockTransport = new MockAnalyzeIncidentTransport(transportSpy);
    const { container } = render(<App transportOverride={mockTransport} />);

    const captureCanonicalDigests = () =>
      Array.from(container.querySelectorAll('[data-testid^="canonical-digest-"]')).map(
        (el) => el.textContent,
      );
    const baselineDigests = captureCanonicalDigests();

    const tourTrigger = screen.getByRole('button', { name: /^Guided tour$/i });
    const tourDialog = container.querySelector('#guided-tour-dialog') as HTMLDialogElement;

    // 1. Open at 00:00
    fireEvent.click(tourTrigger);
    expect(tourDialog.hasAttribute('open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss tour/i }));
    expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect(transportSpy).not.toHaveBeenCalled();

    // 2. Open at 06:00 decision gate (no intervention selected) -> verify gate stays enforced
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));
    fireEvent.click(tourTrigger);
    fireEvent.click(screen.getByRole('button', { name: /Step 6 of 6/i }));
    fireEvent.click(screen.getByRole('button', { name: /Finish tour/i }));

    expect(screen.getByText(/06:00 \/ 15:00/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /15:00 Outcome & Debrief/i }).getAttribute('aria-disabled'),
    ).toBe('true');
    // Attempting Play at 06:00 still blocks progression without an intervention
    fireEvent.click(screen.getByRole('button', { name: /▶ Play/i }));
    expect(screen.getByText(/06:00 \/ 15:00/)).toBeTruthy();
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect(transportSpy).not.toHaveBeenCalled();

    // 3. Switch to incident-002, pin item, filter Logs, set preview mode, Apply & Play from 06:00, then open tour
    const scenarioSelect = screen.getByLabelText(/Select incident scenario to investigate/i);
    fireEvent.change(scenarioSelect, { target: { value: 'incident-002' } });
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));

    const pinButtons = screen.getAllByRole('button', { name: /Pin evidence/i });
    fireEvent.click(pinButtons[0]!);
    expect(screen.getByRole('button', { name: /Pinned \(1\)/i })).toBeTruthy();

    const logsBtn = screen.getByRole('button', { name: /^Logs$/i });
    fireEvent.click(logsBtn);
    expect(logsBtn.getAttribute('aria-pressed')).toBe('true');

    const modeSelect = screen.getByLabelText(/Assessment State Mode:/i) as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: 'preview_cached_ai' } });
    expect(modeSelect.value).toBe('preview_cached_ai');

    const applyPlayBtns = screen.getAllByRole('button', { name: /Apply & Play from 06:00/i });
    fireEvent.click(applyPlayBtns[0]!);
    expect(screen.getByText(/06:05 \/ 15:00/)).toBeTruthy();
    expect(screen.getByText(/▶ LIVE PLAYBACK/)).toBeTruthy();

    // Opening tour pauses playback immediately
    fireEvent.click(tourTrigger);
    expect(tourDialog.hasAttribute('open')).toBe(true);
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /▶ Play/i })).toBeTruthy();

    // Dismissing leaves playback paused and preserves all investigation state
    fireEvent.keyDown(tourDialog, { key: 'Escape' });
    expect(tourDialog.hasAttribute('open')).toBe(false);
    expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
    expect((scenarioSelect as HTMLSelectElement).value).toBe('incident-002');
    expect(screen.getByText(/06:05 \/ 15:00/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pinned \(1\)/i })).toBeTruthy();
    expect(logsBtn.getAttribute('aria-pressed')).toBe('true');
    expect(modeSelect.value).toBe('preview_cached_ai');
    expect(container.querySelector('[data-selected-badge="true"]')).toBeTruthy();
    expect(transportSpy).not.toHaveBeenCalled();

    // Switch back to incident-001 and verify canonical snapshot digests remain unchanged
    fireEvent.change(scenarioSelect, { target: { value: 'incident-001' } });
    expect(captureCanonicalDigests()).toEqual(baselineDigests);
  });

  it('handles unavailable storage and mismatched guided-tour preference versions gracefully', () => {
    const throwingStorage: Storage = {
      length: 0,
      clear: () => {},
      key: () => null,
      removeItem: () => {},
      getItem: () => {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    };

    expect(getGuidedTourPreference(throwingStorage)).toBeNull();
    expect(hasDismissedOrCompletedGuidedTour(throwingStorage)).toBe(false);
    expect(saveGuidedTourPreference('completed', 'assessment-gate', throwingStorage)).toBe(false);

    // Mismatched preference version or invalid status is ignored safely
    window.localStorage.setItem(
      GUIDED_TOUR_STORAGE_KEY,
      JSON.stringify({ version: 999, status: 'completed' }),
    );
    expect(getGuidedTourPreference()).toBeNull();
    expect(hasDismissedOrCompletedGuidedTour()).toBe(false);

    window.localStorage.setItem(
      GUIDED_TOUR_STORAGE_KEY,
      JSON.stringify({ version: GUIDED_TOUR_PREF_VERSION, status: 'unknown' }),
    );
    expect(getGuidedTourPreference()).toBeNull();

    // Unavailable window.localStorage during App tour open and dismissal does not throw
    saveMissionBriefingDismissed();
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    try {
      const { container } = render(<App />);
      const tourBtn = screen.getByRole('button', { name: /^Guided tour$/i });
      fireEvent.click(tourBtn);
      const tourDialog = container.querySelector('#guided-tour-dialog') as HTMLDialogElement;
      expect(tourDialog.hasAttribute('open')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: /Dismiss tour/i }));
      expect(tourDialog.hasAttribute('open')).toBe(false);
    } finally {
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  it('focuses the step heading with step number, title, and guidance on every transition, preserves Tab containment, and anchors Step 6 to the 06:00 decision area only once unlocked', () => {
    saveMissionBriefingDismissed();
    const transportSpy = vi.fn(() => ({
      status: 'ok' as const,
      cacheHit: false,
      isMockProvider: true,
      result: INCIDENT_001_DEFINITION.walkthroughs.alert,
    }));
    const mockTransport = new MockAnalyzeIncidentTransport(transportSpy);
    const { container } = render(<App transportOverride={mockTransport} />);

    const tourTrigger = screen.getByRole('button', { name: /^Guided tour$/i });
    const tourDialog = container.querySelector('#guided-tour-dialog') as HTMLDialogElement;
    const assertHeadingFocusForStep = (idx: number) => {
      const step = GUIDED_TOUR_STEPS[idx]!;
      const heading = document.getElementById('guided-tour-step-title');
      expect(document.activeElement).toBe(heading);
      expect(heading?.getAttribute('tabindex')).toBe('-1');
      expect(heading?.textContent).toContain(`Step ${idx + 1} of ${GUIDED_TOUR_STEPS.length}`);
      expect(heading?.textContent).toContain(step.categoryLabel);
      expect(heading?.textContent).toContain(step.title);

      const describedById = heading?.getAttribute('aria-describedby');
      expect(describedById).toBe('guided-tour-step-body');
      const bodyEl = describedById ? document.getElementById(describedById) : null;
      expect(bodyEl?.textContent).toContain(step.copy);
      expect(bodyEl?.textContent).toContain(step.targetLabel);
    };

    // Open at 00:00 -> Step 1 focuses heading; Tab moves to Close button, Shift+Tab wraps to Next step
    fireEvent.click(tourTrigger);
    assertHeadingFocusForStep(0);

    const closeBtn = screen.getByRole('button', { name: /Close guided tour/i });
    const nextBtn = screen.getByRole('button', { name: /Next step →/i });
    fireEvent.keyDown(tourDialog, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);
    document.getElementById('guided-tour-step-title')?.focus();
    fireEvent.keyDown(tourDialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(nextBtn);

    // Next step, step dot, ArrowRight, ArrowLeft, and Back all move focus to the updated step heading
    fireEvent.click(nextBtn);
    assertHeadingFocusForStep(1);

    fireEvent.keyDown(tourDialog, { key: 'ArrowRight' });
    assertHeadingFocusForStep(2);

    fireEvent.keyDown(tourDialog, { key: 'ArrowLeft' });
    assertHeadingFocusForStep(1);

    fireEvent.click(screen.getByRole('button', { name: /← Back/i }));
    assertHeadingFocusForStep(0);

    // Pre-06:00 (at 00:00): Step 6 anchors to #panel-analysis without advancing simulation time
    fireEvent.click(screen.getByRole('button', { name: /Step 6 of 6/i }));
    assertHeadingFocusForStep(5);
    expect(screen.getByText(/00:00 \/ 15:00/)).toBeTruthy();
    expect(container.querySelector('[data-tour-active="true"]')?.id).toBe('panel-analysis');
    expect(document.getElementById('intervention-decision-section')).toBeNull();

    vi.useFakeTimers();
    try {
      fireEvent.keyDown(tourDialog, { key: 'Escape' });
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    expect(document.activeElement).toBe(tourTrigger);

    // Pre-06:00 (at 03:00 Alert): Step 6 still anchors to #panel-analysis without advancing to 06:00
    fireEvent.click(screen.getByRole('button', { name: /03:00 Alert/i }));
    fireEvent.click(tourTrigger);
    fireEvent.click(screen.getByRole('button', { name: /Step 6 of 6/i }));
    assertHeadingFocusForStep(5);
    expect(screen.getByText(/03:00 \/ 15:00/)).toBeTruthy();
    expect(container.querySelector('[data-tour-active="true"]')?.id).toBe('panel-analysis');
    expect(document.getElementById('intervention-decision-section')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Dismiss tour/i }));

    // At 06:00 decision gate (starting from mobile tab 1): Step 6 switches mobile tab to analysis and anchors #intervention-decision-section
    fireEvent.click(screen.getByRole('button', { name: /06:00 Evidence & Intervene/i }));
    fireEvent.click(screen.getByRole('tab', { name: /1\. System map/i }));

    const scrollTargets: string[] = [];
    const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = function () {
      if (this.id) scrollTargets.push(this.id);
    };

    try {
      fireEvent.click(tourTrigger);
      fireEvent.click(screen.getByRole('button', { name: /Step 6 of 6/i }));
      assertHeadingFocusForStep(5);

      expect(screen.getByRole('tab', { name: /3\. Assessment & response/i }).getAttribute('aria-selected')).toBe('true');
      const activeAnchor = container.querySelector('[data-tour-active="true"]');
      expect(activeAnchor?.id).toBe('intervention-decision-section');
      expect(scrollTargets).toContain('intervention-decision-section');
      expect(screen.getByText(/06:00 \/ 15:00/)).toBeTruthy();
      expect(screen.getByText(/⏸ PAUSED/)).toBeTruthy();
      expect(transportSpy).not.toHaveBeenCalled();

      vi.useFakeTimers();
      try {
        fireEvent.keyDown(tourDialog, { key: 'Escape' });
        vi.runAllTimers();
      } finally {
        vi.useRealTimers();
      }
      expect(document.activeElement).toBe(tourTrigger);
      expect(screen.getByRole('tab', { name: /1\. System map/i }).getAttribute('aria-selected')).toBe('true');
      expect(
        screen.getByRole('button', { name: /15:00 Outcome & Debrief/i }).getAttribute('aria-disabled'),
      ).toBe('true');
    } finally {
      window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
