#!/usr/bin/env node
/**
 * Fixture tests for the three hooks. Run: node scripts/test-hooks.mjs
 * Spawns each hook as a real subprocess with stdin JSON and a temp project dir,
 * asserting on exit codes and output. Exits 0 when all pass. No dependencies.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
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

// ------------------------------------------------------------------- fail-open
{
  const corrupt = proj({});
  mkdirSync(join(corrupt, '.loop'), { recursive: true });
  writeFileSync(join(corrupt, '.loop', 'state.json'), '{not json');
  for (const s of ['boundary-gate.mjs', 'memory-gate.mjs', 'loop-reminder.mjs']) {
    const r = runHook(s, { cwd: corrupt, tool_input: { file_path: 'a.ts' } });
    check(`fail-open: corrupt state.json → ${s} allows`, r.code === 0, `code=${r.code}`);
  }
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log(failed === 0 ? '\nall hook checks passed' : `\n${failed} hook check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
