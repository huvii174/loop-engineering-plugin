---
name: loop-memory
description: Compounding memory contract for loop runs — three memory shapes (one-line learnings, full solution entries, epic rollups), three tiers with a promotion gate, recall budget, and five-outcome maintenance. Load when running /loop-engineering:memory or /loop-engineering:breakdown, or writing anything under .loop/memory/.
---

# Loop Memory — Compounding Contract

**Every run must leave the system smarter than it found it.** Memory compounds
only if future sessions actually read it and it actually changes their behavior —
so it must be small, grounded, deduplicated, and shaped to fit what it records.

## Three shapes — one size does not fit all knowledge

A one-line entry is right for knowledge where *the action itself is the
knowledge*. It is wrong for a debugging journey (loses the reasoning that tells a
future session **whether the entry even applies**), for design decisions (loses
the rejected alternatives), and for dead hypotheses (loses the *why*, which is
the only part that prevents a re-run).

| Shape | File | Holds |
|---|---|---|
| One-liner | `learnings.md` | Environment facts, gotchas, reusable patterns |
| Full entry | `solutions/<slug>.md` | Non-trivial solved problems — the narrative |
| Epic rollup | `epics/<epic-slug>.md` | What a multi-sub-goal epic taught, per item + retro |
| Decisions | `decisions.md` | Choices made, with rejected alternatives |

**Escalation rule (a rule, not a vibe).** A learning is written as a full
`solutions/` entry when ANY of these holds; otherwise it stays a one-liner:

- **(a)** the fix took more than 2 iterations, **or**
- **(b)** the root cause differed from the first hypothesis, **or**
- **(c)** "when does this apply?" cannot be answered in one line.

## Tiers and the promotion gate

Three tiers, borrowed from memory-engineering: **scratch is cheap to write,
durable is expensive to promote.**

| Tier | Written when | Trust | Location |
|---|---|---|---|
| **scratch** | mid-iteration, immediately | low — unreviewed | `learnings.md` → `## Scratch (this run)` |
| **durable** | end of run, after distilling | medium | the shape-appropriate file above |
| **host** | after an explicit gate | high — affects every session | host `CLAUDE.md` |

**The gate:** nothing reaches the host project's `CLAUDE.md` without either the
user confirming it or the `loop-engineering:loop-verifier` agent confirming the
claim is evidence-backed. `CLAUDE.md` is loaded into every future session — an
unreviewed line there is a permanent tax. Scratch entries are **never** promoted
directly; they must survive distillation into durable first.

## `learnings.md`

```markdown
# Learnings

## Never store
- secrets, tokens, credentials, connection strings
- customer or personal data, internal client names
- anything the user marked confidential

## Environment
- [env][build] run `pnpm test --filter api`, not the full suite — full suite needs docker, times out (run-2026-07-29, iter 3)

## Gotchas
- [gotcha][auth] session cookies need `sameSite: lax` in dev — Safari drops them otherwise (run-2026-07-29, iter 4)

## Patterns
- [pattern][api] validate at the route boundary, not in handlers — keeps handlers unit-testable (run-2026-07-29, iter 2)

## What didn't work
- [dead][cache] resolver-layer caching — invalidation needs a cross-tenant event the system doesn't emit (run-2026-07-29, iter 5)

## Scratch (this run)
- raw note, unreviewed — distilled or deleted at end of run
```

Rules:
- **`## Never store` is data, not prose** — a declared list can be checked before
  every write; a rule buried in narrative gets skipped. Read it first, every time.
- One line, imperative, **with the why attached** — a learning without a why gets
  ignored or misapplied.
- **Tag every entry `[type][area]`** so retrieval is greppable by field
  (`grep '\[gotcha\]\[auth\]'`) instead of by hope. Types: `env`, `gotcha`,
  `pattern`, `dead`. Area is the module/domain in this repo's own vocabulary.
- **Ground claims**: behavioral claims about code cite `file:line`; unverified
  claims are attributed ("per this run's conclusion…"), never stated as fact.
  Cite **PR numbers, not bare SHAs** — SHAs are rewritten by squash/rebase merges.
- Tag with run id + iteration so stale entries can be audited.
- **Budget ~60 durable one-liners.** Over budget → run maintenance before adding.
  Past ~40, prefer moving narrative-shaped entries out to `solutions/`.
- `## Scratch` must be **empty at the end of every run** — distilled or deleted.

## `solutions/<slug>.md`

One file per non-trivial solved problem. Frontmatter is typed so the store stays
greppable by field:

```markdown
---
type: bug | knowledge
area: <module/domain>
date: 2026-07-29
run: run-2026-07-29
severity: low | medium | high
root_cause: wrong-api | missing-config | async-timing | scope | test-isolation | data-shape | dependency | logic | unknown
status: current | stale
stale_reason: <required when status: stale>
---

# <one-line problem statement>

## Problem
## Symptoms
## What didn't work
<each failed attempt + why it failed — this is the section that prevents re-runs>
## Solution
## Why this works
## When this applies
<the discrimination: what looks similar but is NOT this>
```

