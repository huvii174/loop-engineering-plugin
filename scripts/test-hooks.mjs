#!/usr/bin/env node
/**
 * Fixture tests for the hooks. Run: node scripts/test-hooks.mjs
 * Spawns each hook as a real subprocess with stdin JSON and a temp project dir,
 * asserting on exit codes and output. Exits 0 when all pass. No dependencies.
 */

import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync, readdirSync, chmodSync, symlinkSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStanding } from '../hooks/lib.mjs';
import { recordCritique } from './loop-critique.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

function runHook(script, stdinObj, env = {}) {
  const r = spawnSync('node', [join(HOOKS, script)], {
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
    env: { ...process.env, LOOP_HOOKS_OFF: '', LOOP_MEMORY_GIT: '', LOOP_GIT_BASH: '', ...env },
    timeout: 10000,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function project({ state, goal, learnings, memoryFresh } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-hook-test-'));
  if (state) {
    mkdirSync(join(dir, '.loop'), { recursive: true });
    writeFileSync(join(dir, '.loop', 'state.json'), JSON.stringify(state));
  }
  if (goal) writeFileSync(join(dir, '.loop', 'goal.md'), goal);
  if (learnings !== undefined || memoryFresh !== undefined) {
    mkdirSync(join(dir, '.loop', 'memory'), { recursive: true });
    writeFileSync(join(dir, '.loop', 'memory', 'learnings.md'), learnings ?? '# Learnings\n');
    if (memoryFresh === false) {
      // make memory look older than state.json
      const old = (Date.now() - 3600_000) / 1000;
      utimesSync(join(dir, '.loop', 'memory', 'learnings.md'), old, old);
    }
  }
  return dir;
}

/**
 * Build the index/body memory tree.
 * `index` and `bodies` are written verbatim; `bodies` maps a filename under
 * learnings/ to its content.
 */
function tree(dir, { index, bodies = {}, decisionsIndex, scratchRun } = {}) {
  const mem = join(dir, '.loop', 'memory');
  mkdirSync(join(mem, 'learnings'), { recursive: true });
  if (index !== undefined) writeFileSync(join(mem, 'learnings', '_index.md'), index);
  for (const [name, content] of Object.entries(bodies)) {
    writeFileSync(join(mem, 'learnings', name), content);
  }
  if (decisionsIndex !== undefined) {
    mkdirSync(join(mem, 'decisions'), { recursive: true });
    writeFileSync(join(mem, 'decisions', '_index.md'), decisionsIndex);
  }
  if (scratchRun !== undefined) {
    mkdirSync(join(mem, 'scratch'), { recursive: true });
    writeFileSync(join(mem, 'scratch', 'run.md'), scratchRun);
  }
  return dir;
}

/** Write a fake session transcript (JSONL-ish; the gate scans strings only). */
function transcript(dir, { edits = 0, errors = 0 } = {}) {
  const lines = [];
  for (let i = 0; i < edits; i++) lines.push('{"type":"tool_use","name":"Edit","input":{"file_path":"a.ts"}}');
  for (let i = 0; i < errors; i++) lines.push('{"type":"tool_result","content":"TypeError: x is not a function — build failed"}');
  lines.push('{"type":"text","text":"plain assistant text"}');
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

/** Backdate every file under .loop/memory/ so it predates the transcript. */
function ageMemory(dir) {
  const old = (Date.now() - 3600_000) / 1000;
  const memDir = join(dir, '.loop', 'memory');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else utimesSync(p, old, old);
    }
  };
  walk(memDir);
}

const GOAL_WITH_BOUNDARY = `# Goal
## Success criteria (verifiable)
- [ ] x
## Global boundaries
- Do not touch: \`src/legacy/**\`
- Do not touch: docs/api.md
`;

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
}

const cleanup = [];
function proj(opts) { const d = project(opts); cleanup.push(d); return d; }

// ---------------------------------------------------------------- boundary-gate
{
  const bare = proj({});
  let r = runHook('boundary-gate.mjs', { cwd: bare, tool_input: { file_path: 'src/legacy/a.ts' } });
  check('boundary: no .loop → allow', r.code === 0, `code=${r.code}`);

  const running = proj({ state: { status: 'running' }, goal: GOAL_WITH_BOUNDARY });
  r = runHook('boundary-gate.mjs', { cwd: running, tool_input: { file_path: 'src/legacy/deep/a.ts' } });
  check('boundary: running + glob match → block', r.code === 2 && r.err.includes('Global boundary'), `code=${r.code}`);

  r = runHook('boundary-gate.mjs', { cwd: running, tool_input: { file_path: join(running, 'docs/api.md') } });
  check('boundary: absolute path normalized + exact match → block', r.code === 2, `code=${r.code}`);

  r = runHook('boundary-gate.mjs', { cwd: running, tool_input: { file_path: 'src/modern/a.ts' } });
  check('boundary: non-matching path → allow', r.code === 0, `code=${r.code}`);

  const designed = proj({ state: { status: 'designed' }, goal: GOAL_WITH_BOUNDARY });
  r = runHook('boundary-gate.mjs', { cwd: designed, tool_input: { file_path: 'src/legacy/a.ts' } });
  check('boundary: loop not running → allow', r.code === 0, `code=${r.code}`);

  r = runHook('boundary-gate.mjs', { cwd: running, tool_input: { file_path: 'src/legacy/a.ts' } }, { LOOP_HOOKS_OFF: '1' });
  check('boundary: LOOP_HOOKS_OFF=1 → allow', r.code === 0, `code=${r.code}`);
}

// ------------------------------------------------------------------ memory-gate
{
  const bare = proj({});
  let r = runHook('memory-gate.mjs', { cwd: bare });
  check('memory: no .loop → allow stop', r.code === 0, `code=${r.code}`);

  const doneStale = proj({ state: { status: 'done' }, memoryFresh: false });
  r = runHook('memory-gate.mjs', { cwd: doneStale });
  check('memory: done + stale memory → block stop', r.code === 2 && r.err.includes('compounded'), `code=${r.code}`);

  r = runHook('memory-gate.mjs', { cwd: doneStale, stop_hook_active: true });
  check('memory: stop_hook_active → allow (blocks only once)', r.code === 0, `code=${r.code}`);

  // learnings written AFTER state.json in project() order → memory is fresh
  const doneFresh = proj({ state: { status: 'done' }, learnings: '# Learnings\n' });
  r = runHook('memory-gate.mjs', { cwd: doneFresh });
  check('memory: done + fresh memory → allow stop', r.code === 0, `code=${r.code}`);

  const runningStale = proj({ state: { status: 'running' }, memoryFresh: false });
  r = runHook('memory-gate.mjs', { cwd: runningStale });
  check('memory: running (paused mid-loop) → allow stop', r.code === 0, `code=${r.code}`);

  const dirtyScratch = proj({
    state: { status: 'stuck' },
    learnings: '# Learnings\n## Scratch (this run)\n- raw unreviewed note about zod (run-x, iter 2)\n',
  });
  r = runHook('memory-gate.mjs', { cwd: dirtyScratch });
  check('memory: terminal + undistilled scratch → block stop', r.code === 2 && r.err.includes('scratch'), `code=${r.code}`);
}

// ---------------------------------------------------------------- loop-reminder
{
  const running = proj({ state: { status: 'running', iteration: 5, max_iterations: 12, tier: 'medium',
    history: [{ n: 5, intent: 'wire the adapter', verdict: 'fail' }] } });
  let r = runHook('loop-reminder.mjs', { cwd: running });
  check('reminder: running → prints context line', r.code === 0 && r.out.includes('iteration 5/12') && r.out.includes('wire the adapter'), `out=${r.out.slice(0, 60)}`);

  const done = proj({ state: { status: 'done' } });
  r = runHook('loop-reminder.mjs', { cwd: done });
  check('reminder: done → silent', r.code === 0 && r.out === '', `out=${JSON.stringify(r.out)}`);

  const bare = proj({});
  r = runHook('loop-reminder.mjs', { cwd: bare });
  check('reminder: no .loop → silent', r.code === 0 && r.out === '', `code=${r.code}`);
}

// ---------------------------------------------------------- memory-gate: ad-hoc
{
  const LEARN = '# Learnings\n## Gotchas\n- [gotcha][auth] cookies need sameSite lax — Safari drops them (run-1, iter 2)\n';

  const adhoc = proj({ learnings: LEARN });
  ageMemory(adhoc);
  let r = runHook('memory-gate.mjs', { cwd: adhoc, transcript_path: transcript(adhoc, { edits: 2, errors: 3 }) });
  check('adhoc: edits + errors + nothing captured → nudge once', r.code === 2 && r.err.includes('adhoc.md'), `code=${r.code}`);

  r = runHook('memory-gate.mjs', { cwd: adhoc, transcript_path: transcript(adhoc, { edits: 2, errors: 3 }), stop_hook_active: true });
  check('adhoc: stop_hook_active → allow (nudges only once)', r.code === 0, `code=${r.code}`);

  const readOnly = proj({ learnings: LEARN });
  ageMemory(readOnly);
  r = runHook('memory-gate.mjs', { cwd: readOnly, transcript_path: transcript(readOnly, { edits: 0, errors: 5 }) });
  check('adhoc: no file edits → allow (read-only session)', r.code === 0, `code=${r.code}`);

  const noDebug = proj({ learnings: LEARN });
  ageMemory(noDebug);
  r = runHook('memory-gate.mjs', { cwd: noDebug, transcript_path: transcript(noDebug, { edits: 3, errors: 1 }) });
  check('adhoc: edits but no debug journey → allow', r.code === 0, `code=${r.code}`);

  const captured = proj({ learnings: LEARN }); // memory written "now" → fresh vs transcript birthtime
  r = runHook('memory-gate.mjs', { cwd: captured, transcript_path: transcript(captured, { edits: 2, errors: 3 }) });
  check('adhoc: memory touched this session → allow', r.code === 0, `code=${r.code}`);

  const runningLoop = proj({ state: { status: 'running' }, learnings: LEARN });
  ageMemory(runningLoop);
  r = runHook('memory-gate.mjs', { cwd: runningLoop, transcript_path: transcript(runningLoop, { edits: 2, errors: 3 }) });
  check('adhoc: loop running → allow (loop territory)', r.code === 0, `code=${r.code}`);

  const noMemory = proj({});
  r = runHook('memory-gate.mjs', { cwd: noMemory, transcript_path: transcript(noMemory, { edits: 2, errors: 3 }) });
  check('adhoc: memory not adopted (.loop/memory missing) → allow', r.code === 0, `code=${r.code}`);
}

// ---------------------------------------------------------------- memory-recall
{
  const LEARN = '# Learnings\n## Gotchas\n- [gotcha][auth] session cookies need sameSite lax in dev — Safari drops them otherwise (run-1, iter 4)\n' +
    '## Patterns\n- [pattern][api] validate at the route boundary — keeps handlers unit-testable (run-1, iter 2)\n';

  const mem = proj({ learnings: LEARN });
  mkdirSync(join(mem, '.loop', 'memory', 'solutions'), { recursive: true });
  writeFileSync(join(mem, '.loop', 'memory', 'solutions', 'safari-cookie-drop.md'),
    '---\ntype: bug\narea: auth\n---\n\n# Safari drops session cookies in dev\n\n## Problem\n…\n');

  let r = runHook('memory-recall.mjs', { cwd: mem, prompt: 'fix the Safari cookie bug on the auth login page' });
  check('recall: keyword match → injects one-liner + solution pointer',
    r.code === 0 && r.out.includes('sameSite') && r.out.includes('safari-cookie-drop.md'), `out=${r.out.slice(0, 80)}`);
  check('recall: injection labeled supplementary', r.out.includes('outrank'), `out=${r.out.slice(0, 80)}`);

  r = runHook('memory-recall.mjs', { cwd: mem, prompt: 'quantum blockchain topology' });
  check('recall: no keyword overlap → silent', r.code === 0 && r.out === '', `out=${JSON.stringify(r.out.slice(0, 60))}`);

  r = runHook('memory-recall.mjs', { cwd: mem, prompt: '/loop-engineering:design fix the Safari cookie bug' });
  check('recall: slash-command prompt → silent (commands own recall)', r.code === 0 && r.out === '', `out=${JSON.stringify(r.out.slice(0, 60))}`);

  r = runHook('memory-recall.mjs', { cwd: mem, prompt: 'fix the Safari cookie bug' }, { LOOP_HOOKS_OFF: '1' });
  check('recall: LOOP_HOOKS_OFF=1 → silent', r.code === 0 && r.out === '', `code=${r.code}`);

  const bare = proj({});
  r = runHook('memory-recall.mjs', { cwd: bare, prompt: 'fix the Safari cookie bug' });
  check('recall: no .loop/memory → silent', r.code === 0 && r.out === '', `code=${r.code}`);

  // budget: 8 matching lines but at most 5 injected
  const many = '# Learnings\n## Gotchas\n' +
    Array.from({ length: 8 }, (_, i) => `- [gotcha][cache] redis eviction case ${i} — watch maxmemory (run-1, iter ${i})`).join('\n') + '\n';
  const big = proj({ learnings: many });
  r = runHook('memory-recall.mjs', { cwd: big, prompt: 'debug the redis eviction maxmemory problem' });
  const injected = r.out.split('\n').filter((l) => l.trim().startsWith('- [')).length;
  check('recall: budget cap — at most 5 entries injected', r.code === 0 && injected === 5, `injected=${injected}`);
}

// ------------------------------------------- memory-recall: index/body layout
{
  const INDEX = `# Learnings index

## Never store
- secrets, tokens, credentials

## gotcha
- L-042 [gotcha][frontend] outside-click handler misses every target; jsdom passes, real browser does not
- L-017 [gotcha][testing] DB fixture leg ERRORs at setup with "rejected SSL upgrade"

## pattern
- L-003 [pattern][api] validate at the route boundary — keeps handlers unit-testable
`;
  const GOTCHAS = `### L-042 [gotcha][frontend] outside-click must listen on pointerdown

A hand-rolled outside-click handler MUST listen on pointerdown, never click.
Radix sets pointer-events none on body, so the browser retargets click to <html>.

### L-017 [gotcha][testing] DB fixture leg needs three env vars

DB_HOST, DB_PORT and DB_SSL_REQUIRE=false, or all 43 route tests ERROR at setup.
`;

  const t = tree(proj({}), { index: INDEX, bodies: { 'gotchas.md': GOTCHAS } });
  cleanup.push(t);

  // two keywords hit L-042's trigger -> strong enough to spend a body on
  let r = runHook('memory-recall.mjs', { cwd: t, prompt: 'the outside-click handler breaks in the real browser but jsdom is green' });
  check('recall/tree: strong match inlines the body',
    r.code === 0 && r.out.includes('L-042') && r.out.includes('pointer-events none on body'), `out=${r.out.slice(0, 160)}`);
  check('recall/tree: injection asks for a Recall: verdict', r.out.includes('Recall:'), `out=${r.out.slice(0, 120)}`);

  // one weak keyword -> trigger + a runnable grep, no body spent
  r = runHook('memory-recall.mjs', { cwd: t, prompt: 'rework the route boundary' });
  check('recall/tree: weak match points with a runnable grep',
    r.code === 0 && r.out.includes("grep -rA 20 '^### L-003'") && !r.out.includes('pointer-events none'), `out=${r.out.slice(0, 160)}`);

  // the log is what the Recall: line is checked against
  const log = readFileSync(join(t, '.loop', '.recall-log'), 'utf8');
  check('recall/tree: injected IDs are logged', /\tL-0\d\d\t/.test(log), `log=${log.slice(0, 80)}`);
  check('recall/tree: log lives outside memory/ (cannot fake a memory write)',
    !existsSync(join(t, '.loop', 'memory', '.recall-log')), 'found log inside memory/');

  // an index present means the flat file is not also scanned
  const both = tree(proj({ learnings: '# Learnings\n- [gotcha][x] legacy flat entry about pointerdown handlers\n' }),
    { index: INDEX, bodies: { 'gotchas.md': GOTCHAS } });
  cleanup.push(both);
  r = runHook('memory-recall.mjs', { cwd: both, prompt: 'outside-click handler jsdom browser' });
  check('recall/tree: index wins over the legacy flat file', !r.out.includes('legacy flat entry'), `out=${r.out.slice(0, 120)}`);

  // half-migrated store: learnings has an index, decisions is still flat
  const half = tree(proj({}), { index: INDEX, bodies: { 'gotchas.md': GOTCHAS } });
  writeFileSync(join(half, '.loop', 'memory', 'decisions.md'),
    '# Decisions\n- **kept the zod parser** — rationale; alternatives rejected: yup (run-1)\n');
  cleanup.push(half);
  r = runHook('memory-recall.mjs', { cwd: half, prompt: 'why did we keep the zod parser' });
  check('recall: a root without an index still falls back to its flat file',
    r.code === 0 && r.out.includes('zod parser'), `out=${r.out.slice(0, 140)}`);
}

// -------------------------------------------- memory-recall: index parsing
{
  // The comment guard's load-bearing case: every index (and the scratch
  // template) carries an EXAMPLE ENTRY inside its HTML comment. Without the
  // guard that decoy parses as a real entry and gets injected on the topic it
  // happens to mention. (An earlier fixture tested "absorption into the bullet
  // above", which the open/close discipline already prevents on its own — a
  // mutation run proved that assertion vacuous, twice.)
  const INDEX = `# Learnings index

## Never store
- secrets, tokens, credentials
<!-- One line per entry, <=200 chars. Format example:
  - L-999 [gotcha][example] decoy example trigger about zod parsing
-->

## gotcha
- L-042 [gotcha][x] a real trigger about zod parsing
`;
  const t = tree(proj({}), { index: INDEX });
  cleanup.push(t);

  let r = runHook('memory-recall.mjs', { cwd: t, prompt: 'help with zod parsing here' });
  check('recall: a decoy entry inside an index comment is not injected',
    r.code === 0 && r.out.includes('L-042') && !r.out.includes('L-999'), `out=${r.out.slice(0, 160)}`);

  // hand-wrapped entries must still join — that is what the continuation rule is for
  const WRAPPED = `# Learnings index
## gotcha
- L-050 [gotcha][tiptap] suggestion exit clears plugin state
  but never document content, so Escape leaves the trigger range behind
`;
  const w = tree(proj({}), { index: WRAPPED });
  cleanup.push(w);
  r = runHook('memory-recall.mjs', { cwd: w, prompt: 'escape leaves the trigger range behind in the document' });
  check('recall: a hand-wrapped entry is still matched on its continuation line',
    r.code === 0 && r.out.includes('L-050'), `out=${r.out.slice(0, 160)}`);
}

// ------------------------------------------------ memory-recall: keyword rules
{
  // Every fixture below isolates the 3-char rule: each prompt's ONLY qualifying
  // keywords are 3 characters long, so the whole block goes red if the minimum
  // returns to 4. A prompt carrying an incidental long word would pass either
  // way and prove nothing.
  const INDEX = `# Learnings index
## env
- L-001 [env][gateway] the api gateway returns 500 when upstream refuses the upgrade
## gotcha
- L-002 [gotcha][ui] rapid double-click on the toolbar duplicates the row
- L-003 [gotcha][ui] nút lưu bị mờ sau khi đổi tab
`;
  const t = tree(proj({}), { index: INDEX });
  cleanup.push(t);

  let r = runHook('memory-recall.mjs', { cwd: t, prompt: 'api' });
  check('recall: 3-char acronym reaches the store', r.code === 0 && r.out.includes('L-001'), `out=${r.out.slice(0, 120)}`);
  check('recall: 3-char keyword does not match inside a longer word (api ⊄ rapid)',
    !r.out.includes('L-002'), `out=${r.out.slice(0, 120)}`);

  r = runHook('memory-recall.mjs', { cwd: t, prompt: 'nút lưu bị mờ' });
  check('recall: an all-Vietnamese prompt reaches the store',
    r.code === 0 && r.out.includes('L-003'), `out=${r.out.slice(0, 120)}`);
}

// --------------------------------------------------- memory-gate: index budget
{
  const bloated = '# Learnings index\n## gotcha\n' +
    Array.from({ length: 400 }, (_, i) =>
      `- L-${String(i).padStart(3, '0')} [gotcha][x] ${'a'.repeat(120)}`).join('\n') + '\n';
  const over = tree(proj({ state: { status: 'done' } }), { index: bloated });
  cleanup.push(over);
  let r = runHook('memory-gate.mjs', { cwd: over });
  check('gate: index over the reading budget → block stop',
    r.code === 2 && r.err.includes('reading budget'), `code=${r.code} err=${r.err.slice(0, 120)}`);

  const longLine = '# Learnings index\n## gotcha\n- L-001 [gotcha][x] ' + 'b'.repeat(300) + '\n';
  const wide = tree(proj({ state: { status: 'done' } }), { index: longLine });
  cleanup.push(wide);
  r = runHook('memory-gate.mjs', { cwd: wide });
  check('gate: over-long trigger line → block stop',
    r.code === 2 && r.err.includes('exceed 200 chars'), `code=${r.code} err=${r.err.slice(0, 120)}`);

  const ok = tree(proj({ state: { status: 'done' } }), { index: '# Learnings index\n## gotcha\n- L-001 [gotcha][x] short trigger\n' });
  cleanup.push(ok);
  r = runHook('memory-gate.mjs', { cwd: ok });
  check('gate: index within budget → allow stop', r.code === 0, `code=${r.code} err=${r.err.slice(0, 120)}`);
}

// -------------------------------------------- memory-gate: recall accountability
{
  const mk = (record) => {
    const d = tree(proj({ state: { status: 'done' } }), { index: '# Learnings index\n## gotcha\n- L-001 [gotcha][x] short\n' });
    mkdirSync(join(d, '.loop', 'iterations'), { recursive: true });
    writeFileSync(join(d, '.loop', 'iterations', '0001.md'), record);
    writeFileSync(join(d, '.loop', '.recall-log'), '2026-09-01T00:00:00Z\tL-001\t2\tinlined\n');
    cleanup.push(d);
    return d;
  };

  let r = runHook('memory-gate.mjs', { cwd: mk('# Iteration 0001\n- **Actions:** did a thing\n') });
  check('gate: recall injected but never judged → block stop',
    r.code === 2 && r.err.includes('Recall:'), `code=${r.code} err=${r.err.slice(0, 140)}`);

  r = runHook('memory-gate.mjs', { cwd: mk('# Iteration 0001\n- **Recall:** L-001 dismissed (no DB work here)\n') });
  check('gate: Recall: line present → allow stop', r.code === 0, `code=${r.code} err=${r.err.slice(0, 140)}`);

  r = runHook('memory-gate.mjs', { cwd: mk('# Iteration 0001\nRecalling the plan from yesterday, we did a thing.\n') });
  check('gate: prose starting "Recalling" is not a Recall: line → still blocks',
    r.code === 2 && r.err.includes('Recall'), `code=${r.code} err=${r.err.slice(0, 140)}`);
}

// -------------------------------------- memory-gate: scratch template comment
{
  // The migrated scratch/run.md carries an example entry inside an HTML
  // comment; counting it as live scratch would block every stop forever.
  const templated = tree(proj({ state: { status: 'done' } }), {
    index: '# Learnings index\n## gotcha\n- L-001 [gotcha][x] short\n',
    scratchRun: '<!--\nRaw notes. Format:\n  - [<type>][<area>] <fact> — <why> (YYYY-MM-DD)\n-->\n',
  });
  cleanup.push(templated);
  let r = runHook('memory-gate.mjs', { cwd: templated });
  check('gate: scratch template comment alone is not live scratch → allow stop',
    r.code === 0, `code=${r.code} err=${r.err.slice(0, 140)}`);

  const templatedLive = tree(proj({ state: { status: 'done' } }), {
    index: '# Learnings index\n## gotcha\n- L-001 [gotcha][x] short\n',
    scratchRun: '<!--\n  - [<type>][<area>] <fact> — <why> (YYYY-MM-DD)\n-->\n- [gotcha][zod] a real live note (run-x, iter 1)\n',
  });
  cleanup.push(templatedLive);
  r = runHook('memory-gate.mjs', { cwd: templatedLive });
  check('gate: live entry after the template comment still blocks',
    r.code === 2 && r.err.includes('scratch'), `code=${r.code} err=${r.err.slice(0, 140)}`);
}

// ------------------------------- memory-recall: scaffolded-over-legacy backstop
{
  // An entry-less index (headings + Never store only) beside a populated flat
  // file is the scaffold-over-legacy mistake — the flat store must stay live.
  const d = tree(proj({ learnings: '# Learnings\n## Gotchas\n- [gotcha][zod] legacy fact about zod parsing — why (run-1)\n' }), {
    index: '# Learnings index\n\n## Never store\n- secrets, tokens, credentials\n\n## gotcha\n\n## pattern\n',
  });
  cleanup.push(d);
  const r = runHook('memory-recall.mjs', { cwd: d, prompt: 'debug the zod parsing failure' });
  check('recall: entry-less index beside a populated flat file → flat file stays live',
    r.code === 0 && r.out.includes('legacy fact'), `out=${r.out.slice(0, 140)}`);
}

// ------------------------------------------- memory-gate: scratch in tree layout
{
  const dirty = tree(proj({ state: { status: 'stuck' } }), {
    index: '# Learnings index\n## gotcha\n- L-001 [gotcha][x] short\n',
    scratchRun: '- [gotcha][zod] raw unreviewed note (run-x, iter 2)\n',
  });
  cleanup.push(dirty);
  const r = runHook('memory-gate.mjs', { cwd: dirty });
  check('gate: undistilled scratch/run.md → block stop',
    r.code === 2 && r.err.includes('scratch'), `code=${r.code} err=${r.err.slice(0, 120)}`);
}

// ------------------------------------ memory-gate: a tool dropping is not a write
{
  const LEARN = '# Learnings\n## Gotchas\n- [gotcha][auth] cookies need sameSite lax — Safari drops them (run-1, iter 2)\n';
  const d = proj({ learnings: LEARN });
  cleanup.push(d);
  ageMemory(d);
  // session tooling drops state inside memory/ — it must not read as "captured"
  mkdirSync(join(d, '.loop', 'memory', '.omc', 'state'), { recursive: true });
  writeFileSync(join(d, '.loop', 'memory', '.omc', 'state', 'session.jsonl'), '{}\n');
  const r = runHook('memory-gate.mjs', { cwd: d, transcript_path: transcript(d, { edits: 2, errors: 3 }) });
  check('gate: .omc dropping under memory/ does not silence the ad-hoc nudge',
    r.code === 2 && r.err.includes('adhoc.md'), `code=${r.code} err=${r.err.slice(0, 120)}`);
}

// ------------------------------------------------------- loop-reminder: digest
{
  const mem = proj({ learnings: '# Learnings\n## Gotchas\n- [gotcha][auth] x — y (run-1)\n- [pattern][api] a — b (run-1)\n' });
  mkdirSync(join(mem, '.loop', 'memory', 'solutions'), { recursive: true });
  writeFileSync(join(mem, '.loop', 'memory', 'solutions', 'safari-cookie-drop.md'), '# t\n');
  let r = runHook('loop-reminder.mjs', { cwd: mem });
  check('reminder: memory, no open loop → digest printed',
    r.code === 0 && r.out.includes('2 learnings') && r.out.includes('safari-cookie-drop') && r.out.includes('adhoc.md'), `out=${r.out.slice(0, 80)}`);

  const both = proj({ state: { status: 'running', iteration: 2, max_iterations: 12, history: [] }, learnings: '# Learnings\n' });
  r = runHook('loop-reminder.mjs', { cwd: both });
  check('reminder: open loop + memory → both lines', r.code === 0 && r.out.includes('Open loop') && r.out.includes('Project memory'), `out=${r.out.slice(0, 80)}`);
}

// ------------------------------------------------------------------- fail-open
{
  const corrupt = proj({});
  mkdirSync(join(corrupt, '.loop'), { recursive: true });
  writeFileSync(join(corrupt, '.loop', 'state.json'), '{not json');
  for (const s of ['boundary-gate.mjs', 'memory-gate.mjs', 'loop-reminder.mjs', 'memory-recall.mjs']) {
    const r = runHook(s, { cwd: corrupt, tool_input: { file_path: 'a.ts' }, prompt: 'anything goes here' });
    check(`fail-open: corrupt state.json → ${s} allows`, r.code === 0, `code=${r.code}`);
  }
  const corruptMem = proj({});
  mkdirSync(join(corruptMem, '.loop', 'memory', 'solutions'), { recursive: true });
  writeFileSync(join(corruptMem, '.loop', 'memory', 'learnings.md'), Buffer.from([0xff, 0xfe, 0x00]));
  const r = runHook('memory-recall.mjs', { cwd: corruptMem, prompt: 'fix the Safari cookie bug' });
  check('fail-open: binary learnings.md → memory-recall exits 0', r.code === 0, `code=${r.code}`);
}


// --------------------------- the store is recoverable only if it is TRACKED
{
  const t = tree(proj({}), { index: '# Learnings index\n- L-001 [gotcha][x] a symptom\n' });
  cleanup.push(t);
  const git = (...a) => spawnSync('git', a, { cwd: t, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');

  // Un-ignored and never added is just as unrecoverable as ignored, and an
  // ignore check calls it healthy — the easy property standing in for the one
  // that matters, which is the defect the warning itself is about.
  let r = runHook('loop-reminder.mjs', { cwd: t });
  check('reminder: an un-ignored store nobody added still warns',
    r.out.includes('is tracked'), r.out.slice(0, 160));

  // The opt-out: a project that keeps the store out of git on purpose.
  r = runHook('loop-reminder.mjs', { cwd: t }, { LOOP_MEMORY_GIT: 'off' });
  check('reminder: LOOP_MEMORY_GIT=off silences the untracked warning',
    !r.out.includes('is tracked') && r.out.includes('Project memory'), r.out.slice(0, 160));
  writeFileSync(join(t, '.loop', 'config.json'), JSON.stringify({ memory: { git: false } }));
  r = runHook('loop-reminder.mjs', { cwd: t });
  check('reminder: config memory.git=false silences the untracked warning',
    !r.out.includes('is tracked') && r.out.includes('Project memory'), r.out.slice(0, 160));
  writeFileSync(join(t, '.loop', 'config.json'), '{not json');
  r = runHook('loop-reminder.mjs', { cwd: t });
  check('reminder: an unreadable config.json still warns', r.out.includes('is tracked'), r.out.slice(0, 160));
  rmSync(join(t, '.loop', 'config.json'));

  git('add', '.loop/memory');
  r = runHook('loop-reminder.mjs', { cwd: t });
  check('reminder: a tracked store is silent', !r.out.includes('is tracked'), r.out.slice(0, 160));
}

{
  // The other legitimate shape: a repo of the store's own, so a company checkout
  // carries no private notes. Invisible to `git ls-files` run at the project
  // root, which is why the question is asked from inside the store.
  const t = tree(proj({}), { index: '# Learnings index\n- L-001 [gotcha][x] a symptom\n' });
  cleanup.push(t);
  const mem = join(t, '.loop', 'memory');
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, stdio: 'ignore' });
  git(t, 'init', '-q');
  writeFileSync(join(t, '.gitignore'), '.loop/\n');
  git(mem, 'init', '-q');
  git(mem, 'config', 'user.email', 't@example.com');
  git(mem, 'config', 'user.name', 'T');
  git(mem, 'add', '-A');
  git(mem, 'commit', '-qm', 'store');

  const r = runHook('loop-reminder.mjs', { cwd: t });
  check('reminder: a store with a repo of its own is silent, though the parent ignores it',
    !r.out.includes('is tracked'), r.out.slice(0, 160));
}

// ------------------------------------------------------------------ run-gate
{
  const BACKLOG = (s1, s2, s3) => `# Backlog — demo

| # | Sub-goal | Done when (seed) | Must not (seed) | Depends on | Tier | Status |
|---|----------|------------------|-----------------|------------|------|--------|
| 1 | Prove the surface | a | b | — | medium | ${s1} |
| 2 | Render the line | c | d | 1 | small | ${s2} |
| 3 | Ship the wiring | e | f | 2 | medium | ${s3} |
`;
  const runProj = ({ run, backlog, state } = {}) => {
    const d = proj(state ? { state } : {});
    mkdirSync(join(d, '.loop', 'epics', 'demo'), { recursive: true });
    if (backlog !== undefined) writeFileSync(join(d, '.loop', 'epics', 'demo', 'backlog.md'), backlog);
    if (run !== undefined) writeFileSync(join(d, '.loop', 'run.json'), JSON.stringify(run));
    return d;
  };
  const RUN = { epic: 'demo', hands_off: true, order: [1, 2, 3] };
  const readRun = (d) => JSON.parse(readFileSync(join(d, '.loop', 'run.json'), 'utf8'));

  let r = runHook('run-gate.mjs', { cwd: proj({}) });
  check('run-gate: no run.json → allow stop', r.code === 0, `code=${r.code}`);

  // the symptom: item 1 closed, memory compounded, session tries to stop with 2 items left
  let d = runProj({ run: RUN, backlog: BACKLOG('done', 'designed (pre-compiled)', 'pending'), state: { status: 'done', backlog_item: 1 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: items pending → block stop, names the next item',
    r.code === 2 && r.err.includes('next is item 2') && r.err.includes('1 of 3 items done'), `code=${r.code} err=${r.err.slice(0, 160)}`);
  check('run-gate: block names the hands-off mode', r.err.includes('(hands-off)'), r.err.slice(0, 120));
  check('run-gate: nudge counter written to run.json', readRun(d).nudge?.count === 1 && typeof readRun(d).nudge?.key === 'string', JSON.stringify(readRun(d).nudge));

  // a loop paused mid-iteration under a run is a premature stop too
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'in-progress (iter 3/8)', 'pending'), state: { status: 'running', backlog_item: 2, iteration: 3, max_iterations: 8 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: loop running mid-item → block, says run the breaker',
    r.code === 2 && r.err.includes('mid-flight') && r.err.includes('3/8'), `code=${r.code} err=${r.err.slice(0, 160)}`);

  d = runProj({ run: RUN, backlog: BACKLOG('done', 'designed', 'pending'), state: { status: 'designed', backlog_item: 2 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: next item designed → block, says run its loop',
    r.code === 2 && r.err.includes('is designed'), `code=${r.code} err=${r.err.slice(0, 160)}`);

  // the legitimate stops
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'stuck (breaker: stagnation)', 'pending'), state: { status: 'stuck' } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: a stuck row → allow stop (runner stops on stuck)', r.code === 0, `code=${r.code} err=${r.err.slice(0, 120)}`);

  d = runProj({ run: RUN, backlog: BACKLOG('done', 'in-progress', 'pending'), state: { status: 'stopped-user', backlog_item: 2 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: loop stopped-user → allow stop', r.code === 0, `code=${r.code}`);

  d = runProj({ run: RUN, backlog: BACKLOG('done', 'in-progress', 'pending'), state: { status: 'stopped-max-iterations', backlog_item: 2 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: loop stopped-max-iterations → allow stop', r.code === 0, `code=${r.code}`);

  d = runProj({ run: { ...RUN, human_gates: [2] }, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'done', backlog_item: 1 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: next item is a human gate → allow stop', r.code === 0, `code=${r.code} err=${r.err.slice(0, 120)}`);

  d = runProj({ run: { ...RUN, budget: 1, done_at_start: 0 }, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'done', backlog_item: 1 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: item budget spent → allow stop', r.code === 0, `code=${r.code} err=${r.err.slice(0, 120)}`);

  d = runProj({ run: { ...RUN, budget: 2, done_at_start: 0 }, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'done', backlog_item: 1 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: item budget not yet spent → block', r.code === 2, `code=${r.code}`);

  d = runProj({ run: RUN, backlog: BACKLOG('done', 'done', 'done'), state: { status: 'done', backlog_item: 3 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: every row done → allow stop', r.code === 0, `code=${r.code}`);

  d = runProj({ run: RUN, state: { status: 'done' } }); // instance archived, stale run.json
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: backlog gone (instance archived) → allow stop', r.code === 0, `code=${r.code}`);

  // order honours the topo sort, not the table order
  d = runProj({ run: { ...RUN, order: [1, 3, 2] }, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'done', backlog_item: 1 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: next item follows run.json order', r.code === 2 && r.err.includes('next is item 3'), r.err.slice(0, 120));

  // the cap: same position nudged MAX times → give up, say so
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'done', backlog_item: 1 } });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push(runHook('run-gate.mjs', { cwd: d }));
  check('run-gate: nudges 1-3 at one position block', codes.slice(0, 3).every((x) => x.code === 2), codes.map((x) => x.code).join(','));
  check('run-gate: 4th nudge without progress → allow, says halted',
    codes[3].code === 0 && codes[3].err.includes('halted'), `code=${codes[3].code} err=${codes[3].err.slice(0, 140)}`);
  check('run-gate: stop_hook_active is not what caps it',
    runHook('run-gate.mjs', { cwd: runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'done', backlog_item: 1 } }), stop_hook_active: true }).code === 2, '');

  // progress resets the counter: 3 nudges, then the loop moves an iteration
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'in-progress', 'pending'), state: { status: 'running', backlog_item: 2, iteration: 1 } });
  for (let i = 0; i < 3; i++) runHook('run-gate.mjs', { cwd: d });
  writeFileSync(join(d, '.loop', 'state.json'), JSON.stringify({ status: 'running', backlog_item: 2, iteration: 2 }));
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: an iteration of progress resets the nudge counter',
    r.code === 2 && readRun(d).nudge.count === 1, `code=${r.code} nudge=${JSON.stringify(readRun(d).nudge)}`);

  // ---- review findings, each reproduced before it was fixed
  // a leftover state.json from another epic must not silence this run
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'stuck', epic: 'some-other-epic' } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: stuck state.json of ANOTHER epic is ignored → block', r.code === 2, `code=${r.code}`);

  // a running loop belonging to item 1 is not item 2's loop
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'running', backlog_item: 1, iteration: 5, max_iterations: 8 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: running loop of a different item → block, but says design gate, not mid-flight',
    r.code === 2 && !r.err.includes('mid-flight') && r.err.includes("item 2's design gate"), r.err.slice(0, 200));

  // status-cell decoration — the done rule is loop-close.mjs's (D-eci-026): `done` opens the cell once
  // ` * _ are gone. Item 5 moved '✅ done' and '[x] done' out of this list (named, stricter change).
  for (const cell of ['done.', '**Done**', 'done!', 'Done (closed 2026-09-25 by loop-close)']) {
    d = runProj({ run: RUN, backlog: BACKLOG(cell, cell, cell) });
    r = runHook('run-gate.mjs', { cwd: d });
    check(`run-gate: status cell ${JSON.stringify(cell)} reads done → allow`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 100)}`);
  }
  for (const cell of ['✅ done', '[x] done', '~~x~~ done']) {
    d = runProj({ run: RUN, backlog: BACKLOG(cell, cell, cell) });
    r = runHook('run-gate.mjs', { cwd: d });
    check(`run-gate: status cell ${JSON.stringify(cell)} reads not done (loop-close's rule) → block`, r.code === 2 && r.err.includes('0 of 3 items done'), `code=${r.code} err=${r.err.slice(0, 100)}`);
  }

  // row 0 is a row (L-007): a run whose first pending item is 0 names it; budget 0 is no budget
  {
    const B0 = `# Backlog — demo\n\n| # | Sub-goal | Status |\n|---|---|---|\n| 0 | Baseline | pending |\n| 1 | Next | pending |\n`;
    d = runProj({ run: { ...RUN, order: [0, 1] }, backlog: B0 });
    r = runHook('run-gate.mjs', { cwd: d });
    check('run-gate: row 0 pending first in order → block naming item 0', r.code === 2 && r.err.includes('next is item 0') && r.err.includes('0 of 2 items done'), r.err.slice(0, 160));
    d = runProj({ run: { ...RUN, order: [0, 1], budget: 0, done_at_start: 0 }, backlog: B0 });
    r = runHook('run-gate.mjs', { cwd: d });
    check('run-gate: budget 0 is no budget (a positive count is required) → still blocks', r.code === 2 && r.err.includes('next is item 0'), `code=${r.code}`);
  }

  // item 5: a loop done while its row is not — the close step writes done, not the model
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'designed', 'pending'), state: { status: 'done', backlog_item: 2 } });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: loop done, row not → says to run the close step (loop-close writes done)',
    r.code === 2 && r.err.includes('loop-close.mjs writes') && !r.err.includes('row → done'), r.err.slice(0, 240));

  // only the first table is the backlog; fenced tables and later tables do not rewrite it
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'done', 'done') + '\n## Acceptance\n\n| # | Criterion | Status |\n|---|---|---|\n| 1 | ships | pending |\n' });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: a later table cannot flip an item back to pending → allow', r.code === 0, `code=${r.code} err=${r.err.slice(0, 120)}`);
  d = runProj({ run: RUN, backlog: '## Risks\n\n```\n| # | Risk | Status |\n|---|---|---|\n| 1 | x | open |\n```\n\n' + BACKLOG('done', 'done', 'done') });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: a fenced table before the backlog is skipped → allow', r.code === 0, `code=${r.code} err=${r.err.slice(0, 120)}`);
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending').replace('| 2 | Render the line | c | d |', '| 2 | Render a \\| b line | c | d |') });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: an escaped pipe in a cell keeps the status column', r.code === 2 && r.err.includes('next is item 2') && r.err.includes('a | b'), r.err.slice(0, 160));

  // ids spelled as strings in run.json are the same ids
  d = runProj({ run: { ...RUN, human_gates: ['2'] }, backlog: BACKLOG('done', 'pending', 'pending') });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: human_gates as strings still gate → allow', r.code === 0, `code=${r.code} err=${r.err.slice(0, 120)}`);
  d = runProj({ run: { ...RUN, order: ['1', '3', '2'] }, backlog: BACKLOG('done', 'pending', 'pending') });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: order as strings is honoured', r.code === 2 && r.err.includes('next is item 3'), r.err.slice(0, 120));
  d = runProj({ run: { ...RUN, order: [9, 8] }, backlog: BACKLOG('done', 'pending', 'pending') });
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: order naming no real item falls back to table order', r.code === 2 && r.err.includes('next is item 2'), r.err.slice(0, 120));

  // fail-open: a counter that cannot be written is a spent counter
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending') });
  chmodSync(join(d, '.loop', 'run.json'), 0o444); chmodSync(join(d, '.loop'), 0o555);
  r = runHook('run-gate.mjs', { cwd: d });
  chmodSync(join(d, '.loop'), 0o755); chmodSync(join(d, '.loop', 'run.json'), 0o644);
  check('run-gate: unwritable run.json → allow (a bound it cannot record is no bound)',
    r.code === 0 && r.err.includes('halted'), `code=${r.code} err=${r.err.slice(0, 120)}`);

  // the gate runs when invoked through a symlinked plugin root
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending') });
  const linkRoot = mkdtempSync(join(tmpdir(), 'loop-hook-link-')); cleanup.push(linkRoot);
  symlinkSync(HOOKS, join(linkRoot, 'hooks'));
  {
    const sr = spawnSync('node', [join(linkRoot, 'hooks', 'run-gate.mjs')], { input: JSON.stringify({ cwd: d }), encoding: 'utf8', env: { ...process.env, LOOP_HOOKS_OFF: '' } });
    check('run-gate: invoked via a symlinked plugin root still blocks', sr.status === 2, `code=${sr.status}`);
  }

  // memory-gate keeps its once-only block per terminal state under a run, though stop_hook_active stays true
  d = runProj({ run: RUN, backlog: BACKLOG('pending', 'pending', 'pending'), state: { status: 'done', backlog_item: 1 } });
  mkdirSync(join(d, '.loop', 'memory'), { recursive: true });
  writeFileSync(join(d, '.loop', 'memory', 'learnings.md'), '# Learnings\n');
  { const old = (Date.now() - 3600_000) / 1000; utimesSync(join(d, '.loop', 'memory', 'learnings.md'), old, old); }
  r = runHook('memory-gate.mjs', { cwd: d, stop_hook_active: true });
  check('memory-gate: under an open run, stop_hook_active does not mute it → block once', r.code === 2 && r.err.includes('compounded'), `code=${r.code} err=${r.err.slice(0, 100)}`);
  r = runHook('memory-gate.mjs', { cwd: d, stop_hook_active: true });
  check('memory-gate: same terminal state again → let through (blocked once)', r.code === 0, `code=${r.code} err=${r.err.slice(0, 100)}`);
  writeFileSync(join(d, '.loop', 'state.json'), JSON.stringify({ status: 'done', backlog_item: 2 }));
  { const t = (Date.now() + 5000) / 1000; utimesSync(join(d, '.loop', 'state.json'), t, t); }
  r = runHook('memory-gate.mjs', { cwd: d, stop_hook_active: true });
  check('memory-gate: a NEW terminal state under the run blocks again', r.code === 2, `code=${r.code} err=${r.err.slice(0, 100)}`);

  r = runHook('run-gate.mjs', { cwd: runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending') }) }, { LOOP_HOOKS_OFF: '1' });
  check('run-gate: LOOP_HOOKS_OFF=1 → allow', r.code === 0, `code=${r.code}`);

  r = runHook('run-gate.mjs', { cwd: runProj({ run: { epic: 'demo' }, backlog: BACKLOG('done', 'pending', 'pending') }) });
  check('run-gate: run.json without order falls back to table order', r.code === 2 && r.err.includes('next is item 2'), r.err.slice(0, 120));

  // the reminder announces the run, so a fresh session resumes the runner
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'pending', 'pending'), state: { status: 'done', backlog_item: 1 } });
  r = runHook('loop-reminder.mjs', { cwd: d });
  check('reminder: open run → names epic, progress, next item and the resume command',
    r.code === 0 && r.out.includes('Open epic run') && r.out.includes('1 of 3') && r.out.includes('/loop-engineering:run demo --hands-off'), r.out.slice(0, 200));
  d = runProj({ run: RUN, backlog: BACKLOG('done', 'done', 'done') });
  r = runHook('loop-reminder.mjs', { cwd: d });
  check('reminder: run with nothing pending → silent about the run', !r.out.includes('Open epic run'), r.out.slice(0, 120));
}

