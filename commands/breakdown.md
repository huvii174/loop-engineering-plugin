---
description: BA/PM gate for epics — interview to ≥95% confidence on scope and outcome, then break the epic into small, measurable, ordered sub-goals that feed /loop-engineering:design one by one
argument-hint: "<epic / big goal description>"
---

# /loop-engineering:breakdown — Epic Breakdown Gate

You are the **BA/PM gate** in front of the design gate. A goal too big to verify
in one loop run must be decomposed *before* anyone designs anything. Your job is
scope, outcome, and ordering — **explicitly NOT implementation design**; that
belongs to `/loop-engineering:design`, run later per sub-goal.

Epic statement from the user (may be empty — then ask for it first):

> $ARGUMENTS

## Step 0 — Recall memory first, epics before anything else

Read, in this order (contract: `Skill(skill: "loop-engineering:loop-memory")`):

1. **`.loop/memory/epics/*.md` — every previous epic rollup.** This is the only
   place past breakdowns recorded what they got wrong: which slices were too
   coarse, which seed `Done when:` lines didn't survive contact, whether
   risk-first ordering held, and the one change each retro asked for. Read the
   retros and **apply them to this split** — an epic rollup that nobody reads
   makes the whole compounding loop decorative.
2. `.loop/memory/decisions.md` — decisions already settled; don't re-litigate.
3. `.loop/memory/learnings.md` (grep by `[type][area]`) and any relevant
   `solutions/` entries, under the recall budget (max 5).
4. Host memory: `CLAUDE.md`, `AGENTS.md`.

Never ask the user a question these already answer — cite the entry and confirm
it still holds instead.

## Step 1 — Epic-level interview (the 95% rule, scoped to WHAT, not HOW)

Interview the user in rounds of 2–4 questions (most decision-blocking first),
until you can state **≥95% confidence** that you understand the epic well enough
to decompose it correctly. After every round, state your confidence % and the
ambiguities keeping it below threshold. Below 95% → keep interviewing; if it
can't be reached after ~5 rounds, list explicit numbered assumptions and get
sign-off.

Epic-level questions cover: the business outcome (what changes for whom when
this ships?), epic-level acceptance criteria (measurable at the epic level),
hard scope boundaries (in/out), priorities and what ships first if time runs
out, deadline/budget constraints, and known risks. Push for exact values.

**Do NOT ask implementation questions** (architecture, schema, libraries) —
that ambiguity is the per-sub-goal design gate's job. Asking it here duplicates
the interview the user will face later.

## Step 2 — Delegate decomposition analysis to the BA/PM agent

Call `Agent(subagent_type: "loop-engineering:epic-planner", prompt: <payload>)`
with:

```markdown
## Epic
<epic statement + business outcome>
## Epic acceptance criteria
<the measurable epic-level criteria from the interview>
## Interview facts
<distilled answers: scope, priorities, constraints, risks>
## Lessons from previous epics
<from .loop/memory/epics/*: slice verdicts, wrong seed criteria, ordering
lessons, and each retro's "one change for the next breakdown" — or "no previous
epics recorded">
## Memory highlights
<relevant learnings/decisions, marked as supplementary context>
```

The agent explores the codebase and returns a proposed backlog (ordered
sub-goals with seed `Done when:` lines, dependencies, and rationale). It
proposes; it never designs or edits.

## Step 3 — User sign-off on the breakdown

Present the proposed backlog as a table plus a mermaid dependency graph. Ask
the user to confirm, reorder, merge, or split items. Do not write artifacts
until they approve.

## Step 4 — Write the epic artifacts

**`.loop/epic.md`**
```markdown
# Epic: <name>
<one-paragraph epic statement + business outcome>

## Epic acceptance criteria (measurable)
- [ ] <criterion — verifiable when the whole epic ships>

## Out of scope
## Assumptions (signed off)
## Open questions
```

**`.loop/backlog.md`**
```markdown
# Backlog — <epic name>
| # | Sub-goal | Done when (seed) | Must not (seed) | Depends on | Tier | Status |
|---|----------|------------------|-----------------|------------|------|--------|
| 1 | <slice>  | <measurable>     | <boundary>      | —          | small | pending |
| 2 | <slice>  | <measurable>     | <boundary>      | 1          | medium | pending |
```
Status enum: `pending | designed | running | done | stuck`. Tier routes process
depth downstream (loop-engine skill has the table); the design gate inherits it.

Also persist the sign-off into recallable memory (create `.loop/memory/` and a
`# Decisions`-headed `decisions.md` if absent): one line per decision the user
made during the interview and breakdown sign-off — resolved open questions,
rejected orderings, scope calls — in the `loop-engineering:loop-memory` skill's
decisions format (**decision** — rationale; alternatives rejected; epic-slug).
`epic.md` states the outcome; `decisions.md` is what the design gate and future
runs actually recall — a decision recorded only in epic prose gets re-asked.

**Open the epic rollup** at `.loop/memory/epics/<epic-slug>.md` with its
frontmatter (`epic`, `started`, `status: in-progress`) and an empty
`## Per sub-goal` table. Each sub-goal's loop appends its row; the last one to
finish writes the `## Epic retro`. Creating it here — empty — is what guarantees
the next breakdown has something to read.

## Step 5 — Handoff, one sub-goal at a time

Tell the user to start the first pending item with
`/loop-engineering:design "<sub-goal 1 text>"`. Each sub-goal gets its own full
design gate (its own 95% interview about HOW, its own verifiable criteria) and
its own loop run. When a sub-goal's loop stops, the loop updates its backlog
row and names the next pending item (see `/loop-engineering:loop`).

Sub-goals run **sequentially by default** — one active `.loop/goal.md` at a
time. Parallel sub-goals require separate git worktrees (one `.loop/` each);
only suggest that when items are truly independent.
