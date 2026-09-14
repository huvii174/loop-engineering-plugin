---
name: loop-memory
description: Compounding memory contract for loop runs — index/body split so the store grows without growing what every run reads, four memory shapes, three tiers with a promotion gate, recall under a budget with recorded applied/dismissed verdicts, and six-outcome maintenance. Load when running /loop-engineering:memory or /loop-engineering:breakdown, or writing anything under .loop/memory/.
---

# Loop Memory — Compounding Contract

**Every run must leave the system smarter than it found it.** Memory compounds
only if future sessions actually read it and it actually changes their behavior —
so it must be grounded, deduplicated, shaped to fit what it records, and cheap to
read at the moment of need.

## Index and body — growth without cost

A long-lived project's knowledge grows without bound. What must stay flat is the
cost of **reading it by default**. So every durable entry splits in two:

| Half | Holds | Cost | Cap |
|---|---|---|---|
| **trigger** — one line in `_index.md` | the symptom a future session will recognise | loaded every recall | 200 chars |
| **body** — the entry under its `###` anchor | mechanism, measurements, run refs | read only when its trigger fires | none |

The index is the store's map and the only part loaded by default; a body is
reached by anchor (`grep -A 20 '^### L-042' .loop/memory/learnings/gotchas.md`).

**A flat store predates this layout and must be migrated, never scaffolded
over.** A populated `learnings.md` or `decisions.md` beside a fresh `_index.md`
is the worst state the store can be in: the index is authoritative to every
reader, so the flat file's knowledge silently stops being recalled. On meeting
one, run `node "$CLAUDE_PLUGIN_ROOT"/scripts/migrate-memory.mjs --dry-run`, show
the plan, then migrate — the sources are renamed to `*.pre-migration`, not
deleted. Until that has happened, do not create either `_index.md`.
Growth therefore lands in bodies, which are unbounded, while the index grows only
with the number of distinct **kinds** of problem — which grows far slower than
the number of incidents, and slower still once the consolidation trigger below
starts firing.

**A trigger names the symptom, not the lesson.** Write the error text, API name
or file name a future session will have in front of it — that string is what
recall matches on. "Assertions must be narrow" matches nothing; `"rejected SSL
upgrade" / all route tests ERROR at fixture setup` matches the session that needs
it.

## Four shapes — one size does not fit all knowledge

A one-line entry is right for knowledge where *the action itself is the
knowledge*. It is wrong for a debugging journey (loses the reasoning that tells a
future session **whether the entry even applies**), for design decisions (loses
the rejected alternatives), and for dead hypotheses (loses the *why*, which is
the only part that prevents a re-run).

| Shape | Location | Holds |
|---|---|---|
| Learning | `learnings/_index.md` + `learnings/<type>.md` | Environment facts, gotchas, reusable patterns, dead ends |
| Full entry | `solutions/<slug>.md` | Non-trivial solved problems — the narrative |
| Decision | `decisions/_index.md` + `decisions/<epic>/item-<N>.md` | Choices made, with rejected alternatives |
| Epic rollup | `epics/<epic-slug>.md` | What a multi-sub-goal epic taught, per item + retro |

**Escalation rule (a rule, not a vibe).** A learning is written as a full
`solutions/` entry when ANY of these holds; otherwise it stays a learning:

- **(a)** the fix took more than 2 iterations, **or**
- **(b)** the root cause differed from the first hypothesis, **or**
- **(c)** "when does this apply?" cannot be answered in one line.

## Tiers and the promotion gate

Three tiers, borrowed from memory-engineering: **scratch is cheap to write,
durable is expensive to promote.**

| Tier | Written when | Trust | Location |
|---|---|---|---|
| **scratch** | mid-iteration, immediately | low — unreviewed | `scratch/run.md` |
| **scratch (ad-hoc)** | during non-loop work, immediately | low — unreviewed | `scratch/adhoc.md` |
| **durable** | end of run, after distilling | medium | the shape-appropriate location above |
| **host** | after an explicit gate | high — affects every session | host `CLAUDE.md` |

**The gate:** nothing reaches the host project's `CLAUDE.md` without either the
user confirming it or the `loop-engineering:loop-verifier` agent confirming the
claim is evidence-backed. `CLAUDE.md` is loaded into every future session — an
unreviewed line there is a permanent tax. Scratch entries are **never** promoted
directly; they must survive distillation into durable first.

## `learnings/`

```
learnings/
  _index.md      triggers, grouped by type — the only file read by default
  env.md         gotchas.md        patterns.md       dead-ends.md
```

