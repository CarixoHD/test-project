import ReactMarkdown from 'react-markdown';

export interface MarkdownProps {
  children: string;
  className?: string;
}

/**
 * Renders untrusted markdown (agent output, PRDs) safely: raw HTML is dropped, not rendered,
 * and react-markdown's default URL transform strips `javascript:` and other unsafe links.
 */
export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={['ui-markdown', className].filter(Boolean).join(' ')}>
      <ReactMarkdown skipHtml>{children}</ReactMarkdown>
    </div>
  );
}
