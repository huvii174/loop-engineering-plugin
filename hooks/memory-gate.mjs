#!/usr/bin/env node
/**
 * memory-gate — Stop hook.
 *
 * "Every run must leave the system smarter than it found it" — enforced, not
 * hoped for. When the session tries to stop with the loop in a TERMINAL state
 * (done / stuck / stopped-*) but memory untouched since that state was written,
 * or with undistilled `## Scratch (this run)` entries, block the stop once and
 * say why. Deterministic checks only (mtime + string match); fail-open;
 * stop_hook_active prevents infinite re-blocking; LOOP_HOOKS_OFF=1 bypass.
 *
 * Honest limitation (same as ECC's delivery-gate): this enforces the HABIT of
 * compounding, not the quality of what gets written.
 */

import { join } from 'node:path';
import { readStdinJson, hooksOff, loadState, readIfExists, newestMtime, mdSection } from './lib.mjs';

const TERMINAL = new Set(['done', 'stuck', 'stopped-max-iterations', 'stopped-user']);
const MTIME_TOLERANCE_MS = 2000;

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  if (input.stop_hook_active) return 0; // already blocked once — let it through
  const cwd = input.cwd || process.cwd();

  const state = loadState(cwd);
  if (!state || !TERMINAL.has(state.data.status)) return 0;

  const reasons = [];

  const memNewest = newestMtime(join(cwd, '.loop', 'memory'));
  if (memNewest + MTIME_TOLERANCE_MS < state.mtime) {
    reasons.push(
      `the loop reached status "${state.data.status}" but nothing under .loop/memory/ ` +
      `was written afterwards — the compounding step did not run`
    );
  }

  const learnings = readIfExists(join(cwd, '.loop', 'memory', 'learnings.md'));
  if (learnings) {
    const scratch = mdSection(learnings, 'Scratch \\(this run\\)');
    if (scratch) {
      const live = scratch.split('\n').filter((l) => {
        const t = l.trim();
        return t.startsWith('- ') && !/^-\s*(raw note.*deleted at end of run|\(.*\))\s*$/i.test(t);
      });
      if (live.length) {
        reasons.push(`${live.length} scratch entr${live.length === 1 ? 'y' : 'ies'} in learnings.md are not distilled (scratch must be empty at run end)`);
      }
    }
  }

  if (!reasons.length) return 0;

  process.stderr.write(
    `memory-gate: the loop stopped but its knowledge was not compounded:\n` +
    reasons.map((r) => `  - ${r}`).join('\n') + '\n' +
    `Run the memory step now (Steps 1-6 of /loop-engineering:memory — load ` +
    `Skill "loop-engineering:loop-memory"): distil scratch, write learnings/solutions, ` +
    `update the epic rollup, then finish. This gate blocks only once.\n`
  );
  return 2;
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
