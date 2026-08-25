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
| **scratch (ad-hoc)** | during non-loop work, immediately | low — unreviewed | `scratch/adhoc.md` |
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
  (`grep '\[gotcha\]\[auth\]'`) instead of by hope. The type set is **closed**:
  `env`, `gotcha`, `pattern`, `dead`. A fifth type is a change to this skill,
  not a choice made mid-run — an open vocabulary is a store nobody can grep.
  Area is the module/domain in this repo's own vocabulary.
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

**`alternatives rejected:` is mandatory, not a nicety.** A decision recorded
without what it beat invites the next session to re-litigate it, which is the
exact failure this file exists to prevent: the reader cannot tell whether the
obvious-looking alternative was weighed and lost or never considered. If nothing
was genuinely rejected, the entry is not a decision — it is a fact, and it
belongs in `learnings.md`. Write the alternative even when it embarrasses the
decision; especially then.

## Maintenance — five outcomes per entry

Classify every touched entry as **Keep / Update / Consolidate / Replace / Delete**:

- **Keep** — prefer no-write Keep; leave the entry byte-identical, no
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

**Dead ends are kept as guardrails, not as history.** A `[dead]` line or a
`solutions/` entry whose value is "we tried this and it failed" earns its place
only while that path is still tempting: someone reading the current code could
plausibly propose it again. When the premise is gone — the API it used no longer
exists, a later decision settled the question, the subsystem was deleted — the
entry stops preventing anything and starts costing recall budget. Delete it.
"We might want the history" is what git is for.

**Never edit an entry into a different conclusion.** An entry that reality has
overtaken is Replaced (same topic, rewritten premise) or superseded by a new
entry that links back to it. Rewriting a `[dead]` line into a `[pattern]` line
destroys the record that the path was tried and failed, and the next run pays
for it again.

**Consolidation is a transfer, not a deletion.** Before removing an entry into
another one, carry over every unique piece it holds: the rationale, the
alternatives rejected, the consequence, each failed attempt with why it failed,
and any named gap. An entry absorbed without its failed attempts leaves the
merged record looking more confident than the evidence was.

**`.loop/archive/` is frozen and is not memory.** Never mine an archived run for
current facts, never edit one, and never cite one as authority. If knowledge in
a run still matters, it is promoted into `memory/` at that run's stop — that is
the whole point of the memory step firing on every stop, success or not.

Cross-entry **contradictions are more urgent than staleness** — they actively
mislead. Resolve them first. Refresh order matters: one-liners and `solutions/`
first, epic rollups second — a stale learning makes an epic retro look more valid
than it is.

## Calibration — worked examples, because the rules alone do not decide

Retention rules leave the hard cases open, and the hard cases are most of them.
These examples set the bar. **Length and age are discovery aids, never
criteria**: grep the longest entries first because they are where dead weight
hides, then judge each one on whether it would change a future session's
behavior. A 14-word line can be load-bearing and a 300-word entry can be inert.

Keep:

- `[env][test] run \`pnpm test --filter api\`, not the full suite — full suite needs docker, times out` (17 words). An environment fact no file in the repo states, and the next run wastes ten minutes without it.
- `[gotcha][auth] session cookies need sameSite: lax in dev — Safari drops them otherwise` (13 words). A boundary condition invisible from reading the code.
- `solutions/webhook-retry-storm.md` (410 words). Its "When this applies" section discriminates it from a timeout bug that looks identical at the symptom level; that discrimination is the whole value.
- `[dead][cache] resolver-layer caching — invalidation needs a cross-tenant event the system doesn't emit` (14 words). Keep while the resolver exists and caching there still looks attractive: it is preventing a real, tempting mistake.

Delete:

- `[pattern][api] prefer clear names` (5 words). True everywhere, actionable nowhere, and it matches every grep for `[pattern][api]` while carrying nothing.
- `[env][build] the project runs on Node 22` (8 words). The `engines` field already says so: one home per fact, and the file that ships with the code wins.
- `solutions/legacy-import-crash.md` (600 words). The module it describes was deleted two goals ago; the problem domain is gone, not just the code.
- `[dead][ui] tried the old modal API` (7 words). That API no longer exists, so the entry prevents nothing.

Consolidate:

- Three `[gotcha][auth]` lines describing the same cookie behavior from three runs. Apply the Retrieval-Value Test: a future search wants one entry, not three near-duplicates that will drift apart and start contradicting each other.

**Do not prune toward a quota.** The ~60-line budget is a signal to run
maintenance, not a target to reach by deleting whatever is line 61. Classify
every entry in scope, group analogous ones under one principle, and record
genuinely borderline calls in the run's memory summary so the next maintenance
pass inherits the reasoning instead of re-deriving it.

## Prose that survives recall

Memory is read under a budget, by a reader who will act on it. Hunt these in
every entry before it is written:

- The same fact in two entries. Keep one home; the other links or dies.
- Narrated history: "previously we used X", "this used to fail", "after the
  refactor". State the current fact; the run id already carries the when.
- Status annotations that rot: "currently broken", "being fixed next run",
  "TODO". Status belongs in `state.json` and the backlog, not in memory.
- The reasoning transcript instead of the conclusion. Keep what was learned and
  the evidence for it; delete the path used to derive it.
- A rationale repeated beside every sibling entry rather than stated once at the
  entry that owns it.
- Emphasis on everything: when three words per line are bold, nothing is.
- Future tense in a durable entry ("we should", "we will move to"). A durable
  entry describes what is; an intention belongs in the backlog.
- A fact with no why attached. It will be misapplied by the first session that
  meets a case the original author would have recognised as different.

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

## Ambient memory — when no slash command is running

Slash commands recall and capture because their text says to. Ad-hoc sessions
("fix this bug", typed with no command) get the same flow from three
deterministic hooks — the push half of the system:

- **Recall, layer 1 (digest):** SessionStart prints one line naming what
  `.loop/memory/` holds, so the session knows the store exists and can grep it
  deliberately.
- **Recall, layer 2 (targeted):** every user prompt is keyword-matched against
  learnings/decisions/solutions/ad-hoc scratch; the top matches (respecting the
  5-entry budget) are injected as context, labeled supplementary. Keyword grep,
  not semantics — treat an empty injection as "nothing matched", never as
  "nothing exists".
- **Capture (nudge, once):** at session stop, if files were edited while
  working through errors and nothing under `.loop/memory/` was touched, the
  memory-gate blocks once and asks for ONE line in `scratch/adhoc.md`:

  ```markdown
  - [adhoc][<area>] <fact> — <why> (YYYY-MM-DD)
  ```

**`scratch/adhoc.md` is scratch, not durable memory.** Ad-hoc sessions append
one-liners there and never write durable files directly — distillation needs
judgment, and it happens in `/loop-engineering:memory` (which harvests this file
even when run standalone, with no loop record). The file must be empty after
every memory run: distilled or deleted, same rule as `## Scratch (this run)`.
