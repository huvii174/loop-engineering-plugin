Epic: enforce-class-and-epic-integration — backlog item #3

# Goal
(snapshot stand-in for item 3's goal, authored for loop-close tests)

## Success criteria (verifiable)
- [x] C1 close runs from the loop
      Done when: `commands/loop.md` step 3 calls `loop-close.mjs close` and no longer tells the model to tick epic ACs
      Evidence: docs → grep
      Must not: the model ticks an AC
