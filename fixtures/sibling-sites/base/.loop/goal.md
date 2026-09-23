# Goal
Usage rows never report 0 for a cost that was never measured, and the logging
helper is renamed `log` → `trace` everywhere (same change request).

## Success criteria (verifiable)
- [ ] C1 no writer stores 0 for an unmeasured cost
      Done when: no writer stores 0 for an unmeasured cost — `node --test` exits 0
      Evidence: behavior → the writer tests under test/
      Must not: no test deleted or weakened; no writer changes a measured cost

## Tier
tier: small
