// Sets (or resets) the owner password from the host: `npm run set-password`.
// Reads the password from the terminal without echo, or from stdin when piped, never from argv
// (argv is visible to other users in `ps`). Uses VIBECODE_DATA_DIR like the server, and works
// while the server runs: it reads the password hash from the DB on every request.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createAccess } from '../src/server/commands/index.ts';
import { ensureDataDir, parseConfig } from '../src/server/config.ts';
import { open } from '../src/server/db/index.ts';
import { createSecrets, redactor } from '../src/server/security/index.ts';
import { createStore } from '../src/server/store/index.ts';
import { systemClock } from '../src/server/util/clock.ts';

export interface SetPasswordOptions {
  env: Record<string, string | undefined>;
  password: string;
  log: (line: string) => void;
}

/** Stores the password's scrypt hash and ends every session. Returns the exit code. */
export async function setPassword({ env, password, log }: SetPasswordOptions): Promise<number> {
  const config = parseConfig(env);
  ensureDataDir(config.dataDir);
  const db = open(config.dbPath);
  try {
    const clock = systemClock;
    const secrets = createSecrets({ db, clock, redactor });
    const store = createStore({ db, clock, redactor });
    const result = await createAccess({ store, secrets, clock }).resetPassword(password);
    if (!result.ok) {
      log(`Password not set: ${result.reason}`);
      return 1;
    }
    log(`Password set for ${config.dataDir}. Existing sessions were logged out.`);
    return 0;
  } finally {
    db.$client.close();
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}

/** Prompts on the terminal without echoing what is typed. */
async function promptHidden(question: string): Promise<string> {
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    process.stdout.write(question);
    const answer = await rl.question('');
    process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

async function readPassword(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return (await readAll(process.stdin)).split(/\r?\n/)[0] ?? '';
  }
  const first = await promptHidden('New password (at least 12 characters): ');
  const again = await promptHidden('Repeat it: ');
  return first === again ? first : null;
}

if (import.meta.main) {
  const password = await readPassword();
  if (password === null) {
    console.error('The passwords do not match; nothing was changed.');
    process.exitCode = 1;
  } else {
    process.exitCode = await setPassword({ env: process.env, password, log: console.log });
  }
}