Bodies shard by the entry's **type**, which is a closed set, so the tag an entry
already carries decides its file with no judgement call at write time.

`_index.md`:

```markdown
# Learnings index

## Never store
- secrets, tokens, credentials, connection strings
- customer or personal data, internal client names
- anything the user marked confidential

## env
- L-001 [env][docker] worktree DB tests all ERROR at fixture setup / "rejected SSL upgrade" — needs 3 env vars

## gotcha
- L-042 [gotcha][frontend] outside-click handler misses every target; jsdom passes, real browser does not
```

`gotchas.md`:

```markdown
### L-042 [gotcha][frontend] outside-click must listen on pointerdown

A hand-rolled outside-click handler MUST listen on `pointerdown`, never `click`.
Any Radix primitive with `disableOutsidePointerEvents` sets `pointer-events: none`
on `document.body` while open, so a real browser RETARGETS `pointerup`/`click` up
to `<html>` and every `target.closest(...)` guard answers "no". jsdom implements
no retargeting, so a broken handler passes its tests. (run-2026-08-25-uds-postmerge)
```

Rules:

- **`## Never store` is data, not prose** — a declared list can be checked before
  every write; a rule buried in narrative gets skipped. It sits at the top of the
  index, so it is read before every write. Read it first, every time.
- Every entry has an **ID** (`L-NNN`, assigned in order, never reused) carried by
  both halves. The ID is how a run cites what it applied.
- **Tag every entry `[type][area]`** so retrieval is greppable by field
  (`grep '\[gotcha\]\[auth\]'`) instead of by hope. The type set is **closed**:
  `env`, `gotcha`, `pattern`, `dead` — and it is also the shard key. A fifth type
  is a change to this skill, not a choice made mid-run.
  Area is the module/domain in this repo's own vocabulary.
- **The why lives in the body, the symptom in the trigger.** A body without a why
  gets misapplied; a trigger that states the why instead of the symptom never
  fires.
- **Ground claims**: behavioral claims about code cite `file:line`; unverified
  claims are attributed ("per this run's conclusion…"), never stated as fact.
  Cite **PR numbers, not bare SHAs** — SHAs are rewritten by squash/rebase merges.
- Tag with run id + iteration so stale entries can be audited.
- **The budget is on the index, not the store.** Keep every index line inside 200
  chars; when the index itself passes ~40KB, run maintenance. Bodies are
  uncapped — an entry that outgrows a paragraph is a `solutions/` candidate by
  the escalation rule, not a line to trim.
- `scratch/` must be **empty at the end of every run** — distilled or deleted.

## `solutions/<slug>.md`

One file per non-trivial solved problem. Frontmatter is typed so the store stays
greppable by field:

```markdown
---
id: S-042
aliases: [<former slug>, …]
type: bug | knowledge
area: <module/domain>
date: 2026-07-29
run: run-2026-07-29
severity: low | medium | high        # optional
caught_at: merged | review | in-run   # how far it got before something caught it
root_cause: wrong-api | missing-config | async-timing | scope | test-isolation
          | data-shape | dependency | logic | unmeasured-claim | harness
          | incomplete-model | unknown
root_cause_note: <optional free text when the closed value loses something>
status: current | stale
stale_reason: <required when status: stale>
must_not: <one checkable prohibition, written as a goal.md `Must not:` line>
red_probe: <optional — the one-line mutation or command that makes it red>
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

**`caught_at` is the field that discriminates, and `severity` is the one that
stopped.** A real corpus graded 79% of itself `high` — a filter that returns
almost everything is not a filter, and the write cost bought nothing. `caught_at`
records a fact instead of a judgement: `merged` (it reached the branch or
production before anything caught it), `review` (the gate or the verifier caught
it), `in-run` (caught while the work was still open). Leave it **absent** rather
than guess: on the store this was derived from, a keyword pass over "merged" and
"shipped" was wrong on 5 of 24 entries — three were counterfactual ("would have
shipped"), two described a ProseMirror node merge. `severity` stays optional for
entries that already carry a considered one.

The last three causes name failures of *verification* rather than of code:
`unmeasured-claim` (nothing that ran measured it), `harness` (the apparatus was
wrong, not the subject), `incomplete-model` (the model missed a case). They were
added from evidence — a real store produced 17 values outside the original nine
in six weeks, and the class they name accounts for most of its entries, so
`unknown` had been absorbing its sharpest signal. **The set stays closed**: a
thirteenth value is a change to this skill, not a choice made mid-run.

**`must_not` is what turns an entry from advice into a constraint**, and it is
required for `type: bug`. In a real epic, `solutions/false-green-evidence.md` was
recalled and marked `applied` on two separate iterations, with what it changed
written out — and that same epic produced its thirteenth and fourteenth
false-green instances anyway. Another entry was `applied` three times in one run
as *recovery*, after the criteria it warns about had already been written wrong.
Recall was not the failing half: the entry was found, read and consciously used.
A principle raises vigilance; only a line the verifier already checks changes an
outcome, and `Must not:` is that line. Write it as one, testable as written:

- ✅ `No test cited as evidence may pass with its target assertion deleted`
- ✅ `No criterion closes on emitted text — the emitted function must be executed`
- ❌ `Be careful about tests that cannot fail` (nothing to check)

The design gate copies the `must_not` of every entry it marks `applied` into the
relevant criterion's `Must not:` lines, tagged with the entry's ID. From there
the verifier's boundary check enforces it without knowing memory exists.

**The slug is a trigger too.** Recall scores a solution on its filename and
frontmatter, so the slug must carry at least one concrete technical term someone
would type — `docker-cp-writes-through-a-bind-mount`, `jsdom-lacks-range-rects`.
A slug made only of abstractions (`a-bound-that-admits-its-own-defeat`) is a good
title and an unreachable entry; put the epigram in the `#` heading, where it costs
nothing, and spend the filename on words that match.

