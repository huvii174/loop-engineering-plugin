# loop-engineering — repo notes

This repo *is* the plugin. Its `.loop/` is a live dogfood run, not fixtures.

- **Editing anything under `commands/`, `skills/`, `agents/`, or this file** →
  read [`.agents/writing-docs.md`](.agents/writing-docs.md) first: context
  pointers, the information hierarchy, the leading-word registry, and the
  pruning passes.
- **The interview method** — design tree, frontier rounds, the two-part
  confidence gate — lives in `skills/interview/SKILL.md`, once. `design` and
  `breakdown` call it and supply only their own scope and seed dimensions.
- **The memory contract** — the index/body split, entry shapes, IDs, budgets,
  the six maintenance outcomes, recall and its `Recall:` accounting — lives in
  `skills/loop-memory/SKILL.md`, once. Commands, hooks and `loop-verifier` point
  at it; a rule restated in two of them is the drift that skill exists to stop.
- **The shipped surface is auto-discovered** from `commands/`, `skills/`,
  `agents/`, and `hooks/hooks.json`. Adding a file ships it, so update the
  "What ships" table in `README.md` in the same change.
- The version lives in `.claude-plugin/plugin.json` and is echoed from disk by
  `scripts/loop-breaker.mjs`; bump it together with a `CHANGELOG.md` entry.
- **Before a release that changes `agents/loop-verifier.md` or
  `agents/plan-critic.md`** is announced, install it and re-spawn the installed
  agent on the fixture variants — `fixtures/sibling-sites/stage.sh half|full`; the three check-9
  edits of the rendered `full` payload (the `src/ui/format.mjs:3` Sweep line
  removed, the `Sites:` grep narrowed, that line marked `fixed`);
  `fixtures/sites-critic/`. No script tests agent prompt text.
