# Writing for agents — authoring doctrine for this plugin

Everything under `commands/`, `skills/`, and `agents/` is a document an agent
consumes. The packaging differs; the writing does not. Read this before adding
or editing any of them, or this repo's `CLAUDE.md`.

Adapted from the `writing-for-agents` skill in
[mattpocock/skills](https://github.com/mattpocock/skills).

## What costs what

Three tiers of load, and they are not equal:

| Text | When it loads | Cost |
|---|---|---|
| skill `description` | every turn of every session with the plugin installed | highest — prune hardest |
| `CLAUDE.md` | every turn in this repo | highest |
| command body | when the user types the command | once per invocation |
| skill body, `agents/*.md` | on `Skill()` / `Agent()` | once per call |
| `references/*.md` | when a pointer inside a skill fires | only on that branch |

Moving a passage from a skill body into `references/` trades the passage's
tokens for the pointer's. That move is the main lever available here.

## Context pointers

A **context pointer** names out-of-context material and encodes the condition
for reaching it. A skill's `description` is one; so is a line in `CLAUDE.md`; so
is "routing table in the loop-verifier agent". The pointer's *wording* decides
when the agent reaches the material and how reliably, so good material behind a
weak pointer is a variance bug: sharpen the wording before considering inlining
the material.

A pointer states what the material is and lists the **branches** that trigger
reaching it. Front-load the leading word, keep one trigger per branch (synonyms
renaming a single branch are one branch written twice), and cut identity the
body already carries.

## The two loads

- **Context load**: tokens and attention spent every turn, whether or not the
  material fires.
- **Cognitive load**: what the human must remember — which command to type, and
  when. Not a cost to minimise. It is the price of human agency: spend it where
  human judgement matters (the `design` and `breakdown` sign-offs) and remove it
  where it does not (`run` exists because typing `design` six times was
  cognitive load with no judgement in it).

## Information hierarchy

Rank every piece by how immediately the agent needs it:

1. **In-file step** — what the agent does, in order.
2. **In-file reference** — consulted on demand. A flat peer-set (every rule of
   the review gate on one rung) is a fine arrangement, not a smell.
3. **Disclosed reference** — a separate file behind a pointer, loaded only when
   that pointer fires (`skills/prompt-craft/references/`).

**Progressive disclosure** is the move down that ladder, and branching is its
test: inline what every branch needs, push behind a pointer what only some
branches reach. **Co-location** is the within-file companion — keep a concept's
definition, rules and caveats under one heading so reading one part brings its
neighbours along. **Sprawl** is the failure mode: a document simply too long
even when every line is live and unique, with attention thinning across the
excess.

## Completion criteria

Every step ends on a condition that says the work is done. Two properties make
it a lever:

- **Clarity** — can the agent tell done from not-done? A vague bound invites
  **premature completion**, because the steps still visible ahead pull attention
  toward being finished. Sharpen the bound first; splitting the sequence helps
  only across a real context boundary such as a subagent dispatch, since an
  inline call leaves the later steps in context anyway.
- **Demand** — how much it requires. "Every modified model accounted for" forces
  legwork that "produce a change list" does not.

This plugin's whole thesis is that criterion: `Done when:` / `Must not:` /
`Evidence:` is one applied at goal level. Hold the same bar inside the documents.

## Leading words

A **leading word** is a compact concept the model already holds from
pretraining, repeated as a token rather than restated as a sentence. It anchors
behaviour in the fewest tokens, and it anchors invocation too — shared
vocabulary across prompts, docs and code makes the agent reach the right
material.

The registry for this plugin. Use these words; coining a synonym for one splits
the anchor in half:

**breaker** · **gate** · **frontier** · **tier** · **anchor** (external anchor)
· **tenth man** · **scratch** · **rollup** · **brief** · **red** (a check that
goes red on this defect) · **tight** (fast, deterministic, agent-runnable).

Hunt for passages that collapse into one of these. A triad spelled out at three
sites is a passage begging to become a token.

## Prompt the positive

Steering by prohibition drags the forbidden behaviour into context and makes it
*more* available, so state the target behaviour and leave the banned one
unspoken.

A prohibition earns its place as a **hard guardrail** that cannot be phrased
positively — "never grade your own work", "never overrule an exit 2" — and even
then it belongs beside the positive it protects. Soft advice wearing a ban is
the version to flip.

This reads against `prompt-craft`'s lint question 2 ("MUST over should, NEVER
over avoid") only if you skip a step. The two compose in order: **first ask
whether the instruction can be a positive target; once a prohibition is
warranted, make it the strongest one available.** Prompt-craft grades the
wording of a ban already chosen; this section decides whether to choose one. A
hedged prohibition is the worst of both, landing neither the target nor the
guardrail.

## Pruning

- **Single source of truth.** One authoritative home per meaning. Duplication
  costs maintenance, costs tokens, and inflates a meaning's rank on the
  hierarchy — and it drifts: the interview method lived in both `design.md` and
  `breakdown.md` until the two copies disagreed about whether the confidence
  gate was a minimum or an average. That drift is why `skills/interview/` exists.
- **The environment is a source of truth too** — `state.json`'s schema,
  `loop-breaker.mjs`'s exit codes, the directory layout. A document restating
  them is a **cache**, and a cache earns its load only when the lookup is
  expensive. Cache the unwritten convention and the reason behind a choice;
  leave one-file lookups where they cannot go stale.
- **Hunt no-ops** sentence by sentence: an instruction the model already obeys by
  default pays load to say nothing. The test is model-relative and settled by
  running the document, not by debate. When a sentence fails it, delete the
  sentence rather than trimming words from it. The test grades leading words too
  — one too weak to beat the default is a no-op, and the fix is a stronger word.
- **Sediment** is the default fate without this discipline: stale layers that
  settle because adding feels safe and removing feels risky.

## Done when

- Every new pointer states its branches, with its leading word first.
- Each meaning has one home, and a second mention is a pointer to it.
- Every step's completion criterion is checkable, and demanding enough to force
  the legwork that step needs.
- The prohibitions that survived are hard guardrails, each beside its positive.
- The no-op pass ran, and what it found was deleted rather than trimmed.
