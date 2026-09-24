---
description: Execute a signed-off epic end-to-end — drive every backlog item through design→loop→memory in dependency order without the user re-typing commands; sequential by default, parallel via worktrees for independent items
argument-hint: "[epic slug (default: active-epic)] [--hands-off]"
---

# /loop-engineering:run — Epic Runner

The breakdown produced a signed-off backlog; this command conducts it. Every
gate that exists per sub-goal (design gate, tenth-man, verifier, breaker,
review gate, memory) **still runs — the runner adds orchestration, never
shortcuts.** It replaces the user typing `/loop-engineering:design "<item>"`
seven times; it does not replace any check.

## Preconditions

1. Resolve the epic: the slug argument, else `.loop/active-epic`. Its instance
   `.loop/epics/<slug>/` must exist with pending items; otherwise point at
   `/loop-engineering:breakdown`.
   **Resuming:** when `.loop/run.json` already names this epic, the run is in
   flight — its flags stand (a `hands_off` in the file outranks the absence of
   the argument), pre-flight is done, and execution continues at the first item
   in `order` whose backlog row is not `done` (an item whose loop is `running`
   or `designed` picks up where `state.json` says). Read it before anything.
2. Run the breaker once (`node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-breaker.mjs"`
   against any live state) — both to respect an open loop and to surface the
   `[plugin vX.Y.Z]` version check before a long autonomous stretch.
3. Read the epic rollup `.loop/memory/epics/<slug>.md` — lessons from items
   already finished bind the items still to come.

## Pre-flight — front-load EVERY interview (the runner must never ask mid-run)

This plugin's own failure-mode doctrine says an autonomous run cannot count on
asking the user mid-flight. So before executing anything:

1. Topologically sort pending items by `Depends on` (cycle → stop, report,
   refuse to run).
2. For each pending item, dry-scan its seeds against the codebase: will the
   design gate hit a question the seeds + interview facts + memory cannot
   answer? Collect every such gap across ALL items.
3. Ask the user the collected questions **now, in one batch**, grouped by item.
   Their answers become part of each item's design input.
   Compile each item's answers with the `loop-engineering:prompt-craft` skill as
   you go: the item's design gate writes its own `.loop/prompt.md`, and the
   pre-flight answers are the only interview material it will ever have.
4. With `--hands-off`: skip the batch; every gap becomes an explicit numbered
   assumption in that item's `goal.md`, and the tenth-man critique becomes
   **mandatory for every item regardless of tier** — autonomy is paid for with
   stricter review, never looser (self-modifying-loop red line).
5. Present the execution plan (order, tiers, expected gates per item, any
   human-gated items) and get one final go/no-go. This is the last question
   until something stops.
6. On go, **write `.loop/run.json`** (schema in the `loop-engineering:loop-engine`
   skill): epic, `hands_off`, the topo `order`, `human_gates`, and when the
   user capped the run, `budget` with `done_at_start` (the count of rows already
   `done` now — the cap counts from here, not from zero). From here the **run-gate** Stop hook holds the session
   open while an item in `order` is not `done` — the runner's continuity is
   code, and a stop it did not sanction comes back with the next item named.

## Execution — one item at a time, in dependency order

For each item in topo order:

1. **Design gate** (full `/loop-engineering:design` flow in epic-driven mode):
   seeds + pre-flight answers feed the per-dimension gate; the ask is compiled
   into that item's `.loop/prompt.md` before anything is designed;
   archive-and-write, plan-critic per tier rules (or mandatory under
   `--hands-off`), backlog row → `designed`. Under `--hands-off` the compiled
   brief is reported to the user rather than signed off by them, and every gap
   it exposes becomes a numbered assumption.
2. **Loop** (full `/loop-engineering:loop` flow): breaker step 0 each
   iteration, verifier per increment, review gate before `done`, memory step
   and epic bookkeeping at stop — exactly as if the user had run it by hand.
3. **Route on outcome:**
   - `done` → announce (one line: item, iterations used, criteria evidence),
     continue to the next item **in the same turn** — the design gate of item
     k+1 is the next action, not a summary. When the close names the item as
     the epic's integration point, the epic gate comes first
     (`loop-engineering:loop-review` skill, Epic gate).
   - `stuck` → **the runner stops.** The backlog row reads `stuck`, which is
     what silences the gate. Present the stuck diagnosis (competing hypotheses
     + recommended probe) and wait for the user. Never skip a stuck item to
     continue the epic — later items may depend on the lie.
   - Item marked as a human gate in the backlog → stop BEFORE executing it and
     ask, even under `--hands-off`. (Listed in `run.json.human_gates`, so the
     gate stays silent there.)
   - User cancel → the loop writes `stopped-user`; **delete `.loop/run.json`**
     so the gate does not hold a run the user ended.
4. When the last item closes: the epic gate first (`loop-engineering:loop-review`
   skill, Epic gate) — an integration row it appends is the next item, and the
   retro waits for it. Then Epic retro + instance archive + pointer cleanup
   (the loop's own close semantics), **delete `.loop/run.json`**, then a final
   epic report — per-item outcomes, total iterations, epic acceptance-criteria
   status with evidence.

## Runner bounds (explicit, like every other stop in this plugin)

- One `stuck` item stops the whole runner (default). No "skip and continue"
  without the user saying so.
- A per-run item budget: default = all pending items; the user may cap
  (`run 3 items then report`) — recorded as `run.json.budget`, so the gate
  releases the session when it is spent.
- The gate's own bound (the nudge cap in the loop-engine skill): blocked stops
  at one position with no progress, and it lets the session go, saying the
  runner is halted. A stop that keeps recurring at the same item is a stop with
  a cause; find it rather than restart the counter.
- Every item's own `max_iterations` stands — the runner never raises a budget
  to force an item through. Who may raise one, and how a met item closes at
  the cap, is the budget policy in the loop-engine skill.

## Parallel execution — opt-in, worktrees only

`.loop/` holds ONE active goal; two items in one working tree would corrupt
state. When the user asks for parallelism: identify items whose dependencies
are met and that touch disjoint files (compare design work-breakdowns), create
one git worktree per item (each gets its own `.loop/`), **write
`.loop/parallel.json` in the dispatching tree the moment you fan out** — the
manifest format, and the slice-prefix agent-naming rules that travel with it,
live in the `loop-engineering:loop-engine` skill; a fan-out without the manifest
is unresumable the moment this session dies — then run each item's
design→loop there, and merge back sequentially, deleting each slice's manifest
entry as it merges. Merge conflicts or test failures on merge send the item back
to its worktree with the conflict context injected. Recommend parallel only when
≥2 independent items each of tier `small`+; the coordination overhead is real.
Default remains sequential.

## Reporting

Between items, render the one-line progress form of `/loop-engineering:status`
(item k/n, iterations used, criteria met). Keep the narration terse — the
artifacts are the record; the user reads outcomes, not play-by-play.
