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
 * Ad-hoc branch (no loop involved): when the project has adopted loop memory
 * (.loop/memory/ exists), the session edited files while working through
 * errors (transcript scan: >=1 file-edit tool use AND >=2 error-pattern hits),
 * and nothing under .loop/memory/ was touched since the session started —
 * nudge once: append a one-liner to .loop/memory/scratch/adhoc.md or state
 * that nothing is worth capturing. Distillation stays model-invoked
 * (/loop-engineering:memory); this gate only protects the capture habit.
 *
 * Honest limitation (same as ECC's delivery-gate): this enforces the HABIT of
 * compounding, not the quality of what gets written. The transcript scan is a
 * string heuristic — "error" in read file content counts — acceptable because
 * the nudge fires at most once per session and only when files were edited.
 */

import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readStdinJson, hooksOff, loadState, readIfExists, newestMtime, mdSection, readTail } from './lib.mjs';

const TERMINAL = new Set(['done', 'stuck', 'stopped-max-iterations', 'stopped-user']);
const MTIME_TOLERANCE_MS = 2000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const MIN_ERROR_HITS = 2;

/** True when this session did real ad-hoc work but captured nothing. */
function adhocNudgeDue(cwd, input) {
  const memDir = join(cwd, '.loop', 'memory');
  if (!existsSync(memDir)) return false; // memory not adopted here → stay silent
  const tp = input.transcript_path;
  if (!tp) return false;
  let sessionStart = 0;
  try { sessionStart = statSync(tp).birthtimeMs || 0; } catch { return false; }
  if (!sessionStart) return false; // platform without birthtime → fail-open

  const raw = readTail(tp, TRANSCRIPT_TAIL_BYTES);
  if (!raw) return false;
  const edits = (raw.match(/"name":\s*"(Edit|Write|MultiEdit|NotebookEdit)"/g) || []).length;
  if (!edits) return false; // read-only session — nothing to capture
  const errorHits = (raw.match(/\b(error|failed|exception|traceback)\b/gi) || []).length;
  if (errorHits < MIN_ERROR_HITS) return false; // no debug journey — skip

  // Anything written under .loop/memory/ during this session counts as captured.
  return newestMtime(memDir) + MTIME_TOLERANCE_MS < sessionStart;
}

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  if (input.stop_hook_active) return 0; // already blocked once — let it through
  const cwd = input.cwd || process.cwd();

  const state = loadState(cwd);

  // A running loop (paused mid-iteration) is loop territory — its own memory
  // step handles capture; never gate a pause.
  if (state && state.data.status === 'running') return 0;

  // Loop branch: a terminal loop must have compounded its knowledge.
  const reasons = [];
  if (state && TERMINAL.has(state.data.status)) {
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
  }

  // Ad-hoc branch: the loop owes nothing (no state, or long-closed and clean) —
  // but this session may have done real work outside any loop.
  if (!reasons.length) {
    if (!adhocNudgeDue(cwd, input)) return 0;
    process.stderr.write(
      `memory-gate (ad-hoc): this session edited files while working through errors, ` +
      `but nothing under .loop/memory/ was captured.\n` +
      `If something was learned worth keeping, append ONE line to ` +
      `.loop/memory/scratch/adhoc.md (create it if missing):\n` +
      `  - [adhoc][<area>] <fact> — <why> (${new Date().toISOString().slice(0, 10)})\n` +
      `It will be distilled by the next /loop-engineering:memory run. ` +
      `If nothing is worth capturing, say so and finish — this nudge fires only once per session.\n`
    );
    return 2;
  }

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
