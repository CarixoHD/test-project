import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.tsx';

describe('Markdown', () => {
  it('renders markdown structure', () => {
    render(<Markdown>{'# Title\n\nSome **bold** text'}</Markdown>);
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('drops raw HTML instead of rendering it', () => {
    const { container } = render(
      <Markdown>{'Hi <img src=x onerror="alert(1)"> <script>alert(2)</script>'}</Markdown>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('neutralises javascript: links', () => {
    render(<Markdown>{'[click](javascript:alert(1))'}</Markdown>);
    const link = screen.getByText('click');
    expect(link.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
  });
});
