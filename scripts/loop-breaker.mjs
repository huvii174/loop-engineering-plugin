#!/usr/bin/env node
/**
 * loop-breaker — deterministic circuit breaker for the loop-engineering plugin.
 *
 * Reads .loop/state.json and decides whether the loop may continue. No model
 * call, no dependencies: the decision is code, so it cannot be reasoned around.
 *
 *   node loop-breaker.mjs [--state <path>] [--context] [--json]
 *
 * Exit codes:
 *   0  continue — no breaker tripped
 *   2  stop     — a breaker tripped; the loop must halt and report
 *   1  error    — state file missing/unreadable (a config problem, not a verdict)
 *
 * --context  print the "already tried (do NOT repeat)" block for the next
 *            iteration's prompt instead of checking. Exits 0 on success.
 * --json     machine-readable output for check mode.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULTS = { stagnation: 3, frustration: 3, noProgress: 5, plateau: 4, similarity: 0.85 };

// --------------------------------------------------------------- normalization

/**
 * Collapse volatile detail so "the same error" is recognized across iterations
 * despite timestamps, addresses and paths that differ every run.
 */
export function errorSignature(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>');
  s = s.replace(/0x[0-9a-fA-F]+/g, '<addr>');
  // path/to/file.ext:12:5 → file.ext (basename kept, line/col dropped)
  s = s.replace(/(?:[\w.~-]*\/)+([\w.-]+)/g, '$1');
  s = s.replace(/:\d+:\d+/g, '').replace(/:\d+\b/g, '');
  s = s.replace(/\b\d+\b/g, '#');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Character trigrams — cheap similarity, no embedding call. */
function trigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length < 3) return new Set(t ? [t] : []);
  const out = new Set();
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Trigram count below which containment is untrustworthy ("fix" ⊂ "fix the parser"). */
const MIN_CONTAINMENT_SIZE = 12;

/**
 * Jaccard over trigrams, raised by containment when one description is wholly
 * inside the other — "retry the migration" vs "retry the migration again" is the
 * same action reworded, and plain Jaccard scores that just under any useful
 * threshold. Containment is ignored for short strings, where it fires on
 * anything sharing a prefix.
 */
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return A.size === B.size ? 1 : 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const smaller = Math.min(A.size, B.size);
  if (smaller < MIN_CONTAINMENT_SIZE) return jaccard;
  return Math.max(jaccard, inter / smaller);
}

// ----------------------------------------------------------------------- state

function loadState(path) {
  const abs = resolve(path);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`cannot read state file: ${abs} — run /loop-engineering:design first`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    throw new Error(`state file is not valid JSON: ${abs} (${e.message})`);
  }
  if (!Array.isArray(state.history)) state.history = [];
  return state;
}

/**
 * Entries the breaker counts: after any reset point, and never `escalate` —
 * an unverifiable attempt is not a failed approach.
 */
function countable(state) {
  const from = Number(state.breaker_reset_at_iteration ?? 0);
  return state.history
    .filter((h) => Number(h.n ?? 0) > from)
    .filter((h) => String(h.verdict ?? '').toLowerCase() !== 'escalate');
}

/** Consecutive trailing failures, newest first. Stops at the first pass. */
function trailingFails(entries) {
  const out = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (String(entries[i].verdict ?? '').toLowerCase() === 'fail') out.push(entries[i]);
    else break;
  }
  return out;
}

// ---------------------------------------------------------------------- checks

