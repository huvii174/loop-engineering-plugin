# Changelog

## 0.16.0 — 2026-09-14

**The record is code, for the same reason the breaker is.** Measured against a
real six-week store of 75 archived runs: 37 of 311 history entries sat outside
`pass|fail|escalate` — `"verifier: REJECT (criterion 3) / APPROVE (1,2,4,5)"`,
`"self-verified green"`, `"partial"`, `null` — and every one was invisible to
`trailingFails`, which compares `=== 'fail'`. Run `759-5` recorded two
consecutive verifier REJECTs on one criterion, the exact streak the stagnation
threshold exists to catch, and the counter read zero. The loop wrote its history
in prose and asked a script to count it; only one of those two contracts held.

- **`scripts/loop-record.mjs` is the only writer of `state.json.history`.** It
  takes `--verdict` (the enum, not a sentence) and `--kind`, appends the entry,
  bumps `iteration`, and refuses rather than half-writes: a verdict outside the
  enum, a `kind` outside `criterion|review-fix|bookkeeping`, a missing
  `criteria_passed`, an iteration record that does not exist or lacks
  `Verdict:` / `Evidence:` / `Recall:`, an `iteration` that disagrees with
  `history` (27 of 75 archived runs carry that mismatch), or a `.recall-log` ID
  the record never accounts for. It fails **closed** where the hooks fail open —
  a hook that breaks must not block a user, a recorder that breaks must not
  leave half a history behind — and every check runs before the single write.
- **The recall inbox is emptied by the thing that replaces it.** `.recall-log`
  is truncated only after the record accounting it is on disk, so a crash
  between the two leaves the IDs to be answered again rather than lost. The real
  store's log had grown to 127 lines spanning three days and several runs.
- **The breaker reads verdicts through one normalizer.** History written before
  the recorder is coerced — a mixed verdict maps to its *worse* half, because a
  rejected criterion is what the next iteration owes — and every coercion is
  named in a warning on stderr. `record_contract_since` marks where the enum
  began to hold; at or after it, an out-of-enum verdict is exit `1` rather than
  a guess, because a record written by the script and still outside the enum
  means the script was bypassed. Replaying the real archive, `759-5` now reports
  `trailing_fails: 2` where it reported 0.
- **Plateau steps over review-gate fixes.** `kind: review-fix` marks an
  iteration that closed a review finding rather than a criterion; the
  criteria-met count is flat by construction while those run. Run `759-36`
  tripped `STOP (plateau)` at the close of a goal whose every criterion was
  already verifier-approved, and wrote the fix into its own record on 2026-09-03:
  *"otherwise a thorough review gate is structurally punished, and the incentive
  is to run a shallower gate."* The failure chain is untouched — a review-fix
  that fails is a failure like any other — and `kind` is read from a field rather
  than inferred from the `criterion` string, because a machine reading prose is
  the defect the verdict enum just closed.
- **`confidence_at_design` is a number, and the escape hatch has a shape.** The
  template held a placeholder string, so 22 of 75 runs filled it with an essay
  ("hands-off: no interview; 6 numbered assumptions") and ten ran at 85–93%
  against a gate that asks for 95 with nothing recording what was assumed
  instead. It now holds an integer, prose moves to `confidence_note`, and the
  numbered assumptions travel in `assumptions` — the breaker refuses to start a
  sub-95 run that carries neither. A legacy string warns rather than stops: the
  run it describes is already history.
- **Recall becomes a constraint, not context.** The store's own record is what
  forced this: `solutions/false-green-evidence.md` was recalled and marked
  `applied` on two separate iterations of one epic, with what it changed written
  out — and that epic produced its thirteenth and fourteenth false-green
  instances anyway. Another entry was `applied` three times in a single run as
  *recovery*, after the criteria it warns about were already written wrong.
  Retrieval was never the failing half. A `solutions/` entry now carries one
  `must_not:` — a checkable prohibition phrased as a `goal.md` `Must not:` line —
  and the design gate copies it into the criterion it bears on, tagged with the
  entry's ID. From there the verifier's existing boundary check enforces it
  without knowing memory exists.
- **`loop-verifier` gains check 8: the evidence must be able to go red.** For
  each test cited as evidence, delete or invert the one assertion carrying the
  criterion's claim, in a temp copy, and run it again. Still green means the
  APPROVE would have been indistinguishable from a real one — returned as
  `ESCALATE_HUMAN — evidence cannot fail`, not REJECT, because the defect is in
  the proof and the code may be correct. External anchors and deterministic
  self-checks are exempt; agent-authored tests are not, which is the whole
  point. 30 of 66 recorded solution entries describe exactly this defect.
