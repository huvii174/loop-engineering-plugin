# Changelog

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
