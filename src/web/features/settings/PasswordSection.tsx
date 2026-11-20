import { useId } from 'react';

/** Owner password settings. Stub: filled in by its own issue. */
export function PasswordSection() {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId}>Password</h2>
      <p>Setting or changing the owner password will be possible here.</p>
    </section>
  );
}
