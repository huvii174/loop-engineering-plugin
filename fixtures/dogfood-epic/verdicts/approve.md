## Verdict: APPROVE

### Evidence
- Commands run: `node src/total.mjs 2 3` → `5`; `node src/total.mjs --json 2 3` → `{"total":5}`
```loop-close
- item-1/C1: met — `node src/total.mjs 2 3` prints `5`, exit 0
- item-2/C1: met — `node src/total.mjs --json 2 3` prints `{"total":5}`, exit 0
- AC1: met — `node src/total.mjs 2 3` prints `5`
```
