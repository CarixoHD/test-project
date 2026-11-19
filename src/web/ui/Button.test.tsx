import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button.tsx';

describe('Button', () => {
  it('is a non-submitting button by default', () => {
    render(<Button>Pause</Button>);
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAttribute('type', 'button');
  });

  it('passes variant and native props through', () => {
    render(
      <Button variant="danger" type="submit" disabled>
        Cancel issue
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Cancel issue' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toBeDisabled();
    expect(button).toHaveClass('ui-button', 'ui-button--danger');
  });
});
