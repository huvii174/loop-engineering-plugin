#!/usr/bin/env node
/**
 * Fixture tests for loop-breaker. Run: node scripts/test-loop-breaker.mjs
 * Exits 0 when every case matches, 1 otherwise. No dependencies.
 */

import { analyze, contextBlock, errorSignature, resolveThresholds, similarity } from './loop-breaker.mjs';

const CASES = [
  {
    name: 'healthy — a fail after a pass does not trip anything',
    stop: false,
    state: { iteration: 3, max_iterations: 12, history: [
      { n: 1, approach: 'add zod schema', verdict: 'fail', error_signature: 'ZodError at /src/api/user.ts:12:5' },
      { n: 2, approach: 'coerce numeric ids', verdict: 'pass' },
      { n: 3, approach: 'add rate limit', verdict: 'fail', error_signature: 'TypeError: not a function' },
    ] },
  },
  {
    name: 'stagnation — same error 3x despite differing timestamps/paths/addresses',
    stop: true, reason: 'stagnation',
    state: { iteration: 5, max_iterations: 12, history: [
      { n: 1, approach: 'a', verdict: 'pass' },
      { n: 2, approach: 'patch handler', verdict: 'fail', error_signature: '2026-07-29T01:02:03Z ZodError at /src/api/user.ts:12:5 addr 0x7ffee' },
      { n: 3, approach: 'patch middleware', verdict: 'fail', error_signature: '2026-07-29T02:11:44Z ZodError at /app/src/api/user.ts:88:2 addr 0xdeadbeef' },
      { n: 4, approach: 'patch validator', verdict: 'fail', error_signature: '2026-07-29T03:00:00Z ZodError at ./user.ts:4:9 addr 0x1' },
    ] },
  },
  {
    name: 'frustration — same approach reworded 3x, each failing differently',
    stop: true, reason: 'frustration',
    state: { iteration: 4, max_iterations: 12, history: [
      { n: 1, approach: 'retry the failing migration script', verdict: 'fail', error_signature: 'E1: table missing' },
      { n: 2, approach: 'retry the failing migration script again', verdict: 'fail', error_signature: 'E2: column type mismatch' },
      { n: 3, approach: 'retry  the failing  migration script', verdict: 'fail', error_signature: 'E3: deadlock detected' },
    ] },
  },
  {
    name: 'no-progress — 5 distinct failures from 5 distinct approaches',
    stop: true, reason: 'no-progress',
    // Note: signatures must differ in WORDS, not digits — normalization maps
    // every number to '#', so "failure 1".."failure 5" would collapse into one
    // signature and trip stagnation instead (correctly).
    state: { iteration: 6, max_iterations: 12, history: [
      { n: 1, approach: 'alpha path rewrite of the parser entry', verdict: 'fail', error_signature: 'table missing' },
      { n: 2, approach: 'beta strategy using the cache layer', verdict: 'fail', error_signature: 'column type mismatch' },
      { n: 3, approach: 'gamma rewrite of the query builder', verdict: 'fail', error_signature: 'deadlock detected' },
      { n: 4, approach: 'delta refactor moving the transaction', verdict: 'fail', error_signature: 'permission denied' },
      { n: 5, approach: 'epsilon patch on the retry wrapper', verdict: 'fail', error_signature: 'connection reset' },
    ] },
  },
  {
    name: 'max-iterations — budget reached',
    stop: true, reason: 'max-iterations',
    state: { iteration: 12, max_iterations: 12, history: [{ n: 1, approach: 'x', verdict: 'pass' }] },
  },
  {
    name: 'escalate entries are excluded from the counters',
    stop: false,
    state: { iteration: 4, max_iterations: 12, history: [
      { n: 1, approach: 'run suite', verdict: 'fail', error_signature: 'same boom' },
      { n: 2, approach: 'run suite', verdict: 'escalate', error_signature: 'same boom' },
      { n: 3, approach: 'run suite', verdict: 'escalate', error_signature: 'same boom' },
    ] },
  },
  {
    name: 'breaker_reset_at_iteration clears a prior streak',
    stop: false,
    state: { iteration: 5, max_iterations: 12, breaker_reset_at_iteration: 3, history: [
      { n: 1, approach: 'p', verdict: 'fail', error_signature: 'boom' },
      { n: 2, approach: 'p', verdict: 'fail', error_signature: 'boom' },
      { n: 3, approach: 'p', verdict: 'fail', error_signature: 'boom' },
      { n: 4, approach: 'new idea entirely', verdict: 'fail', error_signature: 'different' },
    ] },
  },
  {
    name: 'plateau — passing verdicts but criteria-met count flat for 4 iterations',
    stop: true, reason: 'plateau',
    state: { iteration: 6, max_iterations: 12, history: [
      { n: 1, approach: 'implement criterion one', verdict: 'pass', criteria_passed: 1 },
      { n: 2, approach: 'refactor helpers for clarity', verdict: 'pass', criteria_passed: 1 },
      { n: 3, approach: 'polish logging around the handler', verdict: 'pass', criteria_passed: 1 },
      { n: 4, approach: 'tidy configuration defaults', verdict: 'pass', criteria_passed: 1 },
      { n: 5, approach: 'adjust naming in module', verdict: 'pass', criteria_passed: 1 },
    ] },
  },
  {
    name: 'healthy growth — passing verdicts with rising criteria_passed do not trip plateau',
    stop: false,
    state: { iteration: 5, max_iterations: 12, history: [
      { n: 1, approach: 'criterion one work', verdict: 'pass', criteria_passed: 1 },
      { n: 2, approach: 'criterion two work', verdict: 'pass', criteria_passed: 2 },
      { n: 3, approach: 'criterion three attempt', verdict: 'fail', error_signature: 'e', criteria_passed: 2 },
      { n: 4, approach: 'criterion three fixed', verdict: 'pass', criteria_passed: 3 },
    ] },
  },
  {
    name: 'entries without criteria_passed never trip plateau (backward compatible)',
    stop: false,
    state: { iteration: 5, max_iterations: 12, history: [1, 2, 3, 4].map((n) => ({
      n, approach: `distinct passing increment number ${'abcd'[n - 1]}`, verdict: 'pass',
    })) },
  },
  {
    name: 'genuinely different approaches do NOT trip frustration',
    stop: false,
    state: { iteration: 4, max_iterations: 12, history: [
      { n: 1, approach: 'add zod schema at the route boundary', verdict: 'fail', error_signature: 'e1' },
      { n: 2, approach: 'coerce numeric ids inside the persistence layer', verdict: 'fail', error_signature: 'e2' },
      { n: 3, approach: 'replace the ORM call with a raw query', verdict: 'fail', error_signature: 'e3' },
    ] },
  },
  {
    name: 'bookkeeping pass does not reset a failure streak (stagnation still trips)',
    stop: true, reason: 'stagnation',
    state: { iteration: 6, max_iterations: 12, history: [
      { n: 1, approach: 'patch the handler', verdict: 'fail', error_signature: 'ZodError missing field', criteria_passed: 0 },
      { n: 2, approach: 'record the iteration and tidy memory', verdict: 'pass', criteria_passed: 0 },
      { n: 3, approach: 'patch the middleware', verdict: 'fail', error_signature: 'ZodError missing field', criteria_passed: 0 },
      { n: 4, approach: 'update the design notes', verdict: 'pass', criteria_passed: 0 },
      { n: 5, approach: 'patch the validator', verdict: 'fail', error_signature: 'ZodError missing field', criteria_passed: 0 },
    ] },
  },
  {
    name: 'a pass that closes a criterion DOES reset the streak',
    stop: false,
    counters: { trailing_fails: 1, stagnation: 1 },
    state: { iteration: 5, max_iterations: 12, history: [
      { n: 1, approach: 'patch the handler', verdict: 'fail', error_signature: 'ZodError missing field', criteria_passed: 0 },
      { n: 2, approach: 'patch the middleware', verdict: 'fail', error_signature: 'ZodError missing field', criteria_passed: 0 },
      { n: 3, approach: 'fix the schema properly', verdict: 'pass', criteria_passed: 1 },
      { n: 4, approach: 'patch the validator', verdict: 'fail', error_signature: 'ZodError missing field', criteria_passed: 1 },
    ] },
  },
  {
    name: 'a FAIL is never transparent, whatever its criteria_passed says',
    stop: true, reason: 'stagnation',
    state: { iteration: 4, max_iterations: 12, history: [
      { n: 1, approach: 'x', verdict: 'fail', error_signature: 'boom', criteria_passed: 0 },
      { n: 2, approach: 'y', verdict: 'fail', error_signature: 'boom', criteria_passed: 0 },
      { n: 3, approach: 'z', verdict: 'fail', error_signature: 'boom', criteria_passed: 0 },
    ] },
  },
  {
    name: 'a pass without criteria_passed still resets the streak (backward compatible)',
    stop: false,
    counters: { trailing_fails: 1, bookkeeping: 0 },
    state: { iteration: 5, max_iterations: 12, history: [
      { n: 1, approach: 'patch the handler', verdict: 'fail', error_signature: 'boom' },
      { n: 2, approach: 'patch the middleware', verdict: 'fail', error_signature: 'boom' },
      { n: 3, approach: 'something that worked', verdict: 'pass' },
      { n: 4, approach: 'patch the validator', verdict: 'fail', error_signature: 'boom' },
    ] },
  },
  {
    name: 'advisory one short of stagnation — warns without stopping',
    stop: false,
    advisories: ['stagnation'],
    state: { iteration: 3, max_iterations: 12, history: [
      { n: 1, approach: 'patch the handler', verdict: 'fail', error_signature: 'boom' },
      { n: 2, approach: 'patch the middleware', verdict: 'fail', error_signature: 'boom' },
    ] },
  },
  {
    name: 'advisory one short of frustration — warns without stopping',
    stop: false,
    advisories: ['frustration'],
    state: { iteration: 3, max_iterations: 12, history: [
      { n: 1, approach: 'retry the failing migration script', verdict: 'fail', error_signature: 'E1: table missing' },
      { n: 2, approach: 'retry the failing migration script again', verdict: 'fail', error_signature: 'E2: column mismatch' },
    ] },
  },
  {
    name: 'a healthy loop raises no advisory',
    stop: false,
    advisories: [],
    state: { iteration: 3, max_iterations: 12, history: [
      { n: 1, approach: 'criterion one work', verdict: 'pass', criteria_passed: 1 },
      { n: 2, approach: 'criterion two work', verdict: 'pass', criteria_passed: 2 },
    ] },
  },

  // ------------------------------------------------- thresholds, not counters
  {
    name: 'legacy `breaker` thresholds are still honoured on their own',
    stop: true, reason: 'stagnation',
    warnings: [],
    state: { iteration: 3, max_iterations: 12, breaker: { stagnation: 2 }, history: [
      { n: 1, approach: 'patch the handler', verdict: 'fail', error_signature: 'ZodError missing field' },
      { n: 2, approach: 'patch the middleware', verdict: 'fail', error_signature: 'ZodError missing field' },
    ] },
  },
  {
    name: '`breaker_thresholds` wins when both spellings are present, with a warning',
    stop: false,
    warnings: ['breaker_thresholds'],
    // legacy would trip at 2; the preferred field says 9, so the loop continues.
    state: { iteration: 3, max_iterations: 12,
      breaker: { stagnation: 2 }, breaker_thresholds: { stagnation: 9 }, history: [
        { n: 1, approach: 'patch the handler', verdict: 'fail', error_signature: 'ZodError missing field' },
        { n: 2, approach: 'patch the middleware', verdict: 'fail', error_signature: 'ZodError missing field' },
      ] },
  },
  {
    name: 'zeroed thresholds ("reset my counters") fall back to defaults instead of stopping',
    stop: false,
    warnings: ['stagnation', 'frustration', 'noProgress', 'plateau', 'thresholds, not counters'],
    // The real-run shape: a brand-new run whose breaker block was zeroed. Every
    // `counter >= threshold` used to read true against an empty history.
    state: { iteration: 0, max_iterations: 14, history: [],
      breaker: { stagnation: 0, frustration: 0, noProgress: 0, plateau: 0, similarity: 0.85 } },
  },
  {
    name: 'negative thresholds fall back to defaults with a warning',
    stop: false,
    warnings: ['stagnation'],
    state: { iteration: 2, max_iterations: 12, breaker_thresholds: { stagnation: -3 }, history: [
      { n: 1, approach: 'patch the handler', verdict: 'fail', error_signature: 'ZodError missing field' },
    ] },
  },
  {
    name: 'a non-numeric threshold falls back to the default with a warning',
    stop: false,
    warnings: ['plateau'],
    state: { iteration: 2, max_iterations: 12, breaker_thresholds: { plateau: null }, history: [
      { n: 1, approach: 'criterion one work', verdict: 'pass', criteria_passed: 1 },
    ] },
  },
  {
    // similarity 0 makes THREE DIFFERENT approaches read as "the same approach
    // retried 3x" — a wrongful stuck whose detail message lies. Refused like
    // the count thresholds, not obeyed.
    name: 'similarity: 0 is refused for the default; different approaches do not trip frustration',
    stop: false,
    warnings: ['similarity'],
    state: { iteration: 3, max_iterations: 12, breaker_thresholds: { similarity: 0 }, history: [
      { n: 1, approach: 'add a zod schema at the route boundary', verdict: 'fail', error_signature: 'e1 alpha' },
      { n: 2, approach: 'rewrite the parser in the service layer', verdict: 'fail', error_signature: 'e2 beta' },
      { n: 3, approach: 'switch the client to form encoding', verdict: 'fail', error_signature: 'e3 gamma' },
    ] },
  },
  {
    name: 'similarity above 1 is refused — it would silently disable the frustration breaker',
    stop: true, reason: 'frustration',
    warnings: ['similarity'],
    state: { iteration: 3, max_iterations: 12, breaker_thresholds: { similarity: 7 }, history: [
      { n: 1, approach: 'retry the flaky migration exactly as before', verdict: 'fail', error_signature: 'e1 alpha' },
      { n: 2, approach: 'retry the flaky migration exactly as before', verdict: 'fail', error_signature: 'e2 beta' },
      { n: 3, approach: 'retry the flaky migration exactly as before', verdict: 'fail', error_signature: 'e3 gamma' },
    ] },
  },
  {
    name: 'a non-object thresholds value falls back wholesale with a warning',
    stop: false,
    warnings: ['must be an object'],
    state: { iteration: 1, max_iterations: 12, breaker_thresholds: 'aggressive', history: [
      { n: 1, approach: 'first attempt', verdict: 'fail', error_signature: 'e1' },
    ] },
  },
  {
    name: 'a misspelled threshold key warns instead of silently reverting to the default',
    stop: false,
    warnings: ['stagnaton'],
    state: { iteration: 1, max_iterations: 12, breaker_thresholds: { stagnaton: 9 }, history: [
      { n: 1, approach: 'first attempt', verdict: 'fail', error_signature: 'e1' },
    ] },
  },
  {
    name: 'empty history with default thresholds trips nothing',
    stop: false,
    advisories: [],
    counters: { trailing_fails: 0, stagnation: 0, frustration: 0 },
    state: { iteration: 0, max_iterations: 12, history: [] },
  },
  {
    name: 'a threshold of 1 on an empty history raises no advisory and does not throw',
    stop: false,
    advisories: [],
    // `counters.stagnation === t.stagnation - 1` is 0 === 0 here: the advisory
    // used to fire and dereference fails[0] on an empty streak.
    state: { iteration: 0, max_iterations: 12, history: [],
      breaker_thresholds: { stagnation: 1, frustration: 1, noProgress: 1, plateau: 1 } },
  },
  {
    name: 'a threshold of 1 stops on the first failure, with the signature in the detail',
    stop: true, reason: 'stagnation',
    state: { iteration: 2, max_iterations: 12, breaker_thresholds: { stagnation: 1 }, history: [
      { n: 1, approach: 'patch the handler', verdict: 'fail', error_signature: 'ZodError missing field' },
    ] },
  },
];

