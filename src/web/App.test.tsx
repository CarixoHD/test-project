import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

describe('App', () => {
  it('renders the Vibecode heading inside main', () => {
    render(<App />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Vibecode' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole('main')).toContainElement(heading);
  });
});
