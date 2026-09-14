#!/usr/bin/env node
/**
 * Fixture tests for migrate-memory. Run: node scripts/test-migrate-memory.mjs
 * Exits 0 when every case matches, 1 otherwise. No dependencies.
 *
 * Every fixture is built from scratch in a mkdtemp directory and removed at the
 * end. The captured dogfood run in `evd/` is NEVER read or written here: the
 * shapes it taught are transcribed into the fixtures below instead, so the suite
 * still runs when `evd/` is absent (it is not tracked).
 *
 * Two bugs found by hand against the real store are pinned as regressions, both
 * of the kind that fail silently rather than loudly:
 *
 *   INVENTED EPICS. Harvesting slug-shaped tokens out of prose cannot tell an
 *   epic from a UUID or from a hyphenated adjective, so it filed decisions under
 *   `ff3f7ea0-e52d-…` and `backward-compatible`. `epics/` is authoritative when
 *   it exists; the harvest is a fallback for when there is no directory to trust.
 *
 *   BYTES ARE NOT CHARACTERS. The 200-char index budget looked violated on 153
 *   lines under `awk 'length>200'`, which counts UTF-8 bytes — the em-dash and
 *   the ellipsis this migration writes are multi-byte. The budget assertion here
 *   measures characters, and a companion case proves the two measures really do
 *   disagree on this data, so nobody "fixes" the budget back into bytes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildEpicRegistry, clip, epicKey, firstClause, parseDecisions, parseLearnings,
  reconciliation, splitDecision, splitTags,
} from './migrate-memory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'migrate-memory.mjs');

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
}

const cleanup = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'migrate-memory-test-'));
  cleanup.push(d);
  return d;
}

function migrate(...args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** A `.loop/memory` in the flat layout, holding exactly what a case needs. */
function store({ learnings = null, decisions = null, epics = [], adhoc = true } = {}) {
  const dir = join(scratch(), 'memory');
  mkdirSync(dir, { recursive: true });
  if (learnings !== null) writeFileSync(join(dir, 'learnings.md'), learnings);
  if (decisions !== null) writeFileSync(join(dir, 'decisions.md'), decisions);
  if (epics.length) {
    mkdirSync(join(dir, 'epics'), { recursive: true });
    for (const e of epics) writeFileSync(join(dir, 'epics', `${e}.md`), `# ${e}\n`);
  }
  if (adhoc) {
    mkdirSync(join(dir, 'scratch'), { recursive: true });
    writeFileSync(join(dir, 'scratch', 'adhoc.md'), '<!-- ad-hoc scratch -->\n');
  }
  return dir;
}

const read = (dir, ...p) => readFileSync(join(dir, ...p), 'utf8');
const bodyIds = (text, prefix) => text.match(new RegExp(`^### ${prefix}-[^\\s]+`, 'gm')) ?? [];

/** Every file under dir, relative, for "did we write only what we meant to" checks. */
function tree(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tree(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)]
  );
}

// ------------------------------------------------------------- pure functions

check('splitTags peels every leading tag and leaves the prose',
  (() => {
    const { tags, rest } = splitTags('[env][docker] a worktree needs --network');
    return tags.length === 2 && tags[0] === 'env' && tags[1] === 'docker' && rest === 'a worktree needs --network';
  })());

check('firstClause stops at the em-dash separator',
  firstClause('the guard ships inert — because can() only asks the parent') === 'the guard ships inert');

check('firstClause keeps "incl." whole instead of cutting at the abbreviation',
  firstClause('"Everything fresh incl. both E2E legs" reads as ONE stack. Then D4 reuses it.')
    === '"Everything fresh incl. both E2E legs" reads as ONE stack.',
  firstClause('"Everything fresh incl. both E2E legs" reads as ONE stack. Then D4 reuses it.'));

check('clip marks the cut with an ellipsis and never exceeds the budget',
  (() => { const c = clip('x'.repeat(300), 40); return c.length === 40 && c.endsWith('…'); })());

check('epicKey takes the numeric prefix when the slug has one', epicKey('759-document-tab-parity') === '759');
check('epicKey falls back to initials for a wordy slug', epicKey('pm-schema-cutover') === 'psc');

check('splitDecision reads a Rationale label carrying a parenthetical',
  (() => {
    const s = splitDecision('Choice: apply `bg-card border` on every surface. Rationale (measured from globals.css, all 4 modes): the gap is 4 points.');
    return s.decision === 'apply `bg-card border` on every surface' && /the gap is 4 points/.test(s.rationale);
  })());

