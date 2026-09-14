#!/usr/bin/env node
/**
 * memory-gate — Stop hook.
 *
 * "Every run must leave the system smarter than it found it" — enforced, not
 * hoped for. When the session tries to stop with the loop in a TERMINAL state
 * (done / stuck / stopped-*), block once and say why if any of these hold:
 *   - memory untouched since that state was written (the compounding step never ran)
 *   - undistilled scratch entries
 *   - the recall log has entries the iteration record never accounted for
 *   - `scripts/memory-lint.mjs` reports a blocking finding (reach, budget, schema)
 * Deterministic checks only (mtime + string match); fail-open; stop_hook_active
 * prevents infinite re-blocking; LOOP_HOOKS_OFF=1 bypass.
 *
 * The budget half of the lint is on the INDEX, never the store: bodies are read
 * only when their trigger fires, so a store may grow without bound while what
 * every run reads must not. Counting entries would gate the wrong thing — a
 * long-lived project is supposed to accumulate entries. The reach half is why
 * the lint exists at all: a body with no trigger and no cluster map costs
 * nothing to read and can never be found, which is worse than over budget.
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
 * compounding, not the quality of what gets written. A `Recall:` line can be
 * present and shallow; checking that each ID was judged well is the
 * loop-verifier's job, not a string match's.
 */

import { join } from 'node:path';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { readStdinJson, hooksOff, loadState, readIfExists, newestMtime, mdSection, readTail } from './lib.mjs';
import { lint } from '../scripts/memory-lint.mjs';

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

/**
 * Live (non-placeholder) list items in a scratch body. HTML comment blocks are
 * skipped: the migrated scratch/run.md template carries an example line inside
 * one, and counting it as live scratch would block every terminal stop forever.
 */
function liveScratchLines(text) {
  if (!text) return [];
  const out = [];
  let inComment = false;
  for (const raw of text.split('\n')) {
    if (inComment) { inComment = !raw.includes('-->'); continue; }
    if (/^\s*<!--/.test(raw)) { inComment = !raw.includes('-->'); continue; }
    const t = raw.trim();
    if (t.startsWith('- ') && !/^-\s*(raw note.*deleted at end of run|\(.*\))\s*$/i.test(t)) out.push(t);
  }
  return out;
}

/** Undistilled scratch, in both the tree layout and the legacy learnings.md section. */
function scratchReason(memDir) {
  let live = liveScratchLines(readIfExists(join(memDir, 'scratch', 'run.md')));
  if (!live.length) {
    const learnings = readIfExists(join(memDir, 'learnings.md'));
    if (learnings) live = liveScratchLines(mdSection(learnings, 'Scratch \\(this run\\)') || '');
  }
  if (!live.length) return null;
  return `${live.length} scratch entr${live.length === 1 ? 'y is' : 'ies are'} not distilled (scratch must be empty at run end)`;
}

/**
 * Blocking findings from the store lint — budget, reachability, schema.
 *
 * Delegated rather than restated: `scripts/memory-lint.mjs` is the one place
 * these rules live, and it is runnable by hand during a maintenance pass. The
 * gate only decides that a blocking finding stops a terminal stop.
 *
 * Warn-level findings are deliberately not carried here. A stop gate that
 * reports everything trains the reader to skim it.
 */
function lintReasons(memDir) {
  try {
    return lint(memDir).filter((f) => f.level === 'block').map((f) => f.message);
  } catch {
    return []; // fail-open, like every other check in this hook
  }
}

/** Newest iteration record, or null. */
function newestIteration(cwd) {
  const dir = join(cwd, '.loop', 'iterations');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return null; }
  if (!files.length) return null;
  return readIfExists(join(dir, files[files.length - 1]));
}

/** Recall was injected but the run's record never says what became of it. */
function recallReason(cwd) {
  const log = readIfExists(join(cwd, '.loop', '.recall-log'));
  if (!log || !log.trim()) return null;
  const record = newestIteration(cwd);
  if (record === null) return null; // no iteration record to carry the line
  if (/^\s*[-*]?\s*\*{0,2}Recall\*{0,2}\s*:/im.test(record)) return null;
  return (
    `.loop/.recall-log holds unaccounted recall injections but the newest iteration record ` +
    `has no \`Recall:\` line — account for each ID as applied or dismissed-with-reason, ` +
    `then empty the log (it is an inbox; a leftover line may be from an earlier session, ` +
    `which is still an injection nobody judged)`
  );
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
    const memDir = join(cwd, '.loop', 'memory');
    if (newestMtime(memDir) + MTIME_TOLERANCE_MS < state.mtime) {
      reasons.push(
        `the loop reached status "${state.data.status}" but nothing under .loop/memory/ ` +
        `was written afterwards — the compounding step did not run`
      );
    }
    const scratch = scratchReason(memDir);
    if (scratch) reasons.push(scratch);
    const recall = recallReason(cwd);
    if (recall) reasons.push(recall);
    reasons.push(...lintReasons(memDir));
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