**`id:` is the handle; the slug is the name, and they are not the same thing.**
Rewriting a bad trigger is the fix the hit-rate pass prescribes most often, so it
has to be cheap. While an entry was addressed by its filename it was not: a real
store had 65 of 66 entries carrying inbound references, 285 in total, and the
four renames it had already scheduled would have broken 33 of them — the cost of
the fix was protecting the broken trigger from being fixed. The `id` never
changes, the filename is free to, and every former name goes in `aliases:` so
recall still matches the old vocabulary and the hit-rate pass can join a renamed
entry to its own dismissal history.

Assign handles with `migrate-memory.mjs --solutions` (deterministic by `date`
then filename, idempotent, never reuses a taken number). Write both halves in a
`Recall:` line — `S-042 (docker-cp-writes-through-a-bind-mount) applied` — so the
record stays readable to a person and joinable by a script. One risk comes with
the handle: two parallel runs can allocate the same number, so `memory-lint`
blocks on a duplicate.

**`status: stale` is a legitimate terminal state.** When evidence is insufficient
to rewrite an entry that reality has outgrown, mark it stale with a reason rather
than guessing at a rewrite — err toward stale-marking over incorrect action.

## `decisions/`

```
decisions/
  _index.md              one line per decision, grouped by epic
  durable.md             cross-epic and process decisions
  <epic-slug>/item-<N>.md
```

Records both breakdown sign-off decisions **and** per-sub-goal design-gate
choices. A design decision that lives only in an archived `design.md` is
effectively lost — the design gate must mirror it here.

```markdown
### D-759-017 · active · 2026-08-31 · item 35
**Decision:** raise `breaker_thresholds.plateau` from 4 to 9 for this item's loop
**Rationale:** the design's 7 work groups mean the whole-toolbar criteria can only
close after the last group, so `criteria_passed` correctly stays 0 through
iterations 1-6 despite verified progress
**Alternatives rejected:** leaving the default (false-trips mid-migration);
re-slicing the item into 7 goals (the criteria are only checkable together)
```

- **ID and status on the anchor line.** `D-<epickey>-NNN`, plus `active` or
  `superseded-by D-…`. A decision is never edited into a different conclusion:
  it is superseded by a new entry, and the old one keeps its record.
- **Sharding is by epic, tracing is by ID.** The directory makes an epic's
  decisions cheap to load and cheap to retire; supersede links carry the history,
  which is a graph and does not fit a directory.
- **`Alternatives rejected:` is mandatory, not a nicety.** A decision recorded
  without what it beat invites the next session to re-litigate it, which is the
  exact failure this file exists to prevent: the reader cannot tell whether the
  obvious-looking alternative was weighed and lost or never considered. If nothing
  was genuinely rejected, the entry is not a decision — it is a fact, and it
  belongs in `learnings/`. Write the alternative even when it embarrasses the
  decision; especially then.
- **Retire with the epic.** When an epic is archived, its decisions directory
  goes with it — `loop-archive.mjs epic` performs that move; promote a decision
  still binding on future work to `durable.md` FIRST, with its ID preserved and
  its index line regrouped, then drop the retired epic's group from
  `_index.md`.

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