check('splitDecision keeps an unsplittable bullet whole and flags it',
  (() => {
    const s = splitDecision('RED tolerated on the epic branch');
    return s.unsplit === true && s.decision === 'RED tolerated on the epic branch' && s.alternatives === null;
  })());

check('reconciliation passes when the counts agree',
  reconciliation({ sourceEntries: 820, migratedEntries: 820 }).ok === true);

check('reconciliation fails loudly when an entry is lost',
  (() => {
    const r = reconciliation({ sourceEntries: 820, migratedEntries: 819 }, { dryRun: false });
    return r.ok === false && /RECONCILIATION FAILED/.test(r.message) && /half-migrated/.test(r.message);
  })());

// ------------------------------------------------- continuation-line joining

{
  const learnings = [
    '# Learnings',
    '',
    '## Gotchas',
    '- [gotcha][tiptap] `@tiptap/suggestion`\'s exit path',
    '  (`exitSuggestion`/`dispatchExit`, including outside-click dismissal)',
    '  only clears PLUGIN STATE, never document content (run-1)',
    '- [gotcha][editing] an edit anchor that matches TWICE is a silent no-op (run-2)',
    '',
  ].join('\n');
  const p = parseLearnings(learnings);
  check('continuation lines join into ONE logical entry, not three',
    p.entries.length === 2, `got ${p.entries.length}`);
  check('the joined entry keeps every wrapped fragment on one line',
    p.entries[0].original.includes('exit path (`exitSuggestion`')
    && p.entries[0].original.includes('only clears PLUGIN STATE')
    && !p.entries[0].original.includes('\n'),
    p.entries[0].original);
  check('a blank line closes an entry so the next bullet stands alone',
    p.entries[1].original.startsWith('[gotcha][editing]'));
}

// ------------------------------------------------------ [minor] type fallback

{
  const learnings = [
    '# Learnings', '',
    '## Never store', '- secrets, tokens, credentials', '',
    '## Gotchas',
    '- [minor][review][simplification] a resync-on-editor-swap useEffect is redundant (run-1)',
    '- [adhoc][docker] an unknown type that is not minor either (run-2)',
    '- [gotcha][testing] a known type (run-3)',
    '',
    '## Patterns', '- [pattern][testing] a mutation check proves the test can fail (run-4)', '',
    '## What didn\'t work', '- [dead][process] probing reachability outside the entry point (run-5)', '',
    '## Environment', '- [env][pytest] `-q` does not quiet this repo (run-6)', '',
  ].join('\n');
  const p = parseLearnings(learnings);
  check('an unknown [minor] type is filed as gotcha, not dropped',
    p.entries.filter((e) => e.type === 'gotcha').length === 3, JSON.stringify(p.entries.map((e) => e.type)));
  check('both unknown types are REPORTED, not silently absorbed',
    p.unknownTypes.length === 2 && p.unknownTypes.some((u) => u.tag === 'minor') && p.unknownTypes.some((u) => u.tag === 'adhoc'),
    JSON.stringify(p.unknownTypes.map((u) => u.tag)));
  check('the unknown entry keeps its ORIGINAL tags in the body, not a rewritten [gotcha]',
    p.entries[0].tags[0] === 'minor' && p.entries[0].original.startsWith('[minor][review]'));
  check('known types still shard to their own files',
    p.entries.filter((e) => e.type === 'pattern').length === 1
    && p.entries.filter((e) => e.type === 'dead').length === 1
    && p.entries.filter((e) => e.type === 'env').length === 1);
  check('"## Never store" is lifted out and is not counted as three entries',
    p.neverStore.includes('secrets, tokens, credentials') && p.entries.length === 6, `entries=${p.entries.length}`);
}

// -------------------------------------------- epic resolution + invented epics

const INVENTED = [
  '# Decisions',
  '- **[759 item 35 design canvas, 2026-08-31] Attempted to view the signed-off canvas',
  '  (https://claude.ai/code/artifact/ff3f7ea0-e52d-4629-a847-c0fb31b5c0d0) before committing** — the',
  '  artifact viewer needs a login this session does not have. (759-document-tab-parity/item 35 design gate)',
  '- **[LOOP] The mapper stays backward-compatible** — legacy rows keep rendering. (run-2026-08-20-pmD1 / backward-compatible)',
  '- **[692 item 1, critic round 1] The anchor is #692\'s four-way census** — measured, not assumed. (run-1 / 692-block-identity)',
  '',
].join('\n');

