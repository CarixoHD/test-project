import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Modal dialog: focus moves in on open, Tab/Shift+Tab stay inside, Escape closes, and focus
// returns to whatever had it before (usually the button that opened the dialog).

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.closest('[hidden], [inert]') === null,
  );
}

/** Wraps Tab / Shift+Tab around the first and last tabbable element of `panel`. */
function trapTab(e: KeyboardEvent, panel: HTMLElement): void {
  const items = tabbables(panel);
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) {
    e.preventDefault();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && items.includes(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; also the dialog's accessible name. */
  title: string;
  children: ReactNode;
}

export function Dialog({ open, onClose, title, children }: DialogProps) {
  if (!open) return null;
  return createPortal(
    <DialogPanel onClose={onClose} title={title}>
      {children}
    </DialogPanel>,
    document.body,
  );
}

function DialogPanel({ onClose, title, children }: Omit<DialogProps, 'open'>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // A native listener: jsx-a11y rejects key handlers on the non-interactive dialog element.
  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    const panel = panelRef.current;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab' && panel !== null) trapTab(e, panel);
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (tabbables(panel)[0] ?? panel).focus();
    const handleKeyDown = (e: KeyboardEvent) => onKeyDown(e);
    panel.addEventListener('keydown', handleKeyDown);
    return () => {
      panel.removeEventListener('keydown', handleKeyDown);
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, []);

  return (
    <div className="ui-dialog-backdrop">
      <div
        ref={panelRef}
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="ui-dialog__title">
          {title}
        </h2>
        <div className="ui-dialog__body">{children}</div>
        {/* Last in the DOM so focus starts on the content; placed top-right by CSS. */}
        <button type="button" className="ui-dialog__close" aria-label="Close" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