**A rollup cites; it does not restate.** What an item decided lives in
`decisions/`, and the rollup names the ID (`decided at D-759-017`). Retelling it
here creates the second home that drifts.

## Maintenance — six outcomes per entry

Classify every touched entry as **Keep / Update / Consolidate / Replace / Demote /
Delete**:

- **Keep** — prefer no-write Keep; leave the entry byte-identical, no
  cosmetic churn.
- **Update** — evidence contradicts the entry: match the memory to reality, not
  the reverse. New evidence wins; note the correction.
- **Consolidate** — apply the **Retrieval-Value Test**: "if someone searched this
  topic in six months, would two separate entries improve discoverability, or
  just create drift risk?" Overlapping entries drift apart and contradict each
  other — worse than one slightly longer entry.
- **Replace** — the premise is obsolete but the topic is live: rewrite.
- **Demote** — the entry is still true but no longer earns an index line: fold
  its trigger into a neighbouring entry's and keep the body. The store keeps the
  knowledge; the index gets shorter. **Prefer Demote to Delete** for anything
  grounded — a body costs nothing until its trigger fires.
  **The fold is the whole outcome.** A body whose trigger simply stopped
  existing is not demoted, it is dropped: nothing scores body anchors, so it is
  unreachable by auto-recall and by a tag grep alike. `memory-lint` blocks on
  this (`reach`), because the check that is easy to run — the `### L-NNN` anchor
  is still there — passes either way. A real pass verified exactly that, reported
  "zero IDs lost", and left 126 of 509 bodies reachable by nothing.
- **Delete** — reserved for entries that are *wrong* or whose problem domain is
  gone. Check the domain is actually gone (code removed ≠ problem gone). No
  archive section: git history is the archive — **which holds only while
  `.loop/memory/` is tracked.** Git cannot un-ignore a child of an ignored
  directory, so a project that ignores `.loop/` ignores the store with it; the
  pattern that works is `.loop/*` + `!.loop/memory/` + `.loop/memory/scratch/`.
  `loop-reminder` says so at session start when it finds the store ignored.

**The consolidation trigger.** When one `[type][area]` cluster passes ~5 index
lines, consolidating it is due: state the principle they share as one entry, and
keep each case as a body (or a `solutions/` entry) that the principle names. This
is the mechanism that keeps the index growing with kinds rather than incidents,
and it is how a store gets *better* as it gets bigger instead of merely longer.

**Dead ends are kept as guardrails, not as history.** A `[dead]` entry earns its
place only while that path is still tempting: someone reading the current code
could plausibly propose it again. When the premise is gone — the API it used no
longer exists, a later decision settled the question, the subsystem was deleted —
the entry stops preventing anything. Demote it, and Delete only when it would
mislead. "We might want the history" is what git is for.

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
mislead. Resolve them first. Refresh order matters: learnings and `solutions/`
first, epic rollups second — a stale learning makes an epic retro look more valid
than it is.

## Trigger quality — the hit-rate pass

Every recall is recorded (see below), which turns the store's own usage into the
signal for maintaining it. Once per memory run, read the `Recall:` lines across
the run's iteration records — the durable half; `.recall-log` is an inbox each
Record step empties — and act on three patterns:

| Pattern | Reading | Action |
|---|---|---|
| injected, then `dismissed` for the same reason repeatedly | the trigger over-matches | narrow it — add the discriminating symptom |
| applied often | the trigger works | Keep, byte-identical |
| never injected while its topic was worked on | the trigger misses | rewrite it in the words the work actually used |

A never-injected entry is the common failure and it is invisible without this
pass: the knowledge is right, the trigger is written in the author's vocabulary
instead of the reader's.

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

Demote:

- A measured, grounded `[gotcha][mutation]` entry from an epic that closed, whose subsystem still exists. The body stays where it is; its index line folds into the neighbouring mutation-testing trigger. Nothing is lost, and the index is one line shorter.

**Do not prune toward a quota.** The index budget is a signal to run maintenance,
not a target to reach by demoting whatever is last. Classify every entry in
scope, group analogous ones under one principle, and record genuinely borderline
calls in the run's memory summary so the next maintenance pass inherits the
reasoning instead of re-deriving it.

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

"Retrieval without a budget is just context spam." Recall reads the index, then
reaches for bodies:

1. **Read `_index.md`** (learnings, and decisions for the epic in scope). This is
   the map; it is cheap and it is the default.
