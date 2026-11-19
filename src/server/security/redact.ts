/** Secrets shorter than this are not registered: too likely to collide with ordinary text. */
export const MIN_SECRET_LENGTH = 8;
/** Secrets at least this long are shown as `***` + last 4 chars; shorter ones as `[REDACTED]`. */
export const LAST4_MIN_LENGTH = 16;
export const REDACTED = '[REDACTED]';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function mask(secret: string): string {
  return secret.length >= LAST4_MIN_LENGTH ? `***${secret.slice(-4)}` : REDACTED;
}

/**
 * Replaces every registered secret value in text. All text bound for logs, events,
 * error messages and process output passes through `redact` (CODING_STANDARDS §7).
 * Matching is literal and single-pass, longest secret first, so a secret that
 * contains another secret is masked as a whole.
 */
export class Redactor {
  #secrets = new Set<string>();
  #pattern: RegExp | undefined;

  register(value: string): void {
    if (value.length < MIN_SECRET_LENGTH || this.#secrets.has(value)) return;
    this.#secrets.add(value);
    this.#pattern = undefined;
  }

  redact(text: string): string {
    if (this.#secrets.size === 0 || text.length === 0) return text;
    this.#pattern ??= this.#buildPattern();
    return text.replace(this.#pattern, mask);
  }

  #buildPattern(): RegExp {
    const alternatives = [...this.#secrets]
      .sort((a, b) => b.length - a.length)
      .map((s) => s.replace(REGEX_SPECIAL, '\\$&'));
    return new RegExp(alternatives.join('|'), 'g');
  }
}
