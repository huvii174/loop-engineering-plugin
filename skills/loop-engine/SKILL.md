---
name: loop-engine
description: State contract and mechanics of the goal-based engineering loop — .loop/ directory layout, iteration record format, stop conditions, resumability. Load when running /loop-engineering:loop or reading/writing .loop/ state.
---

# Loop Engine — Goal-based Loop Contract

A goal-based loop iterates toward a **verifiable goal** instead of a fixed step
count: each pass plans one increment, acts, verifies against the goal's success
criteria, records state, and repeats. The loop, not a human, decides "not done
yet" — but only inside explicit, bounded stop conditions.

## .loop/ directory (lives in the host project root)

```
.loop/
  active-epic        # (epics only) one line: the slug design/loop operate on
  epics/<slug>/      # (epics only) one instance dir PER epic — never shared
    epic.md          #   epic statement + acceptance criteria
    backlog.md       #   ordered sub-goals + status
  prompt.md          # compiled, signed-off form of the ask (design gate output)
  goal.md            # ACTIVE goal + verifiable success criteria (design gate output)
  design.md          # architecture + ordered work breakdown (design gate output)
  state.json         # machine state — single source of truth for loop position
  iterations/
    0001.md          # one record per iteration (append-only)
    0002.md
  archive/
    <run_id>/        # finished goal runs (archived by the design gate)
    epics/<slug>/    # closed epic instances (archived when the retro is written)
  .recall-log        # IDs auto-recall injected — what the `Recall:` line answers to
  parallel.json      # worktree slices, when a run fans out (absent otherwise)
  memory/            # index + body; see loop-memory skill
    learnings/_index.md    # triggers — the half read by default
    learnings/<type>.md    # bodies, uncapped, reached by `### L-NNN` anchor
    decisions/_index.md    # + <epic>/item-N.md, durable.md
    solutions/<slug>.md
    epics/<slug>.md  # per-epic knowledge rollup — NEVER archived; outlives the instance
    scratch/         # run.md + adhoc.md — empty at every run end