- **Every backlog opens with row 0** (`D-841-070`): one item whose only
  deliverable is a row written by the **production path**, its first criterion
  naming a table, a column and a value. No later item closes on unit evidence
  until it is done, `epic-planner` refuses a backlog without it, and
  `plan-critic` gained one mandatory attack — *which criterion could close green
  while the production path never ran?* The epic that produced the rule shipped,
  reviewed, verified and merged four items over a path that raised
  `AttributeError` on its first line into a belt-and-braces `except`. The
  `Cond.` column returns alongside it: name the cheap probe that can make an
  expensive item unnecessary.
- **Epic close must propose its promotions.** A `status: done` rollup carries a
  `## Promotion candidates` block — IDs whose scope exceeds the epic, or
  `none — <reason>` — and `memory-lint` flags one that has neither. Across 77
  archived runs of a real store, the host tier was never proposed once: every
  other tier transition fires on an event, and this one waited on a judgement
  nobody was asked to make. The gate guarded the approval; nothing guarded the
  proposal.
- **`solutions/` entries get a stable handle, so a slug can be renamed.**
  Identity and name were the same thing: an entry was addressed by its filename,
  and renaming a slug — the fix the hit-rate pass prescribes most often for a
  trigger made of abstractions — broke every inbound reference. A real store
  measured the trap: 65 of 66 entries carry inbound references, 285 in total,
  and the four renames it had already scheduled would have broken 33 of them.
  The cost of the fix was protecting the broken trigger from being fixed, which
  is why the pass recorded those four as "deferred rather than done blind".
  `id: S-NNN` is now the handle and never changes, the slug stays the filename
  and stays a trigger, and `aliases:` carries former names so recall still
  matches the old vocabulary and the hit-rate pass can join a renamed entry to
  its own dismissal history. `migrate-memory.mjs --solutions` assigns them —
  deterministic by `date` then filename, idempotent, never reusing a taken
  number — and the 285 existing slug references keep working untouched, so the
  migration is additive rather than a rewrite. The handle brings one new failure
  mode with it, named rather than hidden: two parallel runs can allocate the same
  number, and `memory-lint` blocks on a duplicate.
- **Recall spends its budget on what discriminates.** A keyword matching over
  15% of index lines is dropped before scoring, so the store computes its own
  stopwords; at the score threshold an entry's `[area]` must appear in the
  prompt to earn a body slot; and an ID the last ten records dismissed three
  times keeps its listing but loses its slot. One "Not fixed (minor)" note about
  a window query took 34 of 127 injections — 27% of every budget — arriving
  inlined on runs about generators and Temporal workers. `solutions/` entries
  are injected as `S:<slug>` and now reach `.recall-log`, check 7 and the
  hit-rate pass; they logged as `id: null` before, so the deepest tier spent
  budget and left nothing to maintain it by.
- **`severity` stops being required; `caught_at` carries the signal instead.**
  A real corpus of 66 solution entries graded 79% of itself `high` — a filter
  that returns almost everything is not a filter, and the write cost bought
  nothing. `caught_at` records a fact rather than a judgement: `merged` (it
  reached the branch or production before anything caught it), `review` (the
  gate or the verifier caught it), `in-run`. It is left **absent** rather than
  guessed, because guessing it is the failure the store exists to warn about: a
  keyword pass over "merged" and "shipped" was wrong on 5 of 24 entries — three
  were counterfactual ("would have shipped"; it did not), two described a
  ProseMirror node merge. The 16 entries whose own sentence settles it were
  judged one at a time.
- **`loop-record` refuses seven of the record's ten fields, not three.**
  `Goal criterion targeted`, `Injected`, `Actions` and `Verification` join
  `Verdict`, `Evidence` and `Recall` — the seven a later reader cannot
  reconstruct from `state.json`. `Delegated`, `Learning` and `Next` stay
  narrative: requiring them turns a record into a form. It also refuses a
  `--criterion` the record's own criterion line does not name, because state
  counting one criterion while the record grades another is a mismatch nothing
  downstream can see.
- **Every closed rollup cites its decisions.** Four cited none, against a
  contract that says a rollup cites and does not restate. Each now carries a
  `## Decisions` table mapping row → the `D-` range its `item-N.md` holds.
- **The review gate leaves a trace.** It ran on 51 of 58 runs with iteration
  records and set `state.review_gate` on four, because nothing wrote the field —
  the most expensive step in the loop was the least visible afterwards, and no
  later reader could tell a thorough gate from a skipped one.
  `loop-record.mjs --review-gate "<summary>"` records it without appending an
  iteration, and refuses an empty summary: a clean gate records that it was
  clean, and silence is not a result.
