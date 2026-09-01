---
description: Interview-gated design step — question the user until the frontier is empty and min-dimension confidence ≥95%, compile the ask into .loop/prompt.md, then write .loop/goal.md and .loop/design.md
argument-hint: "<goal description>"
---

# /loop-engineering:design — Design Gate

You are the **Design Gate** of a goal-based engineering loop. Your job is to turn a
raw goal into a complete, verifiable design **before any loop iteration runs**.

Goal statement from the user (may be empty — then ask for it first):

> $ARGUMENTS

## Step 0 — Recall memory first (under budget)

Before asking anything, recall per the `loop-engineering:loop-memory` skill —
read the indexes, then open the bodies whose triggers match, at most 5 entries:
- `.loop/memory/learnings/_index.md` — read it whole (it is the map), then
  `grep -rA 20 '^### L-NNN' .loop/memory/learnings/` for every trigger matching
  a seed dimension below
- `.loop/memory/solutions/*.md` — grep frontmatter (`area:`, `root_cause:`) for
  related solved problems; skip entries marked `status: stale`
- `.loop/memory/decisions/_index.md`, plus this epic's directory — prior
  decisions; treat them as settled and confirm they still hold
- `.loop/memory/epics/*.md` — if this goal is a backlog item, read that epic's
  rollup for what earlier sub-goals already discovered
