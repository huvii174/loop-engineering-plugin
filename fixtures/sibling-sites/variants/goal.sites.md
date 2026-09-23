# Goal
Usage rows never report 0 for a cost that was never measured, and the logging
helper is renamed `log` → `trace` everywhere (same change request).

## Success criteria (verifiable)
- [ ] C1 no writer stores 0 for an unmeasured cost
      Done when: no writer stores 0 for an unmeasured cost — `node --test` exits 0
      Evidence: behavior → the writer tests under test/
      Sites: `grep -rnE '\|\| 0|: 0;' src` → 3 hits at design:
        src/ui/format.mjs:3
        src/usage/sdk-writer.mjs:6
        src/billing/providers/litellm.mjs:9
      Must not: no test deleted or weakened; no writer changes a measured cost

## Tier
tier: small
