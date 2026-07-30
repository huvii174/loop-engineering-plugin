#!/usr/bin/env node
/**
 * loop-reminder — SessionStart hook.
 *
 * If this project has an open loop (running or stuck), print one line of
 * context so a new session cannot forget it exists. Never blocks; fail-open;
 * LOOP_HOOKS_OFF=1 bypass.
 */

import { readStdinJson, hooksOff, loadState } from './lib.mjs';

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();

  const state = loadState(cwd);
  if (!state) return 0;
  const { status, iteration = 0, max_iterations = 12, history = [], tier } = state.data;
  if (status !== 'running' && status !== 'stuck') return 0;

  const last = history[history.length - 1];
  const lastLine = last ? ` Last: iter ${last.n} "${last.intent ?? last.approach ?? ''}" → ${last.verdict}.` : '';
  process.stdout.write(
    `[loop-engineering] Open loop in this project: status=${status}, ` +
    `iteration ${iteration}/${max_iterations}${tier ? `, tier ${tier}` : ''}.${lastLine} ` +
    `Resume with /loop-engineering:loop (state: .loop/state.json — read it before doing loop work; never redo completed iterations).\n`
  );
  return 0;
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
