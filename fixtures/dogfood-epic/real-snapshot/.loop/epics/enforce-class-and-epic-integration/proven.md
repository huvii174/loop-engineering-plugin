# Proven criteria — enforce-class-and-epic-integration

The refined `Done when:` lines each item's verifier APPROVED, copied out at the
item's close so later closes re-run them without reading `.loop/archive/`
(D-eci-006). Items 0–2 were backfilled once at item 8's design gate from their
archived `goal.md`, reviewed by the user (D-eci-021); from item 8 on,
`scripts/loop-close.mjs close` appends each block.

## Item 0
Source: `.loop/archive/run-2026-09-23-eci-0/goal.md` (backfill)

- [x] C1 anchor intact
      Done when: `cd fixtures/two-writer && shasum -a 256 -c SHA256SUMS --quiet` exits 0 after the last spawn, and every SHA256SUMS line matches the hashes pinned in design.md
      Evidence: external anchor → the hash check itself
      Must not: no file under `fixtures/two-writer/` created, edited or deleted after the design gate
- [x] C2 three recorded spawns
      Done when: `.loop/evidence/item-0/spawn-{1,2,3}/state.json` each have `history.length == 1`, `history[0].criterion == "C1"`, and `history[0].verdict` equal to the mapping (APPROVE→pass, REJECT→fail, ESCALATE_HUMAN→escalate) of the verdict line in the same directory's `verdict.md`, which is the spawned `loop-engineering:loop-verifier`'s final message verbatim
      Evidence: CLI/model output → the saved verdicts and the recorder-written states; `node -e` reconciliation over the three directories
      Must not: `git diff --quiet -- agents/loop-verifier.md scripts/loop-record.mjs` fails (no edit to the code under test); the verifier prompt differs from the rendered `payload.md`; a fourth spawn is run to replace a verdict
- [x] C3 baseline written
      Done when: rollup row 0 in `.loop/memory/epics/enforce-class-and-epic-integration.md` and the `Cond.` cell of backlog item 1 both state `k/3 APPROVE` with the same k as C2's evidence, and say whether any REJECT reason names `litellm`
      Evidence: docs → `grep` of both files against the C2 count
      Must not: the baseline is reworded into a target ("must reach 3/3")

## Item 1
Source: `.loop/archive/run-2026-09-23-eci-1/goal.md` (backfill)

