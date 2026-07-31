---
description: Compound memory after a loop run — distil scratch into durable learnings, solution entries and epic rollups, then promote repo-wide facts into the host CLAUDE.md through a gate
---

# /loop-engineering:memory — Memory Compounding

Turn what this run learned into durable memory, so the next run doesn't repeat
the discovery work. **Each unit of work should make the next one cheaper.**

Load the contract first: `Skill(skill: "loop-engineering:loop-memory")` — it owns
the three memory shapes, the escalation rule, the tiers, and the recall budget.

## Step 1 — Harvest

Read the full run record: `.loop/iterations/*.md`, `.loop/state.json`, and the
`## Scratch (this run)` section of `.loop/memory/learnings.md`. Extract candidates
in five categories (destination in parentheses):

- **Gotchas** — things that failed and why (→ `learnings.md` `## Gotchas`)
- **Patterns** — approaches that worked and are reusable (→ `## Patterns`)
- **Environment facts** — build/test/tooling facts discovered the hard way
  (→ `## Environment`)
- **Dead hypotheses** — approaches abandoned, with *why*; these prevent future
  runs from re-running dead ends (→ `## What didn't work`)
- **Decisions** — design choices made and their rationale (→ `decisions.md`)

## Step 2 — Distil, and pick the shape

Keep a candidate only if it would change a future session's behavior. Drop
anything derivable from the code itself. Then apply the **escalation rule** from
the skill to each keeper:

- Fix took >2 iterations, **or** root cause differed from the first hypothesis,
  **or** "when does this apply?" needs more than one line
  → write a full `solutions/<slug>.md` entry (typed frontmatter + the
  `What didn't work` / `When this applies` sections).
- Otherwise → a tagged one-liner `[type][area] … — why (run-id, iter N)`.

Check `## Never store` before writing anything. Ground behavioral claims with
`file:line`; cite PR numbers, not bare SHAs.

## Step 3 — Merge (never duplicate)

Apply the five-outcome model (Keep / Update / Consolidate / Replace / Delete)
from the skill: dedupe via the Retrieval-Value Test; when new evidence
contradicts an entry, the evidence wins — update the entry, never append a
contradiction beside it. Resolve cross-entry contradictions before anything else.
When reality has outgrown an entry but evidence is insufficient to rewrite it,
mark `status: stale` with a reason instead of guessing.

Then **empty `## Scratch (this run)`** — every note is either distilled or deleted.

## Step 4 — Epic rollup (when `.loop/active-epic` resolves to an epic instance)

Append this sub-goal's row to `.loop/memory/epics/<epic-slug>.md`: item number,
outcome, iterations used, **what it taught**, and the **slice verdict**
(`well-sliced` / `too coarse` / `too fine` / `wrong boundary`). The slice verdict
is the feedback signal `epic-planner` needs — without it every breakdown starts
from zero.

**If this run closed the last backlog item, write the Epic retro** in that same
file: which slices were wrong (and the signal that would have caught it at
breakdown time), which seed `Done when:` lines didn't survive contact, whether
risk-first ordering held, and **exactly one change for the next breakdown**. Set
the rollup's `status: done`.

## Step 5 — Promote through the gate

Learnings whose scope exceeds this goal go to the host project's `CLAUDE.md`
(`## Learnings`) — but **only through the gate**: either the user confirms, or
`Agent(subagent_type: "loop-engineering:loop-verifier", ...)` confirms the claim
is evidence-backed. `CLAUDE.md` loads into every future session; an unreviewed
line there is a permanent tax. Never promote a scratch entry directly. If the
host already has a memory system, merge into it rather than adding a second store.

## Step 6 — Prune

If durable one-liners exceed ~60, consolidate before adding more; past ~40,
prefer moving narrative-shaped entries out to `solutions/`.

## Output

Report: N candidates harvested → M kept (X one-liners, Y solution entries), what
the epic rollup gained, what was promoted (and how it passed the gate), and what
was pruned. Quote the actual lines added.
