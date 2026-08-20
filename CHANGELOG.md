# Changelog

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
