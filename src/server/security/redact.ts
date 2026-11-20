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
  #maxLength = 0;

  /**
   * Registers a secret. A multi-line value (LF or CRLF) also registers each of its lines,
   * because line-split streams never see the whole value; the whole value stays registered
   * so whole-buffer redaction masks it as one piece.
   */
  register(value: string): void {
    if (value.includes('\n')) {
      for (const line of value.split('\n')) {
        this.#add(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
    }
    this.#add(value);
  }

  #add(value: string): void {
    if (value.length < MIN_SECRET_LENGTH || this.#secrets.has(value)) return;
    this.#secrets.add(value);
    this.#maxLength = Math.max(this.#maxLength, value.length);
    this.#pattern = undefined;
  }

  redact(text: string): string {
    if (this.#secrets.size === 0 || text.length === 0) return text;
    this.#pattern ??= this.#buildPattern();
    return text.replace(this.#pattern, mask);
  }

  /**
   * For text that will be continued (a stream, or output cut at a buffer limit): the largest
   * index `c` such that `redact(text.slice(0, c))` is final whatever text follows. The rest is
   * shorter than the longest secret and may begin one, so callers hold it back or drop it.
   * A secret is never split at `c`.
   */
  safeBoundary(text: string): number {
    if (this.#secrets.size === 0) return text.length;
    let cut = Math.max(0, text.length - (this.#maxLength - 1));
    this.#pattern ??= this.#buildPattern();
    // A match starting before the cut has every secret fully in view, so the choice is final.
    // If it crosses the cut, release it whole (it is masked in the head).
    for (const match of text.matchAll(this.#pattern)) {
      if (match.index >= cut) break;
      cut = Math.max(cut, match.index + match[0].length);
    }
    return cut;
  }

  #buildPattern(): RegExp {
    const alternatives = [...this.#secrets]
      .sort((a, b) => b.length - a.length)
      .map((s) => s.replace(REGEX_SPECIAL, '\\$&'));
    return new RegExp(alternatives.join('|'), 'g');
  }
}
