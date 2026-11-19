import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge.tsx';

describe('StatusBadge', () => {
  it('shows its status as text, with the tone as a class', () => {
    render(<StatusBadge tone="success">Completed</StatusBadge>);
    const badge = screen.getByText('Completed');
    expect(badge).toHaveClass('ui-badge', 'ui-badge--success');
  });
});
