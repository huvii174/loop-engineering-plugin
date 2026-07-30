#!/usr/bin/env node
/**
 * boundary-gate — PreToolUse hook on Edit/Write/MultiEdit/NotebookEdit.
 *
 * While a loop is `running`, mechanically blocks edits to paths protected by a
 * `Do not touch:` line under `## Global boundaries` in .loop/goal.md. Upgrades
 * a Must-not boundary from verifier-caught (after the violation) to impossible
 * (before it). Deterministic glob match only; fail-open; LOOP_HOOKS_OFF=1 bypass.
 *
 * Boundary syntax in goal.md (backticks optional):
 *   ## Global boundaries
 *   - Do not touch: `src/legacy/**`
 */

import { join, relative, isAbsolute } from 'node:path';
import { readStdinJson, hooksOff, loadState, readIfExists, globToRegex, mdSection } from './lib.mjs';

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();

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

  const ti = input.tool_input || {};
  let target = ti.file_path || ti.notebook_path;
  if (!target) return 0;
  if (isAbsolute(target)) target = relative(cwd, target);
  target = target.split('\\').join('/');
  if (target.startsWith('..')) return 0; // outside the project — not ours to police

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
