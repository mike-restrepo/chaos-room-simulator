import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type GuidedTourMobileTab = 'system' | 'evidence' | 'analysis';

export interface GuidedTourStep {
  id: string;
  anchorId: string;
  preferredAnchorIds?: readonly string[];
  mobileTab: GuidedTourMobileTab | null;
  categoryLabel: string;
  targetLabel: string;
  title: string;
  copy: string;
}

export const GUIDED_TOUR_STEPS: readonly GuidedTourStep[] = [
  {
    id: 'header-context',
    anchorId: 'tour-anchor-header',
    mobileTab: null,
    categoryLabel: 'Workspace orientation',
    targetLabel: 'Header & mission context',
    title: 'Incident header & mission context',
    copy: 'Switch between the three synthetic incident scenarios, reopen the Mission Briefing or this guided tour anytime, and monitor the live customer impact banner as severity changes.',
  },
  {
    id: 'headline-metrics',
    anchorId: 'tour-anchor-metrics',
    mobileTab: null,
    categoryLabel: 'Customer & system impact',
    targetLabel: 'Headline operational measures',
    title: 'Headline operational metrics',
    copy: 'Four headline cards track reservation failures, p95 response time, pending confirmations, and unique reservations impacted—separating retry volume from affected customers.',
  },
  {
    id: 'timeline-controls',
    anchorId: 'tour-anchor-timeline',
    mobileTab: null,
    categoryLabel: 'Accelerated simulation clock',
    targetLabel: 'Incident timeline & checkpoints',
    title: 'Timeline & canonical checkpoints',
    copy: 'Play, pause, scrub, or jump across canonical checkpoints: 00:00 Orient, 03:00 Alert, 06:00 Evidence & Intervene, and 15:00 Outcome. The next-step guidance strip adapts to your current phase.',
  },
  {
    id: 'system-map',
    anchorId: 'panel-system',
    mobileTab: 'system',
    categoryLabel: 'Dependency topology',
    targetLabel: '1. System map',
    title: 'System map & customer journey',
    copy: 'Follow the two-part customer journey from saving a reservation to delivering its confirmation. Select any service node to inspect its health metrics and filter the evidence feed.',
  },
  {
    id: 'evidence-feed',
    anchorId: 'panel-evidence',
    mobileTab: 'evidence',
    categoryLabel: 'Grounded telemetry',
    targetLabel: '2. Evidence',
    title: 'Evidence & time-series telemetry',
    copy: 'Correlate synchronized metric charts with timestamped logs, traces, metrics, and deployments. Filter by category or pin high-signal items while testing hypotheses.',
  },
  {
    id: 'assessment-gate',
    anchorId: 'panel-analysis',
    preferredAnchorIds: ['intervention-decision-section'],
    mobileTab: 'analysis',
    categoryLabel: 'Hypotheses & 06:00 gate',
    targetLabel: '3. Assessment & response',
    title: 'Assessment & 06:00 response gate',
    copy: 'Structured hypotheses, clickable evidence citations, and optional AI analysis unlock at 03:00 Alert. At 06:00 Evidence, you must choose a response path before advancing to 15:00 Outcome.',
  },
];

export function resolveStepAnchorId(step: GuidedTourStep): string {
  if (typeof document !== 'undefined' && step.preferredAnchorIds) {
    for (const candidateId of step.preferredAnchorIds) {
      if (document.getElementById(candidateId)) {
        return candidateId;
      }
    }
  }
  return step.anchorId;
}