// ------------------------------------------- run-gate: silent while its own subagent runs
{
  const agentsDir = (d, s) => join(d, '.loop', '.agents-running', s);
  const track = (d, event, extra = {}, env = {}) => runHook('agent-track.mjs', { cwd: d, hook_event_name: event, session_id: 's1', agent_id: 'a1', ...extra }, env);
  const runP = (d) => { mkdirSync(join(d, '.loop', 'epics', 'demo'), { recursive: true }); return d; };
  const BL = `# Backlog — demo\n\n| # | Sub-goal | Status |\n|---|---|---|\n| 1 | a | done |\n| 2 | b | pending |\n`;
  const openRun = () => {
    const d = runP(proj({ state: { status: 'done', backlog_item: 1 } }));
    writeFileSync(join(d, '.loop', 'epics', 'demo', 'backlog.md'), BL);
    writeFileSync(join(d, '.loop', 'run.json'), JSON.stringify({ epic: 'demo', hands_off: true, order: [1, 2] }));
    return d;
  };
  const nudgeOf = (d) => JSON.parse(readFileSync(join(d, '.loop', 'run.json'), 'utf8')).nudge;

  let d = openRun();
  let t = track(d, 'SubagentStart');
  check('agent-track: SubagentStart writes one file per agent, exits 0', t.code === 0 && existsSync(join(agentsDir(d, 's1'), 'a1')), `code=${t.code}`);
  let r = runHook('run-gate.mjs', { cwd: d, session_id: 's1' });
  check('run-gate: a live subagent of this session → silent, nudge untouched', r.code === 0 && nudgeOf(d) === undefined, `code=${r.code} nudge=${JSON.stringify(nudgeOf(d))}`);
  t = track(d, 'SubagentStop');
  check('agent-track: SubagentStop removes the file and the empty session directory', t.code === 0 && !existsSync(agentsDir(d, 's1')), `code=${t.code}`);
  r = runHook('run-gate.mjs', { cwd: d, session_id: 's1' });
  check('run-gate: after SubagentStop the gate blocks again', r.code === 2 && nudgeOf(d)?.count === 1, `code=${r.code}`);

  d = openRun();
  track(d, 'SubagentStart');
  const old = (Date.now() - 31 * 60 * 1000) / 1000;
  utimesSync(join(agentsDir(d, 's1'), 'a1'), old, old);
  r = runHook('run-gate.mjs', { cwd: d, session_id: 's1' });
  check('run-gate: an entry older than the stale timeout does not silence', r.code === 2, `code=${r.code}`);

  d = openRun();
  track(d, 'SubagentStart', { session_id: 's2' });
  r = runHook('run-gate.mjs', { cwd: d, session_id: 's1' });
  check('run-gate: another session\'s subagent does not silence', r.code === 2, `code=${r.code}`);

  d = openRun();
  track(d, 'SubagentStart');
  r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: a Stop input with no session_id does not silence', r.code === 2, `code=${r.code}`);
  const rEmpty = runHook('run-gate.mjs', { cwd: d, session_id: '' });
  const rDots = runHook('run-gate.mjs', { cwd: d, session_id: '..' });
  check('run-gate: a session_id that is not a plain id (\'\', \'..\') does not silence (it would list the parent)', rEmpty.code === 2 && rDots.code === 2, `codes=${rEmpty.code},${rDots.code}`);

  d = openRun();
  mkdirSync(join(d, '.loop', '.agents-running'), { recursive: true });
  writeFileSync(agentsDir(d, 's1'), 'not a directory');
  r = runHook('run-gate.mjs', { cwd: d, session_id: 's1' });
  check('run-gate: an unreadable record fails open (the gate still blocks)', r.code === 2, `code=${r.code}`);

  d = openRun();
  t = track(d, 'SubagentStart', { agent_id: undefined });
  const t2 = track(d, 'SubagentStart', { session_id: undefined });
  const t3 = track(d, 'SubagentStart', { agent_id: '../escape' });
  check('agent-track: no agent_id, no session_id or a non-id segment → nothing written, exit 0',
    [t, t2, t3].every((x) => x.code === 0) && !existsSync(join(d, '.loop', '.agents-running')) && !existsSync(join(d, '.loop', 'escape')), `codes=${[t, t2, t3].map((x) => x.code)}`);

  d = openRun();
  t = track(d, 'SubagentStart', {}, { LOOP_HOOKS_OFF: '1' });
  check('agent-track: LOOP_HOOKS_OFF=1 → nothing written', t.code === 0 && !existsSync(join(d, '.loop', '.agents-running')), `code=${t.code}`);

  d = proj({});
  rmSync(join(d, '.loop'), { recursive: true, force: true });
  t = track(d, 'SubagentStart');
  check('agent-track: a project without .loop/ → nothing written, exit 0', t.code === 0 && !existsSync(join(d, '.loop')), `code=${t.code}`);

  // two overlapping stops: one file per agent, so neither can resurrect the other's entry
  d = openRun();
  track(d, 'SubagentStart', { agent_id: 'a1' });
  track(d, 'SubagentStart', { agent_id: 'a2' });
  const stopAsync = (agent) => new Promise((res) => {
    const c = spawn('node', [join(HOOKS, 'agent-track.mjs')], { env: { ...process.env, LOOP_HOOKS_OFF: '' } });
    c.on('close', res);
    c.stdin.end(JSON.stringify({ cwd: d, hook_event_name: 'SubagentStop', session_id: 's1', agent_id: agent }));
  });
  await Promise.all([stopAsync('a1'), stopAsync('a2')]);
  check('agent-track: two overlapping stops leave no entry behind', !existsSync(agentsDir(d, 's1')) || readdirSync(agentsDir(d, 's1')).length === 0,
    existsSync(agentsDir(d, 's1')) ? readdirSync(agentsDir(d, 's1')).join(',') : 'gone');
  r = runHook('run-gate.mjs', { cwd: d, session_id: 's1' });
  check('run-gate: after both overlapping stops the gate blocks', r.code === 2, `code=${r.code}`);

  // a marker nobody removes (a crashed agent, or one written by hand) silences at most MAX_SILENCES stops at one position
  d = openRun();
  track(d, 'SubagentStart');
  const codes = [];
  for (let i = 0; i < 21; i += 1) codes.push(runHook('run-gate.mjs', { cwd: d, session_id: 's1' }).code);
  check('run-gate: a live marker silences 20 stops at one position, then the gate nudges again',
    codes.slice(0, 20).every((c) => c === 0) && codes[20] === 2 && nudgeOf(d)?.count === 1, `codes=${codes.join('')}`);

  // a non-string id is not a path segment
  d = openRun();
  t = track(d, 'SubagentStart', { session_id: 7, agent_id: 8 });
  check('agent-track: a non-string session_id/agent_id → nothing written', t.code === 0 && !existsSync(join(d, '.loop', '.agents-running')), `code=${t.code}`);
}