For `type: knowledge` (a pattern or decision rather than a defect), replace
Symptoms/What-didn't-work with **Context** and **Guidance**.

**`status: stale` is a legitimate terminal state.** When evidence is insufficient
to rewrite an entry that reality has outgrown, mark it stale with a reason rather
than guessing at a rewrite — err toward stale-marking over incorrect action.

## `epics/<epic-slug>.md`

Written by `/loop-engineering:breakdown` (created) and appended by
`/loop-engineering:loop` at every sub-goal stop. This is the file that makes
epic-level knowledge compound — without it, `epic-planner` has nothing to learn
from and every breakdown starts from zero.

```markdown
---
epic: <name>
started: 2026-07-29
status: in-progress | done | abandoned
---

# Epic: <name>

## Per sub-goal
| # | Sub-goal | Outcome | Iterations | What it taught | Slice verdict |
|---|----------|---------|-----------|----------------|---------------|
| 1 | clean git repo | done | 3 | history audit must precede any push — rewriting later is expensive | well-sliced |
| 2 | create GitHub repo | stuck→done | 5 | `gh` auth was the real blocker, not the repo creation | too coarse — should have been 2 items |

## Epic retro (written when the last item closes)
- **Slices that were wrong:** <which, and the signal that would have caught it at breakdown time>
- **Seed criteria that were wrong:** <which `Done when:` lines didn't survive contact, and why>
- **Ordering:** <did risk-first hold? what should have gone earlier?>
- **One change for the next breakdown:** <exactly one — bounded so it actually happens>
```

The **Slice verdict** column is the feedback signal `epic-planner` needs: it is
the difference between "we shipped the epic" and "we learned how to slice this
kind of epic".

## `decisions.md`

```markdown
# Decisions
- **<decision>** — <rationale>; alternatives rejected: <x, y> (run-id / epic-slug)
```

Records both breakdown sign-off decisions **and** per-sub-goal design-gate
choices. A design decision that lives only in an archived `design.md` is
effectively lost — the design gate must mirror it here.

## Maintenance — five outcomes per entry

Classify every touched entry as **Keep / Update / Consolidate / Replace / Delete**:

- **Keep** — prefer no-write Keep; never edit just to leave a breadcrumb, no
  cosmetic churn.
- **Update** — evidence contradicts the entry: match the memory to reality, not
  the reverse. New evidence wins; note the correction.
- **Consolidate** — apply the **Retrieval-Value Test**: "if someone searched this
  topic in six months, would two separate entries improve discoverability, or
  just create drift risk?" Overlapping entries drift apart and contradict each
  other — worse than one slightly longer entry.
- **Replace** — the premise is obsolete but the topic is live: rewrite.
- **Delete, don't archive** — no archive section; git history is the archive.
  Before deleting, check the problem domain is actually gone (code removed ≠
  problem gone).

Cross-entry **contradictions are more urgent than staleness** — they actively
mislead. Resolve them first. Refresh order matters: one-liners and `solutions/`
first, epic rollups second — a stale learning makes an epic retro look more valid
than it is.

## Promotion to host project memory

| Learning scope | Destination |
|---|---|
| Only this goal | stays in `.loop/memory/` |
| Whole repo (build/test commands, conventions, standing gotchas) | host `CLAUDE.md` → `## Learnings` — **through the gate** |
| Cross-project workflow preference | tell the user; let them place it |

- Read the host `CLAUDE.md` first; match its tone and structure; create the
  `## Learnings` section only if absent.
- If the host already has a memory system (`AGENTS.md`, `.claude/rules/*`,
  oh-my-claudecode notepad/project-memory), **merge into that** rather than adding
  a second store — fragmented memory is worse than none.
- Check `## Never store` before every promotion.

## Recall — the other half of compounding, under a budget

"Retrieval without a budget is just context spam." Recall procedure:

1. **Grep by tag/frontmatter field first**, using this repo's own vocabulary —
   `[gotcha][auth]`, `area: auth`, `root_cause: async-timing`. Field search beats
   reading files.
2. Self-correct breadth: more than ~25 candidates → narrow; fewer than 3 →
   broaden to full-text search.
3. **Load at most 5 entries per iteration** (default budget; raise only for a
   deliberately broad task). Prefer the most specific matches over the most recent.
4. Nothing found is useful signal too — say so, and note the current work may be
   worth capturing.

Who recalls what:
- `/loop-engineering:breakdown` reads `epics/*` **before** proposing a split, and
  `decisions.md` before interviewing
- `/loop-engineering:design` reads `learnings.md` + relevant `solutions/` before
  interviewing — never re-ask an answered question
- `/loop-engineering:loop` recalls before iteration 1 and applies gotchas
  proactively
- `/loop-engineering:memory` reads existing entries before merging (dedupe)

**Recall discipline:** memory is **supplementary context, never primary
evidence** — current code and command output outrank past notes. A past learning
must never silently override present evidence; when they conflict, surface the
conflict and fix the memory rather than echoing it.
