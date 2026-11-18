import React, { useEffect, useRef } from 'react';

export interface MissionBriefingDialogProps {
  isOpen: boolean;
  onDismiss: () => void;
  onStartTour?: () => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isPointerOutsideDialog(
  e: React.PointerEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement,
): boolean {
  const rect = dialog.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  return (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  );
}

export const MissionBriefingDialog: React.FC<MissionBriefingDialogProps> = ({
  isOpen,
  onDismiss,
  onStartTour,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const primaryBtnRef = useRef<HTMLButtonElement | null>(null);
  const pressedOutsideRef = useRef<boolean>(false);
  const dismissedInCycleRef = useRef<boolean>(false);

  const handleDismiss = () => {
    if (dismissedInCycleRef.current) {
      return;
    }
    dismissedInCycleRef.current = true;
    onDismiss();
  };

  const handleStartTour = () => {
    if (dismissedInCycleRef.current) {
      return;
    }
    dismissedInCycleRef.current = true;
    onStartTour?.();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (isOpen) {
      dismissedInCycleRef.current = false;
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) {
          dialog.showModal();
        }
      } else {
        dialog.setAttribute('open', '');
      }
      primaryBtnRef.current?.focus();
    } else {
      if (typeof dialog.close === 'function') {
        if (dialog.open) {
          dialog.close();
        }
      } else {
        dialog.removeAttribute('open');
      }
    }
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDismiss();
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

      if (!active || !dialog.contains(active)) {
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

  const supportsNativeClosedBy =
    typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;

  const handlePointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (supportsNativeClosedBy) {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    pressedOutsideRef.current = isPointerOutsideDialog(e, dialog);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (supportsNativeClosedBy) {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const releasedOutside = isPointerOutsideDialog(e, dialog);
    const wasPressedOutside = pressedOutsideRef.current;
    pressedOutsideRef.current = false;
    if (wasPressedOutside && releasedOutside) {
      handleDismiss();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      id="mission-briefing-dialog"
      className="mission-briefing-dialog"
      aria-labelledby="mission-briefing-title"
      aria-describedby="mission-briefing-body"
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
      <div className="mission-briefing-header">
        <div className="mission-briefing-title-wrap">
          <span className="brand-pill mono">Mission Briefing</span>
          <h2 id="mission-briefing-title" className="mission-briefing-title">
            Your mission: investigate the incident
          </h2>
        </div>

        <button
          type="button"
          className="btn btn-sm mission-briefing-close-btn"
          onClick={handleDismiss}
          aria-label="Close mission briefing"
        >
          ✕
        </button>
      </div>

      <div id="mission-briefing-body" className="mission-briefing-copy">
        <p>
          Customers use this fictional platform to reserve places at events. Their reservations are
          saved first; confirmations are delivered separately.
        </p>
        <p>
          You are coordinating the incident response. Start with normal operations, watch the
          warning signs emerge, and investigate what changed. Then choose a response and see its
          consequences.
        </p>
        <p>
          AI can help interpret the evidence, but you make the decision. Success means restoring the
          customer journey and checking that recovery worked.
        </p>
      </div>

      <div className="mission-briefing-meta mono">
        <span>About 3–5 minutes • Fictional system and synthetic data</span>
        <span>Pause or jump between checkpoints.</span>
      </div>

      <div className="mission-briefing-actions">
        {onStartTour && (
          <button
            type="button"
            className="btn mission-briefing-tour-btn"
            onClick={handleStartTour}
          >
            Take guided tour
          </button>
        )}
        <button
          ref={primaryBtnRef}
          type="button"
          className="btn btn-primary mission-briefing-enter-btn"
          autoFocus
          onClick={handleDismiss}
        >
          Enter investigation
        </button>
      </div>
    </dialog>
  );
};
