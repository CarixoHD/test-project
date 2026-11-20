// A unified diff as plain text. Added and removed lines are styled, and each also carries a
// text marker for screen readers, so the meaning never depends on colour alone. The `+`/`-`
// prefixes stay visible.

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

const MARKER: Partial<Record<LineKind, string>> = { add: 'Added: ', del: 'Removed: ' };

export function diffLineKind(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  return 'context';
}

export function DiffView({ text }: { text: string }) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return (
    <pre className="diff-view">
      <code>
        {lines.map((line, i) => {
          const kind = diffLineKind(line);
          const marker = MARKER[kind];
          return (
            <span key={i} className={`diff-line diff-line--${kind}`}>
              {marker !== undefined && <span className="visually-hidden">{marker}</span>}
              <span>{line}</span>
              {'\n'}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
