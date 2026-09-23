## Project root
{{ROOT}}
## Target criterion(s)
Done when: no writer stores 0 for an unmeasured cost — `node --test` exits 0
Must not: no test deleted or weakened; no writer changes a measured cost
## Intent
Store null instead of 0 when the provider reports no cost, so an unmeasured cost is never shown as free; and rename the logging helper `log` → `trace` everywhere (same change request).
## Diff / files touched
- src/usage/sdk-writer.mjs — `cost: usage.cost || 0` → `cost: usage.cost ?? null`
- test/sdk-writer.test.mjs — new: unmeasured cost stored as null; measured cost kept
- src/billing/providers/litellm.mjs — `: 0` → `: null` when the cost is not a number
- test/litellm.test.mjs — new: unmeasured cost stored as null; measured cost (including 0) kept
- 12 files under src/ — `log` renamed to `trace` (mechanical rename; `git diff --stat` lists them)
(uncommitted; `git diff` and `git status` in the project root show it)
## Claimed verification
`node --test` → `ℹ pass 4 / ℹ fail 0`
## Sweep
Sites: `grep -rnE '\|\| 0|: 0;' src` (from goal.md)
- src/usage/sdk-writer.mjs:6 — fixed (now `?? null`; no longer a hit)
- src/billing/providers/litellm.mjs:9 — fixed (`: null` when the cost is not a number; no longer a hit)
- src/ui/format.mjs:3 — not-this-class (display formatter for the dashboard; renders a stored cost, never writes a row)
## Recall accounting
none injected
