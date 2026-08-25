# loop-engineering — repo notes

This repo *is* the plugin. Its `.loop/` is a live dogfood run, not fixtures.

- **Editing anything under `commands/`, `skills/`, `agents/`, or this file** →
  read [`.agents/writing-docs.md`](.agents/writing-docs.md) first: context
  pointers, the information hierarchy, the leading-word registry, and the
  pruning passes.
- **The interview method** — design tree, frontier rounds, the two-part
  confidence gate — lives in `skills/interview/SKILL.md`, once. `design` and
  `breakdown` call it and supply only their own scope and seed dimensions.
- **The shipped surface is auto-discovered** from `commands/`, `skills/`,
  `agents/`, and `hooks/hooks.json`. Adding a file ships it, so update the
  "What ships" table in `README.md` in the same change.
- The version lives in `.claude-plugin/plugin.json` and is echoed from disk by
  `scripts/loop-breaker.mjs`; bump it together with a `CHANGELOG.md` entry.
