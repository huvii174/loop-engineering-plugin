#!/usr/bin/env node
/**
 * run-gate — Stop hook.
 *
 * `/loop-engineering:run` promised "this is the last question until something
 * stops", and kept the promise only in prose: nothing on disk knew a run was
 * open, the memory-gate deliberately waved a `running` pause through, and the
 * loop's own close step told the model to name the next item for the user.
 * A short epic fit inside one turn's attention; a long one ended at the first
 * natural place to summarise, and the user typed "continue" until it closed.
 *
 * This gate holds the session open while `.loop/run.json` (written at go/no-go)
 * names an item the backlog still shows as not `done`. The standing it blocks
 * on — and every legitimate stop that silences it — is `runStanding` in
 * lib.mjs, shared with loop-reminder. On top of that standing this file adds
 * one bound: the same position nudged MAX_NUDGES times with no progress lets
 * the stop through (a gate with no cap is a loop with no breaker), and a
 * counter it cannot persist counts as spent — a gate that cannot record its
 * own bound has no bound, so it releases rather than pins.
 *
 * `stop_hook_active` is deliberately NOT honoured: the point is to re-block on
 * every premature stop, and the nudge counter is the cap instead. This is also
 * why memory-gate answers "may the session pause mid-iteration?" differently
 * (yes, never gate a pause): under an open run a pause nobody asked for is the
 * defect. Deterministic checks only; fail-open; LOOP_HOOKS_OFF=1 bypass.
 */

import { writeFileSync } from 'node:fs';
import { readStdinJson, hooksOff, runStanding } from './lib.mjs';

const MAX_NUDGES = 3;

/** Bump the nudge counter for this position; the count after bumping, or past the cap when it cannot be written. */
function nudge({ run, next, loop }) {
  const key = `${next.id}:${loop ? `${loop.status}@${loop.iteration ?? 0}` : 'no-loop'}`;
  const prev = run.data.nudge && run.data.nudge.key === key ? run.data.nudge.count : 0;
  const count = prev + 1;
  try {
    writeFileSync(run.path, JSON.stringify({ ...run.data, nudge: { key, count } }, null, 2) + '\n');
    return count;
  } catch {
    return MAX_NUDGES + 1;
  }
}

function nextAction(next, loop) {
  const mine = loop && loop.backlog_item === next.id;
  if (mine && loop.status === 'running') {
    return `item ${next.id}'s loop is mid-flight (iteration ${loop.iteration ?? 0}/${loop.max_iterations ?? 12}) — ` +
      `run the breaker and take the next iteration`;
  }
  if (mine && loop.status === 'done') {
    return `item ${next.id}'s loop is done but its backlog row is not — finish the loop's close step ` +
      `(memory, epic bookkeeping, row → done), then start the next item's design gate`;
  }
  if (mine && loop.status === 'designed') {
    return `item ${next.id} is designed — run its loop (/loop-engineering:loop flow, breaker first)`;
  }
  return `start item ${next.id}'s design gate (execution step 1 of /loop-engineering:run), then its loop`;
}

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();

  const standing = runStanding(cwd);
  if (!standing) return 0;

  const { run, order, done, next, loop } = standing;
  const count = nudge(standing);
  const slug = run.data.epic;
  const resume = `/loop-engineering:run ${slug}${run.data.hands_off ? ' --hands-off' : ''}`;

  if (count > MAX_NUDGES) {
    process.stderr.write(
      `run-gate: epic run "${slug}" was nudged ${MAX_NUDGES} times at the same position ` +
      `(item ${next.id}${loop ? `, loop ${loop.status} at iteration ${loop.iteration ?? 0}` : ''}) ` +
      `with no progress — letting the session stop. Tell the user the runner is halted here and why; ` +
      `resume with ${resume}.\n`
    );
    return 0;
  }

  process.stderr.write(
    `run-gate: epic run "${slug}" (${run.data.hands_off ? 'hands-off' : 'interactive'}) is still open — ` +
    `${done.length} of ${order.length} items done; next is item ${next.id}` +
    `${next.title ? `: "${next.title.slice(0, 120)}"` : ''}. Continue the runner: ${nextAction(next, loop)}. ` +
    `If the user asked to stop, delete .loop/run.json and stop instead — that is the cancel. ` +
    `Otherwise the run stops only on a stuck item, a human-gated item, or a spent budget. ` +
    `Nudge ${count}/${MAX_NUDGES} at this position.\n`
  );
  return 2;
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