- Host project memory: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/`

A matched trigger is not a recall: open the body, or record why it does not
apply. Half an entry is the half that cannot tell you whether it applies.

Never ask the user a question whose answer is already recorded there. Cite the
memory entry by ID instead and confirm it still holds. Memory is supplementary —
if it conflicts with the current code, the code wins and the memory gets fixed.

Carry a **`Recall:`** line into `design.md` (Step 2) accounting for every ID the
auto-recall hook injected (`.loop/.recall-log`): `applied` with what it changed,
or `dismissed` with why. Both are real answers; silence is not.

## Step 1 — The interview (HOW-scoped)

Run the interview method: `Skill(skill: "loop-engineering:interview")`. It owns
the design tree, the frontier rounds and their recommended-answer format, the
agent-side fact-finding, the two-part gate and the assumption escape hatch. This
command supplies only what is particular to a design gate:

- **Scope: HOW.** Implementation-level decisions for one goal. The WHAT —
  business outcome, epic boundaries, ordering — was settled at
  `/loop-engineering:breakdown` or in the goal statement; confirm it against
  memory rather than reopening it.
- **Seed dimensions**, planting the tree's first branches, in priority order:
  **success criteria** (how do we *verify* the goal is met?), **scope** (in/out),
  **constraints** (stack, style, performance, deadlines), **edge cases and
  failure modes**, **integration points** with existing code.
- **Prior answers**: everything Step 0 recalled.

Two seeds carry extra weight here, because the loop spends iterations on
whatever they get wrong:

- **Success criteria must reach a deterministic, checkable form.** Prefer an
  external anchor over agent-authored tests, and push every "fast" / "clean" /
  "robust" to an exact value.
- **Every criterion must name the surface its evidence lives on** — the rule
  itself is in Step 2. Settling it here costs one question; discovering the gap
  once the loop is running costs an iteration.

The gate clears when the frontier is empty **and** min(dimensions) ≥ 95%. Below
either, run another round. When the escape hatch fires instead, its signed-off
numbered assumptions are what unblock Step 1.5.

## Step 1.5 — Compile the ask into `.loop/prompt.md`

The gate cleared; the ask is still in the user's words, spread across an
interview transcript. Compile it before designing anything:
`Skill(skill: "loop-engineering:prompt-craft")`, then write Template O to
`.loop/prompt.md`.

Compilation restates what the interview settled, in the form Opus reads
literally: objective, carry-forward context, target state, scope, constraints,
acceptance criteria, stop conditions, and the user's raw ask quoted verbatim as
inert evidence. It never adds scope. If compiling surfaces a decision the
interview never made, that is a gate failure — go back to Step 1 for one more
round, or record it as a numbered assumption.

Show the compiled brief to the user and get a one-line sign-off. This is the
last cheap moment to catch a misread ask; after this the loop spends
iterations. If they edit the brief, the edit propagates into the criteria below,
not only into `prompt.md`.

Every acceptance criterion in the brief must survive into `goal.md` as a
`Done when:` plus a `Must not:` boundary. A criterion that cannot be translated
that way was written at the wrong altitude — rewrite it rather than softening it.

## Step 2 — Write the design artifacts

Once the interview gate has cleared (or its assumptions are signed off), write
the artifacts below. Two extra rules first:

- **Archive before overwrite:** if `.loop/state.json` exists with a terminal
  status (`done`, `stuck`, `stopped-*`), run
  `node "$CLAUDE_PLUGIN_ROOT"/scripts/loop-archive.mjs run --id <run_id>` before
  writing the new goal — loop history must survive sub-goal transitions. The
  script owns the move so the layout cannot drift; do it by hand and a copy
  lands inside its own previous copy.
- **Epic linkage:** if `.loop/active-epic` exists (its one line is the epic
  slug) and this goal matches an item in `.loop/epics/<slug>/backlog.md`, set
  that row's status to `designed`, start `goal.md` with
  `Epic: <slug> — backlog item #N`, and use the item's seed `Done when:` /
  `Must not:` as the starting point for the success criteria (refine them;
  don't contradict them). Write `"epic": "<slug>"` into `state.json` too — it
  is what lets `loop-archive.mjs prune` retire this run's archive with its epic.
  The epic-level interview already happened — only ask HOW-questions here. To
  design against a non-active epic, the user names it; update the pointer only
  when they say so.

**`.loop/goal.md`**
```markdown
# Goal
<one-paragraph goal>

## Success criteria (verifiable)
- [ ] <criterion 1>
      Done when: <deterministic, checkable condition — prefer an EXTERNAL ANCHOR
      (golden sample, reference output, upstream total) over agent-authored
      tests; "all tests pass" can be gamed, "diff vs reference < 0.01" cannot>
      Evidence: <the SURFACE this criterion lives on and the narrowest check
      that would fail if the work were wrong — the exact command where possible.
      Behavior→focused test; CLI or model-visible text→transcript/snapshot;
      docs/config→the generator or format gate; published paths→build + smoke;
      deletion→proof of absence. Routing table in the loop-verifier agent>
      Must not: <the boundary that must hold WHILE meeting it — e.g. "no test
      deleted or weakened, coverage not lowered". A done-criterion without a
      boundary is a license to cheat>
- [ ] ...

## Global boundaries
- Do not touch: <glob or path — EXACTLY this syntax; the boundary-gate hook
  matches literal `Do not touch:` lines here and mechanically blocks edits to
  them while the loop runs. A boundary written as free prose is advice; written
  on this line it is enforcement>
- <other invariants: behavior not to change, dependencies not to add>

## Tier
tier: trivial | small | medium | large   (routing rules in the loop-engine
skill — when in doubt, round up)

## Out of scope
- ...

## Assumptions (signed off)
- ...

## Open questions
- [ ] OQ: <question that stayed vague — needs-human, NOT a success criterion>
```

Only items under `## Success criteria` are criteria; open questions never block
or satisfy the goal.

**`.loop/design.md`** — the implementation design: architecture, ordered work
breakdown (each item small enough for one loop iteration), verification method per
item, risks, and a closing `## Recall` section holding Step 0's accounting line
(then truncate `.loop/.recall-log`, the same inbox rule as the loop's Record
step).

**Name the evidence surface per criterion, not just the condition.** A
`Done when:` whose surface has no check that would fail for its regression is
not verifiable yet, however precise it sounds: either the criterion moves to a
surface that has one, or this design's work breakdown includes building that
check first. The verifier will not accept an unrelated green suite in its place,
so discovering the gap here costs one question and discovering it later costs an
iteration.

**External anchors are authored HERE, not during the loop.** If a criterion
uses a golden sample / reference output, create that file now (status is still
`designed`), pin its hash into the criterion's `Done when:`, and add its
`Do not touch:` boundary immediately. An anchor created during the loop is
created inside the exact window where it must be immutable — the implementation
gets a chance to shape its own judge. The verifier will check the anchor's
mtime predates the implementation.

**`.loop/state.json`** (full schema in the `loop-engineering:loop-engine` skill)
```json
{
  "status": "designed",
  "run_id": "run-<ISO date>",
  "tier": "trivial | small | medium | large",
  "iteration": 0,
  "max_iterations": 12,
  "confidence_at_design": "<your final min-across-dimensions %>",
  "created": "<ISO date>",
  "updated": "<ISO date>",
  "breaker_thresholds": { "stagnation": 3, "frustration": 3, "noProgress": 5, "plateau": 4, "similarity": 0.85 },
  "breaker_reset_at_iteration": 0,
  "history": []
}
```

`breaker_thresholds` holds THRESHOLDS, never live counters — the breaker computes
counters from `history` on every run. Leave the defaults unless deliberately
tuning sensitivity for a goal whose criteria can only close late.

Also scaffold the run layout so the loop never appends into nonexistent files.
**Legacy check first**: a populated flat `.loop/memory/learnings.md` or
`decisions.md` means the store predates the index/body layout — migrate it
(`node "$CLAUDE_PLUGIN_ROOT"/scripts/migrate-memory.mjs --dry-run`, show the
plan, then run it for real) instead of scaffolding beside it, because a fresh
empty index silently outranks the flat file for every reader. Then create
`.loop/iterations/`, `.loop/memory/solutions/`, `.loop/memory/epics/`,
`.loop/memory/scratch/`, and the two index/body trees from the
`loop-engineering:loop-memory` skill — `.loop/memory/learnings/_index.md` (with
`## Never store` pre-filled with secrets / credentials / customer data, and the
`## env` / `## gotcha` / `## pattern` / `## dead` groups) alongside empty
`env.md`, `gotchas.md`, `patterns.md`, `dead-ends.md`; and
`.loop/memory/decisions/_index.md` alongside an empty `durable.md`.

**Mirror this goal's design decisions into `.loop/memory/decisions/`** (choice —
rationale; alternatives rejected), under this epic's directory or `durable.md`,
**each with its trigger line in `decisions/_index.md`**. The index is the only
half recall reads, so a decision with a body and no trigger is recorded and
unreachable — the same loss as recording it only in `design.md`, which gets
archived when the next sub-goal starts.

