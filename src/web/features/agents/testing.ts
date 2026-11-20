// Test fixture (not imported by production code): a global EventSource stand-in that records
// every stream the UI opens, so tests can push messages and named events into each one.

type Listener = (ev: { data: string }) => void;

export class FakeEventSource {
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.all = [];
  }

  /** The newest open stream whose URL is `url`. */
  static find(url: string): FakeEventSource {
    const found = FakeEventSource.all.findLast((s) => s.url === url && s.readyState !== 2);
    if (found === undefined) throw new Error(`no open stream for ${url}`);
    return found;
  }

  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: Listener | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  /** Delivers a named event (`event: <type>`) to its listeners. */
  emit(type: string, data: string): void {
    for (const l of this.#listeners.get(type) ?? []) l({ data });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  close(): void {
    this.readyState = 2;
  }
}