- [x] C1 anchors intact
      Done when: from the repo root, `(cd fixtures/two-writer && shasum -a 256 -c SHA256SUMS --quiet) && (cd fixtures/sibling-sites && shasum -a 256 -c SHA256SUMS --quiet)` exits 0 (subshells — the tool's cwd never enters `fixtures/`), `fixtures/sibling-sites/SHA256SUMS` matches the block pinned in design.md, and `find fixtures -name .omc` prints nothing
      Evidence: external anchor → the hash checks
      Must not: any file under `fixtures/` created, edited or deleted after the design gate
- [x] C2 baseline on the hard fixture
      Done when: `.loop/evidence/item-1/baseline-{1,2,3}/` each hold `verdict.md` (the installed `loop-engineering:loop-verifier`'s final message on `stage.sh baseline`, payload verbatim) and a `state.json` whose `history[0].verdict` maps it (APPROVE→pass, REJECT→fail, ESCALATE_HUMAN→escalate), all spawned while `git diff --quiet HEAD -- agents/loop-verifier.md` held; and `k/3 APPROVE` is written on rollup row 1
      Evidence: model output → saved verdicts + recorder-written states; mtimes of the three verdicts precede the first edit to `agents/loop-verifier.md`
      Must not: a spawn re-run to replace a verdict; the payload altered
- [x] C2b old verifier on the half variant (attribution)
      Done when: `.loop/evidence/item-1/oldhalf-{1,2,3}/` each hold `verdict.md` (the installed pre-check-9 verifier on `stage.sh half`, payload verbatim) and a recorder-written `state.json` mapping it, spawned while `git diff --quiet HEAD -- agents/loop-verifier.md` held; `k/3 APPROVE` written on rollup row 1 beside C2's
      Evidence: model output → saved verdicts + states; mtimes precede the first verifier edit
      Must not: a spawn re-run to replace a verdict; the payload altered
- [x] C3 one home, nine checks
      Done when: `skills/loop-engine/SKILL.md` has a section defining `Sites:` (one grep + design-time hits; `Sites: none (<reason>)` opt-out) and `Sweep:` (`fixed | held | not-this-class`, each with a reason); `grep -rlE 'fixed.{0,6}held.{0,6}not-this-class' commands skills agents` prints only `skills/loop-engine/SKILL.md`; `commands/loop.md`'s verifier payload has a `## Sweep` block pointing at loop-engine; `agents/loop-verifier.md` has check 9 pointing at loop-engine
      Sites: `grep -rnEi '(seven|eight|nine) checks|all (seven|eight|nine)' agents commands skills` → 2 hits at design:
        agents/loop-verifier.md:32
        agents/loop-verifier.md:160
      Evidence: docs → the greps; every Sites hit reads "nine"
      Must not: any line of checks 1–8 changed (`git diff agents/loop-verifier.md` shows no removed line strictly after the `## Checks` header line and up to check 8's last line — the header line itself is a Sites hit and changes); the vocabulary restated outside loop-engine
- [x] C4 check 9 rejects the half-fix
      Done when: after check 9 is committed and pushed to origin and the user runs `/plugin update` + `/reload-plugins`, `diff "$(node -e 'const p=require(process.env.HOME+"/.claude/plugins/installed_plugins.json").plugins["loop-engineering@loop-engineering-marketplace"].find(e=>e.scope==="user").installPath;console.log(p)')/agents/loop-verifier.md" agents/loop-verifier.md` is empty, and `.loop/evidence/item-1/half-{4,5,6}/verdict.md` are 3/3 REJECT on `stage.sh half` (spawned on 0.18.1, after iteration 3's REJECT fixed the output contract; `half-{1,2,3}` stand as recorded under 0.18.0 — 3/3 REJECT, 1/3 with the grep on the line) (payload verbatim), each quoting `src/billing/providers/litellm.mjs:9` as an unaccounted `Sites:` hit and each carrying a `Sites swept:` line that quotes the grep command the verifier ran and its live hit list
      Evidence: model output → saved verdicts + recorder-written states + the installPath diff
      Must not: the payload names litellm; a spawn re-rolled
- [x] C5 control: a complete sweep is approved
      Done when: under the same installed verifier (installPath diff still empty), `.loop/evidence/item-1/full-{1,2,3}/verdict.md` are 3/3 APPROVE on `stage.sh full`, the `src/ui/format.mjs:3` hit accepted as `not-this-class`, each carrying a `Sites swept:` line quoting the grep it ran and its live hit list
      Evidence: model output → saved verdicts + recorder-written states
      Must not: a spawn re-rolled; the full payload edited to win an APPROVE

## Item 2
Source: `.loop/archive/run-2026-09-23-eci-2/goal.md` (backfill)

- [x] C1 the refusal, branch by branch
      Done when: `node scripts/test-loop-record.mjs` exits 0 and contains one case per branch — (a) `--kind review-fix` record without `Sweep:` → exit 1, stderr names `Sweep:`, state unchanged; (b) record for a criterion whose goal.md block carries `Sites:` and no `Sweep:` → exit 1; (c) same with a `Sweep:` line → exit 0; (d) required `Sweep: none` → exit 1; (e) criterion with `Sites: none (<reason>)` and no `Sweep:` → exit 0; (f) criterion without `Sites:`, kind criterion, no `Sweep:` → exit 0; (g) goal.md carries `Sites:` but `--criterion` matches no block → exit 1 naming the gap; (h) sentence-shaped `--criterion` matching a block's `Done when:` line is located
      Evidence: behavior → the focused recorder test; each new case's key assertion inverted in a temp copy makes the suite exit 1
      Must not: any pre-existing case in `scripts/test-loop-record.mjs` edited or deleted, except two changes D-eci-003 forces (D-eci-020): the `fixture()` helper gains an optional `goal` argument, and the one existing review-fix case's record gains a `Sweep:` line; a refusal writes to `state.json` or empties `.recall-log`
- [x] C2 nothing else moves
      Done when: every `scripts/test-*.mjs` exits 0, and `git diff` of `scripts/loop-record.mjs` removes no line of an existing check other than the `REQUIRED_SECTIONS` consumer it extends
      Evidence: deterministic self-check → the six suites
      Must not: the recorder's CLI flags renamed or removed
- [x] C3 every listing of the refusals is current
      Done when: each hit of the `Sites:` grep below either names the `Sweep:` refusal or points at the one list in `skills/loop-engine/SKILL.md` that does
      Sites: `grep -rnE "record missing|What it refuses|stderr says what to fix" skills commands scripts/loop-record.mjs` → 5 hits at design:
        skills/loop-engine/SKILL.md:168:verdict outside the enum, a record missing `Verdict:` / `Evidence:` / `Recall:`,
        skills/loop-engine/SKILL.md:246:`loop-record.mjs` refuses a record missing **`Goal criterion targeted`,
        scripts/loop-record.mjs:18: *   1  refused  — nothing written; stderr says what to fix
        scripts/loop-record.mjs:25: * What it refuses:
        commands/loop.md:144:   means nothing was written and stderr says what to fix — a verdict outside the
      Evidence: docs → the grep plus reading each hit
      Must not: the refusal list restated in full in a second place
