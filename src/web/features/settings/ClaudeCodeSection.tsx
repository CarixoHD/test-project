import { useId } from 'react';

/** Claude Code (subscription) backend settings. Stub: filled in by its own issue. */
export function ClaudeCodeSection() {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId}>Claude Code</h2>
      <p>Signing in with your Claude subscription will be set up here.</p>
    </section>
  );
}
