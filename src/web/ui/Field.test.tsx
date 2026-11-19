import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field } from './Field.tsx';

describe('Field', () => {
  it('labels its control', () => {
    render(<Field label="Product name">{(props) => <input {...props} />}</Field>);
    const input = screen.getByRole('textbox', { name: 'Product name' });
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(input).not.toHaveAccessibleDescription();
  });

  it('describes the control with its hint and error and marks it invalid', () => {
    render(
      <Field label="Budget (USD)" hint="Leave empty for no limit." error="Enter a number above 0.">
        {(props) => <input {...props} />}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Budget (USD)' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Leave empty for no limit. Enter a number above 0.');
    expect(screen.getByText('Enter a number above 0.')).toBeVisible();
  });
});
