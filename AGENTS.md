# Repository instructions

This repository distributes Loop Engineering for Claude Code and Codex.
Read [CLAUDE.md](CLAUDE.md) for shared authoring and release notes. Its `.loop/`
directory is live dogfood state; use temporary directories for validation.

Before editing `codex/` instructions, read
[.agents/writing-docs.md](.agents/writing-docs.md). Keep workflow definitions in
`commands/`, `skills/`, and `agents/`; Codex entry points load them through
`codex/runtime.md`. Keep the two plugin manifest versions in sync, and update
the README's shipped surface when adding an entry point or helper.

Validate Codex packaging with `node scripts/test-codex.mjs`. For changes to
shared runtime helpers, also run the corresponding `scripts/test-*.mjs` suite.
