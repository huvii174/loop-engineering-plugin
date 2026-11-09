#!/usr/bin/env node
/**
 * agent-track — SubagentStart / SubagentStop hook, plus PostToolUse on
 * SubagentHandback.
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
 * It also records each plan-critic's verdict, and each tenth-man-arbiter's
 * ruling, through loop-critique.mjs — the one place the tenth man's words reach
 * disk without passing through the session whose design they judge. A report
 * arrives by one of two routes:
 *
 *   - In auto mode (Claude Code ≥ 2.1.271) the critic delivers it by calling
 *     the `SubagentHandback` tool; its `message` is the report, and the stop
 *     payload's `last_assistant_message` is only the closing text, if any. The
 *     PostToolUse hook on that tool records `tool_input.message` and leaves a
 *     `<agent_id>.critique` marker beside the running-file, so the stop that
 *     follows records nothing a second time.
 *   - Otherwise the report is the critic's final text: `last_assistant_message`
 *     on SubagentStop, or, when that is absent, the last assistant text of the
 *     agent transcript. A `SubagentHandback` tool_use found in the transcript
 *     with no marker (the tool hook did not run) is recorded as the report.
 *
 * A critic judging a worktree slice opens its report with `Loop: <abs path>/.loop`;
 * the record goes there when that directory holds a state.json, and to this
 * session's `.loop/` otherwise.
 *
 * When this hook does not run at all (on Windows a Git Bash that fails to
 * start), `loop-critique.mjs recover` records the report from the same
 * transcript afterwards, as `source: transcript`.
 */

import { mkdirSync, writeFileSync, unlinkSync, rmdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { readStdinJson, hooksOff, isPlainId } from './lib.mjs';
import { HANDBACK_TOOL, isArbiter, isPlanCritic, loopDirOf, recordCritique, recordRuling, transcriptReport } from '../scripts/loop-critique.mjs';

/**
 * The two agents whose report this hook records, and how: the critic's as a
 * round (`r<N>.md`), the arbiter's as a ruling (`a<N>.md`, plus the epic
 * ledger copy under this session's cwd). Null for every other agent.
 */
function recorderFor(type) {
  if (isPlanCritic(type)) return { kind: 'critique', write: (target, text, agent) => recordCritique(target, text, { source: 'hook', agentId: agent }) };
  if (isArbiter(type)) return { kind: 'ruling', write: (target, text, agent, cwd) => recordRuling(target, text, { source: 'hook', agentId: agent, cwd }) };
  return null;
}

export { transcriptReport };

/**
 * Record `text` with `recorder`, in the `.loop/` its `Loop:` line names or this
 * session's. A ruling's epic ledger copy always lands under this session's cwd
 * — the dispatching tree when the arbiter judged a worktree slice.
 */
function recordVerdict(cwd, text, agent, recorder) {
  const named = loopDirOf(text);
  const target = named && isAbsolute(named) && basename(named) === '.loop' && existsSync(join(named, 'state.json'))
    ? named : join(cwd, '.loop');
  try { return recorder.write(target, text, agent, cwd); } catch { return { error: 'threw' }; }
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
  const recorder = recorderFor(input.agent_type);
  const marker = join(dir, `${agent}.${recorder?.kind ?? 'critique'}`);
  if (input.hook_event_name === 'SubagentStart') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, agent), '');
  } else if (input.hook_event_name === 'PostToolUse') {
    if (input.tool_name !== HANDBACK_TOOL || !recorder) return;
    const message = input.tool_input?.message;
    if (typeof message !== 'string' || !message.trim()) return;
    const r = recordVerdict(cwd, message, agent, recorder);
    if (r && !r.error) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(marker, r.file);
    }
  } else if (input.hook_event_name === 'SubagentStop') {
    try { unlinkSync(join(dir, agent)); } catch { /* already gone */ }
    const recorded = existsSync(marker);
    try { unlinkSync(marker); } catch { /* none */ }
    try { rmdirSync(dir); } catch { /* not empty, or gone */ }
    if (recorder && !recorded) {
      // A hand-back in the transcript is the report. Otherwise the stop payload's
      // final text is authoritative — the transcript may lag it.
      const report = transcriptReport(input.agent_transcript_path);
      recordVerdict(cwd, report.handback || input.last_assistant_message || report.closing, agent, recorder);
    }
  }
}

main().catch(() => {}).finally(() => process.exit(0));
