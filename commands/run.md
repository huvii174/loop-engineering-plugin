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
4. With `--hands-off`: skip the batch; every gap becomes an explicit numbered
   assumption in that item's `goal.md`, and the tenth-man critique becomes
   **mandatory for every item regardless of tier** — autonomy is paid for with
   stricter review, never looser (self-modifying-loop red line).
5. Present the execution plan (order, tiers, expected gates per item, any
   human-gated items) and get one final go/no-go. This is the last question
   until something stops.

## Execution — one item at a time, in dependency order

For each item in topo order:

1. **Design gate** (full `/loop-engineering:design` flow in epic-driven mode):
   seeds + pre-flight answers feed the per-dimension gate; archive-and-write,
   plan-critic per tier rules (or mandatory under `--hands-off`), backlog row
   → `designed`.
2. **Loop** (full `/loop-engineering:loop` flow): breaker step 0 each
   iteration, verifier per increment, review gate before `done`, memory step
   and epic bookkeeping at stop — exactly as if the user had run it by hand.
3. **Route on outcome:**
   - `done` → announce (one line: item, iterations used, criteria evidence),
     continue to the next item.
   - `stuck` → **the runner stops.** Present the stuck diagnosis (competing
     hypotheses + recommended probe) and wait for the user. Never skip a stuck
     item to continue the epic — later items may depend on the lie.
   - Item marked as a human gate in the backlog → stop BEFORE executing it and
     ask, even under `--hands-off`.
4. When the last item closes: Epic retro + instance archive + pointer cleanup
   (the loop's own close semantics), then a final epic report — per-item
   outcomes, total iterations, epic acceptance-criteria status with evidence.

## Runner bounds (explicit, like every other stop in this plugin)

- One `stuck` item stops the whole runner (default). No "skip and continue"
  without the user saying so.
- A per-run item budget: default = all pending items; the user may cap
  (`run 3 items then report`).
- Every item's own `max_iterations` stands — the runner never raises a budget
  to force an item through.

## Parallel execution — opt-in, worktrees only

`.loop/` holds ONE active goal; two items in one working tree would corrupt
state. When the user asks for parallelism: identify items whose dependencies
are met and that touch disjoint files (compare design work-breakdowns), create
one git worktree per item (each gets its own `.loop/`), run each item's
design→loop there, and merge back sequentially — merge conflicts or test
failures on merge send the item back to its worktree with the conflict context
injected. Recommend parallel only when ≥2 independent items each of tier
`small`+; the coordination overhead is real. Default remains sequential.

## Reporting

Between items, render the one-line progress form of `/loop-engineering:status`
(item k/n, iterations used, criteria met). Keep the narration terse — the
artifacts are the record; the user reads outcomes, not play-by-play.