// ------------------------------------------- runStanding sees an appended integration row (item 5)
{
  // the dogfood epic after item 2's close; the epic gate's findings (minor line removed) appended by loop-close
  const FIX = join(HOOKS, '..', 'fixtures', 'dogfood-epic');
  const d = mkdtempSync(join(tmpdir(), 'loop-hook-append-'));
  cleanup.push(d);
  cpSync(join(FIX, '.loop'), join(d, '.loop'), { recursive: true });
  const close = join(HOOKS, '..', 'scripts', 'loop-close.mjs');
  spawnSync('node', [close, 'close', '--dir', join(d, '.loop'), '--item', '2', '--verdict-file', join(FIX, 'verdicts', 'approve.md')]);
  writeFileSync(join(d, '.loop', 'run.json'), JSON.stringify({ epic: 'demo', hands_off: true, order: [1, 2] }, null, 2) + '\n');
  const before = runStanding(d);
  const f = join(d, 'findings.md');
  writeFileSync(f, readFileSync(join(FIX, 'verdicts', 'epic-gate-findings.md'), 'utf8').split('\n').filter((l) => !l.startsWith('- minor:')).join('\n'));
  const a = spawnSync('node', [close, 'append', '--dir', join(d, '.loop'), '--findings-file', f], { encoding: 'utf8' });
  const after = runStanding(d);
  check('runStanding: nothing pending after the last close, then the appended integration row is next',
    before === null && a.status === 0 && after !== null && after.next.id === 3 && after.order.join(',') === '1,2,3',
    `before=${JSON.stringify(before)} append=${a.status} ${a.stderr} next=${after && after.next.id}`);
  const r = runHook('run-gate.mjs', { cwd: d });
  check('run-gate: the appended integration row holds the session', r.code === 2 && r.err.includes('next is item 3'), r.err.slice(0, 160));
}

