---
description: Compound memory after a loop run — distil scratch into durable learnings, solution entries and epic rollups, then promote repo-wide facts into the host CLAUDE.md through a gate
---

# /loop-engineering:memory — Memory Compounding

Turn what this run learned into durable memory, so the next run doesn't repeat
the discovery work. **Each unit of work should make the next one cheaper.**

Load the contract first: `Skill(skill: "loop-engineering:loop-memory")` — it owns
the index/body split, the four memory shapes, the escalation rule, the tiers, and
the recall budget.

## Step 1 — Harvest

Read the full run record: `.loop/iterations/*.md`, `.loop/state.json`,
`.loop/memory/scratch/run.md`, **and the ad-hoc scratch file
`.loop/memory/scratch/adhoc.md`** (one-liners captured by sessions that worked
outside any loop — the memory-gate hook nudges them there). This command also
runs standalone with no loop record at all: then the ad-hoc scratch is the entire
harvest. Extract candidates in five categories (destination in parentheses):

- **Gotchas** — things that failed and why (→ `learnings/gotchas.md`)
- **Patterns** — approaches that worked and are reusable (→ `learnings/patterns.md`)
- **Environment facts** — build/test/tooling facts discovered the hard way
  (→ `learnings/env.md`)
- **Dead hypotheses** — approaches abandoned, with *why*; these prevent future
  runs from re-running dead ends (→ `learnings/dead-ends.md`)
- **Decisions** — design choices made and their rationale, **with the
  alternatives they beat** (→ `decisions/<epic>/item-<N>.md`, or
  `decisions/durable.md` when the choice outlives its epic — plus a trigger
  line in `decisions/_index.md`, the same both-halves rule as learnings). A
  decision harvested without its rejected alternatives is not recorded, it is
  asserted: write what lost, or file the item as a plain fact instead.

## Step 2 — Distil, and pick the shape

Keep a candidate only if it would change a future session's behavior. Drop
anything derivable from the code itself. Then apply the **escalation rule** from
the skill to each keeper:

- Fix took >2 iterations, **or** root cause differed from the first hypothesis,
  **or** "when does this apply?" needs more than one line
  → write a full `solutions/<slug>.md` entry (typed frontmatter + the
  `What didn't work` / `When this applies` sections).
- Otherwise → a learning: a **body** under `### L-NNN [type][area] <title>` in the
  shard its type names, plus a **trigger** line in `learnings/_index.md`.

Write the trigger last and write it as the **symptom**, not the lesson: the error
text, API or file name a future session will have in front of it when it needs
this. That string is what auto-recall matches on, so a trigger phrased as a
conclusion ("assertions must be narrow") is an entry nobody will ever be handed.
Keep it inside 200 chars; the detail belongs in the body, which is uncapped.

Check `## Never store` before writing anything. Ground behavioral claims with
`file:line`; cite PR numbers, not bare SHAs. Run each keeper past the skill's
prose list before writing it: no narrated history, no rotting status note, no
reasoning transcript, no fact without its why. Never mine `.loop/archive/` for
material — an archived run is frozen history, not a source of current facts.

## Step 3 — Merge (never duplicate)

Apply the six-outcome model (Keep / Update / Consolidate / Replace / Demote /
Delete) from the skill: dedupe via the Retrieval-Value Test; when new evidence
contradicts an entry, the evidence wins — update the entry, never append a
contradiction beside it. Resolve cross-entry contradictions before anything else.
When reality has outgrown an entry but evidence is insufficient to rewrite it,
mark `status: stale` with a reason instead of guessing.

Three rules bound the destructive outcomes. A dead end is kept only while the
path it names is still tempting, and deleted once its premise is gone. An entry
is never edited into a different conclusion: Replace it, or supersede it with a
new entry that links back. A consolidation transfers every unique rationale,
alternative, and failed attempt into the surviving entry **before** the absorbed
one is deleted. Judge close calls against the skill's worked examples rather
than by length or age, and name any genuinely borderline call in this run's
output so the next pass inherits the reasoning.

Then **empty both scratch surfaces** — `scratch/run.md` and `scratch/adhoc.md` —
every note is either distilled or deleted. Ad-hoc entries keep their `[adhoc]`
tag when distilled only if the *source* matters; usually they become normal
`[gotcha]`/`[pattern]`/`[env]` entries.

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

## Step 6 — Hit-rate pass (the store maintains itself from its own usage)

Read the `Recall:` lines across this run's `.loop/iterations/*.md` — they are
the durable record of every injection and its verdict (`.loop/.recall-log` is
just the inbox each Record step empties) — and fix what the data exposes, per
the skill's hit-rate table:

- **dismissed repeatedly for the same reason** → the trigger over-matches: add
  the discriminating symptom to it.
- **injected and applied** → Keep, byte-identical.
- **never injected while its topic was worked on all run** → the trigger is
  written in the author's vocabulary instead of the reader's. Rewrite it in the
  words this run actually used — the grep terms, the error text.

This is the only pass that can find a *correct entry nobody can reach*, which is
the failure that silently wastes a whole store.

## Step 7 — Prune the index, not the store

Run the lint first, and again when the pass is done:

```bash
node "$CLAUDE_PLUGIN_ROOT"/scripts/memory-lint.mjs --dir .loop/memory
```

Exit `2` means a blocking finding — `reach` (a body no trigger and no cluster
map can reach), `budget` (index over 40KB, or a trigger line over 200 chars),
`schema` (untyped `solutions/` frontmatter). The pass is finished when the
second run reports `reach` at zero; the `warn` rows are judgement calls to read,
not a queue to empty.

The lever is **Consolidate** and **Demote**: state the principle a cluster shares
as one entry, keep the cases as bodies it names. The budget is a signal to run
maintenance, **not a quota to hit** — never demote an entry because it was last
in the file, and never keep a wrong one because the index was comfortably short.
When the lint says the commentary share alone is the overage, moving those notes
to `<root>/_maintenance.md` is the pass: it costs no entry at all.

Bodies are not pruned by size. An entry that outgrew a paragraph is a
`solutions/` candidate by the escalation rule, not a line to trim.

## Step 8 — Sweep the exhaust

Run `node "$CLAUDE_PLUGIN_ROOT"/scripts/loop-archive.mjs hygiene` to clear the
session-tool droppings that settle wherever a tool was run from — they have been
found nested inside `memory/` itself, where they also make the store look written
to. The sweep deletes only known exhaust nobody authored.

Loose evidence is **reported, not moved**: deleting exhaust is safe because
nobody wrote it, while relocating someone's evidence needs the context you have
and the script does not. Act on the suggested move, or say why the file is
deliberately global.

Archived-run retention (`loop-archive.mjs prune`) is deliberately not run here:
it needs `--yes` and it deletes history, so it stays a decision the user makes.
Name it when the archive has grown past use.

## Output

Report: N candidates harvested → M kept (X learnings, Y solution entries), what
the epic rollup gained, what was promoted (and how it passed the gate), what the
hit-rate pass changed, what was consolidated or demoted, and what the hygiene
sweep removed or flagged. Quote the actual trigger lines added.
