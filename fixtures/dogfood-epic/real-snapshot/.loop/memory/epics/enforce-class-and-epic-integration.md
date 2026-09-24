---
epic: enforce-class-and-epic-integration
started: 2026-09-23
status: in-progress
---

# Epic: Enforce "fix the class, not the instance" and give epics an integration layer

Decisions: D-eci-001 … D-eci-008 (`decisions/_index.md`).

## Per sub-goal
| # | Sub-goal | Outcome | Iterations | What it taught | Slice verdict |
|---|----------|---------|-----------|----------------|---------------|
| 0 | Baseline row on the two-writer fixture | baseline recorded: **0/3 APPROVE**, 3/3 REJECTs name `litellm` (`.loop/evidence/item-0/`) | 1 | the current verifier already catches a sibling site when the criterion text is universal and the sibling is one `grep src` away — item 1's `Cond.` fires; the fixture is too easy to test a large diff (L-007 found on the way); decided at D-eci-012 | well-sliced — cheap, and it changed item 1 before item 1 was designed |
| 1 | Verifier check 9 | done — pre-check-9 baselines 0/3 and 0/3 APPROVE; check 9 half-fix 3/3 REJECT with the grep on `Sites swept:` (after one output-contract fix), full-fix control 3/3 APPROVE; review gate confirmed 4 correctness findings, all fixed | 8 (4 review fixes, 2 REJECTs) | check 9 formalises what the verifier already did — the leverage is a universal criterion written at all (S-001); a Sweep grep must match the defect's phrasing in single-line fragments (L-008); decided at D-eci-013, D-eci-015 to D-eci-018 | too coarse — measuring the old verifier, writing check 9 and hardening it through review were three increments with a plugin reinstall between them; the measurement half could have been its own item |
| 2 | `loop-record.mjs` refuses a missing `Sweep:` | done — C1–C3 met in 2 iterations; review gate confirmed 3 security bypasses of the new gate (decoy `Sites:`, bookkeeping `--criterion`, placeholder `Sweep:`), fixed in 3 more | 5 (3 review fixes, 1 REJECT) | a refusal gate is itself a class — review rounds found its bypasses one at a time (S-002); parser limits that need goal.md control are recorded, not fixed (L-009); decided at D-eci-019, D-eci-020 | well-sliced — small and self-contained; the review cost was the gate's own bypasses, which belonged here |

## Epic retro (written when the last item closes)