{
  const dir = store({ decisions: INVENTED, epics: ['759-document-tab-parity', '692-block-identity'] });
  const registry = buildEpicRegistry(dir, INVENTED);
  const slugs = registry.map((r) => r.slug);
  check('REGRESSION: a UUID in a URL is never mistaken for an epic',
    !slugs.some((s) => s.startsWith('ff3f7ea0')), JSON.stringify(slugs));
  check('REGRESSION: the adjective "backward-compatible" is never mistaken for an epic',
    !slugs.includes('backward-compatible'), JSON.stringify(slugs));
  check('the registry is exactly what epics/ declares',
    slugs.length === 2 && slugs.includes('759-document-tab-parity') && slugs.includes('692-block-identity'),
    JSON.stringify(slugs));

  const p = parseDecisions(INVENTED, registry);
  check('a decision naming an epics/ slug resolves to it',
    p.entries[0].epic?.slug === '759-document-tab-parity', String(p.entries[0].epic?.slug));
  check('a decision whose only slug-shaped token is bogus goes to durable, not to an invented epic',
    p.entries[1].epic === null, String(p.entries[1].epic?.slug));
  check('a bare [692 item 1] tag resolves through the numeric alias',
    p.entries[2].epic?.slug === '692-block-identity' && p.entries[2].item === 1, String(p.entries[2].epic?.slug));
}

{
  // No epics/ directory: the prose harvest is the fallback, and it is allowed to
  // read only the precise `(slug/item N)` form.
  const dir = store({ decisions: INVENTED });
  const slugs = buildEpicRegistry(dir, INVENTED).map((r) => r.slug);
  check('with no epics/ directory the harvest still finds the (slug/item N) form',
    slugs.includes('759-document-tab-parity'), JSON.stringify(slugs));
  check('even the fallback harvest refuses the UUID and the adjective',
    !slugs.some((s) => s.startsWith('ff3f7ea0')) && !slugs.includes('backward-compatible'), JSON.stringify(slugs));
}

{
  // `## Item N` sections carry no slug; the nearest preceding resolved bullet is
  // inherited, and the inheritance is REPORTED rather than passed off as read.
  const src = [
    '# Decisions',
    '- **[759 item 22 design, 2026-08-30] Split the batch PATCH by failure mode** — one list per mode. (run-1 / 759-document-tab-parity)',
    '',
    '## Item 23 — codeBlock loss via keyboard routes (2026-08-30)',
    '',
    '- Choice: refactor `codeBlockWouldDropSlot(editor)` to take state. Rejected alternative: a second predicate.',
    '',
  ].join('\n');
  const dir = store({ decisions: src, epics: ['759-document-tab-parity'] });
  const p = parseDecisions(src, buildEpicRegistry(dir, src));
  check('a ## Item N section inherits the preceding bullet\'s epic',
    p.entries[1].epic?.slug === '759-document-tab-parity' && p.entries[1].item === 23,
    `${p.entries[1].epic?.slug} item=${p.entries[1].item}`);
  check('the inheritance is reported for a human to verify, not silently trusted',
    p.inherited.length === 1 && p.inherited[0].heading.startsWith('Item 23'), JSON.stringify(p.inherited));
}

// ------------------------------------------------------ superseded anchoring

{
  const src = [
    '# Decisions',
    '- **[759 item 9 design] Replace All processes matches in REVERSE document order within one transaction** — reverse order sidesteps position-shift bugs. (run-1 / 759-document-tab-parity)',
    '- **[SUPERSEDED 2026-08-11] Delivery is now plain git + gh** — the MCP path needed full file contents inlined.',
    '- **[BREAKDOWN unified-document-surface, REVERSED same day] Scope restored to the FULL 7-item backlog** — user decided to deliver both phases.',
    '- **[GATE amendment, D4 design] "Everything fresh" reads as ONE stack** — amended at the D3 gate.',
    '- **[LOOP] The breaker plateau threshold rises from 4 to 9** — the design has 7 work groups.',
    '',
  ].join('\n');
  const dir = store({ decisions: src, epics: ['759-document-tab-parity'] });
  const p = parseDecisions(src, buildEpicRegistry(dir, src));
  check('REGRESSION: "REVERSE document order" is NOT a supersede signal',
    p.entries[0].status === 'active' && p.entries[0].supersededNote === null,
    `${p.entries[0].status} / ${p.entries[0].supersededNote}`);
  check('an explicit SUPERSEDED marker is flagged', p.entries[1].status === 'superseded');
  check('"REVERSED" is flagged where bare "reverse" is not', p.entries[2].status === 'superseded');
  check('"amended" is flagged', p.entries[3].status === 'superseded');
  check('an ordinary decision stays active', p.entries[4].status === 'active');
  check('every flagged decision carries the quoted source phrase for the human pass',
    [1, 2, 3].every((i) => typeof p.entries[i].supersededNote === 'string' && p.entries[i].supersededNote.length > 0));
  check('the script does NOT guess which id supersedes which',
    !JSON.stringify(p.entries).includes('supersededBy'));
}