export function analyze(state, overrides = {}) {
  const t = { ...DEFAULTS, ...(state.breaker ?? {}), ...overrides };
  const entries = countable(state);
  const fails = trailingFails(entries);
  const iteration = Number(state.iteration ?? 0);
  const maxIterations = Number(state.max_iterations ?? 12);

  const counters = {
    iteration,
    max_iterations: maxIterations,
    trailing_fails: fails.length,
    stagnation: 0,
    frustration: 0,
    plateau: 0,
  };

  // plateau — iterations keep "passing" while the criteria-met count stays flat.
  // A different death than failure streaks: the loop looks busy (verified
  // increments!) but the goal is not moving. Needs `criteria_passed` recorded
  // per history entry; entries without it are skipped (backward compatible).
  {
    const scored = entries.filter((h) => typeof h.criteria_passed === 'number');
    if (scored.length) {
      const last = scored[scored.length - 1].criteria_passed;
      let flat = 0;
      for (let i = scored.length - 1; i >= 0; i--) {
        if (scored[i].criteria_passed === last) flat++;
        else break;
      }
      counters.plateau = flat;
    }
  }

  // stagnation — same normalized failure signature repeated consecutively
  if (fails.length) {
    const sig = errorSignature(fails[0].error_signature);
    if (sig) {
      let n = 0;
      for (const f of fails) {
        if (errorSignature(f.error_signature) === sig) n++;
        else break;
      }
      counters.stagnation = n;
    }
  }

  // frustration — same approach retried, even when the error differs
  if (fails.length) {
    const approach = fails[0].approach;
    if (approach) {
      let n = 0;
      for (const f of fails) {
        if (f.approach && similarity(f.approach, approach) >= t.similarity) n++;
        else break;
      }
      counters.frustration = n;
    }
  }

  // Most actionable first.
  if (maxIterations > 0 && iteration >= maxIterations) {
    return {
      stop: true, status: 'stopped-max-iterations', reason: 'max-iterations', counters,
      detail: `iteration ${iteration} reached the budget of ${maxIterations}`,
    };
  }
  if (counters.stagnation >= t.stagnation) {
    return {
      stop: true, status: 'stuck', reason: 'stagnation', counters,
      detail: `the same failure repeated ${counters.stagnation}x consecutively: "${fails[0].error_signature}"`,
    };
  }
  if (counters.frustration >= t.frustration) {
    return {
      stop: true, status: 'stuck', reason: 'frustration', counters,
      detail: `the same approach was retried ${counters.frustration}x consecutively: "${fails[0].approach}"`,
    };
  }
  if (counters.trailing_fails >= t.noProgress) {
    return {
      stop: true, status: 'stuck', reason: 'no-progress', counters,
      detail: `${counters.trailing_fails} consecutive failures with no pass in between (each failing differently)`,
    };
  }
  if (counters.plateau >= t.plateau) {
    const scored = entries.filter((h) => typeof h.criteria_passed === 'number');
    const window = scored.slice(-t.plateau);
    const hasPass = window.some((h) => String(h.verdict ?? '').toLowerCase() === 'pass');
    if (hasPass) {
      return {
        stop: true, status: 'stuck', reason: 'plateau', counters,
        detail: `criteria-met count stuck at ${window[window.length - 1].criteria_passed} for ${counters.plateau} iterations despite passing verdicts — busy but not progressing`,
      };
    }
  }
  return {
    stop: false, status: state.status ?? 'running', reason: null, counters,
    detail: 'no breaker tripped',
  };
}

// --------------------------------------------------------------------- context

/** The "already tried (do NOT repeat)" block for the next iteration's prompt. */
export function contextBlock(state) {
  const entries = countable(state);
  const attempts = entries.filter((h) => h.approach || h.error_signature || h.intent);
  const lines = ['## Already tried — do NOT repeat unchanged'];

  if (!attempts.length) {
    lines.push('- (nothing yet — this is the first attempt)');
  } else {
    for (const h of attempts) {
      const verdict = String(h.verdict ?? '?').toLowerCase();
      const mark = verdict === 'pass' ? '[pass]' : '[fail]';
      const why = h.error_signature ? ` -> ${h.error_signature}` : '';
      lines.push(`- ${mark} iter ${h.n}: ${h.approach ?? h.intent ?? '(unrecorded)'}${why}`);
    }
    const fails = trailingFails(entries);
    if (fails.length) {
      const groups = new Map();
      for (const f of fails) {
        const sig = errorSignature(f.error_signature) || '(no signature)';
        groups.set(sig, (groups.get(sig) ?? 0) + 1);
      }
      lines.push('', '### Current failure streak');
      for (const [sig, n] of groups) lines.push(`- ${n}x ${sig}`);
    }
  }

  const a = analyze(state);
  lines.push('', '### Breaker status');
  lines.push(
    `- iteration ${a.counters.iteration}/${a.counters.max_iterations} | ` +
    `stagnation ${a.counters.stagnation} | frustration ${a.counters.frustration} | ` +
    `consecutive fails ${a.counters.trailing_fails} | criteria-flat ${a.counters.plateau}`
  );
  return lines.join('\n');
}

// ------------------------------------------------------------------------ main

function main(argv) {
  const args = argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const statePath = get('--state', '.loop/state.json');

  let state;
  try {
    state = loadState(statePath);
  } catch (e) {
    process.stderr.write(`loop-breaker: ${e.message}\n`);
    return 1;
  }

  if (args.includes('--context')) {
    process.stdout.write(contextBlock(state) + '\n');
    return 0;
  }

  const verdict = analyze(state);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  } else if (verdict.stop) {
    process.stdout.write(`STOP (${verdict.reason}) -> set status: "${verdict.status}"\n${verdict.detail}\n`);
  } else {
    process.stdout.write(
      `CONTINUE — iteration ${verdict.counters.iteration}/${verdict.counters.max_iterations}, ` +
      `stagnation ${verdict.counters.stagnation}, frustration ${verdict.counters.frustration}, ` +
      `consecutive fails ${verdict.counters.trailing_fails}\n`
    );
  }
  return verdict.stop ? 2 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));
