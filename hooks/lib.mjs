/**
 * Shared helpers for loop-engineering hooks.
 *
 * Hook design contract (README "Hooks" section):
 * - deterministic checks only — stat/mtime/glob/string match; no model, no network
 * - fail-open: any unexpected error means exit 0, never a blocked user
 * - fast path: a project without .loop/ costs one stat() and exits 0
 * - bypass: LOOP_HOOKS_OFF=1 disables every gate
 */

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export async function readStdinJson() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try { return JSON.parse(raw); } catch { return {}; }
}

export function hooksOff() {
  return process.env.LOOP_HOOKS_OFF === '1';
}

export function loadState(cwd) {
  const p = join(cwd, '.loop', 'state.json');
  if (!existsSync(p)) return null;
  try { return { path: p, mtime: statSync(p).mtimeMs, data: JSON.parse(readFileSync(p, 'utf8')) }; }
  catch { return null; }
}

export function readIfExists(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** Newest mtime (ms) of any file under dir, recursive. 0 when dir missing/empty. */
export function newestMtime(dir) {
  let newest = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) newest = Math.max(newest, newestMtime(p));
      else newest = Math.max(newest, statSync(p).mtimeMs);
    } catch { /* fail-open per file */ }
  }
  return newest;
}

/** Minimal glob → RegExp: supports **, *, ? on forward-slash paths. */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\/'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

/** Extract a `## <heading>` section's body from markdown (up to the next ## or EOF). */
export function mdSection(text, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}
