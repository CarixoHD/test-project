// Test helper: PID 1 in the agent sandbox is not an init that reaps orphans, so killed
// grandchildren linger as zombies and `process.kill(pid, 0)` keeps succeeding for them.
import { readdirSync, readFileSync } from 'node:fs';

/** state and pgrp from /proc/<pid>/stat; null when the process is already gone. */
function statOf(pid: number): { state: string; pgrp: number } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may contain spaces and parens, so parse after the last ')'.
    const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0] ?? '', pgrp: Number(rest[2]) };
  } catch {
    return null;
  }
}

function signalSaysGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Gone when the signal probe fails, or when every matching /proc entry is a zombie. */
export function isGone(pid: number): boolean {
  if (pid >= 0) {
    const stat = statOf(pid);
    return stat ? stat.state === 'Z' : signalSaysGone(pid);
  }
  try {
    let seen = false;
    for (const entry of readdirSync('/proc')) {
      const stat = /^\d+$/.test(entry) ? statOf(Number(entry)) : null;
      if (stat?.pgrp !== -pid) continue;
      seen = true;
      if (stat.state !== 'Z') return false;
    }
    if (seen) return true;
  } catch {
    // No /proc (non-Linux): fall through to the signal probe.
  }
  return signalSaysGone(pid);
}
