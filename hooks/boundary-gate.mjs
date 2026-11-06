#!/usr/bin/env node
/**
 * boundary-gate — PreToolUse hook on Edit/Write/MultiEdit/NotebookEdit and Agent/Task.
 *
 * While a loop is `running`, mechanically blocks edits to paths protected by a
 * `Do not touch:` line under `## Global boundaries` in .loop/goal.md. Upgrades
 * a Must-not boundary from verifier-caught (after the violation) to impossible
 * (before it). Deterministic glob match only; fail-open; LOOP_HOOKS_OFF=1 bypass.
 *
 * Boundary syntax in goal.md (backticks optional):
 *   ## Global boundaries
 *   - Do not touch: `src/legacy/**`
 *
 * `.loop/critique/` is blocked in every loop status: the tenth man's verdicts
 * are written by agent-track and loop-critique.mjs, so an edit there is the
 * designer rewriting the review of its own design.
 *
 * On Agent/Task: with agent teams on, a plan-critic spawned with `name` runs as a
 * teammate, whose type the hooks see as its name and whose report travels by
 * SendMessage — agent-track records nothing, and the breaker refuses iteration 1
 * of a design the critic approved. Such a spawn is refused before it starts,
 * whether or not teams are on: the hook cannot see that setting reliably, and
 * the plain spawn costs one retry.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readStdinJson, hooksOff, loadState, readIfExists, globToRegex, mdSection } from './lib.mjs';
import { CRITIQUE_DIR } from '../scripts/loop-critique.mjs';

/** A path with symlinks resolved as far as it exists — the file itself may not yet. */
function real(p) {
  const rest = [];
  let at = p;
  while (!existsSync(at) && dirname(at) !== at) { rest.unshift(basename(at)); at = dirname(at); }
  try { return join(realpathSync(at), ...rest); } catch { return p; }
}

/**
 * The edit target relative to the project, or null when there is none or it
 * lies outside. Resolved, not string-sliced: `./.loop/x`, `src/../.loop/x` and
 * a symlinked tmp prefix all name the same file, and a check that reads them
 * as different paths is a check with a side door.
 */
function projectPath(cwd, ti) {
  const raw = ti.file_path || ti.notebook_path;
  if (!raw) return null;
  const target = relative(real(resolve(cwd)), real(resolve(cwd, String(raw).split('\\').join('/'))))
    .split('\\').join('/');
  if (!target || target.startsWith('..')) return null; // outside the project — not ours to police
  return target;
}

/** Case-insensitive file systems (macOS, Windows) let `.LOOP/` name `.loop/`. */
const foldCase = process.platform === 'darwin' || process.platform === 'win32';

/** `plan-critic`, `loop-engineering:plan-critic` — the namespace varies by install. */
const isPlanCritic = (type) => typeof type === 'string' && /(^|:)plan-critic$/.test(type);
/** `tenth-man-arbiter`, `loop-engineering:tenth-man-arbiter`. */
const isArbiter = (type) => typeof type === 'string' && /(^|:)tenth-man-arbiter$/.test(type);
const isSet = (v) => typeof v === 'string' && v.trim() !== '';

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();

  if (input.tool_name === 'Agent' || input.tool_name === 'Task') {
    const ti = input.tool_input || {};
    const who = isPlanCritic(ti.subagent_type) ? 'plan-critic' : isArbiter(ti.subagent_type) ? 'tenth-man-arbiter' : null;
    if (!existsSync(join(cwd, '.loop')) || !who) return 0;
    if (!isSet(ti.name)) return 0;
    process.stderr.write(
      `boundary-gate: spawn loop-engineering:${who} as a plain subagent — drop \`name\`. ` +
      `With agent teams on, a named spawn runs as a teammate: its report never reaches the agent-track hook, so no ` +
      `${who === 'plan-critic' ? 'tenth-man round' : 'ruling'} is recorded and the breaker refuses iteration 1. Keep subagent_type, ` +
      `model, description and prompt; everything else in the call is unchanged.\n`
    );
    return 2;
  }

  const target = projectPath(cwd, input.tool_input || {});

  const probe = target && foldCase ? target.toLowerCase() : target;
  if (probe && probe.startsWith(`.loop/${CRITIQUE_DIR}/`)) {
    process.stderr.write(
      `boundary-gate: "${target}" is a tenth-man record — written by the agent-track hook or ` +
      `scripts/loop-critique.mjs, never by hand. To answer a REVISE, revise the design and ` +
      `spawn loop-engineering:plan-critic again; its next round is recorded beside this one.\n`
    );
    return 2;
  }
  if (probe && /^\.loop\/epics\/[^/]+\/rulings\//.test(probe)) {
    process.stderr.write(
      `boundary-gate: "${target}" is a tenth-man ruling in the epic ledger — written by the agent-track hook or ` +
      `scripts/loop-critique.mjs, never by hand. The epic gate reads it with \`loop-critique.mjs deferred\`.\n`
    );
    return 2;
  }

  const state = loadState(cwd);
  if (!state || state.data.status !== 'running') return 0;

  const goal = readIfExists(join(cwd, '.loop', 'goal.md'));
  if (!goal) return 0;
  const section = mdSection(goal, 'Global boundaries');
  if (!section) return 0;

  const globs = [];
  for (const line of section.split('\n')) {
    const m = /do not touch:\s*`?([^`\n]+)`?/i.exec(line);
    if (m) globs.push(m[1].trim());
  }
  if (!globs.length) return 0;

  if (!target) return 0;

  for (const g of globs) {
    if (globToRegex(g).test(target)) {
      process.stderr.write(
        `boundary-gate: "${target}" is protected by a Global boundary in .loop/goal.md ` +
        `(Do not touch: ${g}). This edit is blocked while the loop is running. ` +
        `If the boundary is wrong, update .loop/goal.md deliberately (and record the ` +
        `decision) instead of working around it.\n`
      );
      return 2;
    }
  }
  return 0;
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
