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
 *
 * On SubagentStop of a plan-critic it also records the critic's verdict through
 * loop-critique.mjs, from the agent's own last message — the one place the
 * tenth man's words reach disk without passing through the session whose design
 * they judge. A critic judging a worktree slice opens its output with
 * `Loop: <abs path>/.loop`; the record goes there when that directory holds a
 * state.json, and to this session's `.loop/` otherwise.
 */

import { mkdirSync, writeFileSync, unlinkSync, rmdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { readStdinJson, hooksOff, isPlainId } from './lib.mjs';
import { recordCritique, loopDirOf } from '../scripts/loop-critique.mjs';

/** `plan-critic`, `loop-engineering:plan-critic` — the namespace varies by install. */
function isPlanCritic(type) {
  return typeof type === 'string' && /(^|:)plan-critic$/.test(type);
}

/** The last assistant text in a subagent transcript (JSONL), for a payload without `last_assistant_message`. */
export function lastAssistantText(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return ''; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '';
    if (text.trim()) return text;
  }
  return '';
}

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
    if (isPlanCritic(input.agent_type)) {
      const text = input.last_assistant_message || lastAssistantText(input.agent_transcript_path);
      const named = loopDirOf(text);
      const target = named && isAbsolute(named) && basename(named) === '.loop' && existsSync(join(named, 'state.json'))
        ? named : join(cwd, '.loop');
      try { recordCritique(target, text, { source: 'hook', agentId: agent }); } catch { /* fail open */ }
    }
  }
}

main().catch(() => {}).finally(() => process.exit(0));