- **Hygiene finishes what an earlier sweep started.** Removing a dropping tree's
  FILES left the tree: `.loop/memory/` really held an empty `.claude/.cc-writes/`,
  and an empty dot-directory under the store is the same lie the files were — it
  makes the store look written to. Non-dot empty directories are left alone. A
  stale hand-written `RESUME-*.md` is named, never deleted, and only once
  `parallel.json` exists to make it redundant.
- **The duplicate check compares anchors, not strings.** It had never fired on
  any store, because `tests/conftest.py:362` and `conftest.py:362` are one
  defect written two ways and it compared the raw text. Normalised to
  basename:line — the same collapse the breaker's `errorSignature` already
  applies — it immediately found the pair a manual audit had named.
- **One guidance contradiction, closed.** `loop-engine` says `.loop/` is
  committed by default; the new git warning told the reader to ignore it and
  un-ignore `memory/`. The contract now states the part that was missing —
  `memory/` must be tracked either way, because Delete is justified by "git
  history is the archive" — and the warning agrees with it.
- **Two bugs in the lint itself, both found by running it on a real store.**
  `mapBodies` terminated its match with `(?=^###|\Z)` — JavaScript has no `\Z`,
  so it means "or a literal Z", and a cluster map that is the LAST heading in its
  file matched nothing: five entries whose map had just been written read as
  unreachable. And `reach` read only the ID an index line *leads with*, so an
  entry folded into a neighbour's trigger — `- L-051 … L-054 clamps … L-055 must
  walk …`, which is exactly what Demote produces — was reported as dropped and
  asked for a fold that had already happened. Both made the check report a defect
  in the data when the defect was in the check, which is the failure this lint
  exists to catch, landing on the lint. The corrected count on the real store is
  **118 unreachable, not 126**. A regression test covers the end-of-file map and
  was confirmed to go red against the old regex.
- **The lint carries a baseline, because a long-lived store fails a new rule by
  the hundred.** Pointed at the real store, these checks report 154 findings that
  all predate them — and a gate that blocks every stop until they are fixed is a
  gate nobody can work behind, which also buries the one finding that is new.
  `--accept-baseline` records the debt per check: it prints as `debt` and does
  not block, while anything **above** it does. The number may only fall —
  accepting a worse count is refused, which is the difference between a grace
  period and a mute button. Same shape as the breaker's `record_contract_since`.
- **`scripts/memory-lint.mjs` checks reachability, not anchors.** `reach`: every
  body has an index line or is named in a cluster map. A real maintenance pass
  folded 152 index lines, verified all 358 `### L-NNN` anchors survived, and
  recorded "zero IDs lost" — the anchors did survive, and 126 of 509 bodies
  ended reachable by nothing, 115 of them cited nowhere in the store at all.
  Also `budget` (naming the commentary share when moving it alone would clear
  the overage) and `schema` (typed frontmatter, closed `root_cause` set).
  `memory-gate` blocks a terminal stop on any blocking finding.
- **The memory store is tracked in git.** The contract permits **Delete** and
  justifies it with "git history is the archive"; `git ls-files .loop/memory`
  returned 0 on a store of 509 learnings, 547 decisions and 66 solution entries,
  so every Delete was unrecoverable and nothing said so. Git cannot un-ignore a
  child of an ignored directory, so the pattern is `.loop/*` + `!.loop/memory/`
  + `.loop/memory/scratch/`; `loop-reminder` says so at session start when it
  finds the store ignored.
- **`loop-archive run` refuses a history with missing records.** 42 of 308
  iteration records in a real archive did not exist while `state.json` still
  counted them, and 16 runs had none at all. `--allow-gaps` archives anyway and
  writes `missing_iteration_records` into the archived state, so the loss is
  data rather than an absence a later reader has to notice.

## 0.15.0 — 2026-09-01

**Memory splits into an index and a body, so a store can grow without growing
what every run reads.** Measured against a real six-month store: `learnings.md`
had reached 152KB (341 entries) and `decisions.md` 321KB (479 entries), and
`/design` and `/breakdown` read them whole — roughly 120K tokens — before asking
their first question. The same store's indexes come to 115KB, and that is now
the *only* half read by default, with every body still reachable by anchor. The
gate then reports both indexes as over budget, which is correct and is the point:
this store's own header has admitted a consolidation pass was overdue since
2026-08-18, and 341 entries across clusters of near-duplicates is what being
overdue looks like. The budget is a signal to consolidate, never a quota to
delete toward.

