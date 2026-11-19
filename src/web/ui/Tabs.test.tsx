import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Tabs, type TabItem } from './Tabs.tsx';

const ITEMS: TabItem[] = [
  { id: 'build', label: 'Build', content: <p>Board</p> },
  { id: 'spec', label: 'Spec', content: <p>PRD editor</p> },
  { id: 'settings', label: 'Settings', content: <p>Budget</p> },
];

function Harness() {
  const [selected, setSelected] = useState('build');
  return <Tabs label="Product views" items={ITEMS} selectedId={selected} onSelect={setSelected} />;
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('Tabs', () => {
  it('renders an ARIA tablist with the selected tab and its panel', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Product views' })).toBeInTheDocument();
    expect(tab('Build')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Spec')).toHaveAttribute('aria-selected', 'false');
    const panel = screen.getByRole('tabpanel', { name: 'Build' });
    expect(panel).toHaveTextContent('Board');
    expect(tab('Build')).toHaveAttribute('aria-controls', panel.id);
  });

  it('keeps only the selected tab in the tab order', () => {
    render(<Harness />);
    expect(tab('Build')).toHaveAttribute('tabindex', '0');
    expect(tab('Spec')).toHaveAttribute('tabindex', '-1');
    expect(tab('Settings')).toHaveAttribute('tabindex', '-1');
  });

  it('moves and selects with ArrowRight/ArrowLeft, wrapping at the ends', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(tab('Build'));

    await user.keyboard('{ArrowRight}');
    expect(tab('Spec')).toHaveFocus();
    expect(tab('Spec')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Spec' })).toHaveTextContent('PRD editor');

    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tab('Build')).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(tab('Settings')).toHaveFocus();
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to the first and last tab with Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(tab('Spec'));
    await user.keyboard('{End}');
    expect(tab('Settings')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab('Build')).toHaveFocus();
    expect(tab('Build')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps unselected panels mounted but hidden', () => {
    render(<Harness />);
    expect(screen.getByText('PRD editor', { selector: 'p' })).not.toBeVisible();
  });
});
