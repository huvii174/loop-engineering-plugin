/**
 * Shared helpers for loop-engineering hooks.
 *
 * Hook design contract (README "Hooks" section):
 * - deterministic checks only — stat/mtime/glob/string match; no model, no network
 * - fail-open: any unexpected error means exit 0, never a blocked user
 * - fast path: a project without .loop/ costs one stat() and exits 0
 * - bypass: LOOP_HOOKS_OFF=1 disables every gate
 */

import { readFileSync, statSync, readdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
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

/**
 * Newest mtime (ms) of any file under dir, recursive. 0 when dir missing/empty.
 *
 * Dot-entries are skipped: session tooling drops state (`.omc/`, caches) inside
 * whatever directory it is run from, and a dropping under `.loop/memory/` would
 * otherwise read as "this session compounded its knowledge" and silence the
 * memory-gate. Only files a human or the model wrote count as a write.
 */
export function newestMtime(dir) {
  let newest = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) newest = Math.max(newest, newestMtime(p));
      else newest = Math.max(newest, statSync(p).mtimeMs);
    } catch { /* fail-open per file */ }
  }
  return newest;
}

/** Last maxBytes of a file as utf8 (whole file when smaller). null on any error. */
export function readTail(p, maxBytes) {
  try {
    const size = statSync(p).size;
    if (size <= maxBytes) return readFileSync(p, 'utf8');
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      readSync(fd, buf, 0, maxBytes, size - maxBytes);
      return buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }
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

/** One backlog id, or null: run.json is model-written, so "2" and 2 are the same item. */
function itemId(v) {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * The open epic run, or null. `.loop/run.json` is written by the runner at
 * go/no-go and is the only record that `/loop-engineering:run` is in flight;
 * schema in the loop-engine skill. `order` and `human_gates` come back as
 * integer ids whatever the file spelled.
 */
export function loadRun(cwd) {
  const p = join(cwd, '.loop', 'run.json');
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    if (!data || typeof data.epic !== 'string' || !SLUG.test(data.epic.trim())) return null;
    const ids = (v) => (Array.isArray(v) ? v.map(itemId).filter((n) => n !== null) : []);
    return { path: p, data: { ...data, epic: data.epic.trim(), order: ids(data.order), human_gates: ids(data.human_gates) } };
  } catch { return null; }
}

/**
 * Rows of the FIRST backlog table in the text: `{ id, title, status }`, status
 * being the leading word of the Status cell, lowercased, decoration stripped
 * ("**done**", "✅ done", "done." all read `done`). The cell is model-written
 * prose ("designed (pre-compiled, awaiting sub-goal 1)"), and the loop's close
 * step writes its leading word — `done`, `stuck`, `pending` — so the leading
 * word is the contract and the rest is commentary. Fenced blocks are skipped,
 * the table ends at its first non-table line, and a duplicate id keeps its
 * first row — a later table cannot rewrite the backlog.
 */
export function parseBacklog(text) {
  if (!text) return null;
  const rows = [];
  const seen = new Set();
  let cols = null;
  let fence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (!line.startsWith('|')) { if (cols) break; continue; }
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined)
      .split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
    if (!cols) {
      const lower = cells.map((c) => c.toLowerCase());
      const id = lower.indexOf('#');
      const status = lower.indexOf('status');
      if (id === -1 || status === -1) continue;
      const title = lower.findIndex((c) => /sub-?goal|item|title/.test(c));
      cols = { id, status, title: title === -1 ? id + 1 : title };
      continue;
    }
    if (/^:?-+:?$/.test(cells[0] ?? '')) continue; // the |---| rule
    const id = itemId(cells[cols.id]);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const statusCell = (cells[cols.status] ?? '').replace(/[`*_]/g, '').replace(/^\[[^\]]*\]\s*/, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const status = (statusCell.split(/[\s(,;:/.!]+/)[0] || 'pending').toLowerCase();
    rows.push({ id, title: cells[cols.title] ?? '', status });
  }
  return cols ? rows : null;
}

const RUN_TERMINAL_NOT_DONE = new Set(['stuck', 'stopped-max-iterations', 'stopped-user']);

/**
 * Where the open epic run stands, from disk alone — shared by run-gate (which
 * blocks on it) and loop-reminder (which announces it), so the two cannot
 * disagree. Returns null when the run owes nothing: no run, backlog gone
 * (instance archived), a `stuck` row, the epic's loop at stuck/stopped-*, a
 * human gate next, the item budget spent, or every item done. Else
 * `{ run, order, done, next, loop }`; `loop` is the epic's own state.json or
 * null — a state.json naming another epic is a leftover and is ignored.
 */
export function runStanding(cwd) {
  const run = loadRun(cwd);
  if (!run) return null;
  const rows = parseBacklog(readIfExists(join(cwd, '.loop', 'epics', run.data.epic, 'backlog.md')));
  if (!rows || !rows.length) return null;
  if (rows.some((r) => r.status === 'stuck')) return null;

  const state = loadState(cwd);
  const loop = state && (!state.data.epic || state.data.epic === run.data.epic) ? state.data : null;
  if (loop && RUN_TERMINAL_NOT_DONE.has(loop.status)) return null;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = run.data.order.filter((id) => byId.has(id));
  const order = ordered.length ? ordered : rows.map((r) => r.id);
  const done = order.filter((id) => byId.get(id).status === 'done');
  const pending = order.filter((id) => byId.get(id).status !== 'done');
  if (!pending.length) return null;

  const budget = itemId(run.data.budget);
  const doneAtStart = Number.isInteger(run.data.done_at_start) ? run.data.done_at_start : 0;
  if (budget !== null && done.length - doneAtStart >= budget) return null;

  const next = byId.get(pending[0]);
  if (run.data.human_gates.includes(next.id)) return null;

  return { run, order, done, next, loop };
}
