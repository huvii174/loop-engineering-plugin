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
   Read `.loop/prompt.md` too when it exists: it is the compiled, signed-off
   form of the ask, and its carry-forward context block is what every brief you
   write this run inherits. (Absent means the goal predates the compile step,
   not that you may skip it — compile it now via the
   `loop-engineering:prompt-craft` skill and show the user before iterating.)
2. Read `.loop/state.json` and the last entry in `.loop/iterations/` to know
   exactly where the loop stands. The loop is resumable: never redo completed
   work. Recall memory under budget per the `loop-engineering:loop-memory` skill
   — read `learnings/_index.md`, open the body of every trigger matching this
   goal (`grep -rA 20 '^### L-NNN' .loop/memory/learnings/`), grep `solutions/`
   by frontmatter field, load at most 5 entries, and apply their gotchas
   proactively. Every ID the recall hook injected (`.loop/.recall-log`) is
   accounted for in the iteration record's `Recall:` line — applied, or dismissed
   with a reason.
3. Behavior by `state.json.status`:
   - `designed` or `running` → proceed (resume from the last iteration record).
   - `stopped-max-iterations` → require a new max passed as the command
     argument; refuse otherwise.
   - `stuck` → ask the user what changed since the breaker fired; on their
     answer, set `breaker_reset_at_iteration` to the current `iteration` in
     `state.json` (this is how the breaker's counters are reset) and proceed.
     Record their answer as the reset's reason in the next iteration record — a
     reset with no named change is how a stuck loop launders itself and starts
     the same three failures over.
   - `done` → refuse; point at `/loop-engineering:design` for a new goal.
   - `stopped-user` → confirm the user wants to resume, then proceed.
4. If the command was invoked with a number argument, write it to
   `state.json.max_iterations` before iteration 1 — the argument must survive a
   crash. Otherwise use the stored value; if absent, 12.

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

   An `ADVISORY (...)` line on a continuing check is the breaker's one warning
   before it fires: a counter is one short of its threshold. **Act on it in
   THIS iteration** — change the approach rather than its wording, target a
   success criterion directly, or split the increment — and carry the advisory
   text into the iteration's context and its `Injected:` line. An advisory read
   and ignored becomes a `stuck` next iteration, and the loop will have earned
   it.

   The breaker also prints `[plugin vX.Y.Z]` read **from disk**. If features
   this command text describes are missing from your session (a skill or agent
   listed here doesn't resolve), the session was started before the plugin was
   installed/updated and is silently serving stale text — stop and tell the
   user to restart the session before doing loop work.
1. **Select** the next incomplete work item (or the fix for the previous
   iteration's REJECT). State it in one sentence. Get the "already tried" block
   with

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-breaker.mjs" --context
   ```

   and treat it as binding — never repeat a listed failed approach unchanged.
2. **Act** — implement the increment. Delegate to subagents when parallelism
   helps, but keep the increment small enough to verify. **When the increment is
   a fix rather than a build** — a verifier REJECT, a confirmed review finding,
   a defect the goal names — the defect protocol below runs first. **Every delegation is
   composed as a brief, never as a sentence:** load
   `Skill(skill: "loop-engineering:prompt-craft")` and write the spawn payload
   to Template N — absolute project root, one deliverable, inputs as paths,
   forbidden actions, output contract, stop conditions — then run its six-point
   lint before spawning. A subagent cannot ask you a follow-up question; what
   the brief omits, it guesses.
3. **Verify** — never grade your own work. Call
   `Agent(subagent_type: "loop-engineering:loop-verifier", prompt: <payload>)`
   with the payload below: Template N with the verifier's fields filled in,
   composed under the prompt-craft lint. The agent has fresh context and knows
   nothing you don't tell it, and the criteria go in VERBATIM — a paraphrased
   `Done when:` is a different criterion, and it will grade that one instead.

   ```markdown
   ## Project root
   <absolute path — the verifier's cwd is NOT your project; every command it
   runs must be anchored here>
   ## Target criterion(s)
   Done when: <quoted VERBATIM from .loop/goal.md>
   Must not: <quoted VERBATIM>
   <one block per criterion this iteration claims — an iteration may close more
   than one; the verifier judges each separately>
   ## Intent
   <this iteration's one-sentence intent>
   ## Diff / files touched
   <file list + summary of the change>
   ## Claimed verification
   <command(s) you believe verify it, and what you observed>
   ## Sweep
   <required when a targeted criterion carries `Sites:` or this is a review
   fix: one line per grep hit — shape in the loop-engine skill, Sites and
   Sweep. Otherwise "none". The verifier re-runs the grep (its check 9)>
   ## Recall accounting
   <every ID now in .loop/.recall-log: `applied (what it changed)` or
   `dismissed (why it does not apply here)` — or "none injected". The verifier
   judges this block (its check 7); it then lands verbatim on the iteration
   record's `Recall:` line>
   ```

   It returns `APPROVE | REJECT | ESCALATE_HUMAN` with evidence. On APPROVE,
   tick the criterion in `.loop/goal.md` — only items under `## Success
   criteria` count as criteria. The goal is only "met" when the verifier — not
   you — has confirmed every criterion with evidence.
4. **Record** — write `.loop/iterations/NNNN.md` (format in the loop-engine
   skill), then hand it to the recorder:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-record.mjs" \
     --verdict pass|fail|escalate --kind criterion|review-fix|bookkeeping \
     --criterion <id> --criteria-passed <n> \
     --intent "<one sentence>" [--approach "<what was tried>"] [--signature "<the failure>"]
   ```

   The record is code, for the same reason the breaker is. The script appends
   the history entry, bumps `iteration`, reconciles every `.loop/.recall-log` ID
   against the record's `Recall:` line, and empties that inbox last. Exit `1`
   means nothing was written and stderr says what to fix — a verdict outside the
   enum, a missing `Evidence:` line, an unaccounted recall ID, a `Sweep:` line a
   review fix or a `Sites:` criterion owes, an `iteration` that disagrees with
   `history`. The full list lives in the loop-engine skill's record format.

   Two arguments carry the whole weight. **`--verdict`** is what every counter
   reads: a verifier that approved four criteria and rejected one is `fail`, and
   the detail belongs on the record's `Verdict:` line. **`--kind`** says what
   the iteration aimed at, and `review-fix` is what keeps the plateau counter
   from punishing a thorough review gate.
5. **Learn (scratch tier)** — if this iteration produced a lesson, append it to
   `.loop/memory/scratch/run.md`, tagged `(<run_id>, iter N)`. Write it raw and
   immediately; scratch is cheap. It gets distilled into the right shape
   (learning vs `solutions/` entry) at the end of the run — never promote a
   scratch note straight to a durable file.

### Defect increments — make it red before you theorise

An increment that fixes something starts by making the defect **red**. The one
command that goes red on *this* defect is the whole game: with it, bisection and
instrumentation just consume it; without it, reading code produces theories
nobody can falsify.

1. **Build a tight loop**, reaching for these in order: a failing test at the
   seam that reaches the defect → an HTTP call against a running dev server → a
   CLI invocation diffed against known-good output → a headless-browser script →
   a replayed captured payload → a throwaway harness around the one code path →
   a property/fuzz run for "sometimes wrong" → a bisection harness when it
   appeared between two known-good states.

   **Gate:** you can name one command, you have **already run it at least once**
   (show the invocation and its output), and it is *red-capable* (asserts the
   actual symptom, so it goes red now and green after the fix — rather than
   merely running without erroring), *deterministic*, *fast* (seconds), and
   *agent-runnable*. Building a theory before that command exists is the failure
   this gate catches; the fix that follows such a theory is the wasted iteration
   the breaker eventually counts.

   Non-deterministic defects target a **higher reproduction rate**, not a clean
   repro: loop the trigger, parallelise, narrow the timing window. A 50% flake is
   debuggable; 1% is not. A defect you genuinely cannot make red is an
   `ESCALATE_HUMAN`, recorded with what you tried.

2. **Minimise.** Cut inputs, config and steps **one at a time**, re-running the
   loop after each cut. Done when every remaining element is load-bearing:
   removing any one of them turns the loop green. What survives is also the
   regression test.

3. **Rank 3–5 falsifiable hypotheses before testing any of them**, each stating
   its prediction ("if X is the cause, changing Y makes it disappear"). One
   hypothesis anchors the iteration on the first plausible idea; a hypothesis
   with no prediction is a vibe, so sharpen it or drop it. Check the "already
   tried" block first — an approach dead there is not a hypothesis.

4. **Probe one variable at a time**, each probe mapped to one prediction, and
   **tag every debug log with a unique prefix** — `[DEBUG-a4f2]` — so cleanup is
   one grep. For a performance defect, measure a baseline and bisect instead;
   logs answer the wrong question.

5. **Fix, watch the command go green**, then re-run it against the un-minimised
   scenario. The increment stays open while `grep -rn '\[DEBUG-'` still finds
   anything it added, and the hypothesis that turned out right goes into the
   iteration record — that is what stops the next run re-deriving it.

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

Thresholds live in `state.json` under an optional `breaker_thresholds` object
(`stagnation`, `frustration`, `noProgress`, `plateau`, `similarity`); defaults
3/3/5/4/0.85. It holds thresholds, never counters — non-positive values are
refused for the defaults with a warning.
When a `stuck` loop is resumed after the user explains what changed, set
`breaker_reset_at_iteration` to the current `iteration` — the breaker then
ignores everything before it instead of tripping again immediately.

A failing verification is NOT a stop condition — it is the input to the next
iteration.

## Review Gate — between "criteria met" and `done`

When the last criterion passes, load
`Skill(skill: "loop-engineering:loop-review")` and run it: select dimensions by
its selection table — the skill owns which dimensions run at which tier and
trigger, and a summary restated here is how the two drifted once already — then
fan the reviewers out **in parallel with fresh
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
3. **Epic bookkeeping:** if `.loop/active-epic` exists, resolve the slug and
   work in `.loop/epics/<slug>/`: update this sub-goal's backlog row (`done`,
   `stuck`, or back to `pending` per outcome), tick any epic acceptance
   criteria in that epic's `epic.md` now met, and append this sub-goal's row
   to `.loop/memory/epics/<slug>.md` — including **what it taught** and the
   **slice verdict** (`well-sliced` / `too coarse` / `too fine` /
   `wrong boundary`). That verdict is the only feedback `epic-planner` ever gets;
   skipping it breaks epic-level compounding. Then, with `.loop/run.json`
   present, the runner continues to the next pending item itself (its design
   gate is the next action, not a hand-back); otherwise name that item for
   `/loop-engineering:design "<sub-goal>"` — or, if this closed the last item:
   write the **Epic retro** (Step 4 of the memory command), report the epic's
   acceptance-criteria status, **promote any still-binding decision** from
   `.loop/memory/decisions/<slug>/` into `decisions/durable.md` keeping its ID
   (move its `_index.md` line into the durable group too), then **archive the
   instance** with
   `node "$CLAUDE_PLUGIN_ROOT"/scripts/loop-archive.mjs epic --slug <slug>` (its
   knowledge already lives in `.loop/memory/epics/<slug>.md`, which is never
   archived — the script refuses an instance whose rollup is missing, and it
   retires the epic's remaining `decisions/<slug>/` bodies into the archive with
   it). Drop the retired `## <slug>` group from `decisions/_index.md` — index
   lines must not outlive their bodies — and clear `.loop/active-epic` if it
   pointed there. (Legacy singleton `.loop/epic.md` /
   `backlog.md`: migrate per the breakdown command before touching them.)
4. Show the final loop visualization (same rendering as
   `/loop-engineering:status`) and a plain-language summary: what was achieved,
   evidence per success criterion, what remains. Under an open epic run the
   one-line progress form replaces both — the runner's next item is the turn's
   next action.
