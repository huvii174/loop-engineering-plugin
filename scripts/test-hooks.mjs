#!/usr/bin/env node
/**
 * Fixture tests for the three hooks. Run: node scripts/test-hooks.mjs
 * Spawns each hook as a real subprocess with stdin JSON and a temp project dir,
 * asserting on exit codes and output. Exits 0 when all pass. No dependencies.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readdirSync } from 'node:fs';
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