export interface GuidedTourDialogProps {
  isOpen: boolean;
  stepIndex: number;
  onSelectStep: (nextIndex: number) => void;
  onDismiss: () => void;
  onComplete: () => void;
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CardPosition {
  top: number;
  left: number;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function detectReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isPointerOutsideCard(
  e: React.PointerEvent<HTMLDialogElement>,
  card: HTMLElement | null,
  dialog: HTMLDialogElement,
): boolean {
  if (!card) {
    return e.target === dialog;
  }
  const rect = card.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return e.target === dialog;
  }
  return (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  );
}

export const GuidedTourDialog: React.FC<GuidedTourDialogProps> = ({
  isOpen,
  stepIndex,
  onSelectStep,
  onDismiss,
  onComplete,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const pressedOutsideRef = useRef<boolean>(false);
  const closedInCycleRef = useRef<boolean>(false);

  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(detectReducedMotion);
  const [spotlightRect, setSpotlightRect] = useState<SpotlightRect | null>(null);
  const [cardPosition, setCardPosition] = useState<CardPosition | null>(null);

  const clampedIndex = Math.max(0, Math.min(GUIDED_TOUR_STEPS.length - 1, stepIndex));
  const currentStep = GUIDED_TOUR_STEPS[clampedIndex]!;
  const isFirstStep = clampedIndex === 0;
  const isLastStep = clampedIndex === GUIDED_TOUR_STEPS.length - 1;

  const handleDismiss = () => {
    if (closedInCycleRef.current) {
      return;
    }
    closedInCycleRef.current = true;
    onDismiss();
  };

  const handleComplete = () => {
    if (closedInCycleRef.current) {
      return;
    }
    closedInCycleRef.current = true;
    onComplete();
  };

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncPreference = () => setPrefersReducedMotion(mediaQuery.matches);
    syncPreference();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncPreference);
      return () => mediaQuery.removeEventListener('change', syncPreference);
    }
    return undefined;
  }, []);

  const repositionOverlay = useCallback(() => {
    if (!isOpen || typeof window === 'undefined') {
      setSpotlightRect(null);
      setCardPosition(null);
      return;
    }

    const resolvedAnchorId = resolveStepAnchorId(currentStep);
    const anchorEl = document.getElementById(resolvedAnchorId);
    if (!anchorEl) {
      setSpotlightRect(null);
      setCardPosition(null);
      return;
    }

    const rect = anchorEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      setSpotlightRect(null);
      setCardPosition(null);
      return;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const edgeInset = 4;

    const sLeft = Math.max(edgeInset, Math.floor(rect.left - edgeInset));
    const sTop = Math.max(edgeInset, Math.floor(rect.top - edgeInset));
    const sRight = Math.min(vw - edgeInset, Math.ceil(rect.right + edgeInset));
    const sBottom = Math.min(vh - edgeInset, Math.ceil(rect.bottom + edgeInset));
    const sWidth = sRight - sLeft;
    const sHeight = sBottom - sTop;

    if (sWidth > 0 && sHeight > 0) {
      setSpotlightRect({
        top: sTop,
        left: sLeft,
        width: sWidth,
        height: sHeight,
      });
    } else {
      setSpotlightRect(null);
    }

    const cardRect = cardRef.current?.getBoundingClientRect();
    const pad = vw <= 640 ? 12 : 16;
    const cardW = cardRect && cardRect.width > 40 ? cardRect.width : Math.min(390, vw - pad * 2);
    const cardH = cardRect && cardRect.height > 40 ? cardRect.height : 240;
    const maxLeft = Math.max(pad, vw - cardW - pad);
    const maxTop = Math.max(pad, vh - cardH - pad);
    const gap = 14;

    const clampX = (x: number) => Math.max(pad, Math.min(maxLeft, x));
    const clampY = (y: number) => Math.max(pad, Math.min(maxTop, y));

    if (vw <= 768) {
      const mobileLeft = clampX((vw - cardW) / 2);
      if (rect.bottom + gap + cardH <= vh - pad) {
        setCardPosition({ left: mobileLeft, top: clampY(rect.bottom + gap) });
      } else if (rect.top - gap - cardH >= pad) {
        setCardPosition({ left: mobileLeft, top: clampY(rect.top - gap - cardH) });
      } else if (rect.top > vh * 0.45) {
        setCardPosition({ left: mobileLeft, top: pad });
      } else {
        setCardPosition({ left: mobileLeft, top: maxTop });
      }
      return;
    }

    if (rect.bottom + gap + cardH <= vh - pad) {
      setCardPosition({
        left: clampX(rect.left),
        top: clampY(rect.bottom + gap),
      });
    } else if (rect.right + gap + cardW <= vw - pad) {
      setCardPosition({
        left: clampX(rect.right + gap),
        top: clampY(Math.max(pad, rect.top)),
      });
    } else if (rect.left - gap - cardW >= pad) {
      setCardPosition({
        left: clampX(rect.left - gap - cardW),
        top: clampY(Math.max(pad, rect.top)),
      });
    } else if (rect.top - gap - cardH >= pad) {
      setCardPosition({
        left: clampX(rect.left),
        top: clampY(rect.top - gap - cardH),
      });
    } else if (rect.top > vh - rect.bottom) {
      setCardPosition({
        left: maxLeft,
        top: pad,
      });
    } else {
      setCardPosition({
        left: maxLeft,
        top: maxTop,
      });
    }
  }, [currentStep, isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (isOpen) {
      closedInCycleRef.current = false;
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) {
          dialog.showModal();
        }
      } else {
        dialog.setAttribute('open', '');
      }
      stepHeadingRef.current?.focus({ preventScroll: true });
    } else {
      setSpotlightRect(null);
      setCardPosition(null);
      if (typeof dialog.close === 'function') {
        if (dialog.open) {
          dialog.close();
        }
      } else {
        dialog.removeAttribute('open');
      }
    }
  }, [isOpen]);

  // Keep target anchor highlighted, scrolled into view, and step heading focused for screen readers
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const resolvedAnchorId = resolveStepAnchorId(currentStep);
    const anchorEl = document.getElementById(resolvedAnchorId);
    if (!anchorEl) {
      return;
    }

    anchorEl.setAttribute('data-tour-active', 'true');

    const reducedMotion = detectReducedMotion();
    setPrefersReducedMotion(reducedMotion);

    const rect = anchorEl.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth || 1024;
    const behavior: ScrollBehavior = reducedMotion ? 'auto' : 'smooth';
    const minVisibleTop = currentStep.mobileTab && vw <= 640 ? 70 : 12;

    if (
      resolvedAnchorId === 'intervention-decision-section' ||
      rect.width === 0 ||
      rect.height === 0 ||
      rect.top < minVisibleTop ||
      rect.top > vh * 0.45
    ) {
      if (typeof anchorEl.scrollIntoView === 'function') {
        anchorEl.scrollIntoView({
          behavior,
          block: 'start',
          inline: 'nearest',
        });
      }
    } else if (rect.bottom > vh - 16 && rect.height < vh - 32) {
      if (typeof anchorEl.scrollIntoView === 'function') {
        anchorEl.scrollIntoView({
          behavior,
          block: 'nearest',
          inline: 'nearest',
        });
      }
    }

    // Focus the step heading on open and every step transition so screen readers announce step number, title, and guidance
    stepHeadingRef.current?.focus({ preventScroll: true });

    repositionOverlay();

    return () => {
      anchorEl.removeAttribute('data-tour-active');
    };
  }, [currentStep, isOpen, clampedIndex, repositionOverlay]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    repositionOverlay();

    const handleScrollOrResize = () => {
      repositionOverlay();
    };

    window.addEventListener('scroll', handleScrollOrResize, { passive: true, capture: true });
    window.addEventListener('scrollend', handleScrollOrResize, { passive: true, capture: true });
    window.addEventListener('resize', handleScrollOrResize);

    let rafId = 0;
    const settleTimer = window.setTimeout(repositionOverlay, prefersReducedMotion ? 20 : 800);
    if (!prefersReducedMotion && typeof requestAnimationFrame === 'function') {
      const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
      let lastKey = '';
      let stableFrames = 0;
      const tick = () => {
        repositionOverlay();
        const anchorEl = document.getElementById(resolveStepAnchorId(currentStep));
        const r = anchorEl?.getBoundingClientRect();
        const key = r ? `${Math.round(r.top)}:${Math.round(r.left)}` : '';
        if (key && key === lastKey) {
          stableFrames += 1;
        } else {
          lastKey = key;
          stableFrames = 0;
        }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - start < 950 && (now - start < 250 || stableFrames < 4)) {
          rafId = requestAnimationFrame(tick);
        }
      };
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('scrollend', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
      window.clearTimeout(settleTimer);
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isOpen, clampedIndex, currentStep, prefersReducedMotion, repositionOverlay]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDismiss();
      return;
    }

    if (e.key === 'ArrowRight') {
      if (!isLastStep) {
        e.preventDefault();
        onSelectStep(clampedIndex + 1);
      }
      return;
    }

    if (e.key === 'ArrowLeft') {
      if (!isFirstStep) {
        e.preventDefault();
        onSelectStep(clampedIndex - 1);
      }
      return;
    }

    if (e.key === 'Tab') {
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');

      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (!active || !dialog.contains(active) || !focusables.includes(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    pressedOutsideRef.current = isPointerOutsideCard(e, cardRef.current, dialog);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const releasedOutside = isPointerOutsideCard(e, cardRef.current, dialog);
    const wasPressedOutside = pressedOutsideRef.current;
    pressedOutsideRef.current = false;
    if (wasPressedOutside && releasedOutside) {
      handleDismiss();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      id="guided-tour-dialog"
      className="guided-tour-dialog"
      aria-labelledby="guided-tour-step-title"
      aria-describedby="guided-tour-step-body"
      data-tour-step={currentStep.id}
      data-step-index={clampedIndex}
      data-has-spotlight={spotlightRect ? 'true' : 'false'}
      data-reduced-motion={prefersReducedMotion ? 'true' : 'false'}
      {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
      onCancel={(e) => {
        e.preventDefault();
        handleDismiss();
      }}
      onClose={() => {
        if (isOpen) {
          handleDismiss();
        }
      }}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      {spotlightRect && (
        <div
          className="guided-tour-spotlight"
          aria-hidden="true"
          style={{
            top: `${spotlightRect.top}px`,
            left: `${spotlightRect.left}px`,
            width: `${spotlightRect.width}px`,
            height: `${spotlightRect.height}px`,
          }}
        />
      )}

      <div
        ref={cardRef}
        className="guided-tour-card"
        style={
          cardPosition
            ? {
                position: 'fixed',
                top: `${cardPosition.top}px`,
                left: `${cardPosition.left}px`,
                margin: 0,
              }
            : undefined
        }
      >
        <div className="guided-tour-header">
          <div className="guided-tour-title-wrap">
            <div className="guided-tour-eyebrow-row" aria-hidden="true">
              <span className="brand-pill mono">
                Step {clampedIndex + 1} of {GUIDED_TOUR_STEPS.length}
              </span>
              <span className="guided-tour-category mono">{currentStep.categoryLabel}</span>
            </div>
            <h2
              ref={stepHeadingRef}
              id="guided-tour-step-title"
              tabIndex={-1}
              className="guided-tour-title"
              aria-describedby="guided-tour-step-body"
            >
              <span className="visually-hidden">
                Step {clampedIndex + 1} of {GUIDED_TOUR_STEPS.length} ({currentStep.categoryLabel}):{' '}
              </span>
              {currentStep.title}
            </h2>
          </div>

          <button
            type="button"
            className="btn btn-sm guided-tour-close-btn"
            onClick={handleDismiss}
            aria-label="Close guided tour"
          >
            ✕
          </button>
        </div>

        <div id="guided-tour-step-body" className="guided-tour-body">
          <p className="guided-tour-copy">{currentStep.copy}</p>
          <div className="guided-tour-target-chip mono">
            Focused area: <strong>{currentStep.targetLabel}</strong>
          </div>
        </div>

        <div className="guided-tour-progress" role="group" aria-label="Tour step progress">
          {GUIDED_TOUR_STEPS.map((step, idx) => (
            <button
              key={step.id}
              type="button"
              className="guided-tour-step-dot mono"
              data-active={idx === clampedIndex}
              aria-current={idx === clampedIndex ? 'step' : undefined}
              aria-label={`Step ${idx + 1} of ${GUIDED_TOUR_STEPS.length}: ${step.title}`}
              onClick={() => onSelectStep(idx)}
            >
              {idx + 1}
            </button>
          ))}
        </div>

        <div className="guided-tour-actions">
          <button
            type="button"
            className="btn btn-sm guided-tour-dismiss-btn"
            onClick={handleDismiss}
          >
            Dismiss tour
          </button>

          <div className="guided-tour-nav-group">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onSelectStep(Math.max(0, clampedIndex - 1))}
              disabled={isFirstStep}
            >
              ← Back
            </button>

            <button
              ref={primaryActionRef}
              type="button"
              className="btn btn-primary btn-sm guided-tour-next-btn"
              onClick={() => {
                if (isLastStep) {
                  handleComplete();
                } else {
                  onSelectStep(clampedIndex + 1);
                }
              }}
            >
              {isLastStep ? 'Finish tour' : 'Next step →'}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
};
