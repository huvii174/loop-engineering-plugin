#!/usr/bin/env node
/**
 * Fixture tests for loop-record. Run: node scripts/test-loop-record.mjs
 * Exits 0 when every case matches, 1 otherwise. No dependencies.
 *
 * Every case drives the real CLI in a throwaway directory, because the property
 * under test is what lands on disk: a recorder that refuses must leave
 * state.json byte-identical, and one that accepts must empty the recall inbox
 * only after the accounting is written.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'loop-record.mjs');

const RECORD = [
  '# Iteration 0001 — close C1',
  '- **Verdict:** pass — the focused test fails without the change',
  '- **Evidence:** 12 passed, 0 failed',
  '- **Recall:** L-315 dismissed (document-status-summary, other subsystem)',
].join('\n');

/** A fresh .loop/ with one state file, one record, and a recall inbox. */
function fixture({ state, record = RECORD, recallLog = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-record-'));
  const loop = join(dir, '.loop');
  mkdirSync(join(loop, 'iterations'), { recursive: true });
  writeFileSync(join(loop, 'state.json'), JSON.stringify(state ?? {
    status: 'running', run_id: 't', iteration: 0, max_iterations: 12, history: [],
  }, null, 2));
  if (record !== null) writeFileSync(join(loop, 'iterations', '0001.md'), record);
  writeFileSync(join(loop, '.recall-log'), recallLog);
  return { dir, loop };
}

function run(loop, args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, '--dir', loop, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const OK = ['--verdict', 'pass', '--kind', 'criterion', '--intent', 'close C1', '--criteria-passed', '1', '--criterion', 'C1'];

const CASES = [
  {
    name: 'records a well-formed iteration and empties the recall inbox',
    fixture: { recallLog: '2026-09-14T00:00:00Z\tL-315\t2\tinlined\n' },
    args: OK,
    code: 0,
    check: ({ loop }) => {
      const s = JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8'));
      const h = s.history[0];
      return s.iteration === 1 && h.verdict === 'pass' && h.kind === 'criterion'
        && h.criteria_passed === 1 && h.n === 1 && s.record_contract_since === 1
        && readFileSync(join(loop, '.recall-log'), 'utf8') === '';
    },
  },
  {
    // The defect this whole script exists for: a verifier that rejected one
    // criterion and approved the rest is a fail, and the enum is where that
    // gets decided — not in a sentence the breaker will later read with ===.
    name: 'refuses a prose verdict naming both outcomes',
    args: ['--verdict', 'verifier: APPROVE (1-5) / REJECT (6)', '--kind', 'criterion', '--intent', 'x', '--criteria-passed', '1'],
    code: 1,
    stderr: 'pass|fail|escalate',
  },
  {
    name: 'refuses an unknown kind',
    args: ['--verdict', 'pass', '--kind', 'cleanup', '--intent', 'x', '--criteria-passed', '1'],
    code: 1,
    stderr: 'criterion|review-fix|bookkeeping',
  },
  {
    name: 'refuses a missing criteria-passed — the plateau counter would go blind',
    args: ['--verdict', 'pass', '--kind', 'criterion', '--intent', 'x'],
    code: 1,
    stderr: 'plateau counter is blind',
  },
  {
    name: 'refuses a recall injection the record never accounts for',
    fixture: { recallLog: '2026-09-14T00:00:00Z\tL-315\t2\tinlined\n2026-09-14T00:00:01Z\tD-core-101\t1\tpointer\n' },
    args: OK,
    code: 1,
    stderr: 'D-core-101',
  },
  {
    name: 'a refusal writes nothing — state.json and the inbox are untouched',
    fixture: { recallLog: '2026-09-14T00:00:00Z\tL-999\t1\tpointer\n' },
    args: OK,
    code: 1,
    check: ({ loop }) => {
      const s = JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8'));
      return s.iteration === 0 && s.history.length === 0
        && readFileSync(join(loop, '.recall-log'), 'utf8').includes('L-999');
    },
  },
  {
    name: 'refuses when the iteration record does not exist',
    fixture: { record: null },
    args: OK,
    code: 1,
    stderr: 'no iteration record at',
  },
  {
    name: 'refuses a record missing its Evidence line',
    fixture: { record: '# Iteration 0001\n- **Verdict:** pass\n- **Recall:** none injected\n' },
    args: OK,
    code: 1,
    stderr: '`Evidence:` line',
  },
  {
    name: 'refuses a record missing its Recall line',
    fixture: { record: '# Iteration 0001\n- **Verdict:** pass\n- **Evidence:** 12 passed\n' },
    args: OK,
    code: 1,
    stderr: '`Recall:` line',
  },
  {
    // 27 of 75 archived runs carry this mismatch. Numbering the next entry
    // against a count nobody can trust is how it compounds.
    name: 'refuses when state.iteration disagrees with history length',
    fixture: { state: { status: 'running', iteration: 5, max_iterations: 12, history: [] } },
    args: OK,
    code: 1,
    stderr: 'history holds 0',
  },
  {
    name: 'a review-fix records its kind so the plateau counter can step over it',
    args: ['--verdict', 'pass', '--kind', 'review-fix', '--intent', 'close the anchor finding', '--criteria-passed', '7'],
    code: 0,
    check: ({ loop }) => JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8')).history[0].kind === 'review-fix',
  },
  {
    name: '--dry-run runs every check and writes nothing',
    fixture: { recallLog: '2026-09-14T00:00:00Z\tL-315\t2\tinlined\n' },
    args: [...OK, '--dry-run'],
    code: 0,
    check: ({ loop }) => {
      const s = JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8'));
      return s.iteration === 0 && readFileSync(join(loop, '.recall-log'), 'utf8') !== '';
    },
  },
  {
    // The gate ran on 51 of 58 runs in a real archive and left a trace on four.
    name: '--review-gate records the gate without appending an iteration',
    args: ['--review-gate', '5 dimensions; 4 raised, 1 refuted, 3 fixed'],
    code: 0,
    check: ({ loop }) => {
      const s = JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8'));
      return s.review_gate?.summary.includes('3 fixed') && s.history.length === 0 && s.iteration === 0;
    },
  },
  {
    name: '--review-gate with no summary is refused — "clean" is a result, silence is not',
    args: ['--review-gate'],
    code: 1,
    stderr: 'needs a summary',
  },
  {
    name: 'record_contract_since is stamped once and never moved',
    fixture: { state: { status: 'running', iteration: 3, max_iterations: 12, record_contract_since: 2,
      history: [{ n: 1, verdict: 'pass' }, { n: 2, verdict: 'pass' }, { n: 3, verdict: 'fail' }] },
      record: null },
    args: OK,
    code: 1, // no 0004.md — but the point is the field survives a refusal untouched
    check: ({ loop }) => JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8')).record_contract_since === 2,
  },
];

let failed = 0;
for (const c of CASES) {
  const { dir, loop } = fixture(c.fixture);
  let ok = true;
  let detail = '';
  try {
    const r = run(loop, c.args);
    if (r.code !== c.code) { ok = false; detail += ` (exit ${r.code}, want ${c.code}; stderr: ${r.stderr.trim().slice(0, 160)})`; }
    if (c.stderr && !r.stderr.includes(c.stderr)) { ok = false; detail += ` (stderr missing ${JSON.stringify(c.stderr)}: ${r.stderr.trim().slice(0, 160)})`; }
    if (c.check && !c.check({ loop })) { ok = false; detail += ' (on-disk check failed)'; }
  } catch (e) {
    ok = false; detail = ` (threw: ${e.message})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${detail}`);
}

if (!existsSync(SCRIPT)) { console.log('FAIL  loop-record.mjs is missing'); failed++; }

console.log(failed === 0 ? `\nall ${CASES.length} checks passed` : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
