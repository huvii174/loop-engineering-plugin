---
name: interview
description: The questioning method behind every gate that interviews the user — design tree, frontier rounds carrying a recommended answer per question, agent-side fact-finding, and a two-part gate (frontier empty AND min-dimension ≥95%) with a numbered-assumption escape hatch. Load at the start of /loop-engineering:design and /loop-engineering:breakdown, or before questioning the user ahead of any artifact.
---

# Interview — the questioning method

One method, two callers: `/loop-engineering:design` interviews about HOW,
`/loop-engineering:breakdown` about WHAT. The seeds differ; everything below is
the same. The caller supplies three things:

- **Scope** — the class of question in bounds, and the class explicitly out.
- **Seed dimensions** — 4–6 named areas that plant the first branches.
- **Prior answers** — memory already recalled, so nothing settled gets re-asked.

## The design tree

Map the ask as a **design tree**: every decision branches into the decisions
hanging off it. The seed dimensions are the first branches, never the whole
tree — the tree grows out of the answers. A fixed taxonomy can read 95% complete
on every one of its buckets while a whole subtree went unvisited because it fit
no bucket; a tree grown from answers has no such blind spot.

The **frontier** is every decision whose prerequisites are settled: what you can
ask *now* without guessing at an answer you have not heard yet.

## Rounds

Ask the **whole frontier** in one round. Batch size follows dependency rather
than a cap — eight independent questions is one round of eight, because the
scarce resource is the user's round-trips, not tokens.

**A question whose answer depends on another question still open in this round
belongs to a later round.** Asking both together buys an answer conditioned on a
guess that neither of you stated, and that guess flows into the artifact
unexamined.

Every question carries **your recommended answer**. It turns an open question
into a review task the user can accept in one line, and it forces you to hold a
position — a recommendation the user rejects teaches more, and teaches sooner,
than an open question answered.

Where `AskUserQuestion` is available and the frontier is ≤4 questions, use it
with concrete options and mark the recommended one. For a wider frontier, or a
delegated context without that tool, ask in text, in this form:

```
❓ **Q1** — **<short title>**: <body; multiple paragraphs and explicit choices are fine>

➡️ **Recommend:** <your answer, plus the one-line reason>

---

❓ **Q2** — **<short title>**: …
```

Then wait for answers. Each round reshapes the tree: settled decisions push the
frontier outward and unblock what depended on them. Recompute the frontier and
ask the next round.

## Facts are your job; decisions are the user's

A frontier question that needs a fact from the environment — what the code does
today, what a config holds, whether a library supports something — is **yours to
resolve**. Dispatch a subagent for it, composed as a brief under
`Skill(skill: "loop-engineering:prompt-craft")`.

A running exploration is an unsettled prerequisite **in the same tree**: only
the questions downstream of it wait for the subagent, and the rest of the
frontier goes to the user now. Facts and decisions are one graph with two
resolvers.

## The gate — two parts

After every round, report per dimension and name the weakest:

```
success criteria 97% · scope 95% · constraints 92% · edge cases 80% · integration 95%
→ min = 80% (edge cases) · frontier: 3 open
Next round targets edge cases.
```

The gate clears when **both** hold:

1. **The frontier is empty** — every branch visited, nothing silently assumed.
   Structural, and inspectable: the user can read back the rounds and say "you
   never asked about X".
2. **min(dimensions) ≥ 95%** — depth. The gate is the MINIMUM, never the
   average: 99% on scope must not be allowed to hide 70% on edge cases.

Frontier-empty alone lets a shallow tree through; the percentage alone is a
number you assign to yourself. Both hold, or you run another round.

## Escape hatch

The tree keeps growing as long as the user keeps opening branches, so the
interview needs a floor. When roughly 5 rounds have passed, or the user says
some form of "just go":

1. Stop questioning.
2. List every remaining open branch as a **numbered assumption**, each with the
   default you chose and what it costs if that default is wrong.
3. Get one explicit sign-off on the list.

Signed-off assumptions go into the artifact under `## Assumptions (signed off)`.
A branch still vague after one re-ask becomes `- [ ] OQ: <question>` under
`## Open questions` instead of a guess; open questions never block or satisfy a
goal.

## What you hand back

- **Settled** — one line per decision, in the answer as given.
- **Assumptions** — the numbered list, when the escape hatch fired.
- **Open questions** — `OQ:` lines, needs-human, never criteria.
- **Confidence** — the final per-dimension line, whose minimum is what
  `state.json.confidence_at_design` records.

## Rules

- Every question must be capable of changing the artifact. One asked to look
  thorough spends a round-trip and buys nothing.
- Push for exact values: "it should be fast" becomes "what p95, in ms?". The
  loop's verifier gates on evidence, and a vibe produces none.
- Ask in behaviour terms — what the user should observe, rather than which
  function to write.
- Cite memory instead of asking. An answer already in `decisions/` or a
  learnings entry gets confirmed by ID ("D-759-017 still true?"), never re-asked.
