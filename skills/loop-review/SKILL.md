---
name: loop-review
description: Review gate run after all success criteria pass and before a goal is marked done — parallel fresh-context reviewers per dimension (correctness, spec fidelity and its scope-creep check, security, test adequacy, simplification), adversarial refutation of findings, per-dimension reporting with no cross-dimension reranking, confirmed findings fed back into the loop as normal iterations. Load when the loop reaches "criteria met" or when running the review gate.
---

# Loop Review — the Review Gate

`loop-verifier` answers exactly one question per iteration: *does this increment
satisfy its `Done when:` line?* A goal can pass every criterion and still ship
injectable SQL — no criterion said otherwise. The review gate closes that gap:
**once per goal**, on the goal's accumulated diff, after the last criterion is
verifier-APPROVED and **before `status: "done"` is written**. `done` is not a
loop state until the gate clears. Self-contained: every reviewer is defined
here — no external plugins assumed.

## Step 1 — Scope the surface

Build the goal's accumulated diff: files created/changed across all iterations
(from the iteration records' file lists; `git diff` when the work is committed).
Reviews read the real files, not the records' summaries.

## Step 2 — Select dimensions (rules, not vibes; cap 5)

| Dimension | Runs when | Detection |
|---|---|---|
| **Correctness & maintainability** | always | — |
| **Spec fidelity** | tier ≥ `small` and `.loop/prompt.md` exists | — |
| **Security** | diff touches a trust boundary | grep the diff for: auth/session/token/crypto, input parsing (query/body/params/deserialize), `exec`/`spawn`/shell, file paths from input, network calls, SQL/query building, env/secrets access |
| **Test adequacy** | the goal changed behavior (new/changed logic, not pure docs/config) | any non-test source file changed |
| **Simplification** | diff > ~300 lines or > 5 files | line/file count |

The goal's **tier** caps the gate (routing table in the loop-engine skill):
`trivial` runs correctness only; `small` adds spec fidelity and
security-if-triggered; `medium`/`large` run all triggered dimensions, and
`large` always includes simplification. **Precedence: the tier cap wins over a dimension's trigger** —
a `small` goal whose diff changes behavior still skips test-adequacy. That is a
deliberate cost call, not an oversight; when it feels wrong for a specific goal,
the fix is re-tiering the goal (round up), never silently running the extra
dimension. Every trigger excluded by the cap is named in the iteration record. Record which dimensions ran and why in the final iteration
record — a skipped dimension must be visible, never silent.

## Step 3 — Fan out (parallel, fresh context, read-only)

Spawn one `Agent(subagent_type: "general-purpose", ...)` per selected dimension
**in a single message so they run concurrently**. Each prompt is Template N from
the `loop-engineering:prompt-craft` skill, carrying: absolute project root, the
goal statement, the file list as paths (never pasted bodies), the dimension
charter below, the output contract, and an explicit read-only clause. Reviewers
report; they never edit. Same for the Step 4 refuters — a refuter with no output
contract returns an essay where the gate needs a yes or no.

**Model routing (cost lever — generic Claude Code tiers, no external plugin):**
dimension reviewers pass `model: "sonnet"`; refuters in Step 4 — a narrow
yes/no question — pass `model: "haiku"`. Only escalate a reviewer to the
session's full model for a `large`-tier goal's correctness dimension. Judgment
stays expensive where it is load-bearing, cheap where the question is narrow.

**No partial credit between reviewers.** If any single reviewer reports a
blocker/major, that finding proceeds to refutation regardless of how clean the
other reviewers came back — one reviewer catching an issue means the issue is
real until refuted; the others' blind spot is exactly the failure mode parallel
review exists to eliminate. Reviewers are never averaged or outvoted.

**Correctness & maintainability charter** — hunt defects a criterion-focused
verifier misses: logic errors on edge inputs (empty, zero, unicode, concurrent),
error paths that swallow or mis-handle failures, resource leaks, off-by-one and
boundary conditions, dead code, misleading names, duplication that will drift.
NOT style preferences.

**Spec fidelity charter** — does the diff deliver the ask, and only the ask?
Read `.loop/prompt.md` (the compiled, signed-off ask) and `.loop/goal.md`, then
report: acceptance criteria missing or only partly delivered; **behavior in the
diff nobody asked for** — scope creep, which a criterion-by-criterion verifier
structurally cannot see, because it only ever looks at what a criterion claims;
and criteria that look delivered but whose implementation contradicts the brief.
Quote the `prompt.md` or `goal.md` line behind every finding. Signed-off
assumptions and `Out of scope` bind here too: work that contradicts one is a
finding, not a bonus.

**Security charter** — trust boundaries first: where does external input enter,
and is it validated *at the boundary*? Injection (SQL/command/path), authn/authz
gaps on new surfaces, secrets in code or logs, unsafe deserialization, missing
escaping at output sinks, overly broad file/network permissions. Report what an
attacker gains, not theoretical smells.

**Test adequacy charter** — do the tests that exist prove what the goal claims?
Changed behavior with no test that would fail if it regressed; tests asserting
implementation detail instead of behavior; the criterion's `Done when:` command
still passing if the feature were subtly broken (proxy gaming, test-side).

**Simplification charter** — what can be deleted or collapsed with zero behavior
change: needless abstraction layers, speculative generality, reimplementations of
stdlib or existing project utilities.

**Output contract (every reviewer):**

```markdown
## Findings (max 5, severity-ordered; empty section if clean)
- **[blocker|major|minor]** <one-line defect> — <file:line> — <concrete failure:
  input/state → wrong outcome> — <smallest fix>
## Clean
<what was checked and found sound — one line per area>
```

Max 5 findings per reviewer, ranked. A reviewer with nothing real to report says
so — a padded findings list poisons the refutation stage.

**Report per dimension, and never merge the dimensions into one ranked list.** A
goal can pass correctness and fail spec fidelity (clean code, wrong feature), or
the reverse (right feature, unsafe code). Ranking findings across dimensions
lets a clean one mask a dirty one, which is exactly the masking that fanning out
separately exists to prevent. Name the worst finding *within* each dimension and
leave it there; the severity ordering is per-reviewer, and it stays that way
through Step 4, Step 5, and the summary.

## Step 4 — Refute before you fix

Findings are claims, not facts; parallel reviewers produce plausible-but-wrong
findings, and every false finding fixed is a wasted iteration. For each
**blocker/major** finding, spawn a fresh-context refuter:
*"Try to refute this finding with evidence from the code: <finding>. Default to
refuted if the failure scenario cannot actually occur."* Findings the refuter
kills are dropped (logged in the iteration record with the refutation). **minor**
findings skip refutation and go straight to memory scratch — never to iterations.

## Step 5 — Confirmed findings re-enter the loop; no side door

Each surviving blocker/major becomes a **normal loop iteration**: implement the
fix → `loop-verifier` verdict → record → `loop-breaker` check. Review findings
get no shortcut past the gates; the breaker still bounds the whole run — if
review fixes exhaust the iteration budget, the loop stops honestly as
`stopped-max-iterations` rather than silently expanding it.

After the fix iterations, **do not re-run the full gate** — re-run only the
dimension(s) whose findings were fixed, once, and with a **fresh reviewer
instance**: the re-reviewer must not be the conversation that produced round
one's findings, or it anchors on its own prior judgment and rubber-stamps the
fix. A second full sweep on an already swept diff is where review cost runs
away.

## Step 6 — Then, and only then, `done`

Record that the gate ran before anything else in this step:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop-record.mjs" \
  --review-gate "<dimensions run; findings raised; refuted; confirmed; fixed>"
```

The gate ran on 51 of 58 runs in a real archive and left a machine-readable
trace on four — the most expensive step in the loop was the least visible
afterwards, so no later reader could tell a thorough gate from a skipped one. A
clean gate records that it was clean; silence is not a result.


Gate clears (no unrefuted blocker/major) → write `status: "done"` and proceed to
memory compounding. Findings worth keeping (a real gotcha, a pattern, a dead
hypothesis from a refuted fix) go into scratch for distillation; the review
summary (dimensions run, findings confirmed/refuted/fixed) goes into the final
iteration record.