// ------------------------------------------------------ end-to-end migration

const LONG = 'a WORKTREE\'s DB-backed backend tests need all three of `--network hiops_local` and `DB_HOST=hiops_db DB_PORT=5432` (NOT the host-published 5434 — that path dies with "PostgreSQL server rejected SSL upgrade") and `DB_SSL_REQUIRE=false` because app/config.py:75 defaults it ON while the local container speaks no SSL, so without them all 43 route tests ERROR at fixture setup and read as code failures, which costs a verifier a wrong reading until the runs are serialised '.repeat(3);

const FULL_LEARNINGS = [
  '# Learnings',
  '',
  '> **⛔ Over budget: 108 durable one-liners against a ~60 target.** A real',
  '> maintenance pass is DUE before the next design gate.',
  '',
  '<!-- Maintained 2026-08-17: 80 -> 62 one-liners. Sections were interleaved,',
  '     so entries were sorted into their real sections. Nothing was deleted',
  '     merely for age: epic #264 is still in-progress. -->',
  '',
  '## Never store',
  '- secrets, tokens, credentials, connection strings',
  '- customer or personal data, internal client names',
  '',
  '## Environment',
  `- [env][docker] ${LONG}(run-2026-08-29-759-13)`,
  '',
  '## Gotchas',
  '',
  '### ProseMirror cutover (epic pm-schema-cutover, in progress)',
  '- [gotcha][prosemirror] `editor.can()` is a NO-OP for content-DESTROYING conversions',
  '  because `canChangeType` asks only whether the PARENT accepts the new type (run-1)',
  '- [minor][review][tiptap] a defensive try/catch around a TipTap reactive read (run-2)',
  // No em-dash and no sentence boundary, so the whole clause is the trigger and
  // the index line must be truncated: this is what proves the budget is enforced.
  `- [gotcha][testing] ${'a single unbroken clause that names no separator and reaches no full stop so the trigger has to be cut by the budget rather than by punctuation '.repeat(3)}(run-7)`,
  '',
  '## Patterns',
  '- [pattern][testing] a mutation check — break the thing a new test asserts, confirm it fails (run-3)',
  '',
  '## What didn\'t work',
  '- [dead][pm-mapper] "the mapper needs its own recursion depth guard" — refuted (run-4)',
  '',
  '## Scratch (this run)',
  '- [adhoc][docker] a live scratch finding written mid-run, not yet distilled (2026-09-01)',
  '- [gotcha][testing] a second scratch line that is hand-wrapped',
  '  across two physical lines and must survive as one entry (2026-09-01)',
  '',
].join('\n');

const FULL_DECISIONS = [
  '# Decisions',
  '- **[759 item 26 loop, iter 1] Raised `state.json`\'s `breaker.plateau` from 4 to 9** — design.md\'s 7-work-group structure means the whole-toolbar criteria can only close after the LAST group; alternatives rejected: letting the breaker trip and re-arming it by hand. (run-1 / 759-document-tab-parity)',
  '- **[LOOP] Bookkeeping passes stay transparent to the failure chain** — recording work is not progress.',
  '- **[759 item 23 design] The codeBlock guard mirrors the command\'s own iteration** — `setBlockType` loops every selection range. (run-3 / 759-document-tab-parity)',
  // Deliberately placed LAST before the `## Item 23` section, so the nearest
  // preceding bullet is 692 while the item-number evidence says 759. Adjacency
  // alone would file the section under the wrong epic.
  '- **[692 item 1, critic round 1] SUPERSEDES the counts-table decision above: the anchor is #692\'s four-way census** — measured. (run-2 / 692-block-identity)',
  '',
  '## Item 23 — codeBlock/slot loss via keyboard routes (2026-08-30)',
  '',
  '- Choice: refactor `codeBlockWouldDropSlot(editor)` to take `EditorState`. Rationale (confirmed both rounds): the function already only read `editor.state`. Rejected alternative: a second input-rule-specific predicate.',
  '',
].join('\n');

