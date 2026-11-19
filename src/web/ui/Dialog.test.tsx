import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Dialog } from './Dialog.tsx';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Cancel issue
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Cancel issue #3?">
        <p>The running attempt will be discarded.</p>
        <button type="button">Keep it</button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel issue now
        </button>
      </Dialog>
    </>
  );
}

async function openDialog() {
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Cancel issue' });
  await user.click(opener);
  return { user, opener, dialog: screen.getByRole('dialog', { name: 'Cancel issue #3?' }) };
}

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens as a labelled modal dialog and moves focus into it', async () => {
    const { dialog } = await openDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus();
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const { user } = await openDialog();
    const keep = screen.getByRole('button', { name: 'Keep it' });
    const confirm = screen.getByRole('button', { name: 'Cancel issue now' });
    const close = screen.getByRole('button', { name: 'Close' });

    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(keep).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const { user, opener } = await openDialog();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('returns focus to the opener when closed by an action inside it', async () => {
    const { user, opener } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel issue now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes from its Close button', async () => {
    const { user } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
