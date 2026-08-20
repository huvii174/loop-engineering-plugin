#!/usr/bin/env node
/**
 * Fixture tests for loop-breaker. Run: node scripts/test-loop-breaker.mjs
 * Exits 0 when every case matches, 1 otherwise. No dependencies.
 */

import { analyze, errorSignature, similarity } from './loop-breaker.mjs';

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
];

const UNITS = [
  ['signature collapses timestamps', () => errorSignature('2026-07-29T01:02:03Z boom') === errorSignature('2026-07-29T09:59:00Z boom')],
  ['signature collapses paths to basenames', () => errorSignature('at /a/b/user.ts:1:2 failed') === errorSignature('at ./user.ts:99:1 failed')],
  ['signature distinguishes real differences', () => errorSignature('ZodError missing') !== errorSignature('TypeError missing')],
  ['similarity is 1 for identical text', () => similarity('run the migration script', 'run the migration script') === 1],
  ['similarity ignores short-string containment', () => similarity('fix', 'fix the parser') < 0.85],
];

let failed = 0;
for (const [label, fn] of UNITS) {
  const ok = fn();
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}
for (const c of CASES) {
  const v = analyze(c.state);
  const got = (v.advisories ?? []).map((a) => a.reason).filter((r) => r !== 'bookkeeping');
  const advisoriesOk = !c.advisories
    || (got.length === c.advisories.length && c.advisories.every((r) => got.includes(r)));
  const countersOk = !c.counters
    || Object.entries(c.counters).every(([k, want]) => v.counters[k] === want);
  const ok = v.stop === c.stop && (!c.reason || v.reason === c.reason) && advisoriesOk && countersOk;
  if (!ok) failed++;
  const detail = ok ? '' : ` (got stop=${v.stop} reason=${v.reason} advisories=[${got}] counters=${JSON.stringify(v.counters)})`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${detail}`);
}

console.log(failed === 0 ? `\nall ${UNITS.length + CASES.length} checks passed` : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
