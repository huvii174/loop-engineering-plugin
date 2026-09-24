# Epic: Enforce "fix the class, not the instance" and give epics an integration layer

A loop run on a goal whose criterion is universal ("never", "every", "all",
"any") enumerates the sites the rule must hold at before implementing, and the
verifier refuses an iteration that left a site unaccounted. An epic re-verifies
upstream criteria and its own acceptance criteria by verifier at every item
close instead of the model ticking checkboxes, and runs one epic-level review on
the accumulated diff whose findings land in a budgeted backlog item. Business
outcome: the defect shape "fixed here, the parallel site next to it not" — four
blockers of one shape on a 22-item goal, with the memory rule recalled, marked
applied and not executed — cannot pass a loop run, because the rule is a line a
script refuses rather than a principle a model remembers.

## Epic acceptance criteria (measurable)
- [x] AC1 — On a fixture repo with two parallel write paths (the SDK/litellm
      shape), a loop iteration that fixes one path and claims the criterion is
      REJECTed by `loop-verifier` naming the second path, without the payload
      mentioning it.
      Evidence: transcript of a verifier spawn against the fixture under the
      system temp dir; the REJECT reason quotes the unaccounted grep hit.
- [x] AC2 — `loop-record.mjs` exits 1 on a record that requires a `Sweep:` line
      and has none; exits 0 once present.
      Evidence: `node scripts/test-loop-record.mjs` green with the new cases,
      and red when either assertion is inverted.
- [ ] AC3 — Closing a backlog item re-runs every completed upstream item's
      refined `Done when:` plus the epic AC the item claims, via
      `loop-verifier`, and the verdict lands on the item's row in
      `.loop/memory/epics/<slug>.md`.
      Evidence: `node scripts/test-loop-close.mjs` on the dogfood fixture where
      item 2 breaks item 1's refined `Done when:` — close exits 1 and writes
      nothing; red when that assertion is inverted (D-eci-010).
- [ ] AC4 — Closing the last item (and a marked integration point, at most one)
      runs the epic review gate on the accumulated diff with a cross-item
      charter, recorded via `loop-record.mjs --review-gate`, and every
      confirmed finding appears as a new backlog row `integration` that the
      runner executes before the epic retro.
      Evidence: `node scripts/test-loop-close.mjs` — the dogfood fixture's
      backlog gains the `integration` row, `run.json.order` holds its id and
      `runStanding` names it next (D-eci-010).
- [ ] AC5 — Every rule introduced has exactly one home; every other mention is
      a pointer.
      Evidence: `grep -rn "Sites:\|Sweep:" commands skills agents` shows the
      definition once (loop-engine) and pointers elsewhere.

## Out of scope
- PR boundaries (which goals share a PR) — the plugin has no PR model; the epic
  report may list items, never gate them.
- Line-number references in comments — authoring discipline, not a gate.
- Semantic (non-grep) site discovery. `Sites:` is a grep the critic and the
  verifier can re-run; what cannot be re-run is not evidence.
- A mid-epic release cut (D-eci-002).

## Assumptions (signed off)
1. AC1 is proven on a synthetic two-writer fixture, not on an external repo.
   If wrong: one dogfood round on a real project after 0.18.0 ships.
2. A gate at a marked integration point runs the full cross-item charter, not
   only the sibling-sites half. If wrong: one reviewer spawn per seam wasted.
3. An `integration` row appended by the epic gate is executed by the runner
   under `--hands-off` without a new command. If wrong: one typed command.
   (Item 5's design gate owns the `run.json.order` obstacle in Flags.)

## Flags from the planner (design-gate obstacles, not split changes)
- `hooks/lib.mjs` `runStanding` filters `run.json.order` to ids already in it,
  so an appended `integration` row is invisible to run-gate unless `order` is
  amended; `parseBacklog` keys rows by numeric `#`, so `integration` is a label,
  not an id. Owner: item 5.
- The ship item cannot be strictly last: the `integration` row lands after the
  version bump. Item 7 amends the 0.18.0 entry, never adds a second.
- `goal.md` criteria carry no stable ids; `loop-record.mjs --criterion` is free
  text, so item 2 locates the targeted criterion's `Sites:` line by that value.
- If the fixture's source ships in-repo for reproducible re-spawns, it is a
  shipped file → README "What ships" row in item 7.
- From item 0 (review + run): item 1's design gate re-pins `fixtures/two-writer/`
  and fixes in the same edit (a) `stage.sh`'s sed delimiter clashing with a
  `#` in `$ROOT`, (b) `$ROOT` printed only after `patch` succeeds, and (c) adds
  the caller-side cleanup step (delete the staged copy once evidence is saved)
  to the design's work breakdown.
- From item 0: `hooks/lib.mjs` `itemId` drops row `0` (L-007), so run-gate
  cannot see row 0. Not in any item's scope; raised to the user at item 0 close.

- From item 1's review gate (owners named; each design gate reads these):
  - item 4 — `Sites:` authoring: record hits as grep `-n` output (template now
    says so); decide whether a `Sites:` grep that errors (exit 2) is a REJECT
    or ESCALATE_HUMAN; require a single plain `grep` (no `;` `|` `$()`), same
    trust as `Done when:` today; ask whether the intent spans more surfaces
    than the criterion (the `$0.00` display case, S-001).
    Also: a criterion block with two `Sites:` lines — the recorder now refuses
    it (item 2); the design gate and plan-critic attack 8 should refuse it
    earlier, and check 9's "the criterion carries a `Sites:` line" is
    ambiguous with two.
  - item 4 or 6 — grow a fixture variant where only check 9 can REJECT: fixed
    code with an incomplete Sweep, plus `held`, a `fixed` hit still present,
    a restated grep that differs, and two hits with identical text in one file.
  - item 7 — trim the CHANGELOG's restated Sweep vocabulary to a pointer; add a
    pre-release step that re-spawns the fixture variants (nothing scripts-tests
    agent prompt text); the wording "Sweep is missing" vs a present-but-"none"
    block.
## Pre-flight (run, 2026-09-23)
- Fixtures live in-repo under `fixtures/`, copied to the system temp dir per spawn (D-eci-009).
- Per-item close is `scripts/loop-close.mjs`, added as item 8 (D-eci-010).
- One commit to `main` per `done` item, no push (D-eci-011).
- Assumptions for design gates: `Sweep:` classifies each hit `fixed` / `held` / `not-this-class`; `integration` row tier by finding count 1–2 small, 3–5 medium, >5 large.

## Open questions
(none — three planner questions resolved at sign-off: D-eci-005, D-eci-006, D-eci-007)
