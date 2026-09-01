#!/usr/bin/env node
/**
 * Fixture tests for the three hooks. Run: node scripts/test-hooks.mjs
 * Spawns each hook as a real subprocess with stdin JSON and a temp project dir,
 * asserting on exit codes and output. Exits 0 when all pass. No dependencies.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

function runHook(script, stdinObj, env = {}) {
  const r = spawnSync('node', [join(HOOKS, script)], {
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
    env: { ...process.env, LOOP_HOOKS_OFF: '', ...env },
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

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log(failed === 0 ? '\nall hook checks passed' : `\n${failed} hook check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