2. **Grep by tag/frontmatter field**, using this repo's own vocabulary —
   `[gotcha][auth]`, `area: auth`, `root_cause: async-timing`. Field search beats
   reading files.
3. Self-correct breadth: more than ~25 candidate triggers → narrow; fewer than 3
   → broaden to full-text search across bodies.
4. **Open the body of every trigger that matches the work in hand**, up to 5 per
   iteration (default budget; raise only for a deliberately broad task). Prefer
   the most specific matches over the most recent.
5. Nothing found is useful signal too — say so, and note the current work may be
   worth capturing.

**A matched trigger is not a recall.** The index line exists to tell you a body
exists; acting on the trigger alone applies half an entry, and the half it drops
is the one that says whether the entry applies at all. Read the body or record
why you did not.

**What the auto-recall hook spends a body slot on.** Two of five injections
arrive with their body inlined, and three rules decide which — all measured from
the store itself, none hand-tuned:

| Rule | Why |
|---|---|
| A keyword matching over 15% of index lines is dropped before scoring | Generic words rank the generic entry. One "Not fixed (minor)" note took 34 of 127 injections — 27% of every budget — on the strength of `document`, `status`, `query` |
| At the score threshold, the entry's `[area]` must appear in the prompt | An `ONLY when editing document_instances.py` prefix is prose; keyword matching does not read it. A clearly strong match still stands on its own |
| An ID the last 10 records dismissed 3+ times loses its slot, not its listing | The hit-rate pass rewrites that trigger once per memory run; between those, the entry keeps arriving |

`solutions/` entries are injected under their `id:` — falling back to `S:<slug>`
on a store that has not assigned handles yet — so they reach `.recall-log`, the
verifier's check 7 and the hit-rate pass like every other entry. Before that they
logged as `id: null`, which meant the deepest tier spent budget and left no trace
to maintain it by. `aliases:` are scored alongside the slug, so a rename costs an
entry none of its reachability.

Who recalls what:
- `/loop-engineering:breakdown` reads `epics/*` **before** proposing a split, and
  `decisions/_index.md` + the relevant epic's decisions before interviewing
- `/loop-engineering:design` reads `learnings/_index.md` + the bodies its seed
  dimensions match + relevant `solutions/` before interviewing — never re-ask an
  answered question
- `/loop-engineering:loop` recalls before iteration 1 and applies gotchas
  proactively
- `/loop-engineering:memory` reads existing entries before merging (dedupe), and
  runs the hit-rate pass

**Recall discipline:** memory is **supplementary context, never primary
evidence** — current code and command output outrank past notes. A past learning
must never silently override present evidence; when they conflict, surface the
conflict and fix the memory rather than echoing it.

### The recall record — `applied` or `dismissed`, never silent

Every entry the recall hook injects is logged to `.loop/.recall-log` — outside
`memory/`, so that recording a read can never make the store look written to.
**The log is an inbox**: every iteration record (and every design gate) carries
a **`Recall:`** line accounting for each ID currently in it, and then empties
it — the accounted line is the durable record, and an unemptied inbox makes the
next record answer for injections that were already judged:

```markdown
- **Recall:** L-042 applied (listener switched to pointerdown); L-017 dismissed
  (that entry is about the DB fixture leg; this item has no DB work)
```

Both verdicts are first-class. `dismissed` with a reason is a real judgement and
the cheapest half of this contract to write; what is forbidden is silence, which
is indistinguishable from never having read it. `loop-verifier` checks the line
against `.recall-log` and reports a missing ID the way it reports a criterion
with no evidence.

This record is also the input to the hit-rate pass above: dismissal reasons are
how a bad trigger gets found.

## Ambient memory — when no slash command is running

Slash commands recall and capture because their text says to. Ad-hoc sessions
("fix this bug", typed with no command) get the same flow from three
deterministic hooks — the push half of the system:

- **Recall, layer 1 (digest):** SessionStart prints one line naming what
  `.loop/memory/` holds, so the session knows the store exists and can grep it
  deliberately.
- **Recall, layer 2 (targeted):** every user prompt is keyword-matched against
  the indexes, `solutions/` slugs and ad-hoc scratch. The **strongest matches
  arrive with their body already inlined** — no follow-up read to forget — and
  weaker ones arrive as a trigger plus the exact `grep` that opens the body.
  Keyword match, not semantics — treat an empty injection as "nothing matched",
  never as "nothing exists".
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
every memory run: distilled or deleted, same rule as the run scratch.