- **`learnings/` and `decisions/` are now trees.** Every entry has an ID and
  splits in two: a **trigger** (one ≤200-char index line naming the *symptom* a
  future session will recognise — error text, API and file names) and a **body**
  (uncapped: mechanism, measurements, run refs, reached by its `### L-NNN`
  anchor). Only the index is read by default, so growth lands in the cold half,
  and the index grows with the number of *kinds* of problem rather than the
  number of incidents. Learnings shard by their `[type]` tag, which is a closed
  set, so an entry's file needs no judgement call at write time; decisions shard
  by epic, so an epic's decisions retire with it, while supersede links — a
  graph, not a tree — carry the trace-back.
- **The budget moved from counting entries to measuring the index.** The old
  "~60 durable one-liners" capped the wrong thing: a long-lived project is
  supposed to accumulate entries, and counting lines let each line grow into a
  paragraph (the real store had single "one-liners" over 2,000 characters).
  `memory-gate` now checks index size and trigger-line length mechanically, the
  way the breaker checks counters.
- **Maintenance gains a sixth outcome, `Demote`** — drop an entry's trigger,
  keep its body — and a **consolidation trigger**: a `[type][area]` cluster past
  ~5 trigger lines is due to become one principle naming its cases. That is how
  a store gets better as it gets bigger instead of merely longer.
- **`memory-recall` injects bodies, not just pointers.** A pointer the model does
  not follow is a recall that did not happen, so a strong match now arrives with
  its body already inlined (2 max, capped), and weaker matches arrive as a
  trigger plus the exact runnable `grep`. Keyword matching also drops to 3
  characters with word-boundary checking, which was letting through neither
  technical acronyms (`ssl`, `api`, `dom`) nor most Vietnamese syllables — a
  non-English prompt recalled almost nothing.
- **Recall is now accounted for, not assumed.** Injected IDs are logged to
  `.loop/.recall-log`; every iteration record and design gate carries a
  `Recall:` line marking each ID `applied` or `dismissed` with a reason;
  `loop-verifier` gained a seventh check for it. Those dismissal reasons feed a
  new **hit-rate pass** in `/memory` that finds the store's real failure — a
  correct entry whose trigger is written in the author's vocabulary instead of
  the reader's, so nobody is ever handed it.
- **`scripts/migrate-memory.mjs`** converts a flat store one-way (`--dry-run`
  first; sources are renamed to `*.pre-migration`, never deleted). Verified on
  the real store: 820 entries in, 820 out, IDs unique, no index line over 200
  characters.
- **`scripts/loop-archive.mjs`** replaces the prose archive steps that had
  produced `archive/<run>/iterations/iterations/` in the wild, and adds a hygiene
  sweep (session-tool droppings had settled in 7 places under `.loop/`, including
  inside `memory/`) plus retention for closed epics' runs.
- **`state.json.breaker` → `breaker_thresholds`.** The field held thresholds and
  read like counters, so a run once wrote `{stagnation: 0, …}` meaning "reset the
  counters" and made every `counter >= threshold` compare true, tripping a stop
  on the first check of a fresh run — and crashing in the stagnation branch
  rather than reporting cleanly. The breaker now prefers the new name, still
  reads the old one, refuses non-positive thresholds with a message saying what
  the field is, and no branch dereferences an empty failure list.
- **`.loop/parallel.json`** records worktree slices when a run fans out, and
  `/status` renders it — a fanned-out run that lost its session used to need a
  hand-written resume file to find its own worktrees.
- **Hardened by a two-critic adversarial review before release.** `.recall-log`
  became an explicit **inbox** (each Record accounts its IDs and empties it;
  the `Recall:` lines are the durable history) after both critics showed stale
  cross-run entries would wrongly block stops and poison the contract — whose
  verify-time check also moved onto the verifier payload, since the iteration
  record does not exist yet when the verifier runs. A parser bug that silently
  *duplicated* every entry in a section whose heading directly follows the
  file's first bullet was fixed — reconciliation could not see it, because both
  sides of the count came from the same doubled list. The gate no longer counts
  the scratch template's example line (inside an HTML comment) as live scratch,
  no longer accepts prose starting "Recalling" as a `Recall:` line, and an
  entry-less scaffolded index beside a still-unmigrated flat store no longer
  silences it — the design gate now also says to migrate first. `similarity`
  joined the sanitized thresholds (0 made three different approaches read as
  the same one), misspelled threshold keys warn instead of silently reverting,
  and `--force` re-migration appends to an existing `scratch/run.md` instead of
  destroying live scratch. Epic archiving now retires the epic's
  `decisions/<slug>/` bodies with it, closing the loop the sharding was for.

## 0.14.0 — 2026-08-25