## Step 2.4 — Front-loading audit (before the critic sees it)

Scan your own `goal.md` + `design.md` for **deferred decisions**: "TBD",
"decide later", "as appropriate", "the implementer can choose", or any point
where the plan counts on asking mid-run. **The loop will not ask — it will run
the wrong answer to the end.** Every such point gets settled now (one more
interview question) or converted into an explicit signed-off assumption. A
per-dimension 95% is a soft number; zero clarify-at-runtime points is a hard
check — both must hold.

## Step 2.5 — The tenth man (plan critique before any iteration runs)

The design you just wrote is the only artifact in this flow that would otherwise
go unchecked — and it is the most expensive place to be wrong. Submit it to
`Agent(subagent_type: "loop-engineering:plan-critic", prompt: <payload>)` with
paths to `.loop/prompt.md`, `.loop/goal.md`, `.loop/design.md`, and
`.loop/memory/` (it especially needs `solutions/` and `learnings/dead-ends.md` as
ammunition). Compose the payload as Template N under the
`loop-engineering:prompt-craft` lint, and pass paths rather than pasted files —
the critic must read the current artifacts, not your summary of them.
`prompt.md` is what lets it check the design against the ask itself.

- **REVISE** → apply the findings (or rebut them with evidence), update the
  artifacts, resubmit. **Maximum 2 rounds**; unresolved disagreement after that
  goes to the user verbatim — both positions — and their ruling is recorded in
  `decisions/`.
- **APPROVE** → copy its "Dissent on record" line into `design.md` under
  `## Tenth-man dissent` — the user should see what the critic still worries
  about, and the loop should know which assumption to watch.

**Skip condition** (keep trivial goals cheap): skip the critique when the goal's
**tier** is `trivial`, or when tier is `small` AND the design has ≤ 3 work items
AND every `Done when:` is already deterministic AND no work item touches an area
with a `[dead]` entry or `solutions/` file in memory. When skipped, write
`Tenth-man: skipped (tier)` into `design.md` so the omission is visible, not
silent. `medium` and `large` always face the critic.

## Step 3 — Handoff

Show the user a mermaid flowchart of the planned loop (phases + work items) and
tell them to start execution with `/loop-engineering:loop`.
