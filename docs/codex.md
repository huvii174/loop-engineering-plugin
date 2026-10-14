# Codex installation and distribution

Loop Engineering ships one set of workflows for Claude Code and Codex. Codex
loads `.codex-plugin/plugin.json` and discovers the skill entry points under
`codex/skills/`. Each entry point reads `codex/runtime.md`, then the corresponding
shared command, skill, or role. The adapter translates host syntax without
duplicating the interview, memory, or verification contracts.

## Install

With a Codex CLI supporting `codex plugin`:

```bash
codex plugin marketplace add huvii174/loop-engineering-plugin
codex plugin add loop-engineering@loop-engineering-marketplace
```

From a clone, use its absolute directory path with `marketplace add` instead.
The catalog at `.agents/plugins/marketplace.json` resolves `source.path: "./"`
from the repository root. In the desktop plugin directory, select the Loop
Engineering marketplace and install the plugin. Restart Codex or start a new
session after installing or refreshing it.

Inspect and refresh the marketplace with:

```bash
codex plugin list --marketplace loop-engineering-marketplace
codex plugin marketplace upgrade loop-engineering-marketplace
codex plugin add loop-engineering@loop-engineering-marketplace
```

After upgrading, verify the installed version with `plugin list` and the
breaker's `[plugin vX.Y.Z]` output. If your CLI lacks `plugin`, update Codex before
using this installation route.

## Use

Invoke skills with the user input following their name; Claude's namespaced
slash commands are translated internally rather than registered in Codex.

| Codex request | Workflow |
|---|---|
| `$loop-engineering:loop-breakdown Build a customer portal` | Epic scope interview and ordered backlog |
| `$loop-engineering:loop-design Add password reset` | Design interview, engineered brief, and criteria |
| `$loop-engineering:loop` | Run or resume the current loop |
| `$loop-engineering:loop-run customer-portal` | Execute the signed-off epic |
| `$loop-engineering:loop-run customer-portal --hands-off` | Run with explicit assumptions and mandatory critique |
| `$loop-engineering:loop-status` | Show progress and diagrams |
| `$loop-engineering:loop-memory` | Distil scratch and maintain durable memory |

Node.js 18+ must be on PATH. Scripts run from the installed plugin by absolute
path with the target project as cwd. State and memory remain in the target
project's `.loop/`; the installed plugin is a source of procedures and helpers.
The promotion gate targets the project's `AGENTS.md` or its established memory
system in Codex.

Enable Codex subagents for independent verification, design critique, and review.
Reviewers use fresh context and the host's configured model. Claude model labels
aren't passed as Codex model IDs. When delegation is unavailable, those gates
remain pending; the implementer cannot award itself `APPROVE` or mark the goal
done. Status, interviews, and memory maintenance remain usable.

## Enforcement differences

The Codex manifest sets `commands: []` and `agents: []` so Claude's source
procedures aren't also auto-converted into unadapted Codex skills. It sets
`hooks: []` to replace default hook discovery explicitly.
This prevents a Git installation from picking up `hooks/hooks.json`, which
belongs to Claude. The standalone ZIP excludes hook files entirely.

| Capability | Codex package |
|---|---|
| Breaker, history writer, close and archive gates, memory lint | Shared deterministic scripts |
| Interviews, independent verifier, review, compounding memory | Shared workflows through the runtime adapter |
| Boundaries, recall before work, memory before ending, epic continuity | Checks during an invoked workflow |
| Mechanical write blocking, stop blocking, ambient recall, session reminders, agent tracking | Unavailable; Claude lifecycle hooks are disabled |

Resume an interrupted loop with `$loop-engineering:loop`, or its epic with `$loop-engineering:loop-run`. Codex
doesn't use the Claude stop hook to keep the session open.

The manifest and marketplace follow [official OpenAI packaging guidance](https://developers.openai.com/plugins/build/plugins).
The command and role adapters follow [OpenAI's Claude plugin migration guidance](https://developers.openai.com/plugins/guides/submit-claude-plugin).

## Distribute a standalone ZIP

From the repository:

```bash
node scripts/test-codex.mjs
node scripts/package-codex.mjs
```

With Codex CLI installed, also run `node scripts/test-codex.mjs --with-cli`.
This installs the extracted ZIP into a temporary profile and uses the app
server's `skills/list` to check every registered skill. Tested with Codex CLI
0.160.0; the test doesn't invoke a model or alter your regular profile.

The archive is `dist/loop-engineering-codex-<version>.zip`, containing one
`loop-engineering/` directory with the Codex manifest, adapters, shared
procedures, attribution notices, license, and six runtime helpers. It excludes
`.env`, local configuration, dogfood state, evidence, fixtures, tests, and Claude
hooks. Building requires the `zip` CLI; choose another destination with
`--output-dir /absolute/output/path`.

To distribute the ZIP through a local marketplace, extract its plugin folder
into a marketplace repository and point a catalog entry's `source.path` at that
folder. Public-directory submission is a separate upload and review process;
this change doesn't publish a listing or claim approval.

For a release, keep `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`
names and versions in sync. Packaging refuses a mismatch. Shared behavior stays
in its existing authoritative file; add a short Codex entry point for a new
surface, update the shipped-surface table, and rerun the packaging checks.
