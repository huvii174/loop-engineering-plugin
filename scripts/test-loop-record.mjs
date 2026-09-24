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
  '- **Goal criterion targeted:** C1',
  '- **Injected:** the already-tried block; L-315 (dismissed)',
  '- **Recall:** L-315 dismissed (document-status-summary, other subsystem)',
  '- **Actions:** src/api/user.ts — coerce numeric ids at the route boundary',
  '- **Verification:** pnpm test --filter api -t "rejects bad payloads"',
  '- **Evidence:** 12 passed, 0 failed',
  '- **Verdict:** pass — the focused test fails without the change',
].join('\n');

/** The same record with one field dropped, for the "refuses a missing X" cases. */
const without = (field) => RECORD.split('\n')
  .filter((l) => !l.startsWith(`- **${field}:**`)).join('\n');

/** A fresh .loop/ with one state file, one record, and a recall inbox. */
function fixture({ state, record = RECORD, recallLog = '', goal = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-record-'));
  const loop = join(dir, '.loop');
  mkdirSync(join(loop, 'iterations'), { recursive: true });
  writeFileSync(join(loop, 'state.json'), JSON.stringify(state ?? {
    status: 'running', run_id: 't', iteration: 0, max_iterations: 12, history: [],
  }, null, 2));
  if (record !== null) writeFileSync(join(loop, 'iterations', '0001.md'), record);
  writeFileSync(join(loop, '.recall-log'), recallLog);
  if (goal !== null) writeFileSync(join(loop, 'goal.md'), goal);
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

const GOAL = [
  '# Goal',
  '## Success criteria (verifiable)',
  '- [ ] C1 no writer stores 0 for an unmeasured cost',
  '      Done when: no writer stores 0 for an unmeasured cost — `node --test` exits 0',
  "      Sites: `grep -rnE 'cost [|][|] 0' src` → 1 hits at design:",
  '        src/usage/sdk.mjs:6:  cost: usage.cost || 0',
  '      Must not: no test deleted or weakened',
  '- [ ] C2 the README names the flag',
  '      Done when: `grep -c -- --flag README.md` prints 1',
  '- [x] C3 no screen shows $0.00 for an unmeasured cost',
  '      Done when: every cost tile renders an unmeasured cost as a dash',
  '      Sites: none (tiles are generated at runtime; no grep enumerates them)',
  '## Global boundaries',
  '- Do not touch: `fixtures/**`',
].join('\n');

const SWEEP = '\n- **Sweep:** Sites `grep -rnE ...` — src/usage/sdk.mjs:6 fixed (now `?? null`)';
/** RECORD retargeted at another criterion id. */
const at = (id, extra = '') => RECORD.replace('- **Goal criterion targeted:** C1', `- **Goal criterion targeted:** ${id}`) + extra;
const untouched = ({ loop }) => {
  const s = JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8'));
  return s.iteration === 0 && s.history.length === 0 && readFileSync(join(loop, '.recall-log'), 'utf8').includes('L-315');
};
const LOG = '2026-09-23T00:00:00Z\tL-315\t2\tinlined\n';

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
    fixture: { record: without('Evidence') },
    args: OK,
    code: 1,
    stderr: '`Evidence:` line',
  },
  {
    name: 'refuses a record missing its Recall line',
    fixture: { record: without('Recall') },
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
    fixture: { record: RECORD.replace('- **Goal criterion targeted:** C1', '- **Goal criterion targeted:** none — a round-2 review-gate finding')
      + '\n- **Sweep:** Sites `grep -rn anchor src` — src/a.ts:3 fixed (anchor pinned)' },
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
    name: 'refuses a record with no Verification — Evidence without provenance is a screenshot',
    fixture: { record: without('Verification') },
    args: OK,
    code: 1,
    stderr: '`Verification:` line',
  },
  {
    name: 'refuses a record with no Actions line',
    fixture: { record: without('Actions') },
    args: OK,
    code: 1,
    stderr: '`Actions:` line',
  },
  {
    name: 'refuses a record with no Injected line',
    fixture: { record: without('Injected') },
    args: OK,
    code: 1,
    stderr: '`Injected:` line',
  },
  {
    // A silent mismatch here corrupts criteria_passed, and nothing downstream
    // can see it: state counts one criterion while the record grades another.
    name: 'refuses when --criterion and the record name different criteria',
    args: ['--verdict', 'pass', '--kind', 'criterion', '--intent', 'x', '--criteria-passed', '1', '--criterion', 'C7'],
    code: 1,
    stderr: 'is not named on the record',
  },
  {
    name: 'a criterion quoted as a sentence is matched by the reader, not a substring test',
    fixture: { record: RECORD.replace('- **Goal criterion targeted:** C1', '- **Goal criterion targeted:** the split honours a selection-shaped Enter') },
    args: ['--verdict', 'pass', '--kind', 'criterion', '--intent', 'x', '--criteria-passed', '1',
           '--criterion', 'POST /api/x rejects bad payloads and returns 422 with a field list'],
    code: 0,
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
  // item 5: the epic gate has its own record and never touches the per-goal gate's
  {
    name: '--epic-gate writes state.epic_gate, appends no iteration, and leaves review_gate byte-identical',
    fixture: { state: { status: 'done', iteration: 4, max_iterations: 12, history: [], review_gate: { recorded: '2026-09-25T00:00:00.000Z', summary: 'item gate: clean' } } },
    args: ['--epic-gate', 'cross-item: 2 raised, 1 confirmed → integration row 10'],
    code: 0,
    check: ({ loop }) => {
      const s = JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8'));
      return s.epic_gate?.summary === 'cross-item: 2 raised, 1 confirmed → integration row 10' && typeof s.epic_gate.recorded === 'string'
        && JSON.stringify(s.review_gate) === JSON.stringify({ recorded: '2026-09-25T00:00:00.000Z', summary: 'item gate: clean' })
        && s.history.length === 0 && s.iteration === 4;
    },
  },
  {
    name: '--epic-gate with no summary is refused and writes nothing',
    fixture: { state: { status: 'done', iteration: 4, max_iterations: 12, history: [] } },
    args: ['--epic-gate'],
    code: 1,
    stderr: '--epic-gate needs a summary',
    check: ({ loop }) => !('epic_gate' in JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8'))),
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
  {
    // D-eci-003: every review fix owes a sweep, whatever its criterion.
    name: 'refuses a review-fix record with no Sweep: line, and writes nothing',
    fixture: { goal: GOAL, recallLog: LOG, record: at('none — a review-gate finding') },
    args: ['--verdict', 'pass', '--kind', 'review-fix', '--intent', 'fix the finding', '--criteria-passed', '1'],
    code: 1,
    stderr: 'no `Sweep:` line',
    check: untouched,
  },
  {
    name: 'refuses a record for a criterion carrying Sites: when it has no Sweep: line',
    fixture: { goal: GOAL, recallLog: LOG },
    args: OK,
    code: 1,
    stderr: 'carries `Sites:`',
    check: untouched,
  },
  {
    name: 'records a criterion carrying Sites: once the record has a Sweep: line',
    fixture: { goal: GOAL, record: RECORD + SWEEP },
    args: OK,
    code: 0,
    check: ({ loop }) => JSON.parse(readFileSync(join(loop, 'state.json'), 'utf8')).history.length === 1,
  },
  {
    // A required sweep written as "none" is silence in a longer form (D-eci-019).
    name: 'refuses Sweep: none where a sweep is required',
    fixture: { goal: GOAL, recallLog: LOG, record: RECORD + '\n- **Sweep:** none (nothing to sweep)' },
    args: OK,
    code: 1,
    stderr: 'says `Sweep: none',
    check: untouched,
  },
  {
    // D-eci-004: Sites: none (<reason>) is the visible opt-out.
    name: 'a criterion with Sites: none (<reason>) owes no Sweep: line',
    fixture: { goal: GOAL, record: at('C3') },
    args: ['--verdict', 'pass', '--kind', 'criterion', '--intent', 'x', '--criteria-passed', '1', '--criterion', 'C3'],
    code: 0,
  },
  {
    name: 'a criterion without Sites: owes no Sweep: line',
    fixture: { goal: GOAL, record: at('C2') },
    args: ['--verdict', 'pass', '--kind', 'criterion', '--intent', 'x', '--criteria-passed', '1', '--criterion', 'C2'],
    code: 0,
  },
  {
    // A misspelled --criterion must not be how a sweep gets skipped.
    name: 'refuses when goal.md carries Sites: and --criterion matches no block',
    fixture: { goal: GOAL, recallLog: LOG, record: at('C9') },
    args: ['--verdict', 'pass', '--kind', 'criterion', '--intent', 'x', '--criteria-passed', '1', '--criterion', 'C9'],
    code: 1,
    stderr: 'matches no block',
    check: untouched,
  },
  {
    name: 'a sentence-shaped --criterion is located by its Done when: text',
    fixture: { goal: GOAL, recallLog: LOG, record: at('the unmeasured-cost writers') },
    args: ['--verdict', 'pass', '--kind', 'criterion', '--intent', 'x', '--criteria-passed', '1',
           '--criterion', 'no writer stores 0 for an unmeasured cost — `node --test` exits 0'],
    code: 1,
    stderr: 'C1 no writer stores 0',
    check: untouched,
  },
  {
    // Review gate, item 2: a decoy `Sites: none (…)` above the real grep used to
    // waive the sweep, because only the first `Sites:` line was read.
    name: 'refuses a criterion block carrying two Sites: lines — a decoy none cannot waive the sweep',
    fixture: { goal: GOAL.replace("      Sites: `grep -rnE", "      Sites: none (decoy)\n      Sites: `grep -rnE"), recallLog: LOG },
    args: OK,
    code: 1,
    stderr: 'carries 2 `Sites:` lines',
    check: untouched,
  },
  {
    // Review gate round 2, item 2: `--kind bookkeeping` skipped the lookup.
    name: 'a bookkeeping entry naming a Sites: criterion still owes a Sweep: line',
    fixture: { goal: GOAL, recallLog: LOG },
    args: ['--verdict', 'pass', '--kind', 'bookkeeping', '--intent', 'x', '--criteria-passed', '1', '--criterion', 'C1'],
    code: 1,
    stderr: 'no `Sweep:` line',
    check: untouched,
  },
  {
    // Review gate round 2, item 2: any placeholder other than "none" passed.
    name: 'refuses a Sweep: value that classifies no hit (n/a)',
    fixture: { goal: GOAL, recallLog: LOG, record: RECORD + '\n- **Sweep:** n/a' },
    args: OK,
    code: 1,
    stderr: 'fixed, held or not-this-class',
    check: untouched,
  },
  {
    // Iteration 4's REJECT: a vocabulary word with no hit passed.
    name: 'refuses a Sweep: value that names a class but no hit (bare "fixed")',
    fixture: { goal: GOAL, recallLog: LOG, record: RECORD + '\n- **Sweep:** fixed' },
    args: OK,
    code: 1,
    stderr: 'fixed, held or not-this-class',
    check: untouched,
  },
  {
    name: 'refuses a placeholder that happens to contain a class word ("TBD — nothing fixed yet")',
    fixture: { goal: GOAL, recallLog: LOG, record: RECORD + '\n- **Sweep:** TBD — nothing fixed yet' },
    args: OK,
    code: 1,
    stderr: 'fixed, held or not-this-class',
    check: untouched,
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
