# Goal
Usage rows never report 0 for a cost that was never measured.

## Success criteria (verifiable)
- [ ] C1 no writer stores 0 for an unmeasured cost
      Done when: no writer stores 0 for an unmeasured cost — `node test/sdk-writer.test.mjs` exits 0
      Evidence: behavior → the focused writer test
      Must not: no test deleted or weakened; no writer changes a measured cost

## Tier
tier: small
