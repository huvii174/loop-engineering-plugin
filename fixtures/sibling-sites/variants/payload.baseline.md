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
- 12 files under src/ — `log` renamed to `trace` (mechanical rename; `git diff --stat` lists them)
(uncommitted; `git diff` and `git status` in the project root show it)
## Claimed verification
`node --test` → `ℹ pass 2 / ℹ fail 0`
## Recall accounting
none injected
