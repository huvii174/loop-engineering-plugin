---
description: Run the goal-based loop — iterate plan→act→verify against .loop/goal.md until success criteria pass or a stop condition fires
argument-hint: "[max iterations, default 12]"
---

# /loop-engineering:loop — Goal-based Loop Runner

Execute the goal-based engineering loop defined in `.loop/`. Load the state
contract first: `Skill(skill: "loop-engineering:loop-engine")`.

## Preconditions

1. `.loop/goal.md` and `.loop/design.md` must exist. If not, stop and tell the
   user to run `/loop-engineering:design` first — never invent a goal yourself.
2. Read `.loop/state.json` and the last entry in `.loop/iterations/` to know
   exactly where the loop stands. The loop is resumable: never redo completed
   work. Recall memory under budget per the `loop-engineering:loop-memory` skill
   — grep `learnings.md` by `[type][area]` tag and `solutions/` by frontmatter
   field, load at most 5 entries, and apply their gotchas proactively.
3. Behavior by `state.json.status`:
   - `designed` or `running` → proceed (resume from the last iteration record).
   - `stopped-max-iterations` → require a new max in `$ARGUMENTS`; refuse otherwise.
   - `stuck` → ask the user what changed since the breaker fired; on their
     answer, set `breaker_reset_at_iteration` to the current `iteration` in
     `state.json` (this is how the breaker's counters are reset) and proceed.
   - `done` → refuse; point at `/loop-engineering:design` for a new goal.
   - `stopped-user` → confirm the user wants to resume, then proceed.
4. If `$ARGUMENTS` contains a number, write it to `state.json.max_iterations`
   before iteration 1 — the argument must survive a crash. Otherwise use the
   stored value; if absent, 12.

## The loop

Repeat until a stop condition fires. **One iteration = one small, verifiable
increment** from the design's work breakdown:

0. **Breaker check — run this before every iteration, no exceptions:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-breaker.mjs"
   ```

   Exit `0` → continue. Exit `2` → **stop now**: it prints the reason and the
   `status` to write into `state.json`; go to "On every stop". Exit `1` → the
   state file is missing/corrupt; fix that before iterating. This check is
   deterministic code, not a judgment call — never skip it, and never overrule
   an exit `2`.
1. **Select** the next incomplete work item (or the fix for the previous
   iteration's REJECT). State it in one sentence. Get the "already tried" block
   with

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-breaker.mjs" --context
   ```

   and treat it as binding — never repeat a listed failed approach unchanged.
2. **Act** — implement the increment. Delegate to subagents when parallelism
   helps, but keep the increment small enough to verify.
3. **Verify** — never grade your own work. Call
   `Agent(subagent_type: "loop-engineering:loop-verifier", prompt: <payload>)`
   with this payload (the agent has fresh context and knows nothing you don't
   tell it):

   ```markdown
   ## Intent
   <this iteration's one-sentence intent>
   ## Target criterion
   Done when: <quoted VERBATIM from .loop/goal.md>
   ## Diff / files touched
   <file list + summary of the change>
   ## Claimed verification
   <command(s) you believe verify it, and what you observed>
   ```

   It returns `APPROVE | REJECT | ESCALATE_HUMAN` with evidence. On APPROVE,
   tick the criterion in `.loop/goal.md` — only items under `## Success
   criteria` count as criteria. The goal is only "met" when the verifier — not
   you — has confirmed every criterion with evidence.
4. **Record** — append `.loop/iterations/NNNN.md` (format in the loop-engine
   skill, including the `Delegated:` line) and update `.loop/state.json`:
   increment `iteration`, append the history entry (`n`, `intent`, `approach`,
   `verdict`, `error_signature`, `criterion`, **`criteria_passed`** — the count
   of verifier-APPROVED criteria after this iteration; the breaker's plateau
   detection is blind without it), set `status` and `updated`.
5. **Learn (scratch tier)** — if this iteration produced a lesson, append it to
   `## Scratch (this run)` in `.loop/memory/learnings.md`, tagged
   `(<run_id>, iter N)`. Write it raw and immediately; scratch is cheap. It gets
   distilled into the right shape (one-liner vs `solutions/` entry) at the end of
   the run — never promote a scratch note straight to a durable section.

## Stop conditions (explicit — check before every iteration)

`loop-breaker.mjs` (step 0) owns the mechanical ones — max-iterations,
stagnation, frustration, no-progress, and plateau (criteria-met count flat
despite passing verdicts; requires `criteria_passed` recorded each iteration) —
and its exit `2` is final. When it fires `stuck`, **diagnose before asking**:
present 2–3 competing hypotheses for why the loop is stuck, each with evidence
for/against from the iteration records, plus a recommended probe — then let the
user pick a direction. The two stops the script cannot see are yours to detect:

- **Goal met:** every success criterion verifier-APPROVED with evidence →
  **run the Review Gate first** (below); only a cleared gate writes `done`.
- **Verifier ESCALATE_HUMAN** (environment problem / risky change) → `stuck`.
  (`escalate` history entries are excluded from the breaker's counters — an
  unverifiable attempt is not a failed approach.)
- **User cancel** → write `status: "stopped-user"` before stopping.

Thresholds live in `state.json` under an optional `breaker` object
(`stagnation`, `frustration`, `noProgress`, `similarity`); defaults 3/3/5/0.85.
When a `stuck` loop is resumed after the user explains what changed, set
`breaker_reset_at_iteration` to the current `iteration` — the breaker then
ignores everything before it instead of tripping again immediately.

A failing verification is NOT a stop condition — it is the input to the next
iteration.

## Review Gate — between "criteria met" and `done`

When the last criterion passes, load
`Skill(skill: "loop-engineering:loop-review")` and run it: select dimensions by
its rules (correctness always; security/test-adequacy/simplification only when
their triggers fire; cap 4), fan the reviewers out **in parallel with fresh
context**, refute blocker/major findings before believing them, and feed
confirmed findings back into this same loop as normal iterations — verifier,
record, breaker, no side door. Minor findings go to memory scratch, never to
iterations. The gate's summary (dimensions run and why, findings
confirmed/refuted/fixed) goes into the final iteration record. Only a cleared
gate writes `status: "done"`.

## On every stop (success or not)

1. Compound memory: load `Skill(skill: "loop-engineering:loop-memory")` and
   perform Steps 1–4 of the `/loop-engineering:memory` command inline (harvest →
   distill → merge → prune). Include the **hypotheses that died** (what didn't
   work and why) — they prevent the next run from re-running dead ends.
2. Write a **post-run critique** into the run's last iteration record: false
   starts, noisy signals, and exactly ONE concrete change to improve the next
   run (bounding it to one change is what makes it actually happen).
3. **Epic bookkeeping:** if `.loop/backlog.md` exists, update this sub-goal's
   row (`done`, `stuck`, or back to `pending` per outcome), tick any epic
   acceptance criteria in `.loop/epic.md` now met, and append this sub-goal's row
   to `.loop/memory/epics/<epic-slug>.md` — including **what it taught** and the
   **slice verdict** (`well-sliced` / `too coarse` / `too fine` /
   `wrong boundary`). That verdict is the only feedback `epic-planner` ever gets;
   skipping it breaks epic-level compounding. Then name the next pending item for
   `/loop-engineering:design "<sub-goal>"` — or, if this closed the last item,
   write the **Epic retro** (Step 4 of the memory command) and report the epic's
   acceptance-criteria status.
4. Show the final loop visualization (same rendering as
   `/loop-engineering:status`) and a plain-language summary: what was achieved,
   evidence per success criterion, what remains.
