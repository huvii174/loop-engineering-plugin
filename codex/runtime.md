# Codex runtime adapter

Read this before following a shared command, skill, or agent procedure. The
shared files define the workflow; this adapter translates their Claude host
syntax for Codex. Apply these translations to every subsequently loaded file
and include this adapter in delegated briefs.

## Paths and inputs

The installed plugin root is three directories above a Codex entry point at
`codex/skills/<name>/SKILL.md`. Resolve it from the supplied skill location,
including when installed in a cache. The target project root is the user's
workspace; keep all `.loop/` state there. Run helpers with the target project as
cwd and the helper's absolute installed path.

`$ARGUMENTS` means the user's arguments to the invoking skill, including flags
such as `--hands-off`. For `CLAUDE_PLUGIN_ROOT` in shared shell examples,
substitute the resolved absolute plugin root, properly shell-quoted. Codex
doesn't promise that variable to skill shell calls. Use Node.js 18 or newer
from the host environment.

## Workflow lookup

`Skill(skill: "loop-engineering:<name>")` means read the corresponding shared
`skills/<name>/SKILL.md` and follow it in the current task. Resolve its relative
references from that shared file's directory. Load references only on the
branch that needs them.

`/loop-engineering:<command>` means read `commands/<command>.md` and execute
that procedure with its arguments. User-facing equivalents are:

| Shared command | Codex entry point |
|---|---|
| `breakdown` | `$loop-engineering:loop-breakdown` |
| `design` | `$loop-engineering:loop-design` |
| `loop` | `$loop-engineering:loop` |
| `run` | `$loop-engineering:loop-run` |
| `status` | `$loop-engineering:loop-status` |
| `memory` | `$loop-engineering:loop-memory` |

The memory command and its contract are distinct: `$loop-engineering:loop-memory` executes
`commands/memory.md`; `$loop-engineering:loop-memory-contract` loads `skills/loop-memory/SKILL.md`.

## Delegation and tools

`Agent(...)` means use Codex's available subagent tool. For a named
`loop-engineering:<role>`, read `agents/<role>.md` and include its body, this
adapter, and the composed Template N brief in a fresh-context task. For
`general-purpose`, supply the composed brief and this adapter. Agent Markdown
frontmatter describes the role; it is not a Codex agent registration.

Use `fork_turns: "none"` when the tool exposes that option, or its equivalent
for a fresh-context task. Give each reviewer the absolute project and plugin
roots, exact criteria, file paths, output contract, and read-only restriction.
Preserve the verifier's scratch-probe exception in system temp. Await every
required verdict before proceeding. Schedule parallel reviewers only where
the host supports them; a concurrency limit may serialize fresh reviewers.

Keep the host's configured model. Shared `sonnet`, `haiku`, and `inherit`
labels express Claude routing and are not Codex model IDs. Use available
shell/file tools for `Bash`, `Read`, `Grep`, `Glob`, `Edit`, and `Write`.
`AskUserQuestion` means an available Codex question tool where it supports the
needed question; otherwise ask in the conversation and wait for the answer.

**The implementer never grades itself.** If fresh-context delegation is
unavailable, report the unavailable gate and keep it pending. Design interviews,
status, and memory maintenance can still run; implementation cannot claim
`APPROVE`, finish a review gate, or mark a goal done without the required
independent verdict. Ask the user to enable subagents or arrange an independent
review; do not substitute self-review.

## Host memory

Read the target project's `AGENTS.md` and applicable scoped instructions. Shared
instructions to promote learnings into host `CLAUDE.md` mean the project's
`AGENTS.md` in Codex, through the same promotion gate. Merge into an established
host memory system where present. Claude-specific settings and `.claude/rules/`
are context files only, not Codex configuration.

## Gates without lifecycle hooks

The Codex manifest explicitly disables lifecycle-hook discovery. The Claude
hook payloads and stop blocking are not part of this adapter. Apply these checks
inside an invoked workflow:

- Recall memory before work per `skills/loop-memory/SKILL.md`; account for every
  opened entry in `Recall:`. Reconcile an existing `.loop/.recall-log` if present;
  its absence means no hook-injected entries, not a skipped recall step.
- Before editing during a running loop, check `Do not touch:` boundaries in
  `.loop/goal.md`. This is a workflow check, not mechanical write blocking.
- Run `scripts/loop-breaker.mjs` before each iteration. Exit 2 stops the loop;
  exit 1 requires repairing/reporting invalid state before further iteration.
- Record history only with `scripts/loop-record.mjs`. Retain the close and epic
  gates enforced by `scripts/loop-close.mjs` and `scripts/loop-archive.mjs`.
- At a terminal loop state, execute the memory command and its lint before
  ending. For an epic runner, continue through dependency order until completion
  or a documented stop; reload `.loop/run.json` when resuming a new session.

Ambient recall, session-start reminders, subagent tracking, and stop-hook
continuity outside an invoked workflow are unavailable in this Codex package.