const UNITS = [
  ['signature collapses timestamps', () => errorSignature('2026-07-29T01:02:03Z boom') === errorSignature('2026-07-29T09:59:00Z boom')],
  ['signature collapses paths to basenames', () => errorSignature('at /a/b/user.ts:1:2 failed') === errorSignature('at ./user.ts:99:1 failed')],
  ['signature distinguishes real differences', () => errorSignature('ZodError missing') !== errorSignature('TypeError missing')],
  ['similarity is 1 for identical text', () => similarity('run the migration script', 'run the migration script') === 1],
  ['similarity ignores short-string containment', () => similarity('fix', 'fix the parser') < 0.85],
  ['thresholds: an absent breaker block yields the defaults',
    () => resolveThresholds({}).thresholds.stagnation === 3 && resolveThresholds({}).warnings.length === 0],
  ['thresholds: a zeroed field is refused but its siblings survive', () => {
    const { thresholds } = resolveThresholds({ breaker_thresholds: { stagnation: 0, frustration: 7 } });
    return thresholds.stagnation === 3 && thresholds.frustration === 7;
  }],
  ['thresholds: similarity is a ratio, not a count — 0.5 passes through untouched',
    () => resolveThresholds({ breaker_thresholds: { similarity: 0.5 } }).thresholds.similarity === 0.5],
  ['thresholds: a non-object breaker block is ignored, not crashed on',
    () => resolveThresholds({ breaker: 'reset' }).thresholds.stagnation === 3],
  ['thresholds: overrides beat both spellings', () => {
    const state = { breaker: { stagnation: 2 }, breaker_thresholds: { stagnation: 9 } };
    return resolveThresholds(state, { stagnation: 5 }).thresholds.stagnation === 5;
  }],
  ['context block survives an empty history', () => contextBlock({ iteration: 0, history: [] }).includes('first attempt')],
  ['context block carries the state.json warning into the next prompt',
    () => contextBlock({ iteration: 0, history: [], breaker: { stagnation: 0 } }).includes('WARNING (state.json)')],
];