// -------------------------------------------- agent-track: tenth-man capture
{
  const verdict = '## Verdict: APPROVE\n\n### Dissent on record\nthe cache key\n';
  const records = (d) => (existsSync(join(d, '.loop', 'critique')) ? readdirSync(join(d, '.loop', 'critique')) : []);
  const stop = (d, extra) => runHook('agent-track.mjs', { cwd: d, hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'c1', ...extra });

  const d = proj({ state: { status: 'designed', run_id: 'run-x', tier: 'medium', iteration: 0, history: [] } });
  let t = stop(d, { agent_type: 'loop-engineering:plan-critic', last_assistant_message: verdict });
  const file = join(d, '.loop', 'critique', 'r1.md');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  check('agent-track: plan-critic SubagentStop records its last message verbatim, source hook',
    t.code === 0 && /source: hook/.test(text) && /run_id: run-x/.test(text) && text.includes('the cache key'), `code=${t.code} files=${records(d)}`);

  const transcriptPath = join(d, 'critic.jsonl');
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '## Verdict: REVISE\n\n### Findings\n- **Finding 1 (major):** z' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
  ].join('\n'));
  t = stop(d, { agent_type: 'plan-critic', agent_transcript_path: transcriptPath });
  const second = join(d, '.loop', 'critique', 'r2.md');
  check('agent-track: without last_assistant_message the transcript’s last assistant text is recorded',
    t.code === 0 && existsSync(second) && /verdict: REVISE/.test(readFileSync(second, 'utf8')), `files=${records(d)}`);

  t = stop(d, { agent_type: 'loop-engineering:loop-verifier', last_assistant_message: verdict });
  check('agent-track: a non-critic agent records no critique', t.code === 0 && records(d).length === 2, `files=${records(d)}`);

  // Auto mode: the report travels through the SubagentHandback tool, and the
  // stop payload's last message is only the closing text (or nothing).
  const handback = (dir, extra) => runHook('agent-track.mjs', { cwd: dir, hook_event_name: 'PostToolUse', session_id: 's1', agent_id: 'c2', tool_name: 'SubagentHandback', ...extra });
  const bodyOf = (file) => readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  const report = '## Verdict: REVISE\n\n### Attacks mounted\n1. the cache key — grep — FAILED\n\n### Findings\n- **Finding 1 (major):** the hand-back\n';
  const marker = join(d, '.loop', '.agents-running', 's1', 'c2.critique');
  t = handback(d, { agent_type: 'loop-engineering:plan-critic', tool_input: { message: report } });
  const third = join(d, '.loop', 'critique', 'r3.md');
  check('agent-track: a plan-critic SubagentHandback records tool_input.message verbatim, source hook, agent_id, and leaves a marker',
    t.code === 0 && existsSync(third) && bodyOf(third) === report && /^verdict: REVISE$/m.test(readFileSync(third, 'utf8'))
      && /^source: hook$/m.test(readFileSync(third, 'utf8')) && /^agent_id: c2$/m.test(readFileSync(third, 'utf8'))
      && existsSync(marker) && readFileSync(marker, 'utf8') === third,
    `code=${t.code} files=${records(d)} marker=${existsSync(marker)}`);
  t = stop(d, { agent_id: 'c2', agent_type: 'loop-engineering:plan-critic', last_assistant_message: 'Report delivered.' });
  check('agent-track: the SubagentStop after a recorded hand-back records nothing more and clears the marker',
    t.code === 0 && records(d).length === 3 && !existsSync(marker) && !existsSync(join(d, '.loop', '.agents-running', 's1')),
    `code=${t.code} files=${records(d)} marker=${existsSync(marker)}`);
  t = handback(d, { agent_type: 'loop-engineering:loop-verifier', tool_input: { message: report } });
  const t4 = handback(d, { agent_type: 'plan-critic', tool_name: 'Bash', tool_input: { command: 'echo', message: report } });
  const t5 = handback(d, { agent_type: 'plan-critic', tool_input: { message: '   ' } });
  check('agent-track: a hand-back from a non-critic, another tool from a critic, or a blank message records nothing',
    t.code === 0 && t4.code === 0 && t5.code === 0 && records(d).length === 3 && !existsSync(join(d, '.loop', '.agents-running', 's1')),
    `files=${records(d)}`);

  // No tool hook ran (marker absent): the transcript's hand-back is the report,
  // and the closing text after it is not.
  const hbTranscript = join(d, 'critic-handback.jsonl');
  writeFileSync(hbTranscript, [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the design.' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'delivered' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Report delivered.' }] } }),
  ].join('\n'));
  t = stop(d, { agent_id: 'c3', agent_type: 'plan-critic', agent_transcript_path: hbTranscript, last_assistant_message: 'Report delivered.' });
  const fourth = join(d, '.loop', 'critique', 'r4.md');
  check('agent-track: a SubagentStop whose transcript holds a hand-back records that message, not the closing text',
    t.code === 0 && existsSync(fourth) && bodyOf(fourth) === report && /^agent_id: c3$/m.test(readFileSync(fourth, 'utf8')), `files=${records(d)}`);

  // Without a hand-back the stop payload's final text wins over the transcript, which may lag it.
  t = stop(d, { agent_id: 'c4', agent_type: 'plan-critic', agent_transcript_path: transcriptPath, last_assistant_message: verdict });
  const fifth = join(d, '.loop', 'critique', 'r5.md');
  check('agent-track: without a hand-back, last_assistant_message wins over the transcript’s last text',
    t.code === 0 && existsSync(fifth) && bodyOf(fifth) === verdict, `files=${records(d)}`);


  const slice = proj({ state: { status: 'designed', run_id: 'run-slice', tier: 'medium', iteration: 0, history: [] } });
  t = stop(d, { agent_type: 'plan-critic', last_assistant_message: `Loop: ${join(slice, '.loop')}\n${verdict}` });
  check('agent-track: a `Loop:` line naming a worktree slice records there, bound to its run_id',
    t.code === 0 && records(slice).length === 1 && /run_id: run-slice/.test(readFileSync(join(slice, '.loop', 'critique', 'r1.md'), 'utf8')) && records(d).length === 5,
    `slice=${records(slice)} main=${records(d)}`);
  t = stop(d, { agent_type: 'plan-critic', last_assistant_message: `Loop: /nonexistent/.loop\n${verdict}` });
  check('agent-track: a `Loop:` line naming no state.json falls back to this session’s .loop/', t.code === 0 && records(d).length === 6, `main=${records(d)}`);

  // Every hook route writes the whole record, severity frontmatter included —
  // compared against a text built here from the contract, over three input
  // endings. `recorded:` is the one value the hook does not let a test inject,
  // so it is read back from the written file; every other line is expected.
  {
    const EMPTY_HASH = createHash('sha256').update('').update('\0').update('').digest('hex').slice(0, 16);
    const critical = '## Verdict: REVISE\n\n### Findings\n- **Finding 1 (critical):** the gate\n  - Failure scenario: s\n- **Finding 2 (minor):** a typo\n';
    const want = (file, body, agentId) => {
      const recorded = (/^recorded: (.*)$/m.exec(readFileSync(file, 'utf8')) || [])[1];
      return ['---', 'run_id: run-w', 'round: 1', 'verdict: REJECT', 'declared: REVISE',
        'severities: blocker=0 critical=1 major=0 minor=1', 'findings: 1=critical,2=minor',
        'source: hook', `design_hash: ${EMPTY_HASH}`, `agent_id: ${agentId}`, `recorded: ${recorded}`, '---', ''].join('\n')
        + body.trim() + '\n';
    };
    const ENDINGS = [['no newline', (x) => x.trimEnd()], ['one newline', (x) => x.trimEnd() + '\n'], ['blank lines', (x) => x.trimEnd() + '\n\n\n']];
    const routes = [
      ['PostToolUse SubagentHandback', (dd, body) => handback(dd, { agent_id: 'w1', agent_type: 'loop-engineering:plan-critic', tool_input: { message: body } }), 'w1'],
      ['SubagentStop last_assistant_message', (dd, body) => stop(dd, { agent_id: 'w2', agent_type: 'plan-critic', last_assistant_message: body }), 'w2'],
      ['SubagentStop transcript hand-back', (dd, body) => {
        const tp = join(dd, 'hb.jsonl');
        writeFileSync(tp, [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: body } }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Report delivered.' }] } })].join('\n'));
        return stop(dd, { agent_id: 'w3', agent_type: 'plan-critic', agent_transcript_path: tp });
      }, 'w3'],
      ['SubagentStop transcript closing text', (dd, body) => {
        const tp = join(dd, 'txt.jsonl');
        writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: body }] } }));
        return stop(dd, { agent_id: 'w4', agent_type: 'plan-critic', agent_transcript_path: tp });
      }, 'w4'],
    ];
    for (const [route, run, agentId] of routes) {
      for (const [ending, shape] of ENDINGS) {
        const dd = proj({ state: { status: 'designed', run_id: 'run-w', tier: 'medium', iteration: 0, history: [] } });
        const body = shape(critical);
        const rr = run(dd, body);
        const file = join(dd, '.loop', 'critique', 'r1.md');
        const got = existsSync(file) ? readFileSync(file, 'utf8') : '';
        const exp = existsSync(file) ? want(file, body, agentId) : '(no record)';
        check(`agent-track: ${route} (${ending}) writes the whole record — severity frontmatter, REVISE rounded up to REJECT`,
          rr.code === 0 && got === exp, `\n--- got\n${got}--- want\n${exp}`);
      }
    }
  }

  // The arbiter's ruling through every hook route, as the whole store of both
  // trees after each write: route × epic none/set × judged tree (this session's
  // .loop/, or a worktree slice named by `Loop:`) × starting store (empty, or
  // another run's leftovers) × every ordered pair of outcomes × 3 endings. The
  // ruling lands in the judged tree; the epic ledger copy under this session's
  // cwd (A1); a hand-back is followed by its SubagentStop, which records nothing
  // more.
  {
    const EMPTY_HASH = createHash('sha256').update('').update('\0').update('').digest('hex').slice(0, 16);
    const R2 = '## Verdict: REVISE\n\n### Findings\n- **Finding 1 (major):** the cache\n- **Finding 2 (critical):** the gate\n- **Finding 3 (minor):** a typo\n';
    const L = (n, call, sev) => `- r2#${n} — ${call} — ${sev} — reason ${n}`;
    const arb = (loop, ruling, lines) => `Loop: ${loop}\n## Ruling: ${ruling}\n\n### Findings ruled\n${lines.join('\n')}\n\n### Why\nweighed both records\n`;
    const OUT = {
      PROCEED: [['PROCEED', [L(1, 'UPHELD', 'major'), L(2, 'OVERRULED', 'critical'), L(3, 'UPHELD', 'minor')]],
        ['ruling: PROCEED', 'judged: r2', 'upheld: blocker=0 critical=0 major=1 minor=1', 'overruled: 1']],
      REDESIGN: [['REDESIGN', [L(1, 'UPHELD', 'major'), L(2, 'UPHELD', 'critical'), L(3, 'OVERRULED', 'minor')]],
        ['ruling: REDESIGN', 'judged: r2', 'upheld: blocker=0 critical=1 major=1 minor=0', 'overruled: 1']],
      unreadable: [['PROCEED', [L(1, 'UPHELD', 'major')]], ['ruling: unreadable', 'declared: PROCEED', 'unreadable: unruled: r2#2, r2#3', 'judged: r2']],
    };
    const ENDINGS = [['no newline', (x) => x.trimEnd()], ['one newline', (x) => x.trimEnd() + '\n'], ['blank lines', (x) => x.trimEnd() + '\n\n\n']];
    const LEFTOVER = (seq) => `---\nrun_id: run-old\nkind: ruling\nseq: ${seq}\nruling: PROCEED\njudged: r2\nupheld: blocker=0 critical=0 major=0 minor=0\noverruled: 0\nsource: hook\ndesign_hash: 0000000000000000\nrecorded: 2026-11-01T00:00:00.000Z\n---\nold run ${seq}\n`;
    const snapshot = (tree) => {
      const out = {};
      const walk = (dd) => {
        if (!existsSync(dd)) return;
        for (const e of readdirSync(dd, { withFileTypes: true })) {
          const pp = join(dd, e.name);
          if (e.isDirectory()) walk(pp); else out[relative(tree, pp)] = readFileSync(pp, 'utf8');
        }
      };
      walk(join(tree, '.loop'));
      return out;
    };
    const same = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()) && Object.keys(a).every((k) => a[k] === b[k]);
    const ROUTES = [
      ['PostToolUse SubagentHandback, then its SubagentStop', (dd, body, id) => {
        const a = runHook('agent-track.mjs', { cwd: dd, hook_event_name: 'PostToolUse', session_id: 's9', agent_id: id, tool_name: 'SubagentHandback', agent_type: 'loop-engineering:tenth-man-arbiter', tool_input: { message: body } });
        const b = runHook('agent-track.mjs', { cwd: dd, hook_event_name: 'SubagentStop', session_id: 's9', agent_id: id, agent_type: 'loop-engineering:tenth-man-arbiter', last_assistant_message: 'Report delivered.' });
        return a.code === 0 && b.code === 0;
      }],
      ['SubagentStop last_assistant_message', (dd, body, id) => runHook('agent-track.mjs', { cwd: dd, hook_event_name: 'SubagentStop', session_id: 's9', agent_id: id, agent_type: 'tenth-man-arbiter', last_assistant_message: body }).code === 0],
      ['SubagentStop transcript hand-back', (dd, body, id) => {
        const tp = join(dd, `hb-${id}.jsonl`);
        writeFileSync(tp, [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: body } }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Report delivered.' }] } })].join('\n'));
        return runHook('agent-track.mjs', { cwd: dd, hook_event_name: 'SubagentStop', session_id: 's9', agent_id: id, agent_type: 'tenth-man-arbiter', agent_transcript_path: tp }).code === 0;
      }],
      ['SubagentStop transcript closing text', (dd, body, id) => {
        const tp = join(dd, `txt-${id}.jsonl`);
        writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: body }] } }));
        return runHook('agent-track.mjs', { cwd: dd, hook_event_name: 'SubagentStop', session_id: 's9', agent_id: id, agent_type: 'tenth-man-arbiter', agent_transcript_path: tp }).code === 0;
      }],
    ];
    for (const [route, run] of ROUTES) {
      for (const epic of [null, 'demo']) {
        for (const judgedKind of ['session', 'slice']) {
          for (const start of ['empty', 'leftover']) {
            for (const first of Object.keys(OUT)) {
              for (const second of Object.keys(OUT)) {
                for (const [ending, shape] of ENDINGS) {
                  const runId = judgedKind === 'slice' ? 'run-s' : 'run-q';
                  const state = (id) => ({ status: 'designed', run_id: id, tier: 'medium', iteration: 0, history: [], ...(epic ? { epic } : {}) });
                  const main = proj({ state: state('run-q') });
                  const slice = proj({ state: state('run-s') });
                  const judged = judgedKind === 'slice' ? slice : main;
                  recordCritique(join(judged, '.loop'), R2.replace('the cache', 'first round'), { source: 'hook', now: new Date('2026-11-05T00:00:01Z') });
                  recordCritique(join(judged, '.loop'), R2, { source: 'hook', now: new Date('2026-11-05T00:00:02Z') });
                  const names = start === 'leftover' ? ['a3.md', 'a4.md'] : ['a1.md', 'a2.md'];
                  if (start === 'leftover') {
                    mkdirSync(join(judged, '.loop', 'critique'), { recursive: true });
                    writeFileSync(join(judged, '.loop', 'critique', 'a1.md'), LEFTOVER(1));
                    writeFileSync(join(judged, '.loop', 'critique', 'a2.md'), LEFTOVER(2));
                    for (const tree of [main, slice]) {
                      mkdirSync(join(tree, '.loop', 'epics', 'demo', 'rulings'), { recursive: true });
                      writeFileSync(join(tree, '.loop', 'epics', 'demo', 'rulings', 'run-old.md'), LEFTOVER(2));
                    }
                  }
                  const modelMain = snapshot(main);
                  const modelSlice = snapshot(slice);
                  const model = judgedKind === 'slice' ? modelSlice : modelMain;
                  let ok = true;
                  let detail = '';
                  [first, second].forEach((outcome, k) => {
                    const [[declared, lines], fields] = OUT[outcome];
                    const body = shape(arb(join(judged, '.loop'), declared, lines));
                    const id = `arb${k}`;
                    const ran = run(main, body, id);
                    const rel = join('.loop', 'critique', names[k]);
                    const written = existsSync(join(judged, rel)) ? readFileSync(join(judged, rel), 'utf8') : '';
                    const recorded = (/^recorded: (.*)$/m.exec(written) || [])[1];
                    const text = ['---', `run_id: ${runId}`, 'kind: ruling', `seq: ${k + 1}`, ...fields, 'source: hook', `design_hash: ${EMPTY_HASH}`,
                      `agent_id: ${id}`, `recorded: ${recorded}`, '---', ''].join('\n') + body.trim() + '\n';
                    model[rel] = text;
                    const wantMain = { ...modelMain };
                    const wantSlice = { ...modelSlice };
                    if (epic && outcome === 'PROCEED') wantMain[join('.loop', 'epics', 'demo', 'rulings', `${runId}.md`)] = text;
                    const gotMain = snapshot(main);
                    const gotSlice = snapshot(slice);
                    if (!ran || !same(gotMain, wantMain) || !same(gotSlice, wantSlice)) {
                      ok = false;
                      const diff = (g, w) => [...new Set([...Object.keys(g), ...Object.keys(w)])].filter((key) => g[key] !== w[key]);
                      detail ||= `after step ${k + 1} (${outcome}): ran=${ran}; main differs at ${JSON.stringify(diff(gotMain, wantMain))}; slice differs at ${JSON.stringify(diff(gotSlice, wantSlice))}`;
                    }
                  });
                  check(`agent-track ruling: ${route} × epic ${epic ?? 'none'} × judged ${judgedKind} × start ${start} × ${first} then ${second} (${ending}) — whole store of both trees`, ok, detail);
                }
              }
            }
          }
        }
      }
    }
  }

  // C2 (b) through the hook: the ruling the record carries is computed, never
  // the heading — a declared PROCEED with an upheld critical, a foreign round,
  // an unclassified line, an unruled finding — each the whole record, 3 endings.
  {
    const EMPTY_HASH = createHash('sha256').update('').update('\0').update('').digest('hex').slice(0, 16);
    const R2 = '## Verdict: REVISE\n\n### Findings\n- **Finding 1 (major):** the cache\n- **Finding 2 (critical):** the gate\n';
    const L = (rr, n, call, sev) => `- r${rr}#${n} — ${call} — ${sev} — reason ${n}`;
    const body = (lines) => `## Ruling: PROCEED\n\n### Findings ruled\n${lines.join('\n')}\n`;
    const CASES = [
      ['a declared PROCEED with an UPHELD critical → REDESIGN', body([L(2, 1, 'OVERRULED', 'major'), L(2, 2, 'UPHELD', 'critical')]),
        ['ruling: REDESIGN', 'declared: PROCEED', 'judged: r2', 'upheld: blocker=0 critical=1 major=0 minor=0', 'overruled: 1']],
      ['a declared PROCEED with an UPHELD blocker alone → REDESIGN', body([L(2, 1, 'UPHELD', 'blocker'), L(2, 2, 'OVERRULED', 'critical')]),
        ['ruling: REDESIGN', 'declared: PROCEED', 'judged: r2', 'upheld: blocker=1 critical=0 major=0 minor=0', 'overruled: 1']],
      ['a ruled line for another round (foreign) → unreadable', body([L(2, 1, 'UPHELD', 'major'), L(2, 2, 'OVERRULED', 'critical'), L(1, 2, 'UPHELD', 'major')]),
        ['ruling: unreadable', 'declared: PROCEED', 'unreadable: line 6: rules r1#2, but the judged round is r2 (foreign)', 'judged: r2']],
      ['an unclassified line in the ruled region → unreadable', body(['Both rounds overstate it.', L(2, 1, 'UPHELD', 'major'), L(2, 2, 'OVERRULED', 'critical')]),
        ['ruling: unreadable', 'declared: PROCEED', 'unreadable: line 4: not a ruled line or a continuation — "Both rounds overstate it."', 'judged: r2']],
      ['a finding of the judged round left unruled → unreadable', body([L(2, 1, 'UPHELD', 'major')]),
        ['ruling: unreadable', 'declared: PROCEED', 'unreadable: unruled: r2#2', 'judged: r2']],
    ];
    const ENDINGS = [['no newline', (x) => x.trimEnd()], ['one newline', (x) => x.trimEnd() + '\n'], ['blank lines', (x) => x.trimEnd() + '\n\n\n']];
    for (const [label, text, fields] of CASES) {
      for (const [ending, shape] of ENDINGS) {
        const dd = proj({ state: { status: 'designed', run_id: 'run-b', tier: 'medium', iteration: 0, history: [] } });
        recordCritique(join(dd, '.loop'), R2.replace('the cache', 'round one'), { source: 'hook' });
        recordCritique(join(dd, '.loop'), R2, { source: 'hook' });
        const b = shape(text);
        const rr = runHook('agent-track.mjs', { cwd: dd, hook_event_name: 'SubagentStop', session_id: 's8', agent_id: 'arb-b', agent_type: 'tenth-man-arbiter', last_assistant_message: b });
        const file = join(dd, '.loop', 'critique', 'a1.md');
        const got = existsSync(file) ? readFileSync(file, 'utf8') : '';
        const recorded = (/^recorded: (.*)$/m.exec(got) || [])[1];
        const want = ['---', 'run_id: run-b', 'kind: ruling', 'seq: 1', ...fields, 'source: hook', `design_hash: ${EMPTY_HASH}`, 'agent_id: arb-b', `recorded: ${recorded}`, '---', ''].join('\n') + b.trim() + '\n';
        check(`agent-track ruling: ${label} (${ending}) — whole record`, rr.code === 0 && got === want, `\n--- got\n${got}--- want\n${want}`);
      }
    }
  }

  const bare = proj({});
  mkdirSync(join(bare, '.loop'), { recursive: true });
  t = stop(bare, { agent_type: 'plan-critic', last_assistant_message: verdict });
  check('agent-track: no state.json → nothing recorded, still exit 0', t.code === 0 && records(bare).length === 0, `code=${t.code}`);

  // boundary-gate: the records are code-written in every loop status.
  let r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: join(d, '.loop', 'critique', 'r1.md') } });
  check('boundary-gate: an edit under .loop/critique/ is blocked while the loop is only designed', r.code === 2 && /tenth-man record/.test(r.err), `code=${r.code}`);
  r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: '.loop/critique/r9.md' } });
  check('boundary-gate: a new file under .loop/critique/ is blocked too', r.code === 2, `code=${r.code}`);
  for (const alias of ['./.loop/critique/r1.md', '.loop/./critique/r1.md', 'src/../.loop/critique/r1.md', join(realpathSync(d), '.loop/critique/r1.md')]) {
    r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: alias } });
    check(`boundary-gate: the alias ${alias.startsWith('/') ? '<realpath>/.loop/critique/r1.md' : alias} is blocked too`, r.code === 2, `code=${r.code}`);
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: '.LOOP/Critique/r1.md' } });
    check('boundary-gate: a case-folded alias is blocked on a case-insensitive file system', r.code === 2, `code=${r.code}`);
  }
  r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: '.loop/design.md' } });
  check('boundary-gate: design.md beside it stays editable', r.code === 0, `code=${r.code}`);
  r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: '.loop/critique/r1.md' } }, { LOOP_HOOKS_OFF: '1' });
  check('boundary-gate: LOOP_HOOKS_OFF=1 lets the critique edit through', r.code === 0, `code=${r.code}`);

  // A plan-critic spawned with `name` runs as an agent-team teammate: the hooks
  // see its name as agent_type and its report goes out by SendMessage, so no
  // round is ever recorded. The spawn is refused while it can still be redone.
  const spawn = (dir, ti, extra = {}) => runHook('boundary-gate.mjs', { cwd: dir, tool_name: 'Agent', tool_input: { description: 'x', prompt: 'p', ...ti }, ...extra });
  r = spawn(d, { subagent_type: 'loop-engineering:plan-critic', model: 'fable', name: 'critic-item0-r2' });
  check('boundary-gate: a plan-critic spawned with `name` is refused and told to drop it',
    r.code === 2 && /plain subagent/.test(r.err) && /`name`/.test(r.err), `code=${r.code} err=${r.err.slice(0, 160)}`);
  r = spawn(d, { subagent_type: 'loop-engineering:plan-critic', name: 'c' }, { tool_name: 'Task' });
  check('boundary-gate: the Task spelling of the spawn tool is held the same way', r.code === 2, `code=${r.code}`);
  const allowed = [
    spawn(d, { subagent_type: 'loop-engineering:plan-critic', model: 'fable' }),
    spawn(d, { subagent_type: 'loop-engineering:plan-critic', name: '  ' }),
    spawn(d, { subagent_type: 'plan-critic', team_name: 'session-1' }),
    spawn(d, { subagent_type: 'loop-engineering:loop-verifier', name: 'verifier-1' }),
    spawn(d, { subagent_type: 'not-a-plan-critic-x', name: 'n' }),
    spawn(proj({}), { subagent_type: 'loop-engineering:plan-critic', name: 'n' }),
    runHook('boundary-gate.mjs', { cwd: d, tool_name: 'Agent', tool_input: { subagent_type: 'plan-critic', name: 'n' } }, { LOOP_HOOKS_OFF: '1' }),
  ];
  check('boundary-gate: a plain critic, a blank name, a team_name alone (deprecated, ignored), another agent type, a project without .loop/, or LOOP_HOOKS_OFF=1 → spawn allowed',
    allowed.every((x) => x.code === 0), allowed.map((x) => x.code).join(','));
  // The arbiter is held the same way: a named spawn runs as a teammate whose ruling the hook never sees.
  r = spawn(d, { subagent_type: 'loop-engineering:tenth-man-arbiter', model: 'fable', name: 'arbiter-1' });
  check('boundary-gate: a tenth-man-arbiter spawned with `name` is refused and told to drop it',
    r.code === 2 && /loop-engineering:tenth-man-arbiter as a plain subagent/.test(r.err) && /no ruling is recorded/.test(r.err), `code=${r.code} err=${r.err.slice(0, 200)}`);
  r = spawn(d, { subagent_type: 'tenth-man-arbiter', name: 'a' }, { tool_name: 'Task' });
  check('boundary-gate: the arbiter through the Task spelling is held the same way', r.code === 2, `code=${r.code}`);
  const arbAllowed = [
    spawn(d, { subagent_type: 'loop-engineering:tenth-man-arbiter', model: 'fable' }),
    spawn(d, { subagent_type: 'loop-engineering:tenth-man-arbiter', name: ' ' }),
    spawn(d, { subagent_type: 'not-a-tenth-man-arbiter-x', name: 'n' }),
    spawn(proj({}), { subagent_type: 'loop-engineering:tenth-man-arbiter', name: 'n' }),
    runHook('boundary-gate.mjs', { cwd: d, tool_name: 'Agent', tool_input: { subagent_type: 'tenth-man-arbiter', name: 'n' } }, { LOOP_HOOKS_OFF: '1' }),
  ];
  check('boundary-gate: a plain arbiter, a blank name, another agent type, a project without .loop/, or LOOP_HOOKS_OFF=1 → arbiter spawn allowed',
    arbAllowed.every((x) => x.code === 0), arbAllowed.map((x) => x.code).join(','));

  // The epic ledger of rulings is code-written: no hand edit, in any loop status.
  r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: join(d, '.loop', 'epics', 'demo', 'rulings', 'run-q.md') } });
  check('boundary-gate: an edit under .loop/epics/<slug>/rulings/ is blocked', r.code === 2 && /tenth-man ruling in the epic ledger/.test(r.err), `code=${r.code} err=${r.err.slice(0, 160)}`);
  for (const alias of ['.loop/epics/demo/rulings/new.md', './.loop/epics/demo/rulings/run-q.md', '.loop/epics/./demo/rulings/run-q.md',
    'src/../.loop/epics/demo/rulings/run-q.md', join(realpathSync(d), '.loop/epics/demo/rulings/run-q.md')]) {
    r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: alias } });
    check(`boundary-gate: the ledger alias ${alias.startsWith('/') ? '<realpath>/.loop/epics/demo/rulings/run-q.md' : alias} is blocked too`, r.code === 2, `code=${r.code}`);
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    r = runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: '.LOOP/Epics/Demo/Rulings/run-q.md' } });
    check('boundary-gate: a case-folded ledger alias is blocked on a case-insensitive file system', r.code === 2, `code=${r.code}`);
  }
  const ledgerAllowed = [
    runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: '.loop/epics/demo/backlog.md' } }),
    runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: '.loop/epics/demo/rulings-notes.md' } }),
    runHook('boundary-gate.mjs', { cwd: d, tool_input: { file_path: '.loop/epics/demo/rulings/x.md' } }, { LOOP_HOOKS_OFF: '1' }),
  ];
  check('boundary-gate: the epic backlog, a sibling name, or LOOP_HOOKS_OFF=1 → edit allowed',
    ledgerAllowed.every((x) => x.code === 0), ledgerAllowed.map((x) => x.code).join(','));
}

