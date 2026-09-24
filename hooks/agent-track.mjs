#!/usr/bin/env node
/**
 * agent-track — SubagentStart / SubagentStop hook.
 *
 * run-gate blocks a stop while an epic run is open, and a session that spawned
 * a background verifier or reviewer ends its turn to wait — which the gate read
 * as a premature stop and nudged toward its cap, burning the bound on a runner
 * that was working. This hook keeps one empty file per running subagent,
 * `.loop/.agents-running/<session_id>/<agent_id>` (mtime = start), so run-gate
 * can tell "waiting on my own agent" from "stopped".
 *
 * One file per agent, created on start and unlinked on stop: no shared file is
 * read, modified and written back, so parallel fan-outs cannot lose a stop. A
 * payload without `session_id` or `agent_id`, or with a segment that is not a
 * plain id, records nothing. Always exits 0 — it must never stand between the
 * session and its agents. Deterministic; fail-open; LOOP_HOOKS_OFF=1 bypass.
 */

import { mkdirSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdinJson, hooksOff, isPlainId } from './lib.mjs';

async function main() {
  if (hooksOff()) return;
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();
  if (!existsSync(join(cwd, '.loop'))) return;
  const session = input.session_id;
  const agent = input.agent_id;
  if (!isPlainId(session) || !isPlainId(agent)) return;
  const dir = join(cwd, '.loop', '.agents-running', session);
  if (input.hook_event_name === 'SubagentStart') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, agent), '');
  } else if (input.hook_event_name === 'SubagentStop') {
    try { unlinkSync(join(dir, agent)); } catch { /* already gone */ }
    try { rmdirSync(dir); } catch { /* not empty, or gone */ }
  }
}

main().catch(() => {}).finally(() => process.exit(0));