let failed = 0;
for (const [label, fn] of UNITS) {
  const ok = fn();
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}
for (const c of CASES) {
  let v;
  try {
    v = analyze(c.state);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${c.name} (threw ${e.message})`);
    continue;
  }
  const got = (v.advisories ?? []).map((a) => a.reason).filter((r) => r !== 'bookkeeping');
  const advisoriesOk = !c.advisories
    || (got.length === c.advisories.length && c.advisories.every((r) => got.includes(r)));
  const countersOk = !c.counters
    || Object.entries(c.counters).every(([k, want]) => v.counters[k] === want);
  // `warnings: []` asserts silence; a list asserts each fragment is mentioned.
  const warnings = v.warnings ?? [];
  const warningsOk = !c.warnings
    || (c.warnings.length ? c.warnings.every((frag) => warnings.some((w) => w.includes(frag))) : warnings.length === 0);
  const ok = v.stop === c.stop && (!c.reason || v.reason === c.reason) && advisoriesOk && countersOk && warningsOk;
  if (!ok) failed++;
  const detail = ok ? '' : ` (got stop=${v.stop} reason=${v.reason} advisories=[${got}] counters=${JSON.stringify(v.counters)} warnings=${JSON.stringify(warnings)})`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${detail}`);
}

console.log(failed === 0 ? `\nall ${UNITS.length + CASES.length} checks passed` : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