```

Add `.loop/` to the host `.gitignore` only if the user asks; by default it is
committed so loop history travels with the repo. `.recall-log` is the exception
worth ignoring on its own: it is per-session churn, and the durable record of
what memory changed is the `Recall:` line in the iteration record.

**`memory/` is the half that must be tracked either way**, because the
maintenance contract permits Delete on the strength of "git history is the
archive" — a sentence that is only true of a tracked file. When a project does
ignore run state, git cannot un-ignore a child of an ignored directory, so the
pattern is `.loop/*` + `!.loop/memory/` + `.loop/memory/scratch/`, never
`.loop/`. `loop-reminder` says so at session start when it finds the store
ignored.

## Parallel slices — `.loop/parallel.json`

One `.loop/` tracks one active goal, so parallel sub-goals run in separate git
worktrees with a `.loop/` each. **The moment a run fans out, the dispatching
`.loop/` writes the manifest** — it is the only record of where those worktrees
are, and a session that dies mid-flight (a usage limit, a crash) takes the
knowledge with it otherwise:

```json
{
  "slices": [
    {"id": "pmA4", "worktree": "../hiops-wt-pmA4", "branch": "feat/pmA4-migrate-rows",
     "brief": "<path to the brief the slice was dispatched with>",
     "agent_prefix": "critic-a4", "started": "2026-08-18"}
  ]
}
```

Each slice's own `state.json` holds its position; the manifest holds only where
to look. `/loop-engineering:status` renders it, which makes resume a read rather
than a reconstruction. Two rules travel with a fan-out: **name every subagent
with its slice prefix and never reuse a name** (a fresh name is a fresh context,
which is the point of a critic or verifier), and never address an agent across
prefixes. Delete a slice's entry when its worktree merges.

**`archive/` is frozen.** A run or epic moved there is a historical snapshot:
never edit it, never update it to match today's code, and never cite it as
authority for current behavior. Knowledge that must stay current belongs in
`memory/` before the archive happens — that is what the memory step at every
stop is for. Reading an archived run to understand what a past run believed is
fine; treating what it believed as true today is the failure the freeze
prevents.

## state.json schema

```json
{
  "status": "designed | running | done | stuck | stopped-max-iterations | stopped-user",
  "run_id": "run-2026-07-29",
  "epic": "your-epic-slug",
  "tier": "small",
  "iteration": 3,
  "max_iterations": 12,
  "confidence_at_design": 96,
  "assumptions": [],
  "confidence_note": "post plan-critic, 7 findings applied",
  "created": "2026-07-29",
  "updated": "2026-07-29",
  "breaker_thresholds": { "stagnation": 3, "frustration": 3, "noProgress": 5, "plateau": 4, "similarity": 0.85 },
  "breaker_reset_at_iteration": 0,
  "record_contract_since": 1,
  "history": [
    {"n": 1, "intent": "scaffold API route", "approach": "minimal Express route + fixture test",
     "verdict": "pass", "kind": "criterion", "error_signature": null,
     "criterion": "GET /api/x returns 200", "criteria_passed": 1},
    {"n": 2, "intent": "add validation", "approach": "zod schema at route boundary",
     "verdict": "fail", "kind": "criterion", "error_signature": "ZodError: expected string, received number",
     "criterion": "POST /api/x rejects bad payloads", "criteria_passed": 1},
    {"n": 3, "intent": "fix schema mismatch", "approach": "coerce numeric ids in schema",
     "verdict": "pass", "kind": "criterion", "error_signature": null,
     "criterion": "POST /api/x rejects bad payloads", "criteria_passed": 2}
  ]
}
```

**`scripts/loop-record.mjs` is the only writer of `history`.** It refuses a
verdict outside the enum, a record missing `Verdict:` / `Evidence:` / `Recall:`,
an `iteration` that disagrees with `history`, and any `.recall-log` ID the
record never accounts for — then empties that inbox last, so a crash between the
two leaves the IDs to be answered again rather than lost.

`confidence_at_design` is the **number** the design gate closed at (min across
dimensions). Under 95 it must be paired with `assumptions` — the numbered
assumptions standing in for the answers the interview never got — or the breaker
refuses to start the run. Prose belongs in `confidence_note`.

`record_contract_since` is the iteration from which the recorder owned this file.
The breaker coerces older free-text verdicts with a warning naming each, and
refuses anything at or after it that still misses the enum.

`epic` is present only on an epic-driven run (the design gate writes it from
`active-epic`); it is how `loop-archive.mjs prune` knows an archived run's epic
is itself already archived and retires the run with it.

`breaker_thresholds` holds **thresholds, never counters** — the breaker recomputes
counters from `history` on every run, so there is nothing there to reset. Writing
zeros to mean "counters cleared" makes every `counter >= threshold` compare true
and stops a brand-new run on its first check; the breaker now refuses any
non-positive value in favour of the default and says so on stderr. To clear
counters, set `breaker_reset_at_iteration`. The former spelling `breaker` is
still read; setting both warns and prefers `breaker_thresholds`.

`criteria_passed` = how many success criteria are verifier-APPROVED after this
iteration. It is what lets the breaker see a **plateau** (verdicts keep passing
while this number stays flat: busy, not progressing), a death that failure
counters structurally cannot detect.

`kind` says what the iteration aimed at, and only the plateau counter reads it:

| `kind` | The iteration | Plateau |
|---|---|---|
| `criterion` | aimed at a success criterion | counted |
| `review-fix` | closed a review-gate finding | stepped over |
| `bookkeeping` | records, archives, memory | stepped over |

While review-gate fixes run, the criteria count is flat by construction. Counting
that as a plateau punishes the thorough gate and rewards the shallow one — a real
run tripped `STOP (plateau)` at the close of a goal whose every criterion was
already verifier-approved. The failure chain ignores `kind` entirely: a
review-fix that fails is a failure like any other.

The breaker is evaluated from `history` alone — `approach` and `error_signature`
exist precisely so it and the "already tried" injection never re-read an
iteration record.

**Verdict mapping** (the verifier speaks a three-way vocabulary; records store
it as): `APPROVE → pass` · `REJECT → fail` · `ESCALATE_HUMAN → escalate`.
A mixed verdict maps to its **worse** half: a verifier that approved four
criteria and rejected one is `fail`, because the rejected criterion is what the
next iteration owes. `escalate` entries stop the loop but are **excluded** from
stagnation / frustration / no-progress counting — an unverifiable attempt is not
a failed approach.

## Iteration record format (`iterations/NNNN.md`)

```markdown
# Iteration NNNN — <one-line intent>
- **Goal criterion targeted:** <which success criterion this advances>
- **Injected:** <what shaped this iteration's context: memory entries recalled
  (by tag/slug), the "already tried" block, any breaker ADVISORY carried in,
  the compiled brief — or "none">
- **Recall:** <every ID in .loop/.recall-log, each `applied (what it changed)` or
  `dismissed (why it does not apply here)` — or "none injected">
- **Actions:** <what was done, files touched>
- **Delegated:** <agent> — <task> — <outcome>   (or "none")
- **Verification:** <exact command(s) the verifier ran>
- **Evidence:** <trimmed command output proving the verdict>
- **Verdict:** pass | fail | escalate — <reason>
- **Learning:** <one line for memory, or "none">
- **Next:** <what the next iteration should do>
```

`loop-record.mjs` refuses a record missing **`Goal criterion targeted`,
`Injected`, `Recall`, `Actions`, `Verification`, `Evidence` or `Verdict`** —
the seven a later reader cannot reconstruct from `state.json`. `Delegated`,
`Learning` and `Next` are narrative: requiring them turns a record into a form.
It also refuses a `--criterion` that the record's own criterion line does not
name, because state counting one criterion while the record grades another is a
mismatch nothing downstream can see.

## Iteration discipline

- One iteration = one small increment with its own verification. If an increment
  can't be verified on its own, it's too big — split it.
- **Maker/checker split**: the implementer never grades itself. After acting,
  delegate the verdict to the `loop-engineering:loop-verifier` agent — invoked
  as `Agent(subagent_type: "loop-engineering:loop-verifier", ...)` — (fresh
  context, reject-by-default, three-way verdict `APPROVE | REJECT | ESCALATE_HUMAN`).
  The verifier runs the verification commands itself — the implementer's claim
  that tests passed is not evidence.
- Verification is evidence-based: command output, test results, build status.
  "Looks correct" is not a verdict. Success criteria must be deterministic and
  measurable (tests passing, a score threshold, a count reaching zero) — the
  design gate is responsible for producing them in that form.
- A **fail (REJECT) verdict is normal** and does not stop the loop; it becomes
  the next iteration's intent — with a *different* approach.
- **Context-visible ⟺ recorded.** Anything that reached the model and shaped
  this iteration — a recalled memory entry, the already-tried block, a breaker
  advisory, the compiled brief — goes on the `Injected:` line. A run whose
  records show what was done but not what the agent was told cannot be debugged
  afterwards: the wrong output looks inexplicable when the wrong input is
  invisible. Recording the injection is also what makes a bad memory entry
  traceable to the iteration it misled.
- **Recalled ⟺ judged.** `Injected:` records what arrived; `Recall:` records what
  became of it. Every ID the hook logged is `applied` or `dismissed` with a
  reason — a dismissal is a real judgement and the cheap half to write, while
  silence is indistinguishable from never having read the entry. The dismissal
  reasons are also what the memory command's hit-rate pass reads to find a
  trigger that over-matches.
- **"Already tried" injection**: every iteration's prompt context must start
  from `state.json.history` — list what was already tried and what failed, and
  do NOT repeat a failed approach unchanged. This is the loop's short-term
  memory between iterations.
- **Every delegation is a composed brief.** No `Agent()` in this plugin is
  spawned from an ad-hoc sentence: the payload is Template N from the
  `loop-engineering:prompt-craft` skill (absolute project root, one deliverable,
  inputs as paths, forbidden actions, output contract, stop conditions) and
  passes that skill's six-point lint first. A subagent's context is fresh and
  its turn is single; an omitted field is not a gap it will ask about.
- The loop is **resumable**: on start, always read `state.json` + the last
  iteration record; never redo completed work, never trust memory of a previous
  session over the files.

## Stop conditions — the circuit breaker (all explicit and bounded)

**The breaker is code, not a prompt.** Run it before every iteration:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-breaker.mjs"   # 0 continue · 2 stop · 1 state error
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-breaker.mjs" --context   # "already tried" block
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-record.mjs" --help       # the only writer of history
```

It reads `state.json.history` and decides deterministically — an instruction a
model can drift from becomes a check it cannot. Exit `2` is final: record the
printed reason and `status`, then stop. The table below documents what the
script implements (thresholds overridable per-loop via a `breaker` object in
`state.json`; reset after a `stuck` resume via `breaker_reset_at_iteration`):

**Ownership matters:** the script decides only the ⚙ rows; the others are the
model's to detect — the script echoes `status` but will happily say CONTINUE on
a goal that is already met.

| Condition | Owner | Detection | status |
|---|---|---|---|
| Goal met | model | every criterion verified APPROVE with evidence → run the Review Gate, then `done` | `done` |
| Iteration budget | ⚙ script | `iteration >= max_iterations` (default 12) | `stopped-max-iterations` |
| **Stagnation** | ⚙ script | same error/failure reason 3 consecutive iterations | `stuck` |
| **Frustration** | ⚙ script | same *action* attempted 3 consecutive iterations (even with different errors) | `stuck` |
| **No progress** | ⚙ script | 5 consecutive fails with no pass in between | `stuck` |
| **Plateau** | ⚙ script | `criteria_passed` flat for 4 `kind: criterion` iterations despite passing verdicts | `stuck` |
| **Unreadable record** | ⚙ script | a verdict outside the enum at or after `record_contract_since`, or a sub-95 design gate with no assumptions | exit `1` — fix the record |
| **Advisory** | ⚙ script | any counter one short of its threshold | none — prints `ADVISORY`, exit stays `0` |
| Verifier escalation | model | verdict `ESCALATE_HUMAN` (environment problem, risky change) | `stuck` |
| User cancel | model | user says stop | `stopped-user` |

No-progress is the backstop for thrashing where every attempt fails
*differently* — five distinct errors from five distinct approaches — which
stagnation and frustration both miss. `escalate` entries count toward none of
the three.

**Bookkeeping passes are transparent to the failure chain.** A passing iteration
that closed no criterion (`criteria_passed` did not rise) neither counts as an
attempt nor resets one: `fail → tidy the records → fail` still reads as two
consecutive failures. Recording work is not progress, and it must not be able to
launder a stuck loop by resetting the counters. The rule is derived from
recorded state, not declared: fails are never transparent, so nothing is gained
by labelling a failed attempt as bookkeeping, and entries written before
`criteria_passed` existed keep their old behavior. `--context` marks such
iterations `[bookkeeping]`, and the CONTINUE line counts them.

**One counter short of a threshold prints an `ADVISORY` and exits `0`.** The loop
gets exactly one warning it can still act on — change the approach, target a
criterion directly, split the increment — before the breaker takes the decision
away. Carry the advisory into the next iteration's context and record it on the
`Injected:` line; an advisory that only appeared in a terminal changed nothing.
An advisory never stops a run: a nudge that can halt the loop is a stop
condition wearing a disguise, and the stop conditions are the table above.

**Escalation is not a free exit.** `escalate` entries are excluded from every
counter, which makes an unjustified ESCALATE_HUMAN the cheapest way to launder a
stuck loop. The verifier owes a proof block — command, exact error, the retry it
already tried, and the fact that makes the failure environmental rather than
behavioral — and a verdict without it is a REJECT. The same applies to
`breaker_reset_at_iteration`: set it only when the user has named what changed,
and record that reason in the iteration record.

The script handles signature normalization for you (timestamps, hex addresses,
paths → basenames, numbers → `#`) so "the same error" means the same signature,
not identical text; approach similarity is trigram Jaccard raised by containment
at a 0.85 threshold, so a reworded retry still counts.

**On `stuck`, diagnose before asking.** Don't hand the user a bare "what should I
do?" — present **2–3 competing hypotheses** for why the loop is stuck, each with
evidence for and against drawn from the iteration records, and your recommended
probe. The user picks a direction in seconds instead of re-deriving the situation
from raw history. Record exactly what was tried and why the breaker fired; never
silently keep burning iterations.

## Tier routing — how much process a goal pays

Every goal carries a **tier** (assigned by `epic-planner` for backlog items;
self-assessed at the design gate for standalone goals — when in doubt, round up):

| Tier | Fits | Design gate | Tenth-man | Review gate |
|---|---|---|---|---|
| `trivial` | config change, copy edit, one-liner | abbreviated (confirm criteria only) | skip (visible) | correctness only |
| `small` | single-file feature/fix | full | skip if its conditions hold | correctness + spec fidelity (+security if triggered) |
| `medium` | multi-file feature | full | full | all triggered dimensions |
| `large` | architectural / cross-cutting | full | full | all triggered dimensions + simplification always |

One line of process discipline: a config tweak must not pay the cost of a schema
migration — and a schema migration must never sneak through on a config tweak's
paperwork. Tier is recorded in `state.json` (`"tier": "medium"`) and in the
backlog row; disputes round up.

Every stop — including failure stops — triggers the memory compounding step
(`loop-engineering:loop-memory` skill), a **post-run critique** (false starts, noise, and exactly
ONE change to improve the next run), and a final status visualization.
