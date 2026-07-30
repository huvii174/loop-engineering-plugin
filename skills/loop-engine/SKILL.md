---
name: loop-engine
description: State contract and mechanics of the goal-based engineering loop — .loop/ directory layout, iteration record format, stop conditions, resumability. Load when running /loop-engineering:loop or reading/writing .loop/ state.
---

# Loop Engine — Goal-based Loop Contract

A goal-based loop iterates toward a **verifiable goal** instead of a fixed step
count: each pass plans one increment, acts, verifies against the goal's success
criteria, records state, and repeats. The loop, not a human, decides "not done
yet" — but only inside explicit, bounded stop conditions.

## .loop/ directory (lives in the host project root)

```
.loop/
  goal.md            # goal + verifiable success criteria checklist (design gate output)
  design.md          # architecture + ordered work breakdown (design gate output)
  state.json         # machine state — single source of truth for loop position
  iterations/
    0001.md          # one record per iteration (append-only)
    0002.md
  memory/
    learnings.md     # compounded learnings (see loop-memory skill)
    decisions.md     # design decisions + rationale
```

Add `.loop/` to the host `.gitignore` only if the user asks; by default it is
committed so loop history travels with the repo.

## state.json schema

```json
{
  "status": "designed | running | done | stuck | stopped-max-iterations | stopped-user",
  "run_id": "run-2026-07-29",
  "iteration": 3,
  "max_iterations": 12,
  "confidence_at_design": "96%",
  "created": "2026-07-29",
  "updated": "2026-07-29",
  "breaker": { "stagnation": 3, "frustration": 3, "noProgress": 5, "similarity": 0.85 },
  "breaker_reset_at_iteration": 0,
  "history": [
    {"n": 1, "intent": "scaffold API route", "approach": "minimal Express route + fixture test",
     "verdict": "pass", "error_signature": null, "criterion": "GET /api/x returns 200"},
    {"n": 2, "intent": "add validation", "approach": "zod schema at route boundary",
     "verdict": "fail", "error_signature": "ZodError: expected string, received number",
     "criterion": "POST /api/x rejects bad payloads"},
    {"n": 3, "intent": "fix schema mismatch", "approach": "coerce numeric ids in schema",
     "verdict": "pass", "error_signature": null, "criterion": "POST /api/x rejects bad payloads",
     "criteria_passed": 2}
  ]
}
```

`criteria_passed` = how many success criteria are verifier-APPROVED after this
iteration. Record it on **every** entry — it is what lets the breaker see a
**plateau** (verdicts keep passing while this number stays flat: busy, not
progressing), a death that failure counters structurally cannot detect.

Update `state.json` at the END of every iteration, atomically (write full file).
It must always reflect reality — a crashed loop resumes from it. The circuit
breaker is evaluated from `history` alone — `approach` and `error_signature`
exist precisely so the breaker and the "already tried" injection never need to
re-read every iteration record.

**Verdict mapping** (the verifier speaks a three-way vocabulary; records store
it as): `APPROVE → pass` · `REJECT → fail` · `ESCALATE_HUMAN → escalate`.
`escalate` entries stop the loop but are **excluded** from stagnation /
frustration / no-progress counting — an unverifiable attempt is not a failed
approach.

## Iteration record format (`iterations/NNNN.md`)

```markdown
# Iteration NNNN — <one-line intent>
- **Goal criterion targeted:** <which success criterion this advances>
- **Actions:** <what was done, files touched>
- **Delegated:** <agent> — <task> — <outcome>   (or "none")
- **Verification:** <exact command(s) the verifier ran>
- **Evidence:** <trimmed command output proving the verdict>
- **Verdict:** pass | fail | escalate — <reason>
- **Learning:** <one line for memory, or "none">
- **Next:** <what the next iteration should do>
```

## Iteration discipline

- One iteration = one small increment with its own verification. If an increment
  can't be verified on its own, it's too big — split it.
- **Maker/checker split**: the implementer never grades itself. After acting,
  delegate the verdict to the `loop-engineering:loop-verifier` agent — invoked
  as `Agent(subagent_type: "loop-engineering:loop-verifier", ...)` — (fresh
  context, reject-by-default, three-way verdict `APPROVE | REJECT | ESCALATE_HUMAN`).
  The verifier runs the verification commands itself — the implementer's claim
  that tests passed is not evidence.
