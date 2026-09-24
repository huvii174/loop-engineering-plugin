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

import { writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readStdinJson, hooksOff, runStanding, isPlainId } from './lib.mjs';

const MAX_NUDGES = 3;
const STALE_MS = 30 * 60 * 1000;
const MAX_SILENCES = 20;

/**
 * A subagent this session spawned is still running: agent-track keeps one file per
 * running subagent under `.loop/.agents-running/<session_id>/`, and one younger than
 * STALE_MS means the session ended its turn to wait on its own agent, not to stop.
 * No session id, or anything unreadable → false: silence is the exception that needs proof.
 */
function ownAgentRunning(cwd, session) {
  if (!isPlainId(session)) return false;
  const dir = join(cwd, '.loop', '.agents-running', session);
  try {
    const now = Date.now();
    return readdirSync(dir).some((f) => now - statSync(join(dir, f)).mtimeMs < STALE_MS);
  } catch {
    return false;
  }
}

const positionKey = ({ next, loop }) => `${next.id}:${loop ? `${loop.status}@${loop.iteration ?? 0}` : 'no-loop'}`;

/** Bump `field`'s counter for this position; the count after bumping, or `cap + 1` when it cannot be written. */
function bump(standing, field, cap) {
  const { run } = standing;
  const key = positionKey(standing);
  const prev = run.data[field] && run.data[field].key === key ? run.data[field].count : 0;
  const count = prev + 1;
  try {
    writeFileSync(run.path, JSON.stringify({ ...run.data, [field]: { key, count } }, null, 2) + '\n');
    run.data = { ...run.data, [field]: { key, count } };
    return count;
  } catch {
    return cap + 1;
  }
}

const nudge = (standing) => bump(standing, 'nudge', MAX_NUDGES);

function nextAction(next, loop) {
  const mine = loop && loop.backlog_item === next.id;
  if (mine && loop.status === 'running') {
    return `item ${next.id}'s loop is mid-flight (iteration ${loop.iteration ?? 0}/${loop.max_iterations ?? 12}) — ` +
      `run the breaker and take the next iteration`;
  }
  if (mine && loop.status === 'done') {
    return `item ${next.id}'s loop is done but its backlog row is not — run the close step ` +
      `(commands/loop.md "On every stop" step 3: loop-close.mjs writes done on a full APPROVE), ` +
      `then memory, then the next item's design gate`;
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
  // waiting on its own subagent is not a stop — but a marker nobody removes (a crashed agent, or one
  // written by hand) must not silence the gate for ever: past MAX_SILENCES at one position it nudges again
  if (ownAgentRunning(cwd, input.session_id) && bump(standing, 'silence', MAX_SILENCES) <= MAX_SILENCES) return 0;

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
