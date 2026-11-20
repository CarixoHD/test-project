import { describe, expect, it } from 'vitest';
import { open } from '../db/index.ts';
import { FakeClock } from '../util/clock.ts';
import { Redactor, createSecrets } from './index.ts';

const LONG = 'sk-ant-api03-abcdefghijklmnop1234';
const SHORT = 'abc12345xyz';

function setup() {
  const db = open(':memory:');
  const clock = new FakeClock(1_700_000_000_000);
  const redactor = new Redactor();
  return { db, clock, redactor, secrets: createSecrets({ db, clock, redactor }) };
}

describe('secrets', () => {
  it('stores, reads, overwrites and deletes a value', () => {
    const { secrets } = setup();
    expect(secrets.get('llm.anthropic.apiKey')).toBeUndefined();
    secrets.set('llm.anthropic.apiKey', LONG);
    expect(secrets.get('llm.anthropic.apiKey')).toBe(LONG);
    secrets.set('llm.anthropic.apiKey', `${LONG}-v2`);
    expect(secrets.get('llm.anthropic.apiKey')).toBe(`${LONG}-v2`);
    secrets.delete('llm.anthropic.apiKey');
    expect(secrets.get('llm.anthropic.apiKey')).toBeUndefined();
    secrets.delete('llm.anthropic.apiKey'); // deleting a missing key is a no-op
  });

  it('lists keys with only the last 4 characters, never the value', () => {
    const { secrets } = setup();
    secrets.set('b', LONG);
    secrets.set('a', SHORT);
    const listed = secrets.list();
    // Short values reveal nothing: their last 4 would be too large a share of the secret.
    expect(listed).toEqual([
      { key: 'a', last4: null },
      { key: 'b', last4: '1234' },
    ]);
    expect(JSON.stringify(listed)).not.toContain(LONG);
    expect(JSON.stringify(listed)).not.toContain(SHORT);
  });

  it('registers every value with the redactor on set', () => {
    const { secrets, redactor } = setup();
    secrets.set('k', LONG);
    expect(redactor.redact(`key=${LONG}`)).toBe('key=***1234');
  });

  it('registers every stored value with the redactor at boot', () => {
    const { db, clock, secrets } = setup();
    secrets.set('k', LONG);
    secrets.set('j', SHORT);
    const fresh = new Redactor();
    createSecrets({ db, clock, redactor: fresh });
    expect(fresh.redact(`${LONG} ${SHORT}`)).toBe('***1234 [REDACTED]');
  });

  it('keeps a cleared value registered (it may still sit in old output)', () => {
    const { secrets, redactor } = setup();
    secrets.set('k', LONG);
    secrets.delete('k');
    expect(redactor.redact(LONG)).toBe('***1234');
  });
});