- Verification is evidence-based: command output, test results, build status.
  "Looks correct" is not a verdict. Success criteria must be deterministic and
  measurable (tests passing, a score threshold, a count reaching zero) — the
  design gate is responsible for producing them in that form.
- A **fail (REJECT) verdict is normal** and does not stop the loop; it becomes
  the next iteration's intent — with a *different* approach.
- **"Already tried" injection**: every iteration's prompt context must start
  from `state.json.history` — list what was already tried and what failed, and
  do NOT repeat a failed approach unchanged. This is the loop's short-term
  memory between iterations.
- The loop is **resumable**: on start, always read `state.json` + the last
  iteration record; never redo completed work, never trust memory of a previous
  session over the files.

## Stop conditions — the circuit breaker (all explicit and bounded)

**The breaker is code, not a prompt.** Run it before every iteration:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-breaker.mjs"   # 0 continue · 2 stop · 1 state error
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-breaker.mjs" --context   # "already tried" block
```

It reads `state.json.history` and decides deterministically — an instruction a
model can drift from becomes a check it cannot. Exit `2` is final: record the
printed reason and `status`, then stop. The table below documents what the
script implements (thresholds overridable per-loop via a `breaker` object in
`state.json`; reset after a `stuck` resume via `breaker_reset_at_iteration`):

| Condition | Detection | status |
|---|---|---|
| Goal met | every criterion verified APPROVE with evidence | `done` |
| Iteration budget | `iteration >= max_iterations` (default 12) | `stopped-max-iterations` |
| **Stagnation** | same error/failure reason 3 consecutive iterations | `stuck` |
| **Frustration** | same *action* attempted 3 consecutive iterations (even with different errors) | `stuck` |
| **No progress** | 5 consecutive fails with no pass in between | `stuck` |
| **Plateau** | `criteria_passed` flat for 4 iterations despite passing verdicts | `stuck` |
| Verifier escalation | verdict `ESCALATE_HUMAN` (environment problem, risky change) | `stuck` |
| User cancel | user says stop | `stopped-user` |

No-progress is the backstop for thrashing where every attempt fails
*differently* — five distinct errors from five distinct approaches — which
stagnation and frustration both miss. `escalate` entries count toward none of
the three.

The script handles signature normalization for you (timestamps, hex addresses,
paths → basenames, numbers → `#`) so "the same error" means the same signature,
not identical text; approach similarity is trigram Jaccard raised by containment
at a 0.85 threshold, so a reworded retry still counts.

**On `stuck`, diagnose before asking.** Don't hand the user a bare "what should I
do?" — present **2–3 competing hypotheses** for why the loop is stuck, each with
evidence for and against drawn from the iteration records, and your recommended
probe. The user picks a direction in seconds instead of re-deriving the situation
from raw history. Record exactly what was tried and why the breaker fired; never
silently keep burning iterations.

## Tier routing — how much process a goal pays

Every goal carries a **tier** (assigned by `epic-planner` for backlog items;
self-assessed at the design gate for standalone goals — when in doubt, round up):

| Tier | Fits | Design gate | Tenth-man | Review gate |
|---|---|---|---|---|
| `trivial` | config change, copy edit, one-liner | abbreviated (confirm criteria only) | skip (visible) | correctness only |
| `small` | single-file feature/fix | full | skip if its conditions hold | correctness (+security if triggered) |
| `medium` | multi-file feature | full | full | all triggered dimensions |
| `large` | architectural / cross-cutting | full | full | all triggered dimensions + simplification always |

One line of process discipline: a config tweak must not pay the cost of a schema
migration — and a schema migration must never sneak through on a config tweak's
paperwork. Tier is recorded in `state.json` (`"tier": "medium"`) and in the
backlog row; disputes round up.

Every stop — including failure stops — triggers the memory compounding step
(`loop-engineering:loop-memory` skill), a **post-run critique** (false starts, noise, and exactly
ONE change to improve the next run), and a final status visualization.