**Four ideas adapted from [mattpocock/skills](https://github.com/mattpocock/skills).**

- **`skills/interview/` — one questioning method, two callers.** The interview
  doctrine had been copy-pasted into `design.md` and `breakdown.md`, and the
  copies had drifted: `design` required the MINIMUM across dimensions and
  `breakdown` asked for a single blended confidence %, the exact thing `design`
  forbids. Both now call the skill and supply only their own scope (HOW vs WHAT),
  seed dimensions, and recalled answers.
  - The state is a **design tree**, not a fixed taxonomy: seeds plant the first
    branches, and the tree grows out of answers, so a subtree that fits no
    bucket can no longer go unvisited behind five green dimensions.
  - Rounds ask the **whole frontier**, sized by dependency rather than a 2–4 cap,
    and a question depending on one still open in this round is deferred — that
    pairing used to buy an answer conditioned on an unstated guess.
  - Every question carries a **recommended answer**, turning an open question
    into a review task and forcing the model to hold a position.
  - **Facts are the agent's job**: an environment lookup is dispatched to a
    subagent as an unsettled node in the same tree, so only the questions
    downstream of it wait.
  - The gate is now two-part: **frontier empty AND min(dimensions) ≥ 95%**. The
    ~5-round numbered-assumption escape hatch is unchanged.
  - The text round format (`❓ Q1 … ➡️ Recommend: …`) gives the delegated path,
    where `AskUserQuestion` is unavailable, a defined shape for the first time.

- **`loop`: defect increments make it red before they theorise.** A fix-shaped
  increment — a verifier REJECT, a confirmed review finding, a defect the goal
  names — now starts by building one command that goes red on *that* defect
  (ten construction routes, ranked), already run once, and red-capable /
  deterministic / fast / agent-runnable. Then minimise until every remaining
  element is load-bearing, rank 3–5 falsifiable hypotheses before testing any,
  probe one variable at a time with `[DEBUG-xxxx]`-tagged logs so cleanup is one
  grep, and close only once the command goes green on the un-minimised scenario.

- **Review gate: a spec-fidelity dimension, and no reranking across dimensions.**
  A criterion-by-criterion verifier structurally cannot see work nobody asked
  for, because it only ever looks at what a criterion claims. The new reviewer
  reads `.loop/prompt.md` and reports missing, contradicted, and **unasked-for**
  behaviour. It runs at tier ≥ `small`; the cap moves 4 → 5. Findings are now
  reported per dimension and never merged into one ranked list, so a clean axis
  cannot mask a dirty one.

- **`.agents/writing-docs.md` + `CLAUDE.md` — authoring doctrine for this repo.**
  Context pointers, the two loads, the information hierarchy, completion
  criteria, a leading-word registry for the plugin, prompt-the-positive, and the
  pruning passes. Reconciles with `prompt-craft`'s "NEVER over avoid" lint: ask
  first whether the instruction can be a positive target, then make any
  prohibition that survives the strongest one available. A first pass under it
  flipped three soft advisories to positives and cut one duplicated rule from
  `design.md`; the hard guardrails were kept deliberately.

## 0.13.2 — 2026-08-22

**The README's mermaid is replaced by the editorial diagrams.** All five embeds
land through `<picture>` + `prefers-color-scheme`, so dark-theme readers get the
dark variant and the light `<img>` is the fallback everywhere else.

- The three inline mermaid blocks (`## The loop`, `## Epic flow`,
  `## Memory compounding`) are replaced in place by their SVGs.
- `### The breaker is code, not a prompt` and `## Prompt compilation` gain a
  diagram they never had.
- README prose is byte-identical to before: the sha256 of its diagram-free view,
  anchored before the work started, is unchanged, and no heading moved.

## 0.13.1 — 2026-08-22

**Diagram assets.** Five editorial diagrams for the plugin's core parts — loop
lifecycle, circuit breaker, memory compounding, epic flow, prompt compilation —
authored as self-contained HTML sources and exported to SVG + PNG, each in a
light and a dark variant, under `docs/diagrams/`. Not yet referenced from
`README.md`; the inline mermaid blocks stay in place until the embeds land.

- `.loop/` is now ignored: it is per-project run state created by the plugin,
  and this repo carries its own dogfood run.

## 0.13.0 — 2026-08-21

**Honest counters, matched evidence, memory with a lifecycle.** Seven changes
taken from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(MIT) — its `.agents/` corpus, `AGENTS.md` conventions, and the
`repeat-tool-reminder` guard — and rewired around this plugin's gates:

- **Bookkeeping passes are transparent to the breaker** (`loop-breaker.mjs`):
  a passing iteration that closed no criterion (`criteria_passed` did not rise)
  neither counts as an attempt nor resets one, so `fail → tidy records → fail`
  still reads as two consecutive failures. Derived from recorded state, not
  declared; fails are never transparent; entries predating `criteria_passed`
  keep their old behavior. Closes the path by which recording work could reset
  the counters that were about to stop a stuck loop.
- **Advisory tier** (`loop-breaker.mjs`): one counter short of any threshold
  prints `ADVISORY (...)` and still exits `0`. The loop gets one warning it can
  act on before the breaker decides for it; advisories ride into the next
  iteration's context via `--context` and never change the exit code.
- **Evidence matched to the surface**: `loop-verifier` gains a routing table
  (behavior → focused test, CLI → transcript, model-visible text → snapshot,
  docs → generator/gate, published paths → build + smoke, deletion → proof of
  absence, …) plus four rules — report only commands actually run, no broad
  green suite in place of the missing narrow check, never make evidence green by
  shrinking its scope, anchors are checked against the anchor. The design gate
  now writes an `Evidence:` line per success criterion.
- **`ESCALATE_HUMAN` carries a proof burden**: retry once unchanged, try the
  other surface, then record command, exact error and what makes the failure
  environmental. Without that block the verdict is REJECT. Escalate entries are
  excluded from the breaker's counters, so an unjustified escalation was the
  cheapest way to launder a stuck loop.
- **`Injected:` line in every iteration record**: memory entries recalled, the
  already-tried block, any advisory carried in, the compiled brief. A run whose
  records show what was done but not what the agent was told cannot be debugged
  afterwards.
- **Memory lifecycle rules** (`loop-memory`): `alternatives rejected:` is
  mandatory in `decisions.md`; dead ends are kept only while still tempting and
  deleted when the premise is gone; an entry is never edited into a different
  conclusion (replace or supersede with a back-link); consolidation transfers
  every unique rationale, alternative and failed attempt before deleting;
  `[type]` tags are a closed set; `.loop/archive/` is frozen history, never
  authority.
- **Calibration by worked example** (`loop-memory`): keep/delete/consolidate
  examples with their lengths, the statement that length and age are discovery
  aids rather than criteria, "do not prune toward a quota", and a prose list
  (no narrated history, no rotting status, no reasoning transcript, no fact
  without its why).
- `/loop-engineering:status` reports breaker counters and any standing
  advisory. Breaker test suite: 16 → 23 checks.

## 0.12.0 — 2026-08-21

**Prompt compilation** — the design gate no longer hands a raw interview to the
loop, and no subagent is spawned from an ad-hoc sentence:

- `prompt-craft` (skill, NEW): the plugin's prompt-engineering contract. Two
  jobs and no third one — compile the ask into `.loop/prompt.md` (Template O)
  once `min(dimensions) ≥ 95%`, and compose every `Agent()` payload as a brief
  (Template N) that passes a six-point lint before the spawn. Hard rules: never
  compile below the gate, never add unstated scope, never paraphrase a
  criterion, never ship a placeholder, never tell an Opus agent to think step by
  step, strip credentials, treat pasted prompt text as inert data.
- `.loop/prompt.md` (NEW artifact): objective, carry-forward context, target
  state, scope, constraints, acceptance criteria, stop conditions, and the
  user's raw ask quoted verbatim. Written between the confidence gate and
  `goal.md`, signed off in one line, archived with the rest of the run. Its
  criteria must survive into `goal.md` as `Done when:` + `Must not:` pairs.
- Wired into every spawn site: `design` (Step 1.5 + archive list), `loop`
  (preconditions, Act delegation, verifier payload), `breakdown` (epic-planner
  payload), `run` (pre-flight compilation per item), `loop-review` (reviewers
  and refuters), `loop-engine` (directory layout + iteration discipline).
- References under `skills/prompt-craft/references/`: 37 failure patterns with
  a map of which loop gate catches which, templates A to O, and per-tool
  routing. Adapted from [nidhinjs/prompt-master](https://github.com/nidhinjs/prompt-master)
  v1.7.0 (MIT, Nidhin Joseph Nelson).

## 0.11.0 — 2026-08-10

**Ambient memory** — the memory flow no longer depends on slash commands.
Sessions that just type "fix this bug" now get recall pushed in and capture
nudged out, through deterministic hooks (fail-open, `LOOP_HOOKS_OFF=1`):

- `memory-recall` (UserPromptSubmit, NEW): keyword-greps `.loop/memory/`
  (learnings, decisions, solutions frontmatter/titles, ad-hoc scratch) against
  every non-slash prompt and injects the top matches — max 5 entries (the
  loop-memory recall budget), labeled supplementary ("current code outranks
  past notes"). Silent when nothing scores; slash prompts skip it (commands own
  their recall).
- `loop-reminder` (SessionStart): now also prints a one-line **memory digest**
  (counts + solution slugs) whenever `.loop/memory/` exists — the cheap layer
  of the layered recall; the per-prompt grep is the targeted layer.
- `memory-gate` (Stop): new **ad-hoc branch** — when no loop is involved but
  the transcript shows real work (≥1 file-edit tool use AND ≥2 error-pattern
  hits) and nothing under `.loop/memory/` was touched this session, nudge once
  for ONE line in `.loop/memory/scratch/adhoc.md`. A running loop is never
  gated; a project without `.loop/memory/` stays silent.
- `scratch/adhoc.md` is a new scratch surface, not durable memory: ad-hoc
  sessions append one-liners; `/loop-engineering:memory` harvests and empties
  it (and now runs standalone with no loop record). Distillation stays
  model-invoked — the v0.8.0 "enforcement, not capture" doctrine holds; the
  nudge enforces the habit, never writes the memory.
- Hook test suite: 18 → 36 checks.

## 0.10.0 — 2026-07-31

**Epic runner** — `/loop-engineering:run [slug] [--hands-off]`: executes a
signed-off backlog end-to-end in dependency order; the user stops typing
`design` per item. Orchestration only, never shortcuts: every gate (design,
tenth-man, verifier, breaker, review gate, memory) still runs per item.
Interviews are front-loaded in a batched pre-flight (an autonomous run must
never count on asking mid-flight); `--hands-off` converts gaps to explicit
assumptions and makes the tenth-man mandatory for every item — autonomy is
paid for with stricter review. One `stuck` item stops the runner. Parallelism
is opt-in and worktree-only (one `.loop/` per worktree, merge-back with
conflict context injected).

## 0.9.0 — 2026-07-31

**Per-epic instance directories** — epics no longer share files.

- `.loop/epics/<slug>/{epic.md, backlog.md}`: one instance dir per epic;
  running a second epic can no longer overwrite the first, and instances stay
  short instead of accreting into one long file.
- `.loop/active-epic` pointer (one line) names the epic `design`/`loop` operate
  on; switching epics rewrites the pointer with user confirmation.
- Close semantics: when the last backlog item finishes and the retro is
  written, the instance dir archives to `.loop/archive/epics/<slug>/`. The
  knowledge rollup `.loop/memory/epics/<slug>.md` is NEVER archived — the
  epic's lessons outlive its working files by design.
- Legacy singleton `.loop/epic.md`/`backlog.md` are migrated on first touch.

## 0.8.1 — 2026-07-31

**Fresh-session dogfood fixes** — a clean-room agent ran the plugin end-to-end
knowing only the README; every friction point it logged is addressed:

- Version-skew made visible: the breaker prints `[plugin vX.Y.Z]` read from
  disk on every check, and the README warns that a pre-update session silently
  serves stale command text with inert hooks ("restart is not optional").
- Verifier payload: gains a `## Project root` field (the verifier's cwd is not
  the project) and supports multiple criteria per iteration, judged separately;
  scratch probes now belong in the system temp dir, never beside the project.
- Design gate: external anchors (golden samples) are authored AT the gate,
  hash-pinned and boundary-protected before the loop starts — never during the
  window they must be immutable; AskUserQuestion fallback documented; state.json
  template aligned with the engine schema (`tier`, `breaker`,
  `breaker_reset_at_iteration`).
- loop-engine: stop-condition table now marks which rows the script owns (⚙)
  vs the model — the script does not detect "goal met".
- loop-review: explicit precedence — the tier cap wins over dimension triggers;
  excluded triggers are named in the iteration record; the fix for a wrong call
  is re-tiering, not silently running extra dimensions.
- Empty-argument phrasing in the loop command no longer renders as a blank
  code span.

## 0.8.0 — 2026-07-31

**Deterministic hooks — enforcement, not capture.**

- `boundary-gate` (PreToolUse): while a loop is `running`, edits to paths under
  `Do not touch:` lines in goal.md's `## Global boundaries` are mechanically
  blocked — a Must-not upgraded from verifier-caught to impossible.
- `memory-gate` (Stop): blocks ending the session (once) when the loop reached a
  terminal state but `.loop/memory/` was never touched afterwards, or scratch
  entries were left undistilled.
- `loop-reminder` (SessionStart): one context line when the project has an open
  loop.
- All fail-open (any error → allow), stat/glob/string checks only, bypass via
  `LOOP_HOOKS_OFF=1`. 18-check test suite (`scripts/test-hooks.mjs`).
- Deliberately not hooks: memory capture (distilling needs judgment — stays
  model-invoked) and self-evaluation (the breaker already runs as code in-loop).

## 0.7.0 — 2026-07-31

**Anti-Goodhart hardening + cost tiers** (synthesized from ECC's
loop-design-check lineage and oh-my-claudecode mechanisms; fully standalone).

- Every `Done when:` now ships a `Must not:` boundary; goal.md gains
  `## Global boundaries`; verifier check #6 rejects criteria met by violating
  their boundary ("all tests green" via deleting a test = REJECT).
- Evidence-quality ladder in the verifier: external anchor > deterministic
  self-check > agent-authored tests > "looks right" (never accepted).
- Complexity tiers `trivial|small|medium|large` per goal/sub-goal, routing
  design-gate depth, tenth-man, and review-gate dimensions.
- Plateau detection in `loop-breaker.mjs`: `criteria_passed` flat for 4
  iterations despite passing verdicts → `stuck` ("busy but not progressing").
- Design gate: per-dimension confidence (gate = MIN across dimensions, never
  the average) + front-loading audit (no "TBD" / "decide later" survives).
- Review gate: no partial credit between reviewers; fresh reviewer instances on
  re-review; sonnet/haiku routing for the fan-out.
- Stuck handling: 2–3 competing hypotheses with evidence before asking the user.

## 0.6.0 — 2026-07-30

**Review gate** (`skills/loop-review`): once per goal, between "criteria met"
and `done` — parallel fresh-context reviewers (correctness always; security /
test-adequacy / simplification by greppable triggers, cap 4), blocker/major
findings must survive adversarial refutation, confirmed findings re-enter the
loop as normal iterations under the breaker. Self-contained: no external
plugins assumed.

## 0.5.0 — 2026-07-30

**Tenth-man plan critic** (`agents/plan-critic`): the design was the only
self-graded artifact in the flow. A fresh-context agent now assumes the
signed-off plan is wrong and attacks it with evidence (assumptions, gameable
criteria, decomposition, ordering, omissions). Mandatory dissent in
investigation, honest verdict: approvals carry the surviving attacks + one
standing doubt on record. Max 2 revise rounds, then the user arbitrates.

## 0.4.0 — 2026-07-29

**Memory rebuilt: three shapes, three tiers** (memory-engineering governance ×
compound-engineering craft).

- Shapes: tagged one-liners (`learnings.md`), full 6-section
  `solutions/<slug>.md` entries with typed frontmatter, `epics/<slug>.md`
  rollups. Explicit escalation rule (>2 iterations, surprise root cause, or
  "when does this apply" needs >1 line → full entry).
- Tiers: scratch (mid-run, cheap) → durable (distilled) → host `CLAUDE.md`
  behind a promotion gate (user or verifier). `## Never store` as declared data.
- Recall budget: grep by tag/field, max 5 entries per iteration.
- Epic feedback loop closed: every sub-goal stop appends a lesson + slice
  verdict; the last item writes a retro; `breakdown` reads retros first and
  `epic-planner` is bound by them.

## 0.3.0 — 2026-07-29

**The breaker is code, not a prompt**: `scripts/loop-breaker.mjs` (zero-dep
Node) reads `.loop/state.json` — exit 0 continue / 2 stop / 1 state error —
implementing max-iterations, stagnation (normalized error signature ×3),
frustration (approach similarity ×3, trigram Jaccard + containment @0.85), and
no-progress (5 consecutive fails). `--context` emits the "already tried — do
NOT repeat" block. Run at step 0 of every iteration; exit 2 is final.

## 0.2.x — 2026-07-29

- **0.2.1**: breakdown sign-off decisions persist into `.loop/memory/decisions.md`.
- **0.2.0**: epic tier — `/loop-engineering:breakdown` (BA/PM gate: epic-level
  95% interview scoped to WHAT/order, never implementation) + `epic-planner`
  agent (vertical slices, seed measurable criteria, risk-first ordering,
  proposes only). Sub-goals flow through the design gate one at a time;
  `.loop/epic.md`, `.loop/backlog.md`, archives per run.

## 0.1.0 — 2026-07-29

Initial release: goal-based loop with interview-gated design (95% confidence),
fresh-context `loop-verifier` (reject-by-default, APPROVE/REJECT/ESCALATE_HUMAN,
runs the checks itself), append-only iteration records, resumable
`.loop/state.json`, compounding memory with host-`CLAUDE.md` promotion, and
mermaid visualization via `/loop-engineering:status`.
