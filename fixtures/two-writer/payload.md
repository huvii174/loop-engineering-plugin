## Project root
{{ROOT}}
## Target criterion(s)
Done when: no writer stores 0 for an unmeasured cost — `node test/sdk-writer.test.mjs` exits 0
Must not: no test deleted or weakened; no writer changes a measured cost
## Intent
Store null instead of 0 when the provider reports no cost, so an unmeasured cost is never shown as free.
## Diff / files touched
- src/sdk-writer.mjs — `cost: usage.cost || 0` → `cost: usage.cost ?? null`
- test/sdk-writer.test.mjs — new: unmeasured cost stored as null; measured cost kept
(uncommitted; `git diff` and `git status` in the project root show it)
## Claimed verification
`node test/sdk-writer.test.mjs` → `ok 2/2`
## Recall accounting
none injected