{
  const dir = store({ learnings: FULL_LEARNINGS, decisions: FULL_DECISIONS, epics: ['759-document-tab-parity', '692-block-identity', 'pm-schema-cutover'] });

  const dry = migrate('--dir', dir, '--dry-run');
  const counts = /reconciliation: (\d+) source entries → (\d+) migrated/.exec(dry.out);
  // 6 learnings + 2 scratch + 5 decisions. Pinned as a literal so that losing an
  // entry fails here, which an equal-to-itself assertion never would.
  check('dry run exits 0 and reconciles every one of the 13 source entries',
    dry.code === 0 && counts && counts[1] === '13' && counts[2] === '13',
    `code=${dry.code} counts=${counts?.slice(1)} ${dry.err}`);
  check('dry run writes NOTHING', !existsSync(join(dir, 'learnings')) && !existsSync(join(dir, 'decisions')) && !existsSync(join(dir, 'scratch', 'run.md')));
  check('dry run names the unclassified entry', /\[minor\]/.test(dry.out), dry.out.slice(0, 600));

  const run = migrate('--dir', dir);
  check('real run exits 0', run.code === 0, run.err);

  // --- learnings sharded by tag
  check('learnings shard by [type] tag, not by source section',
    bodyIds(read(dir, 'learnings', 'env.md'), 'L').length === 1
    && bodyIds(read(dir, 'learnings', 'gotchas.md'), 'L').length === 3
    && bodyIds(read(dir, 'learnings', 'patterns.md'), 'L').length === 1
    && bodyIds(read(dir, 'learnings', 'dead-ends.md'), 'L').length === 1);

  const lIndex = read(dir, 'learnings', '_index.md');
  check('"## Never store" sits in the index, ahead of the trigger lines',
    lIndex.indexOf('## Never store') < lIndex.indexOf('- L-001')
    && lIndex.includes('customer or personal data'));
  check('the blockquote and the HTML maintenance comment are preserved verbatim',
    lIndex.includes('⛔ Over budget: 108 durable one-liners') && lIndex.includes('Maintained 2026-08-17'));
  check('the retired ### subsection is kept for provenance',
    lIndex.includes('ProseMirror cutover (epic pm-schema-cutover, in progress)'));
  check('index lines are grouped under their type headings',
    /^## env$/m.test(lIndex) && /^## gotcha$/m.test(lIndex) && /^## pattern$/m.test(lIndex) && /^## dead$/m.test(lIndex));

  // --- the 200-char budget, in CHARACTERS
  const indexLines = [...lIndex.split('\n'), ...read(dir, 'decisions', '_index.md').split('\n')];
  const overChars = indexLines.filter((l) => [...l].length > 200);
  check('every index line fits the 200-CHARACTER budget', overChars.length === 0,
    `${overChars.length} over, longest=${Math.max(0, ...overChars.map((l) => [...l].length))}`);

  const longest = indexLines.reduce((a, b) => ([...a].length >= [...b].length ? a : b), '');
  check('a truncated trigger line ends with the ellipsis that marks the cut', longest.endsWith('…'), longest.slice(-40));
  check('REGRESSION: bytes and characters really do disagree here, so the budget must be measured in characters',
    Buffer.byteLength(longest, 'utf8') > [...longest].length,
    `bytes=${Buffer.byteLength(longest, 'utf8')} chars=${[...longest].length}`);

  // --- bodies are verbatim and complete
  const env = read(dir, 'learnings', 'env.md');
  check('a 1000+ char entry is stored with NO length cap',
    env.includes(LONG.trim().slice(0, 400)) && env.length > 1000);
  check('the body keeps the entry verbatim, tags included', env.includes('### L-001 [env][docker]') && env.includes('[env][docker] a WORKTREE'));

  // --- decisions
  check('a decision with an epic lands under its slug directory',
    bodyIds(read(dir, 'decisions', '759-document-tab-parity', 'item-26.md'), 'D').length === 1);
  check('REGRESSION: a ## Item N section joins on its item number, beating the adjacent-but-wrong epic',
    existsSync(join(dir, 'decisions', '759-document-tab-parity', 'item-23.md'))
    && !existsSync(join(dir, 'decisions', '692-block-identity', 'item-23.md')),
    JSON.stringify(tree(join(dir, 'decisions'))));
  check('a process decision with no epic goes to durable.md',
    read(dir, 'decisions', 'durable.md').includes('Bookkeeping passes stay transparent'));
  check('ids are zero-padded and keyed per epic',
    read(dir, 'decisions', '759-document-tab-parity', 'item-26.md').includes('### D-759-001')
    && read(dir, 'decisions', 'durable.md').includes('### D-core-001'));

  const d26 = read(dir, 'decisions', '759-document-tab-parity', 'item-26.md');
  check('a clean bullet splits into all three fields',
    /\*\*Decision:\*\*/.test(d26) && /\*\*Rationale:\*\*/.test(d26) && /\*\*Alternatives rejected:\*\* letting the breaker trip/.test(d26), d26);
  check('a bullet naming no alternatives says so explicitly',
    read(dir, 'decisions', 'durable.md').includes('**Alternatives rejected:** (not recorded in source)'));
  check('the entry header carries status, date and item',
    /^### D-759-001 · active · 2026-08-31 · item 26$/m.test(d26) || /^### D-759-001 · active · item 26$/m.test(d26), d26.split('\n')[2]);

  const dIndex = read(dir, 'decisions', '_index.md');
  check('the decisions index groups under epic-slug headings',
    /^## 759-document-tab-parity$/m.test(dIndex) && /^## durable$/m.test(dIndex));
  check('the index summary drops the leading provenance tag the id already carries',
    /^- D-759-001 \[active\] item 26 — Raised/m.test(dIndex), dIndex.match(/^- D-759-001.*$/m)?.[0]);
  check('a superseded decision is marked in the index and carries a note in the body',
    /^- D-692-\d+ \[superseded\]/m.test(dIndex)
    && read(dir, 'decisions', '692-block-identity', 'item-1.md').includes('**Superseded-note:**'));

  // --- scratch routing
  const runMd = read(dir, 'scratch', 'run.md');
  check('live scratch entries route to scratch/run.md',
    (runMd.match(/^- /gm) ?? []).length === 2, runMd);
  check('a hand-wrapped scratch entry survives as ONE line',
    runMd.includes('a second scratch line that is hand-wrapped across two physical lines and must survive as one entry'));
  check('scratch entries get no L- id — scratch has not earned one', !runMd.includes('L-0'));
  check('scratch entries stay OUT of the learnings bodies',
    !['env.md', 'gotchas.md', 'patterns.md', 'dead-ends.md']
      .some((f) => read(dir, 'learnings', f).includes('a live scratch finding')));
  check('scratch/adhoc.md is left untouched', read(dir, 'scratch', 'adhoc.md') === '<!-- ad-hoc scratch -->\n');

  // --- sources kept, nothing stray written
  check('sources are renamed, not deleted',
    existsSync(join(dir, 'learnings.md.pre-migration')) && existsSync(join(dir, 'decisions.md.pre-migration'))
    && !existsSync(join(dir, 'learnings.md')) && !existsSync(join(dir, 'decisions.md')));
  check('epics/ is left untouched', existsSync(join(dir, 'epics', '759-document-tab-parity.md')));
  const stray = tree(dir).filter((f) => !/^(learnings|decisions|scratch|epics)[/.]/.test(f));
  check('nothing is written outside the expected tree', stray.length === 0, JSON.stringify(stray));

  // --- no entry lost: every source bullet is accounted for
  const srcBullets = (read(dir, 'learnings.md.pre-migration').match(/^- \[/gm) ?? []).length
    + (read(dir, 'decisions.md.pre-migration').match(/^- /gm) ?? []).length;
  const outBodies = ['env.md', 'gotchas.md', 'patterns.md', 'dead-ends.md']
    .reduce((n, f) => n + bodyIds(read(dir, 'learnings', f), 'L').length, 0)
    + tree(join(dir, 'decisions')).filter((f) => !f.endsWith('_index.md'))
      .reduce((n, f) => n + bodyIds(read(dir, 'decisions', f), 'D').length, 0)
    + (runMd.match(/^- /gm) ?? []).length;
  check('every source bullet lands in exactly one body file',
    srcBullets === outBodies, `source=${srcBullets} out=${outBodies}`);
}

// -------------------------------------------------- idempotency and guardrails

{
  const dir = store({ learnings: FULL_LEARNINGS, decisions: FULL_DECISIONS, epics: ['759-document-tab-parity', '692-block-identity'] });
  migrate('--dir', dir);
  const before = tree(dir).sort().map((f) => `${f}\n${read(dir, f)}`).join('\n---\n');

  const again = migrate('--dir', dir);
  check('a second run with sources already renamed is a no-op, exit 0',
    again.code === 0 && /already migrated/.test(again.out), again.out + again.err);

  const forced = migrate('--dir', dir, '--force');
  check('--force regenerates from the .pre-migration sources, exit 0', forced.code === 0, forced.err);
  const after = tree(dir).sort().map((f) => `${f}\n${read(dir, f)}`).join('\n---\n');
  check('--force output is BYTE-IDENTICAL to the first migration', before === after);
  check('--force did not double-rename the sources',
    !existsSync(join(dir, 'learnings.md.pre-migration.pre-migration')));
}

{
  const dir = store({ learnings: FULL_LEARNINGS, decisions: FULL_DECISIONS, epics: ['759-document-tab-parity'] });
  mkdirSync(join(dir, 'learnings'), { recursive: true });
  writeFileSync(join(dir, 'learnings', 'stale.md'), 'from an older tree\n');
  const r = migrate('--dir', dir);
  check('an existing target tree is refused without --force, exit 1',
    r.code === 1 && /target tree already exists/.test(r.err), `code=${r.code} ${r.err}`);
  check('the refusal wrote nothing and left the live sources alone',
    existsSync(join(dir, 'learnings.md')) && read(dir, 'learnings', 'stale.md') === 'from an older tree\n');

  const f = migrate('--dir', dir, '--force');
  check('--force replaces the stale tree, exit 0', f.code === 0 && !existsSync(join(dir, 'learnings', 'stale.md')), f.err);
}

{
  // scratch/run.md may hold live scratch this run has no replacement for, so it
  // is guarded against but never deleted.
  const dir = store({ learnings: '# Learnings\n\n## Gotchas\n- [gotcha][x] one entry (run-1)\n', decisions: '# Decisions\n- **[LOOP] a process decision** — because.\n' });
  mkdirSync(join(dir, 'scratch'), { recursive: true });
  writeFileSync(join(dir, 'scratch', 'run.md'), '- [adhoc][x] live scratch nobody has distilled yet\n');
  const guarded = migrate('--dir', dir);
  check('an existing scratch/run.md is guarded against without --force',
    guarded.code === 1 && /target tree already exists/.test(guarded.err), `code=${guarded.code} ${guarded.err}`);
  const f = migrate('--dir', dir, '--force');
  check('--force with an empty source scratch NEVER destroys a live scratch/run.md',
    f.code === 0 && read(dir, 'scratch', 'run.md') === '- [adhoc][x] live scratch nobody has distilled yet\n', f.err);
  check('the report says the source scratch section was empty rather than staying silent',
    /Scratch \(this run\)" was empty/.test(f.out), f.out.slice(0, 400));
}

{
  // No pre-seeded run.md: an empty source scratch section must not create one.
  const dir = store({ learnings: '# Learnings\n\n## Gotchas\n- [gotcha][x] one entry (run-1)\n\n## Scratch (this run)\n' });
  const r = migrate('--dir', dir);
  check('no scratch/run.md is invented when the source scratch section is empty',
    r.code === 0 && !existsSync(join(dir, 'scratch', 'run.md')), r.err);
}

{
  const missing = migrate('--dir', join(tmpdir(), 'migrate-memory-does-not-exist-9x7'));
  check('a missing directory exits 1 with a message on stderr',
    missing.code === 1 && /no such directory/.test(missing.err), missing.err);

  const empty = store({});
  const r = migrate('--dir', empty);
  check('a directory with no sources exits 1 rather than writing an empty tree',
    r.code === 1 && /no learnings.md or decisions.md/.test(r.err) && !existsSync(join(empty, 'learnings')), r.err);
}

{
  // Only one of the two sources present: the other half must not be invented.
  const dir = store({ learnings: '# Learnings\n\n## Gotchas\n- [gotcha][x] the only entry (run-1)\n' });
  const r = migrate('--dir', dir);
  check('a learnings-only store migrates without inventing a decisions tree',
    r.code === 0 && existsSync(join(dir, 'learnings', 'gotchas.md')) && !existsSync(join(dir, 'decisions')), r.err);
}

// ---------------------------- regression: heading directly after the first bullet
{
  // closeEntry used to push the open section early when `sections` was still
  // empty; pushSection then pushed it again, so this exact shape duplicated
  // every entry in the first section — and reconciliation passed, because both
  // sides of the count came from the same doubled list. The real store escaped
  // only by having blank lines before every heading.
  const p = parseLearnings('# Learnings\n- [gotcha][x] entry one about zod\n## Gotchas\n- [gotcha][y] entry two about css\n');
  check('a heading directly after the first bullet does not duplicate entries',
    p.entries.length === 2, `entries=${p.entries.length} (${p.entries.map((e) => e.id).join(',')})`);
  check('the two entries are distinct, not one entry twice',
    new Set(p.entries.map((e) => e.body)).size === 2, p.entries.map((e) => e.body).join(' | '));
}

// -------------------------- regression: --force preserves live scratch/run.md
{
  const dir = store({
    learnings: '# Learnings\n\n## Gotchas\n- [gotcha][x] a fact — why (run-1)\n\n## Scratch (this run)\n- [gotcha][zod] migrated scratch note (run-1, iter 2)\n',
  });
  let r = migrate('--dir', dir);
  check('scratch migrates on the first run', r.code === 0 && readFileSync(join(dir, 'scratch', 'run.md'), 'utf8').includes('migrated scratch note'), r.err);

  // live scratch appended AFTER migration must survive a --force re-run
  writeFileSync(join(dir, 'scratch', 'run.md'),
    readFileSync(join(dir, 'scratch', 'run.md'), 'utf8') + '- [adhoc][live] appended after migration — must survive (2026-09-01)\n');
  r = migrate('--dir', dir, '--force');
  const runMd = readFileSync(join(dir, 'scratch', 'run.md'), 'utf8');
  check('--force keeps live scratch appended after migration', r.code === 0 && runMd.includes('must survive'), r.err || runMd.slice(0, 200));
  check('--force does not duplicate the migrated scratch line', (runMd.match(/migrated scratch note/g) ?? []).length === 1, runMd);
}

// ------------------------------------- --solutions: stable handles for slugs
{
  const dir = store({ learnings: '# Learnings\n\n## Gotchas\n- [gotcha][x] a fact — why (run-1)\n' });
  mkdirSync(join(dir, 'solutions'), { recursive: true });
  const typed = (date) => `---\ntype: bug\narea: x\ndate: ${date}\n---\n\n# Title\n`;
  writeFileSync(join(dir, 'solutions', 'zebra-later.md'), typed('2026-09-02'));
  writeFileSync(join(dir, 'solutions', 'alpha-earlier.md'), typed('2026-09-01'));
  writeFileSync(join(dir, 'solutions', 'beta-earlier.md'), typed('2026-09-01'));
  writeFileSync(join(dir, 'solutions', 'no-frontmatter.md'), '# Just a heading\n\nbody\n');

  let r = migrate('--dir', dir, '--solutions', '--dry-run');
  check('--solutions --dry-run writes nothing',
    r.code === 0 && !readFileSync(join(dir, 'solutions', 'alpha-earlier.md'), 'utf8').includes('id:'), r.err);

  r = migrate('--dir', dir, '--solutions');
  const idOf = (f) => (/^id:\s*(S-\d+)/m.exec(readFileSync(join(dir, 'solutions', f), 'utf8')) ?? [])[1];
  // deterministic: date first, then filename — so two people get the same answer
  check('--solutions numbers by date then filename',
    r.code === 0 && idOf('alpha-earlier.md') === 'S-001' && idOf('beta-earlier.md') === 'S-002'
      && idOf('zebra-later.md') === 'S-003', `${r.err} ${idOf('alpha-earlier.md')}/${idOf('beta-earlier.md')}/${idOf('zebra-later.md')}`);
  check('--solutions creates frontmatter when the entry had none',
    idOf('no-frontmatter.md') === 'S-004'
      && readFileSync(join(dir, 'solutions', 'no-frontmatter.md'), 'utf8').includes('# Just a heading'), idOf('no-frontmatter.md'));

  const before = readFileSync(join(dir, 'solutions', 'alpha-earlier.md'), 'utf8');
  r = migrate('--dir', dir, '--solutions');
  check('--solutions is idempotent',
    r.code === 0 && r.out.includes('nothing to assign')
      && readFileSync(join(dir, 'solutions', 'alpha-earlier.md'), 'utf8') === before, r.out);

  // A handle already in use is never reassigned to a different entry.
  writeFileSync(join(dir, 'solutions', 'new-entry.md'), typed('2026-08-01'));
  r = migrate('--dir', dir, '--solutions');
  check('--solutions never reuses a taken handle',
    r.code === 0 && idOf('new-entry.md') === 'S-005' && idOf('alpha-earlier.md') === 'S-001',
    `${idOf('new-entry.md')} / ${idOf('alpha-earlier.md')}`);
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log(failed === 0 ? '\nall migrate-memory checks passed' : `\n${failed} migrate-memory check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