// ------------------------------------------------------------ hooks.json wiring
{
  const cfg = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'));
  const line = (h) => [h.command, ...(h.args ?? [])].join(' ');
  const scripts = (event) => (cfg.hooks[event] ?? []).flatMap((m) => m.hooks.map((h) => (line(h).match(/hooks\/([\w-]+\.mjs)/) ?? [])[1]));
  const all = Object.keys(cfg.hooks).flatMap(scripts);
  check('hooks.json: every command names a hook script that exists', all.length > 0 && all.every((f) => f && existsSync(join(HOOKS, f))), all.join(','));
  check('hooks.json: SubagentStart and SubagentStop run agent-track.mjs for every agent type',
    ['SubagentStart', 'SubagentStop'].every((e) => (cfg.hooks[e] ?? []).some((m) => m.matcher === '*' && m.hooks.some((h) => /hooks\/agent-track\.mjs"?$/.test(line(h))))),
    JSON.stringify({ start: cfg.hooks.SubagentStart, stop: cfg.hooks.SubagentStop }).slice(0, 200));
  check('hooks.json: PreToolUse runs boundary-gate.mjs on Agent and Task spawns',
    (cfg.hooks.PreToolUse ?? []).some((m) => m.matcher.split('|').includes('Agent') && m.matcher.split('|').includes('Task') && m.hooks.some((h) => /hooks\/boundary-gate\.mjs"?$/.test(line(h)))),
    JSON.stringify(cfg.hooks.PreToolUse ?? null).slice(0, 200));
  check('hooks.json: Stop runs run-gate.mjs', (cfg.hooks.Stop ?? []).some((m) => m.hooks.some((h) => /hooks\/run-gate\.mjs"?$/.test(line(h)))), '');
  check('hooks.json: PostToolUse runs agent-track.mjs on SubagentHandback',
    (cfg.hooks.PostToolUse ?? []).some((m) => m.matcher === 'SubagentHandback' && m.hooks.some((h) => /hooks\/agent-track\.mjs"?$/.test(line(h)))),
    JSON.stringify(cfg.hooks.PostToolUse ?? null).slice(0, 200));
  check('hooks.json: every hook is exec form — `node` + the script in args, no shell (Git Bash on Windows)',
    Object.values(cfg.hooks).flat().flatMap((m) => m.hooks).every((h) => h.command === 'node' && Array.isArray(h.args) && h.args.length === 1
      && /^\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.mjs$/.test(h.args[0]) && !('shell' in h)),
    JSON.stringify(Object.values(cfg.hooks).flat().flatMap((m) => m.hooks).find((h) => h.command !== 'node') ?? null));
  check('hooks.json: PreToolUse runs boundary-gate.mjs on the Bash tool (the Git Bash switch)',
    (cfg.hooks.PreToolUse ?? []).some((m) => m.matcher.split('|').includes('Bash') && m.hooks.some((h) => /hooks\/boundary-gate\.mjs"?$/.test(line(h)))), '');
}

// ------------------------------------------------- Git Bash switched off
{
  const bash = (d, env = {}) => runHook('boundary-gate.mjs', { cwd: d, tool_name: 'Bash', tool_input: { command: 'ls' } }, env);
  const d = proj({ state: { status: 'running', iteration: 1, history: [] } });
  let r = bash(d);
  check('git-bash: switch absent → the Bash tool passes (exit 0, silent)', r.code === 0 && r.err === '', r.err);
  writeFileSync(join(d, '.loop', 'config.json'), JSON.stringify({ shell: { gitBash: false } }));
  r = bash(d);
  check('git-bash: {"shell":{"gitBash":false}} → the Bash tool is refused (exit 2) naming the PowerShell tool and an absolute script path',
    r.code === 2 && /PowerShell tool/.test(r.err) && r.err.includes(join(HOOKS, '..', 'scripts')), r.err);
  const edit = runHook('boundary-gate.mjs', { cwd: d, tool_name: 'Edit', tool_input: { file_path: join(d, 'a.txt') } });
  check('git-bash: the switch leaves non-Bash tools alone', edit.code === 0, edit.err);
  const rem = runHook('loop-reminder.mjs', { cwd: d });
  check('git-bash: loop-reminder names the PowerShell route with the resolved scripts path',
    rem.code === 0 && /Git Bash is switched off/.test(rem.out) && rem.out.includes(join(HOOKS, '..', 'scripts')), rem.out.slice(0, 200));
  writeFileSync(join(d, '.loop', 'config.json'), JSON.stringify({ shell: { gitBash: true } }));
  r = bash(d);
  const quiet = runHook('loop-reminder.mjs', { cwd: d });
  check('git-bash: gitBash true → Bash passes and the reminder says nothing about it', r.code === 0 && !/Git Bash/.test(quiet.out), r.err + quiet.out);
  const bare = mkdtempSync(join(tmpdir(), 'loop-hook-test-'));
  cleanup.push(bare);
  r = bash(bare, { LOOP_GIT_BASH: 'off' });
  check('git-bash: LOOP_GIT_BASH=off refuses Bash even without .loop/', r.code === 2, r.err);
  r = bash(bare, { LOOP_GIT_BASH: 'off', LOOP_HOOKS_OFF: '1' });
  check('git-bash: LOOP_HOOKS_OFF=1 still bypasses', r.code === 0, r.err);
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log(failed === 0 ? '\nall hook checks passed' : `\n${failed} hook check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
