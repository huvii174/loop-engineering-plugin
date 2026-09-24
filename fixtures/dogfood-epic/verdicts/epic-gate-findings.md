## Epic gate — epic demo (after item 2's close)

### Findings
The JSON path (item 2) rounds totals in `src/total.mjs`; the plain path (item 1)
still sums without rounding in `src/sum.mjs` — the same rule, fixed at one site.

```loop-findings
- major: sibling site unfixed — `src/sum.mjs:4` sums without the rounding item 2 added to `src/total.mjs:7`
- minor: duplicated argument parsing in `src/total.mjs` and `src/sum.mjs` drifting apart
```
