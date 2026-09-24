#!/usr/bin/env node
/**
 * Fixture tests for loop-close. Run: node scripts/test-loop-close.mjs
 * Exits 0 when every case matches, 1 otherwise. No dependencies.
 *
 * Every case copies a fixture's `.loop/` to a throwaway directory and drives the
 * real CLI, because the property under test is what lands on disk: a close that
 * refuses must leave backlog, proven and rollup byte-identical, and one that
 * accepts must change exactly the lines it owns.
 *   fixtures/dogfood-epic/.loop           — a tidy two-item epic (item 2 closing)
 *   fixtures/dogfood-epic/real-snapshot/  — this epic's own state at item 8's design
 *                                           gate: row 0, `C2b`, multi-line ACs,
 *                                           escaped `\|` cells, a 9-column backlog
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'loop-close.mjs');
const FIX = join(HERE, '..', 'fixtures', 'dogfood-epic');
const DEMO = { loop: join(FIX, '.loop'), slug: 'demo' };
const REAL = { loop: join(FIX, 'real-snapshot', '.loop'), slug: 'enforce-class-and-epic-integration' };
const APPROVE = join(FIX, 'verdicts', 'approve.md');
const REJECT = join(FIX, 'verdicts', 'reject.md');
const NATIVE = join(FIX, 'real-snapshot', 'verdicts', 'item3-approve-native.md');

function copy(src) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-close-'));
  cpSync(src.loop, join(dir, '.loop'), { recursive: true });
  return { dir, loop: join(dir, '.loop'), slug: src.slug };
}

const files = (c) => [
  join(c.loop, 'epics', c.slug, 'backlog.md'),
  join(c.loop, 'epics', c.slug, 'proven.md'),
  join(c.loop, 'memory', 'epics', `${c.slug}.md`),
];
const snap = (c) => files(c).map((f) => readFileSync(f, 'utf8'));
const same = (c, before) => snap(c).every((t, i) => t === before[i]);

/** A verdict file written into the temp dir (derived, never edited in the fixture). */
function verdictFrom(c, path, transform) {
  const out = join(c.dir, 'verdict.md');
  writeFileSync(out, transform(readFileSync(path, 'utf8')));
  return out;
}

function run(c, args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args, '--dir', c.loop], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}


/** Backlog row n's Status cell in the copy — found by header name, never by position or "done anywhere in the row". */
function statusCell(c, n) {
  const split = (l) => l.trim().split(/(?<!\\)\|/).map((x) => x.trim());
  const rows = snap(c)[0].split('\n').filter((l) => l.trim().startsWith('|'));
  const head = split(rows[0]).map((x) => x.toLowerCase());
  const row = rows.filter((l) => split(l)[head.indexOf('#')] === String(n))[0];
  return row ? split(row)[head.indexOf('status')] : '';
}

/** Rollup row n's cell in column `col` (lower-case header name) of `## Per sub-goal` — by header, never "anywhere in the row". */
function rollupCell(c, n, col) {
  const split = (l) => l.trim().split(/(?<!\\)\|/).map((x) => x.trim());
  const text = readFileSync(files(c)[2], 'utf8');
  const rows = text.slice(text.indexOf('## Per sub-goal')).split('\n').slice(1).filter((l) => l.trim().startsWith('|'));
  const head = split(rows[0]).map((x) => x.toLowerCase());
  const hits = rows.slice(2).filter((l) => /^\d+$/.test(split(l)[head.indexOf('#')]) && Number(split(l)[head.indexOf('#')]) === n);
  return hits.length === 1 ? split(hits[0])[head.indexOf(col)] : `<${hits.length} rows numbered ${n}>`;
}

// Expected-text builders for whole-file comparisons — written independently of loop-close.mjs, so a write that
// lands in the wrong cell, drops a block, or touches anything else shows up as an inequality.
const TODAY = () => new Date().toISOString().slice(0, 10);
/** `text` with the cell `col` (lower-case header) of table row `n` set to ` value `; every other byte kept. */
function setCell(text, n, col, value, fromHeading = null) {
  const lines = text.split('\n');
  const start = fromHeading ? lines.findIndex((l) => l.startsWith(fromHeading)) : 0;
  const idx = lines.map((l, i) => (i > start && l.trim().startsWith('|') ? i : -1)).filter((i) => i >= 0);
  const cut = (l) => l.split(/(?<!\\)\|/);
  const head = cut(lines[idx[0]].trim()).map((x) => x.trim().toLowerCase());
  const row = idx.slice(2).filter((i) => Number(cut(lines[i].trim())[head.indexOf('#')].trim()) === n && cut(lines[i].trim())[head.indexOf('#')].trim() !== '');
  if (row.length !== 1) throw new Error(`setCell: ${row.length} rows numbered ${n}`);
  const cells = cut(lines[row[0]]);
  const offset = cells.length - head.length;
  cells[head.indexOf(col) + offset] = ` ${value} `;
  lines[row[0]] = cells.join('|');
  return lines.join('\n');
}
/** `text` with `row` inserted after the last table line under `## Per sub-goal`. */
function addRollupRow(text, row) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## Per sub-goal'));
  let last = start + 1;
  while (last + 1 < lines.length && lines[last + 1].trim().startsWith('|')) last++;
  lines.splice(last + 1, 0, row);
  return lines.join('\n');
}
/** The goal's criterion blocks as close copies them: each block from its `- [ ] C<n>` head, blank lines INSIDE a block kept, trailing blank lines of each block dropped, blocks joined by one newline. */
function ownBlocks(goal) {
  const start = goal.indexOf('\n', goal.indexOf('## Success criteria')) + 1;
  const end = goal.indexOf('\n## ', start);
  const blocks = [];
  for (const line of goal.slice(start, end === -1 ? undefined : end).split('\n')) {
    if (/^- \[[ xX]\] C\d/.test(line)) blocks.push([line]);
    else if (blocks.length) blocks[blocks.length - 1].push(line);
  }
  return blocks.map((b) => b.join('\n').replace(/\s+$/, '')).join('\n');
}
/** A new rollup row built from the rollup's own header: `—` everywhere, then `#`, the title (first 120 chars) and the outcome. */
function newRollupRow(r0, n, title, outcome) {
  const lines = r0.split('\n');
  const head = lines[lines.findIndex((l) => l.startsWith('## Per sub-goal')) + 1].trim().split(/(?<!\\)\|/).slice(1, -1).map((x) => x.trim().toLowerCase());
  const cells = head.map(() => '—');
  cells[head.indexOf('#')] = String(n);
  if (head.indexOf('sub-goal') >= 0) cells[head.indexOf('sub-goal')] = title.slice(0, 120);
  cells[head.indexOf('outcome')] = outcome;
  return `| ${cells.join(' | ')} |`;
}
const provenAfter = (p0, n, goal) => `${p0.replace(/\s*$/, '\n')}\n## Item ${n}\nSource: goal.md at close (loop-close, ${TODAY()})\n\n${ownBlocks(goal)}\n`;

const refusalCase = (name, src, argsFor, stderr, prep) => ({
  name, src, stderr, code: 1,
  go: (c) => {
    if (prep) prep(c);
    const before = snap(c);
    const r = run(c, argsFor(c));
    return { r, ok: same(c, before) };
  },
});


/** A strict-readers refusal: edit one file of the demo copy, expect exit 1, `<file>:<line>:` of `needle`, `want`, nothing written. */
const strict = (name, rel, edit, needle, want, args) => ({
  name: `strict readers: ${name}`, src: DEMO, code: 1,
  go: (c) => {
    const f = join(c.loop, rel);
    const t = edit(readFileSync(f, 'utf8'));
    writeFileSync(f, t);
    const no = t.split('\n').findIndex((l) => l.includes(needle)) + 1;
    if (no === 0) throw new Error(`needle not found: ${needle}`);
    const before = snap(c);
    const r = run(c, args ?? ['close', '--item', '2', '--verdict-file', APPROVE]);
    const tag = `${rel.split('/').pop()}:${no}: `;
    return { r, ok: same(c, before) && r.stderr.includes(tag) && r.stderr.includes(want) };
  },
});
/** A strict-readers accepted shape: edit, expect `close --item 2` exit 0 with row 2 done and `ids` in stdout. */
const accepted = (name, rel, edit, ids) => ({
  name: `strict readers accepts: ${name}`, src: DEMO, code: 0,
  go: (c) => {
    const f = join(c.loop, rel);
    writeFileSync(f, edit(readFileSync(f, 'utf8')));
    const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
    return { r, ok: statusCell(c, 2).startsWith('done') && ids.every((id) => r.stdout.includes(id)) };
  },
});
/** Run with the demo copy as cwd and no appended --dir (argv cases). */
function runRaw(c, args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { cwd: c.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
const argvCase = (name, argsFor, want) => ({
  name: `argv: ${name}`, src: DEMO, code: 1, stderr: want,
  go: (c) => { const before = snap(c); const r = runRaw(c, argsFor(c)); return { r, ok: same(c, before) }; },
});
const addCol = (t, name) => t.split('\n').map((l) => {
  if (l.startsWith('| # |')) return l.replace(/\|\s*$/, `| ${name} |`);
  if (l.startsWith('|---')) return l.replace(/\|\s*$/, '|---|');
  if (l.startsWith('|')) return l.replace(/\|\s*$/, '| x |');
  return l;
}).join('\n');
const B = 'epics/demo/backlog.md';
const G = 'goal.md';
const P = 'epics/demo/proven.md';
const E = 'epics/demo/epic.md';
const RL = 'memory/epics/demo.md';
const row2epic = (cell) => (t) => t.replace('| 1 | AC1 | small | designed |', `| 1 | ${cell} | small | designed |`);

const CASES = [
  // ------------------------------------------------------------------ C1 plan
  {
    name: 'plan lists upstream, own and claimed-AC criteria verbatim, id-qualified',
    src: DEMO, code: 0,
    go: (c) => {
      const r = run(c, ['plan', '--item', '2']);
      const o = r.stdout;
      const ok = o.includes('## item-1/C1\nDone when: `node src/total.mjs 2 3` prints `5` and exits 0')
        && o.includes('## item-2/C1\nDone when: `node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0')
        && o.includes('## AC1\n- [ ] AC1 — `node src/total.mjs` adds its arguments.\n      Evidence: `node src/total.mjs 2 3` prints `5`.')
        && o.includes('Report one line per id: `- <id>: met`');
      return { r, ok };
    },
  },
  // ------------------------------------------------------------------ C2 refusals
  refusalCase('close refuses a REJECT verdict and writes nothing', DEMO,
    () => ['close', '--item', '2', '--verdict-file', REJECT], 'not APPROVE'),
  refusalCase('close refuses an APPROVE that never marks item-1/C1', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.split('\n').filter((l) => !l.includes('item-1/C1')).join('\n'))],
    'never marks item-1/C1'),
  refusalCase('close refuses an APPROVE that marks one id not met', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace('- AC1: met', '- AC1: not met — the plain total changed'))],
    'marks AC1 not met'),
  refusalCase('close refuses an item that is already done', DEMO,
    () => ['close', '--item', '1', '--verdict-file', APPROVE], 'already done'),
  refusalCase('plan refuses a done upstream row with no proven.md block, naming it', DEMO,
    () => ['plan', '--item', '2'], 'row 1 is done but',
    (c) => writeFileSync(files(c)[1], '# Proven criteria — demo\n')),
  refusalCase('close refuses a done upstream row with no proven.md block, naming it', DEMO,
    () => ['close', '--item', '2', '--verdict-file', APPROVE], 'row 1 is done but',
    (c) => writeFileSync(files(c)[1], '# Proven criteria — demo\n')),
  // ------------------------------------------------------------------ C3 accept
  {
    name: 'close on a full APPROVE marks the row done, extends proven, and puts the verdict on a new rollup row',
    src: DEMO, code: 0,
    go: (c) => {
      const [b0, p0, r0] = snap(c);
      const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      const [b1, p1, r1] = snap(c);
      const bl0 = b0.split('\n'); const bl1 = b1.split('\n');
      const changed = bl1.filter((l, i) => l !== bl0[i]);
      const goal = readFileSync(join(c.loop, 'goal.md'), 'utf8');
      const block = goal.slice(goal.indexOf('- [x] C1 JSON total'), goal.indexOf('\n\n## Tier'));
      const row2 = r1.split('\n').find((l) => l.startsWith('| 2 |')) ?? '';
      const epic = readFileSync(join(c.loop, 'epics', 'demo', 'epic.md'), 'utf8');
      const d = TODAY();
      const exact = b1 === setCell(b0, 2, 'status', `done (closed ${d} by loop-close)`)
        && p1 === provenAfter(p0, 2, goal)
        && r1 === addRollupRow(r0, `| 2 | JSON output | closed: APPROVE (${d}; item-1/C1, item-2/C1, AC1; ${APPROVE}) | — | — | — |`);
      const ok = exact && changed.length === 1 && changed[0].startsWith('| 2 |') && statusCell(c, 2).startsWith('done (closed ')
        && p1.startsWith(p0.replace(/\s*$/, '')) && p1.indexOf('\n## Item 2\nSource: ') >= 0 && p1.indexOf(block) > p1.indexOf('\n## Item 2\nSource: ')
        && /^closed: APPROVE \(\d{4}-\d\d-\d\d; item-1\/C1, item-2\/C1, AC1; .*approve\.md\)$/.test(rollupCell(c, 2, 'outcome'))
        && rollupCell(c, 2, 'sub-goal') === 'JSON output' && row2 !== ''
        && r1.split('\n').filter((l) => l !== '' && !r0.includes(l)).length === 1
        && epic.includes('- [ ] AC1');
      return { r, ok };
    },
  },
  // ------------------------------------------------------------------ C6 real state
  {
    name: 'plan on the real-state snapshot lists row 0, C2b and AC3 in full',
    src: REAL, code: 0,
    go: (c) => {
      const r = run(c, ['plan', '--item', '3']);
      const o = r.stdout;
      const epic = readFileSync(join(c.loop, 'epics', c.slug, 'epic.md'), 'utf8');
      const acStart = epic.indexOf('- [ ] AC3');
      const acEnd = epic.indexOf('\n- [', acStart + 1);
      const ac3 = epic.slice(acStart, acEnd).replace(/\s+$/, '');
      // Each id's OWN Done when, read independently from proven.md and goal.md — a plan that pairs an id with
      // another criterion's text (an index shift) fails here even when every id is still listed.
      const own = new Map();
      let item = null; let crit = null;
      for (const line of readFileSync(files(c)[1], 'utf8').split('\n')) {
        const h = line.match(/^## Item (\d+)\s*$/); if (h) { item = h[1]; crit = null; }
        const b = line.match(/^- \[[ xX]\] (C\d+[a-z]?)\b/); if (b) crit = b[1];
        const d = line.match(/^\s*Done when:\s*(.*)$/); if (d && item !== null && crit) own.set(`item-${item}/${crit}`, d[1].trim());
      }
      const goal = readFileSync(join(c.loop, 'goal.md'), 'utf8');
      const gd = goal.match(/^- \[[ xX]\] (C\d+[a-z]?)\b[\s\S]*?^\s*Done when:\s*(.*)$/m);
      own.set(`item-3/${gd[1]}`, gd[2].trim());
      const pairs = [...own.entries()].filter(([id]) => o.includes(`## ${id}\n`));
      const ok = ['## item-0/C1', '## item-0/C2', '## item-0/C3', '## item-1/C2b', '## item-2/C3', '## item-3/C1']
        .every((h) => o.includes(`${h}\nDone when: `))
        && pairs.length >= 13 && pairs.every(([id, dw]) => o.includes(`## ${id}\nDone when: ${dw}\n`))
        && new Set(pairs.map(([, dw]) => dw)).size === pairs.length
        && ac3.split('\n').length > 1 && o.includes(`## AC3\n${ac3}\n`);
      return { r, ok };
    },
  },
  {
    name: 'close on the real snapshot with the verifier-native APPROVE changes exactly one backlog line',
    src: REAL, code: 0,
    go: (c) => {
      const [b0, p0, r0] = snap(c);
      const r = run(c, ['close', '--item', '3', '--verdict-file', NATIVE]);
      const [b1, p1, r1] = snap(c);
      const goal = readFileSync(join(c.loop, 'goal.md'), 'utf8');
      const split = (l) => l.trim().split(/(?<!\\)\|/).map((x) => x.trim());
      const bRows = b0.split('\n').filter((l) => l.trim().startsWith('|'));
      const bHead = split(bRows[0]).map((x) => x.toLowerCase());
      const title3 = split(bRows.filter((l) => split(l)[bHead.indexOf('#')] === '3')[0])[bHead.findIndex((x) => /sub-?goal/.test(x))];
      const wholeOk = p1 === provenAfter(p0, 3, goal)
        && /^closed item 3 — 14 criteria met \((.*)\)$/m.test(r.stdout)
        && r1 === addRollupRow(r0, newRollupRow(r0, 3, title3, `closed: APPROVE (${TODAY()}; ${r.stdout.match(/\((.*)\)/)[1]}; ${NATIVE})`))
        && title3.length > 120;
      const l0 = b0.split('\n'); const l1 = b1.split('\n');
      const diff = l1.map((l, i) => (l === l0[i] ? null : i)).filter((i) => i !== null);
      const escaped = l0.filter((l) => l.includes('\\|'));
      const ok = wholeOk && b1 === setCell(b0, 3, 'status', `done (closed ${TODAY()} by loop-close)`)
        && l0.length === l1.length && diff.length === 1 && l1[diff[0]].startsWith('| 3 |')
        && escaped.length >= 2 && escaped.every((l) => l1.includes(l));
      return { r, ok };
    },
  },
  {
    name: 'a native line shaped like real output ("→ met." then prose) is accepted',
    src: REAL, code: 0,
    go: (c) => {
      const v = verdictFrom(c, NATIVE, (t) => t.replace(/→ met$/gm, '→ met. The verifier ran it and saw exit 0.'));
      const r = run(c, ['close', '--item', '3', '--verdict-file', v]);
      return { r, ok: true };
    },
  },
  refusalCase('a native line saying → **not met** refuses', REAL,
    (c) => ['close', '--item', '3', '--verdict-file', verdictFrom(c, NATIVE, (t) => {
      const lines = t.split('\n');
      const i = lines.findIndex((l) => l.includes('→ met'));
      lines[i] = lines[i].replace('→ met', '→ **not met** — the anchor hash changed');
      return lines.join('\n');
    })], 'not met'),
  // ------------------------------------------------------------------ review gate (item 8)
  refusalCase('two ## Verdict: lines refuse — a decoy APPROVE cannot sit above the real REJECT', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => `${t}\n## Verdict: REJECT\n`)], '2 `## Verdict:` lines'),
  refusalCase('a lowercase "approve" is not APPROVE', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace('## Verdict: APPROVE', '## Verdict: approve'))], 'not APPROVE'),
  refusalCase('"not yet met" is not met', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/, '- item-2/C1: not yet met — needs a retest'))], 'item-2/C1'),
  refusalCase('a hedge ("met? no") is not met', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, '- AC1: met? no, same regression'))], 'AC1'),
  refusalCase('a hedge ("would be met if") is not met', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-1\/C1: met[^\n]*/, '- item-1/C1 would be met if the regression were fixed'))], 'marks item-1/C1 not met ("- item-1/C1 would be met'),
  refusalCase('a "not met" wrapped onto the next line still refuses, despite a later "met" line', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-1\/C1: met[^\n]*/, '- item-1/C1:\n  not met — actually broken') + '- item-1/C1: met (restated)\n')], 'marks item-1/C1 not met'),
  {
    name: 'a line naming two ids, one not met, blocks both — the first id\'s status says "not met" too',
    src: DEMO, code: 1, stderr: 'item-2/C1 not met ("- item-1/C1: met — item-2/C1: not met',
    go: (c) => {
      const v = verdictFrom(c, APPROVE, (t) => t.replace(/- item-1\/C1: met[^\n]*\n- item-2\/C1: met[^\n]*/, '- item-1/C1: met — item-2/C1: not met — flakes'));
      const before = snap(c);
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: same(c, before) && r.stderr.includes('item-1/C1 not met') };
    },
  },
  refusalCase('item-1/C10: met does not mark item-1/C1', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace('- item-1/C1: met', '- item-1/C10: met'))], 'never marks item-1/C1'),
  {
    name: 'a missing rollup refuses after every other check, writing neither backlog nor proven',
    src: DEMO, code: 1, stderr: 'no epic rollup',
    go: (c) => {
      rmSync(files(c)[2]);
      const [b0, p0] = [files(c)[0], files(c)[1]].map((f) => readFileSync(f, 'utf8'));
      const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      const [b1, p1] = [files(c)[0], files(c)[1]].map((f) => readFileSync(f, 'utf8'));
      return { r, ok: b0 === b1 && p0 === p1 && !existsSync(files(c)[2]) };
    },
  },
  refusalCase('goal.md naming another item refuses', DEMO,
    () => ['plan', '--item', '2'], 'is not item 2',
    (c) => { const g = join(c.loop, 'goal.md'); writeFileSync(g, readFileSync(g, 'utf8').replace('backlog item #2', 'backlog item #1')); }),
  refusalCase('an active-epic that is a path, not a name, refuses', DEMO,
    () => ['plan', '--item', '2'], 'not a single directory name',
    (c) => writeFileSync(join(c.loop, 'active-epic'), '../../outside/evil\n')),
  // A criterion whose Done-when text quotes a listed id (as item 8's own C1 does).
  ...['AC1', 'AC10'].map((inner) => ({
    name: `a native line whose quoted Done when contains "${inner}" is accepted`,
    src: DEMO, code: 0,
    go: (c) => {
      const g = join(c.loop, 'goal.md');
      const done = '`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0';
      writeFileSync(g, readFileSync(g, 'utf8').replace(`Done when: ${done}`, `Done when: ${done} (see ${inner})`));
      const v = verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/, `- Criterion: "${done} (see ${inner})" → met.`));
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  })),
  // Iteration 3's REJECT: one case per path of the anchored reader.
  {
    name: 'a quoted Done when that contains "AC1: met" does not mark AC1',
    src: DEMO, code: 1, stderr: 'never marks AC1',
    go: (c) => {
      const g = join(c.loop, 'goal.md');
      const done = '`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0';
      writeFileSync(g, readFileSync(g, 'utf8').replace(`Done when: ${done}`, `Done when: ${done} (AC1: met)`));
      const v = verdictFrom(c, APPROVE, (t) => t
        .replace(/- item-2\/C1: met[^\n]*/, `- Criterion: "${done} (AC1: met)" → met.`)
        .replace(/- AC1: met[^\n]*\n?/, ''));
      const before = snap(c);
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: same(c, before) };
    },
  },
  refusalCase('an id named without its own ": met" is not marked by a later id\'s ("AC1 skipped, item-2/C1: met")', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t
      .replace(/- item-2\/C1: met[^\n]*/, '- AC1 skipped, item-2/C1: met')
      .replace(/- AC1: met[^\n]*\n?/, ''))], 'AC1 not met ("- AC1 skipped'),
  refusalCase('"XAC1: met" does not mark AC1', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met/, '- XAC1: met'))], 'never marks AC1'),
  refusalCase('"sub-AC1: met" names AC1 and blocks it', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met/, '- sub-AC1: met'))], 'marks AC1 not met ("- sub-AC1'),
  refusalCase('"AC1: metrics unchanged" is not met', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, '- AC1: metrics unchanged'))], 'marks AC1 not met ("metrics unchanged")'),
  {
    // A statement opens its line: an id glued to the end of a quote is not one.
    name: 'an id right after a quoted criterion, mid-line, names AC1 and blocks it',
    src: DEMO, code: 1, stderr: 'marks AC1 not met ("- see ',
    go: (c) => {
      const done = '`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0';
      const v = verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, `- see "${done}"AC1: met`));
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: !statusCell(c, 2).startsWith('done') };
    },
  },
  {
    // Iteration 4's REJECT: one criterion's quoted Done when is a prefix of another's.
    name: 'a Done when that extends another criterion\'s and quotes "AC1: met" does not mark AC1',
    src: DEMO, code: 1, stderr: 'never marks AC1',
    go: (c) => {
      const one = '`node src/total.mjs 2 3` prints `5` and exits 0';
      const two = `${one}" (AC1: met) "and more`;
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace(/Done when: .*/, `Done when: ${two}`));
      const v = verdictFrom(c, APPROVE, (t) => t
        .replace(/- item-2\/C1: met[^\n]*/, `- item-2/C1: met\n- Criterion: "${two}" → met.`)
        .replace(/- AC1: met[^\n]*\n?/, ''));
      const before = snap(c);
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: same(c, before) };
    },
  },
  {
    name: 'one native line marks every criterion whose Done when is that exact text',
    src: DEMO, code: 0,
    go: (c) => {
      const one = '`node src/total.mjs 2 3` prints `5` and exits 0';
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace(/Done when: .*/, `Done when: ${one}`));
      const v = verdictFrom(c, APPROVE, (t) => t
        .replace(/- item-1\/C1: met[^\n]*\n/, '')
        .replace(/- item-2\/C1: met[^\n]*/, `- Criterion: "${one}" → met.`));
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  },
  refusalCase('a native statement mid-sentence marks nothing', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '- I skipped it, unlike Criterion: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met.'))], 'never marks item-2/C1'),
  refusalCase('a status that does not open with met is not met ("skipped — nothing met")', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, '- AC1: skipped — nothing met'))], 'marks AC1 not met ("skipped'),
  {
    name: 'a quoted Done when that itself contains " → is matched whole',
    src: DEMO, code: 0,
    go: (c) => {
      const done = '`node src/total.mjs --json 2 3` prints "total" → `5`';
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace(/Done when: `node src\/total\.mjs --json.*/, `Done when: ${done}`));
      const v = verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/, `- Criterion: "${done}" → met.`));
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  },
  refusalCase('an uppercase "AC1: MET" is not met — only lowercase met counts', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met/, '- AC1: MET'))], 'marks AC1 not met ("MET'),
  // ------------------------------------------------------------------ iteration 6: every line naming an id must say met
  refusalCase('"AC1: Not met" then a later "AC1: met" refuses', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, '- AC1: Not met — the total changed\n- AC1: met'))], 'marks AC1 not met ("Not met'),
  refusalCase('an indented "  - AC1: not met" sub-bullet then a later "- AC1: met" refuses', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, '- item-2/C1: met\n  - AC1: not met — nested\n- AC1: met'))], 'marks AC1 not met ("not met — nested'),
  refusalCase('a bare "AC1: not met" line with no bullet then "- AC1: met" refuses', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, 'AC1: not met — bare\n- AC1: met'))], 'marks AC1 not met ("not met — bare'),
  refusalCase('a "*" bullet is not a met statement: "* AC1: met" names AC1 and blocks it', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met/, '* AC1: met'))], 'marks AC1 not met ("* AC1: met'),
  refusalCase('a labelled "Criterion item-2/C1: …" is not the native shape and blocks item-2/C1', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '- Criterion item-2/C1: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met'))], 'marks item-2/C1 not met ("- Criterion item-2/C1'),
  refusalCase('"AC1 : not met" (space before the colon) then "- AC1: met" refuses', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, '- AC1 : not met — spaced\n- AC1: met'))], 'marks AC1 not met ("not met — spaced'),
  refusalCase('a hedge with a space ("met ? no") is not met', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, '- AC1: met ? no'))], 'marks AC1 not met ("met ? no'),
  ...[['indented', '  - '], ['bare', ''], ['spaced-colon', '- ']].map(([how, lead]) => refusalCase(
    `a ${how} native line saying not met, then a met one, refuses`, DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      `${lead}Criterion${how === 'spaced-colon' ? ' ' : ''}: "\`node src/total.mjs --json 2 3\` prints \`{"total":5}\` and exits 0" → not met — ${how}\n` +
      '- Criterion: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met'))], `marks item-2/C1 not met ("not met — ${how}`)),
  refusalCase('"AC1: met" then a later "AC1: not met" refuses — no line wins by coming first', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, '- AC1: met\n- AC1: not met — on second look'))], 'marks AC1 not met ("not met — on second look'),
  refusalCase('a native-looking line with "=" instead of "→" marks nothing', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '- Criterion: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" = met'))], 'never marks item-2/C1'),
  refusalCase('a native-looking line under another word ("Evidence:") marks nothing', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '- Evidence: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met'))], 'never marks item-2/C1'),
  {
    name: 'bold markers are dropped: "- **AC1:** met" and "→ **met**" close',
    src: DEMO, code: 0,
    go: (c) => {
      const v = verdictFrom(c, APPROVE, (t) => t.replace('- AC1: met', '- **AC1:** met').replace(/- item-2\/C1: met[^\n]*/,
        '- Criterion: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → **met**'));
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  },
  // ------------------------------------------------------------------ iteration 7: refuse by default — every false-close shape the iteration-6 verifier found
  ...[
    ['- item-1/C1: met — item-2/C1: not met — flakes', 'item-2/C1 not met'],
    ['- `AC1`: not met', 'AC1 not met'],
    ['- AC1 — not met', 'AC1 not met'],
    ['- AC1 not met', 'AC1 not met'],
    ['* AC1: not met', 'AC1 not met'],
    ['+ AC1: not met', 'AC1 not met'],
    ['1. AC1: not met', 'AC1 not met'],
    ['| AC1 | not met |', 'AC1 not met'],
    ['> - AC1: not met', 'AC1 not met'],
    ['- [ ] AC1: not met', 'AC1 not met'],
    ['- ac1: not met', 'AC1 not met'],
    ['- AC1: met, actually no — not met', 'AC1 not met'],
    ['- AC1: met (unmet in part)', 'AC1 not met'],
    ['- AC 1: not met', 'AC1 not met'],
    ['- AC-1 not met', 'AC1 not met'],
    ['- item 1 / C1: not met', 'item-1/C1 not met'],
  ].map(([line, want]) => refusalCase(`a not-met in any shape blocks, even beside a met line: ${JSON.stringify(line)}`, DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace('### Evidence\n', `### Evidence\n${line}\n`))], want)),
  refusalCase('"- Criterion \"…\" → met" without the colon is not the native shape', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '- Criterion "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met'))], 'never marks item-2/C1'),
  refusalCase('"* Criterion: …" is not the native shape', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '* Criterion: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met'))], 'never marks item-2/C1'),
  refusalCase('"Criterions: …" is not the native shape', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '- Criterions: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met'))], 'never marks item-2/C1'),
  {
    name: '"-AC1: met" (no space after the dash) is a met statement',
    src: DEMO, code: 0,
    go: (c) => {
      const r = run(c, ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace('- AC1: met', '-AC1: met'))]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  },
  {
    name: 'a native line whose quoted Done when names another id does not block that id',
    src: DEMO, code: 0,
    go: (c) => {
      const done = '`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0, as AC1 and item-1/C1 require';
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace(/Done when: `node src\/total\.mjs --json.*/, `Done when: ${done}`));
      const v = verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/, `- Criterion: "${done}" → met`));
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  },
  refusalCase('"item-1/C2bc: met" does not mark item-1/C2b', REAL,
    (c) => ['close', '--item', '3', '--verdict-file', verdictFrom(c, NATIVE, (t) => {
      const lines = t.split('\n');
      const i = lines.findIndex((l) => l.includes('oldhalf-{1,2,3}'));
      lines[i] = '- item-1/C2bc: met';
      return lines.join('\n');
    })], 'never marks item-1/C2b'),
  ...[
    ['- AC1: met — not  met', 'AC1 not met'],
    ['- AC1: met — Not met', 'AC1 not met'],
  ].map(([line, want]) => refusalCase(`a met statement that also says not met blocks: ${JSON.stringify(line)}`, DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, line))], want)),
  refusalCase('an id mentioned only on another id\'s met line is blocked, not met', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t
      .replace(/- item-1\/C1: met[^\n]*\n/, '')
      .replace(/- item-2\/C1: met[^\n]*/, '- item-2/C1: met — same run as item-1/C1'))], 'item-1/C1 not met ("- item-2/C1: met — same run as item-1/C1'),
  {
    name: '"-Criterion: …" (no space after the dash) is the native shape',
    src: DEMO, code: 0,
    go: (c) => {
      const v = verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
        '-Criterion: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met'));
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  },
  ...[
    ['- AC1: met\n  on reflection, not met — the total changed', 'on reflection, not met'],
    ['- AC1: met\n\nOne criterion is unmet.', 'One criterion is unmet.'],
    ['- AC1: met\n  NOT MET after all', 'NOT MET after all'],
    ['- AC1: met\n  but not  met on rerun', 'but not  met on rerun'],
  ].map(([line, want]) => refusalCase(`a not-met line naming no id blocks the close: ${JSON.stringify(line)}`, DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, line))], `naming no listed id: "${want}`)),
  // ------------------------------------------------------------------ iteration 8: the matched quote is the criterion's text, not a statement
  {
    name: 'a native quote holding "not met" and "**not met**" closes — the text is the criterion, not a verdict',
    src: DEMO, code: 0,
    go: (c) => {
      const done = '`node src/total.mjs --json 2 3` prints `{"total":5}`; an id `not met` and `→ **not met**` refuse';
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace(/Done when: `node src\/total\.mjs --json.*/, `Done when: ${done}`));
      const v = verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/, `- Criterion: "${done}" → met`));
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  },
  refusalCase('an unmatched native quote naming an id blocks that id', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace('### Evidence\n',
      '### Evidence\n- Criterion: "a text no criterion has, about AC1" → met\n'))], 'AC1 not met ("- Criterion: "a text no criterion has, about AC1'),
  refusalCase('an id named after a matched native line\'s "→ met" is blocked', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '- Criterion: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" → met; AC1 fails'))], 'AC1 not met ("- Criterion: '),
  refusalCase('"->" is not the native arrow', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- item-2\/C1: met[^\n]*/,
      '- Criterion: "`node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0" -> met'))], 'never marks item-2/C1'),
  ...[
    ['- AC1: met — see the unmetered path', 'AC1 not met'],
    ['- AC1: met — it cannot meter anything', 'AC1 not met'],
  ].map(([line, want]) => refusalCase(`NEG matches inside words too (stricter): ${JSON.stringify(line)}`, DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace(/- AC1: met[^\n]*/, line))], want)),
  refusalCase('a digit before an id still names it: "- 2AC1: not met" blocks AC1', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t.replace('### Evidence\n', '### Evidence\n- 2AC1: not met\n'))], 'AC1 not met ("- 2AC1'),
  {
    name: 'run through a symlinked path, close still runs (the main guard compares real paths)',
    src: DEMO, code: 0,
    go: (c) => {
      const link = join(c.dir, 'linked-loop-close.mjs');
      symlinkSync(SCRIPT, link);
      let r;
      try {
        const stdout = execFileSync('node', [link, 'close', '--item', '2', '--verdict-file', APPROVE, '--dir', c.loop], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        r = { code: 0, stdout, stderr: '' };
      } catch (e) { r = { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
      return { r, ok: r.stdout.includes('closed item 2') && statusCell(c, 2).startsWith('done') };
    },
  },
  // ------------------------------------------------------------------ iteration 9: a key that repeats is refused, never collapsed in a Map
  refusalCase('two own criteria sharing an id (C1 twice) refuse — one met line cannot prove both', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', verdictFrom(c, APPROVE, (t) => t)], 'names item-2/C1 more than once',
    (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace('\n## Tier', '- [x] C1 JSON exit code\n      Done when: `node src/total.mjs --json 2 3` exits 0\n      Must not: the plain output changes\n\n## Tier'));
    }),
  refusalCase('plan also refuses two own criteria sharing an id', DEMO,
    () => ['plan', '--item', '2'], 'names item-2/C1 more than once',
    (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace('\n## Tier', '- [x] C1 JSON exit code\n      Done when: `node src/total.mjs --json 2 3` exits 0\n\n## Tier'));
    }),
  refusalCase('two backlog rows numbered 2 refuse', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', APPROVE], 'more than one row numbered 2',
    (c) => {
      const b = files(c)[0];
      writeFileSync(b, readFileSync(b, 'utf8').replace(/(\| 2 \| JSON output[^\n]*\n?)/, '$1| 2 | JSON again | x | y | 1 | AC1 | small | pending |\n'));
    }),
  refusalCase('two `## Item 1` blocks in proven.md refuse', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', APPROVE], 'more than one `## Item 1` block',
    (c) => {
      const pp = files(c)[1];
      const t = readFileSync(pp, 'utf8');
      writeFileSync(pp, t + '\n' + t.slice(t.indexOf('## Item 1')));
    }),
  refusalCase('an interrupted close (proven.md already has `## Item 2`, row not done) refuses instead of appending twice', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', APPROVE], 'already has `## Item 2` while row 2 is not done',
    (c) => {
      const pp = files(c)[1];
      writeFileSync(pp, readFileSync(pp, 'utf8') + '\n## Item 2\nSource: item 2\'s goal.md at close\n\n- [x] C1 JSON total\n      Done when: x\n');
    }),
  refusalCase('two AC1 bullets in epic.md refuse', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', APPROVE], 'more than one bullet for AC1',
    (c) => {
      const e = join(c.loop, 'epics', 'demo', 'epic.md');
      writeFileSync(e, readFileSync(e, 'utf8').replace(/(- \[ \] AC1 —[^\n]*\n)/, '$1- [ ] AC1 — a second, different AC1.\n'));
    }),
  // ------------------------------------------------------------------ iteration 10: a first-match lookup over a repeated key refuses
  ...[
    ['a second `## Success criteria` section in goal.md', 'two headings match', (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8') + '\n## Success criteria (continued)\n- [ ] C2 exit code\n      Done when: `node src/total.mjs --json 2 3` exits 0\n');
    }],
    ['a second `## Epic acceptance criteria` section in epic.md', 'two headings match', (c) => {
      const e = join(c.loop, 'epics', 'demo', 'epic.md');
      writeFileSync(e, readFileSync(e, 'utf8') + '\n## Epic acceptance criteria (more)\n- [ ] AC2 — more.\n');
    }],
    ['a criterion with two `Done when:` lines', 'has 2 `Done when:` lines', (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace('      Evidence: CLI output', '      Done when: `node src/total.mjs --json 0 0` prints `{"total":0}`\n      Evidence: CLI output'));
    }],
    ['a proven criterion with two `Done when:` lines', 'has 2 `Done when:` lines', (c) => {
      const pp = files(c)[1];
      writeFileSync(pp, readFileSync(pp, 'utf8').replace('      Evidence: CLI output', '      Done when: `node src/total.mjs 0 0` prints `0`\n      Evidence: CLI output'));
    }],
    ['two `Epic: … — backlog item #N` lines in goal.md', 'more than one `Epic: … — backlog item #N` line', (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, 'Epic: demo — backlog item #1\n' + readFileSync(g, 'utf8'));
    }],
    ...[['#', '| # |'], ['Status', '| Status |'], ['Sub-goal', '| Sub-goal |'], ['Epic criterion', '| Epic criterion |']].map(([name, cell]) => [
      `a backlog header with two ${name} columns`, `more than one ${name} column`, (c) => {
        const b = files(c)[0];
        const t = readFileSync(b, 'utf8').split('\n');
        const h = t.findIndex((l) => l.startsWith('| # |'));
        t[h] = t[h].replace(/\|\s*$/, cell.replace(/^\| /, '| '));
        for (let i = h + 1; i < t.length; i++) if (t[i].startsWith('|')) t[i] = t[i].replace(/\|\s*$/, i === h + 1 ? '|---|' : '| x |');
        writeFileSync(b, t.join('\n'));
      }]),
    ['a second backlog table', 'a second table', (c) => {
      const b = files(c)[0];
      writeFileSync(b, readFileSync(b, 'utf8') + '\n\n| # | Sub-goal | Status |\n|---|---|---|\n| 3 | more | pending |\n');
    }],
    ['a second `## Per sub-goal` heading in the rollup', 'more than one `## Per sub-goal` heading', (c) => {
      const r = files(c)[2];
      writeFileSync(r, readFileSync(r, 'utf8') + '\n## Per sub-goal (old)\n| # | Outcome |\n|---|---|\n| 2 | x |\n');
    }],
    ['a rollup table with two Outcome columns', 'more than one `#` or `Outcome` column', (c) => {
      const r = files(c)[2];
      writeFileSync(r, readFileSync(r, 'utf8').replace('| Slice verdict |', '| Outcome |'));
    }],
    ['a rollup table with two # columns', 'more than one `#` or `Outcome` column', (c) => {
      const r = files(c)[2];
      writeFileSync(r, readFileSync(r, 'utf8').replace('| Slice verdict |', '| # |'));
    }],
    ['two rollup rows numbered 2', 'rows numbered 2', (c) => {
      const r = files(c)[2];
      writeFileSync(r, readFileSync(r, 'utf8').replace(/(\| 1 \| CLI total[^\n]*)/, '$1\n| 2 | JSON output | in progress | 1 | — | — |\n| 2 | JSON again | in progress | 1 | — | — |'));
    }],
  ].map(([what, want, prep]) => refusalCase(`${what} refuses — a first-match lookup would silently skip the other`, DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', APPROVE], want, prep)),
  // ------------------------------------------------------------------ iteration 11: every loop over parsed text read by hand
  ...[
    ['item 2\'s rollup row in a second table under `## Per sub-goal`', 'table lines after its first table', (c) => {
      const r = files(c)[2];
      writeFileSync(r, readFileSync(r, 'utf8').replace(/\s*$/, '\n\n| # | Sub-goal | Outcome |\n|---|---|---|\n| 2 | JSON output | in progress |\n'));
    }],
    ['item 2\'s rollup row after a blank line in the table', 'table lines after its first table', (c) => {
      const r = files(c)[2];
      writeFileSync(r, readFileSync(r, 'utf8').replace(/\s*$/, '\n\n| 2 | JSON output | in progress | 1 | — | — |\n'));
    }],
    ['an upstream backlog row numbered `**1**`', 'has a `#` that is not a plain number', (c) => {
      const b = files(c)[0];
      writeFileSync(b, readFileSync(b, 'utf8').replace('| 1 | CLI total', '| **1** | CLI total'));
    }],
    ['a backlog row numbered `2a`', 'has a `#` that is not a plain number', (c) => {
      const b = files(c)[0];
      writeFileSync(b, readFileSync(b, 'utf8').replace(/\s*$/, '\n| 2a | extra | x | y | 1 | — | small | pending |\n'));
    }],
    ['a rollup row numbered `**2**`', 'not a plain number', (c) => {
      const r = files(c)[2];
      writeFileSync(r, readFileSync(r, 'utf8').replace(/(\| 1 \| CLI total[^\n]*)/, '$1\n| **2** | JSON output | in progress | 1 | — | — |'));
    }],
    ['a rollup row numbered `2a`', 'not a plain number', (c) => {
      const r = files(c)[2];
      writeFileSync(r, readFileSync(r, 'utf8').replace(/(\| 1 \| CLI total[^\n]*)/, '$1\n| 2a | JSON output | in progress | 1 | — | — |'));
    }],
    ['a goal criterion bullet written `**C2**`', 'does not open with `C<n>`', (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace('\n## Tier', '- [ ] **C2** exit code\n      Done when: `node src/total.mjs --json 2 3` exits 0\n\n## Tier'));
    }],
    ['a proven criterion bullet written `c1` (lowercase)', 'does not open with `C<n>`', (c) => {
      const pp = files(c)[1];
      writeFileSync(pp, readFileSync(pp, 'utf8').replace('- [x] C1 the plain total', '- [x] c1 the plain total'));
    }],
  ].map(([what, want, prep]) => refusalCase(`${what} refuses — it would be skipped silently`, DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', APPROVE], want, prep)),
  refusalCase('a repeated --verdict-file refuses — only one would be read', DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', REJECT, '--verdict-file', APPROVE], '--verdict-file given more than once'),
  refusalCase('a repeated --item refuses', DEMO,
    (c) => ['close', '--item', '1', '--item', '2', '--verdict-file', APPROVE], '--item given more than once'),
  // D-eci-030: the former accepted `integration` label case flips to a refusal — backlog `#` cells are numbers only
  strict('a word-labelled backlog row (`integration`)', B, (t) => t.replace(/\s*$/, '\n| integration | epic review | x | y | 2 | — | small | pending |\n'), '| integration |', 'is a word label — backlog `#` cells are numbers only'),
  {
    name: 'a rollup row numbered `02` is item 2\'s row — updated in place, no second row',
    src: DEMO, code: 0,
    go: (c) => {
      const rp = files(c)[2];
      writeFileSync(rp, readFileSync(rp, 'utf8').replace(/(\| 1 \| CLI total[^\n]*)/, '$1\n| 02 | JSON output | in progress | 1 | — | — |'));
      const before02 = readFileSync(rp, 'utf8');
      const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      const rows = readFileSync(rp, 'utf8').split('\n').filter((l) => /^\|\s*0?2\s*\|/.test(l));
      return { r, ok: rows.length === 1 && readFileSync(rp, 'utf8') === setCell(before02, 2, 'outcome', `closed: APPROVE (${TODAY()}; item-1/C1, item-2/C1, AC1; ${APPROVE}) — in progress`, '## Per sub-goal') };
    },
  },
  {
    name: 'closing item 0 leaves a rollup row with a blank `#` alone (blank is not 0)',
    src: DEMO, code: 0,
    go: (c) => {
      const edit = (f, fn) => writeFileSync(f, fn(readFileSync(f, 'utf8')));
      edit(join(c.loop, 'goal.md'), (t) => t.replace('backlog item #2', 'backlog item #0'));
      edit(files(c)[0], (t) => t.replace('| 2 | JSON output', '| 0 | JSON output').replace(/(\| 0 \| JSON output[^\n]*\|)\s*1\s*(\|[^\n]*)/, '$1 1 $2'));
      edit(files(c)[2], (t) => t.replace(/(\| 1 \| CLI total[^\n]*)/, '$1\n|  | notes row | kept | — | — | — |'));
      const v = verdictFrom(c, APPROVE, (t) => t.replace('- item-2/C1: met', '- item-0/C1: met'));
      const r = run(c, ['close', '--item', '0', '--verdict-file', v]);
      const text = readFileSync(files(c)[2], 'utf8');
      return { r, ok: text.includes('|  | notes row | kept |') && rollupCell(c, 0, 'outcome').startsWith('closed: APPROVE (') };
    },
  },
  // ------------------------------------------------------------------ re-design (D-eci-025): strict readers, file:line
  strict('two Status columns', B, (t) => addCol(t, 'Status'), '| # |', 'more than one Status column'),
  strict('a second table after the rows', B, (t) => t.replace(/\s*$/, '\n\n| # | Status |\n|---|---|\n| 9 | pending |\n'), '| # | Status |', 'a second table'),
  strict('a header-only first table, then the real one', B, (t) => t.replace('# Backlog — Demo totals\n', '# Backlog — Demo totals\n| # | Status |\n|---|---|\n\n'), '| # | Sub-goal', 'a second table'),
  strict('a label-only first table, then the real one', B, (t) => t.replace('# Backlog — Demo totals\n', '# Backlog — Demo totals\n| # | Status |\n|---|---|\n| integration | planned |\n\n'), '| # | Sub-goal', 'a second table'),
  strict('a row numbered **1**', B, (t) => t.replace('| 1 | CLI total', '| **1** | CLI total'), '**1**', 'not a plain number'),
  strict('a row numbered 2a', B, (t) => t.replace(/\s*$/, '\n| 2a | x | x | x | x | — | small | pending |\n'), '| 2a |', 'not a plain number'),
  strict('a row labelled item1', B, (t) => t.replace(/\s*$/, '\n| item1 | x | x | x | x | — | small | pending |\n'), '| item1 |', 'not a plain number'),
  strict('two rows numbered 2', B, (t) => t.replace(/\s*$/, '\n| 2 | again | x | x | x | — | small | pending |\n'), '| 2 | again', 'more than one row numbered 2'),
  strict('a row with fewer cells than the header', B, (t) => t.replace(/\s*$/, '\n| 3 | short |\n'), '| 3 | short |', 'cells, the header has'),
  strict('an upstream Status `✅ done`', B, (t) => t.replace('done (item 1 closed)', '✅ done (item 1 closed)'), '✅', 'puts done behind markup'),
  strict('an upstream Status `✅ Done`', B, (t) => t.replace('done (item 1 closed)', '✅ Done (item 1 closed)'), '✅', 'puts done behind markup'),
  strict('an upstream Status `~~x~~ done`', B, (t) => t.replace('done (item 1 closed)', '~~x~~ done (item 1 closed)'), '~~x~~', 'puts done behind markup'),
  ...['ac2)', 'AC-2', 'A.C.2', 'AC 2', 'AC1 and 2', 'ACs 1, 2'].map((cell) =>
    strict(`Epic criterion \`${cell}\``, B, row2epic(cell), '| JSON output', 'is not an `AC<n>` id')),
  strict('two `## Success criteria`', G, (t) => t + '\n## Success criteria (continued)\n- [ ] C2 more\n      Done when: y\n', '## Success criteria (continued)', 'two headings match'),
  strict('a `- [ ] **C2**` bullet', G, (t) => t.replace('      Must not: the plain output changes\n', '      Must not: the plain output changes\n- [ ] **C2** exit code\n'), '**C2**', 'does not open with `C<n>`'),
  strict('an indented `  - [ ] C3` inside C1', G, (t) => t.replace('      Evidence: CLI output', '  - [ ] C3 nested\n      Evidence: CLI output'), '- [ ] C3 nested', 'does not open with `C<n>`'),
  strict('an unindented stray line in the region', G, (t) => t.replace('      Must not: the plain output changes\n', '      Must not: the plain output changes\nnote: something\n'), 'note: something', 'none of the shapes'),
  strict('a criterion with two `Done when:`', G, (t) => t.replace('      Evidence: CLI output', '      Done when: another\n      Evidence: CLI output'), '- [x] C1 JSON total', 'has 2 `Done when:` lines'),
  strict('two `Epic:` lines', G, (t) => 'Epic: demo — backlog item #1\n' + t, 'backlog item #2', 'more than one `Epic:'),
  strict('a continuation before the first criterion', G, (t) => t.replace('## Success criteria (verifiable)\n', '## Success criteria (verifiable)\n      Done when: orphan\n'), 'orphan', 'before the first bullet'),
  strict('`## item 1` in lower case', P, (t) => t.replace('## Item 1', '## item 1'), '## item 1', 'must be `## Item N`'),
  strict('a `## Notes` heading', P, (t) => t + '\n## Notes\nx\n', '## Notes', 'must be `## Item N`'),
  strict('two `## Item 1`', P, (t) => t + '\n## Item 1 \nSource: again\n', '## Item 1 ', 'more than one `## Item 1` block'),
  strict('a `- [x] c1` bullet', P, (t) => t.replace('- [x] C1 the plain total', '- [x] c1 the plain total'), '- [x] c1', 'does not open with `C<n>`'),
  strict('an item block without `Source:`', P, (t) => t.replace("Source: item 1's goal.md at close\n", ''), '## Item 1', 'has no `Source:` line'),
  strict('a continuation before an item\'s first criterion', P, (t) => t.replace("Source: item 1's goal.md at close\n", "Source: item 1's goal.md at close\n      Done when: orphan\n"), 'orphan', 'before the first bullet'),
  strict('two AC sections', E, (t) => t + '\n## Epic acceptance criteria (more)\n- [ ] AC2 — more.\n', '(more)', 'two headings match'),
  strict('two AC1 bullets', E, (t) => t + '- [ ] AC1 — again.\n', 'again', 'more than one bullet for AC1'),
  strict('a `- [ ] ac2` bullet', E, (t) => t + '- [ ] ac2 — lower.\n', 'ac2 — lower', 'does not open with `AC<n>`'),
  strict('two `## Per sub-goal`', RL, (t) => t + '\n## Per sub-goal (old)\n', '(old)', 'more than one `## Per sub-goal` heading'),
  strict('a second rollup table', RL, (t) => t.replace(/\s*$/, '\n\n| # | Outcome |\n|---|---|\n| 2 | x |\n'), '| # | Outcome |', 'table lines after its first table'),
  strict('a blank-split rollup row', RL, (t) => t.replace(/\s*$/, '\n\n| 2 | JSON | x | 1 | — | — |\n'), '| 2 | JSON |', 'table lines after its first table'),
  strict('a prose line in `## Per sub-goal`', RL, (t) => t.replace(/\s*$/, '\na note\n'), 'a note', 'none of the shapes'),
  strict('two rollup Outcome columns', RL, (t) => t.replace('| Slice verdict |', '| Outcome |'), '| # | Sub-goal | Outcome', 'more than one `#` or `Outcome` column'),
  strict('a rollup row numbered **2**', RL, (t) => t.replace(/\s*$/, '\n| **2** | JSON | x | 1 | — | — |\n'), '**2**', 'not a plain number'),
  strict('a rollup row numbered 2a', RL, (t) => t.replace(/\s*$/, '\n| 2a | JSON | x | 1 | — | — |\n'), '| 2a |', 'not a plain number'),
  strict('two rollup rows numbered 2', RL, (t) => t.replace(/\s*$/, '\n| 2 | JSON | x | 1 | — | — |\n| 2 | again | x | 1 | — | — |\n'), '| 2 | again', 'rows numbered 2'),
  strict('a rollup header with no separator', RL, (t) => t.replace('|---|----------|---------|-----------|----------------|---------------|\n', ''), '| 1 | CLI total', 'no separator row'),
  strict('a rollup row with fewer cells', RL, (t) => t.replace(/\s*$/, '\n| 2 | x |\n'), '| 2 | x |', 'cells, the header has'),
  accepted('the real row-0 cell `AC1 (the baseline that goes red)`', B, row2epic('AC1 (the baseline that goes red)'), ['AC1']),
  accepted('`(AC1)` and `**AC1**`', B, row2epic('(AC1), **AC1**'), ['AC1']),
  accepted('an upstream Status `Done (…)`', B, (t) => t.replace('done (item 1 closed)', 'Done (item 1 closed)'), ['item-1/C1']),
  accepted('a legacy Status `pending (… criterion 3 done …)`', B, (t) => t.replace(/\s*$/, '\n| 3 | later | x | x | 2 | — | small | pending (criterion 3 done, others await) |\n'), ['item-1/C1']),
  accepted('an indented table row is a row, not prose', B, (t) => t.replace('| 1 | CLI total', '  | 1 | CLI total'), ['item-1/C1']),
  argvCase('an unknown flag', () => ['close', '--item', '2', '--verdict-file', APPROVE, '--dri', 'x'], 'unknown flag --dri'),
  argvCase('--dir with no value', () => ['close', '--item', '2', '--verdict-file', APPROVE, '--dir'], '--dir needs a value'),
  argvCase('--item with no value', () => ['close', '--verdict-file', APPROVE, '--item'], '--item needs a value'),
  argvCase('--verdict-file with no value', () => ['close', '--item', '2', '--verdict-file'], '--verdict-file needs a value'),
  ...['0x2', '', '1.0', '-1'].map((v) => argvCase(`--item ${JSON.stringify(v)}`, () => ['close', '--item', v, '--verdict-file', APPROVE], '--item must be a backlog row number')),
  argvCase('close with no --verdict-file', () => ['close', '--item', '2'], 'close needs --verdict-file'),
  {
    name: 'argv: no --dir reads ./.loop from the cwd',
    src: DEMO, code: 0,
    go: (c) => { const r = runRaw(c, ['close', '--item', '2', '--verdict-file', APPROVE]); return { r, ok: statusCell(c, 2).startsWith('done') }; },
  },
  // ------------------------------------------------------------------ re-design: every absence refusal has a case
  strict('a backlog row whose `#` is `—`', B, (t) => t.replace(/\s*$/, '\n| — | x | x | x | x | — | small | pending |\n'), '| — | x |', 'neither a number nor a word label'),
  strict('a rollup row whose `#` is `—`', RL, (t) => t.replace(/\s*$/, '\n| — | x | x | 1 | — | — |\n'), '| — | x |', 'neither a number, a word label nor empty'),
  strict('a rollup table without an Outcome column', RL, (t) => t.replace('| Outcome |', '| Result |'), '| # | Sub-goal | Result', 'needs `#` and `Outcome` columns'),
  ...[
    ['an empty active-epic', 'no epic:', (c) => writeFileSync(join(c.loop, 'active-epic'), '\n')],
    ['no backlog.md', 'no backlog at', (c) => { mkdirSync(join(c.loop, 'epics', 'other')); writeFileSync(join(c.loop, 'active-epic'), 'other\n'); }],
    ['a backlog with no table', 'has no table with `#` and `Status` columns', (c) => writeFileSync(files(c)[0], '# Backlog\nno table here\n')],
    ['a backlog table without a Status column', 'has no table with `#` and `Status` columns', (c) => writeFileSync(files(c)[0], readFileSync(files(c)[0], 'utf8').replace('| Status |', '| State |'))],
    ['no goal.md', 'the closing item\'s criteria live there', (c) => rmSync(join(c.loop, 'goal.md'))],
    ['a goal with no criteria', 'has no criteria under `## Success criteria`', (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace(/## Success criteria[\s\S]*?\n## Tier/, '## Success criteria (verifiable)\n\n## Tier'));
    }],
    ['a goal criterion without `Done when:`', 'goal.md criterion C1 has no `Done when:` line', (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace(/      Done when: [^\n]*\n/, ''));
    }],
    ['a proven criterion without `Done when:`', 'proven.md item 1 criterion C1 has no `Done when:` line', (c) => {
      writeFileSync(files(c)[1], readFileSync(files(c)[1], 'utf8').replace(/      Done when: [^\n]*\n/, ''));
    }],
    ['a claimed AC with no epic.md bullet', 'claims AC2 but epic.md has no `AC2` bullet', (c) => writeFileSync(files(c)[0], row2epic('AC1, AC2')(readFileSync(files(c)[0], 'utf8')))],
    ['a rollup without `## Per sub-goal`', 'has no `## Per sub-goal` table', (c) => writeFileSync(files(c)[2], readFileSync(files(c)[2], 'utf8').replace('## Per sub-goal', '## Rows'))],
    ['a `## Per sub-goal` with no table', 'has no table', (c) => writeFileSync(files(c)[2], readFileSync(files(c)[2], 'utf8').replace(/\n\|[\s\S]*$/, '\n'))],
  ].map(([what, want, prep]) => refusalCase(`absence refuses: ${what}`, DEMO,
    (c) => ['close', '--item', '2', '--verdict-file', APPROVE], want, prep)),
  refusalCase('absence refuses: no backlog row 7', DEMO, () => ['close', '--item', '7', '--verdict-file', APPROVE], 'backlog has no row 7'),
  // ------------------------------------------------------------------ re-design iteration 2
  strict('C1 twice in goal.md (the second is named)', G, (t) => t.replace('\n## Tier', '- [x] C1 again\n      Done when: `node src/total.mjs --json 2 3` exits 0\n\n## Tier'), '- [x] C1 again', 'names item-2/C1 more than once'),
  strict('`## Item 2` already in proven.md while row 2 is open', P, (t) => t + "\n## Item 2\nSource: interrupted\n\n- [x] C1 JSON total\n      Done when: x\n", '## Item 2', 'already has `## Item 2`'),
  strict('two # columns', B, (t) => addCol(t, '#'), '| # |', 'more than one # column'),
  strict('two Sub-goal columns', B, (t) => addCol(t, 'Sub-goal'), '| # |', 'more than one Sub-goal column'),
  strict('two Epic criterion columns', B, (t) => addCol(t, 'Epic criterion'), '| # |', 'more than one Epic criterion column'),
  strict('two rollup Sub-goal columns', RL, (t) => t.replace('| Slice verdict |', '| Sub-goal |'), '| # | Sub-goal | Outcome', 'more than one `Sub-goal` column'),
  strict('a one-space-indented line in the criteria region', G, (t) => t.replace('      Must not: the plain output changes\n', '      Must not: the plain output changes\n x one space\n'), 'x one space', 'none of the shapes'),
  strict('a one-space-indented line in the AC region', E, (t) => t + ' x one space\n', 'x one space', 'none of the shapes'),
  strict('a criterion under another `##` heading in goal.md', G, (t) => t + '\n## Notes\n- [ ] C2 hidden\n      Done when: y\n', '- [ ] C2 hidden', 'outside `## Success criteria`'),
  strict('an AC bullet under another `##` heading in epic.md', E, (t) => t + '\n## Later\n- [ ] AC2 — hidden.\n', 'AC2 — hidden', 'outside `## Epic acceptance criteria`'),
  strict('a criterion before the first `## Item` in proven.md', P, (t) => t.replace('\n## Item 1', '\n- [x] C9 loose\n      Done when: z\n\n## Item 1'), '- [x] C9 loose', 'outside a `## Item N` block'),
  strict('an AC in a backlog with no `Epic criterion` column', B, (t) => t.replace('| Epic criterion |', '| Epic ACs |'), '| # |', 'no `Epic criterion` column but epic.md defines AC1'),
  {
    name: 'strict readers: a row naming an AC with no `Epic criterion` column and no AC in epic.md',
    src: DEMO, code: 1,
    go: (c) => {
      const b = files(c)[0];
      writeFileSync(b, readFileSync(b, 'utf8').replace('| Epic criterion |', '| Epic ACs |'));
      const e = join(c.loop, 'epics', 'demo', 'epic.md');
      writeFileSync(e, readFileSync(e, 'utf8').replace(/## Epic acceptance criteria[\s\S]*$/, ''));
      const before = snap(c);
      const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      return { r, ok: same(c, before) && r.stderr.includes('backlog.md:5: this row names an AC') };
    },
  },
  strict('an upstream Status `[x] done`', B, (t) => t.replace('done (item 1 closed)', '[x] done (item 1 closed)'), '[x] done', 'puts done behind markup'),
  strict('an upstream Status `~x~ done`', B, (t) => t.replace('done (item 1 closed)', '~x~ done (item 1 closed)'), '~x~ done', 'puts done behind markup'),
  strict('a wrapped `Done when:` in goal.md', G, (t) => t.replace('and exits 0\n      Evidence:', 'and exits 0\n      under every locale\n      Evidence:'), 'under every locale', 'wraps onto this line'),
  strict('a wrapped `Done when:` in proven.md', P, (t) => t.replace('and exits 0\n      Evidence:', 'and exits 0\n      under every locale\n      Evidence:'), 'under every locale', 'wraps onto this line'),
  argvCase('an extra positional argument', () => ['close', 'extra', '--item', '2', '--verdict-file', APPROVE], 'unexpected argument "extra"'),
  // ------------------------------------------------------------------ re-design iteration 3
  ...[':white_check_mark: done', '&#x2705; done', '<s>x</s> done', '<del>open</del> done', '<!-- c --> done', '<!-- a > b --> done', '<b>done</b>'].map((st) =>
    strict(`an upstream Status \`${st}\``, B, (t) => t.replace('done (item 1 closed)', `${st} (item 1 closed)`), '| 1 | CLI total', 'puts done behind markup')),
  strict('a wrapped `Done when:` whose next line looks like a label', G, (t) => t.replace('and exits 0\n      Evidence:', 'and exits 0\n      Then (also): the exit code is 0\n      Evidence:'), 'Then (also)', 'wraps onto this line'),
  strict('a backlog row wider than its header', B, (t) => t.replace(/\s*$/, '\n| 3 | wide | x | x | x | — | small | pending | extra |\n'), '| 3 | wide |', 'cells, the header has'),
  strict('a bare `AC` token', B, row2epic('AC'), '| JSON output', 'is not an `AC<n>` id'),
  strict('an indented `  * [ ] C3` in the criteria region', G, (t) => t.replace('      Evidence: CLI output', '  * [ ] C3 nested\n      Evidence: CLI output'), '* [ ] C3 nested', 'does not open with `C<n>`'),
  strict('a `- [ ] **C2**` outside `## Success criteria`', G, (t) => t + '\n- [ ] **C2** hidden\n', '**C2** hidden', 'outside `## Success criteria`'),
  strict('a lower-case `ac1` with no `Epic criterion` column', B, (t) => t.replace('| Epic criterion |', '| Epic ACs |').replace('| 1 | AC1 | small | designed |', '| 1 | ac1 | small | designed |'), '| # |', 'no `Epic criterion` column'),
  strict('an indented `  - [ ] AC3` in the AC region', E, (t) => t + '  - [ ] AC3 — nested.\n', 'AC3 — nested', 'does not open with `AC<n>`'),
  argvCase('--help with an unknown flag', () => ['close', '--item', '2', '--verdict-file', APPROVE, '--dri', 'y', '--help'], 'unknown flag --dri'),
  // ------------------------------------------------------------------ re-design review gate fixes
  strict('an interrupted close: the rollup row already records `closed:` while the backlog row is open', RL,
    (t) => t.replace(/\s*$/, '\n| 2 | JSON output | closed: APPROVE (2026-09-24; item-1/C1, item-2/C1, AC1; v.md) | 1 | — | — |\n'),
    '| 2 | JSON output | closed:', 'already records a close while backlog row 2 is not done'),
  {
    name: 'an interrupted close is recoverable by the message: remove the proven block and the rollup `closed:` entry, close again, one entry',
    src: DEMO, code: 0,
    go: (c) => {
      run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      writeFileSync(files(c)[0], readFileSync(files(c)[0], 'utf8').replace(/\| done \(closed [^|]*\|/, '| designed |'));
      const refused = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      if (!refused.stderr.includes('any `closed:` entry on the rollup\'s row 2')) return { r: { code: 1, stderr: refused.stderr }, ok: false };
      writeFileSync(files(c)[1], readFileSync(files(c)[1], 'utf8').replace(/\n## Item 2[\s\S]*$/, '\n'));
      writeFileSync(files(c)[2], readFileSync(files(c)[2], 'utf8').replace(/closed: APPROVE \([^)]*\)( — )?/, ''));
      const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      const row2 = readFileSync(files(c)[2], 'utf8').split('\n').filter((l) => l.startsWith('| 2 |'));
      return { r, ok: row2.length === 1 && (row2[0].match(/closed: APPROVE/g) ?? []).length === 1 && rollupCell(c, 2, 'outcome').startsWith('closed: APPROVE (') && statusCell(c, 2).startsWith('done') };
    },
  },
  {
    name: 'a backlog title holding an escaped `\\|` lands in the new rollup row once-escaped (`JSON \\| output`), and the table still parses',
    src: DEMO, code: 0,
    go: (c) => {
      writeFileSync(files(c)[0], readFileSync(files(c)[0], 'utf8').replace('| 2 | JSON output |', '| 2 | JSON \\| output |'));
      const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      return { r, ok: rollupCell(c, 2, 'sub-goal') === 'JSON \\| output' && rollupCell(c, 2, 'outcome').startsWith('closed: APPROVE (') };
    },
  },
  {
    name: 'a goal with three criteria: proven.md gains every block, byte-for-byte, and the rollup names all three',
    src: DEMO, code: 0,
    go: (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace('\n## Tier',
        '- [x] C2 exit code\n      Done when: `node src/total.mjs --json 2 3` exits 0\n      Must not: none\n\n- [x] C3 no stderr\n      Done when: `node src/total.mjs --json 2 3` writes nothing to stderr\n      Evidence: CLI output\n\n## Tier'));
      const [b0, p0, r0] = snap(c);
      const v = verdictFrom(c, APPROVE, (t) => t + '- item-2/C2: met\n- item-2/C3: met\n');
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      const [b1, p1, r1] = snap(c);
      const d = TODAY();
      const goal = readFileSync(g, 'utf8');
      const ok = p1 === provenAfter(p0, 2, goal) && (p1.match(/^- \[x\] C\d/gm) ?? []).length === 4
        && b1 === setCell(b0, 2, 'status', `done (closed ${d} by loop-close)`)
        && r1 === addRollupRow(r0, `| 2 | JSON output | closed: APPROVE (${d}; item-1/C1, item-2/C1, item-2/C2, item-2/C3, AC1; ${v}) | — | — | — |`);
      return { r, ok };
    },
  },
  {
    name: 'a criterion block with a blank line inside it lands in proven.md verbatim, the blank line kept',
    src: DEMO, code: 0,
    go: (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace('and exits 0\n      Evidence:', 'and exits 0\n\n      Evidence:'));
      const [, p0] = snap(c);
      const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      const [, p1] = snap(c);
      return { r, ok: p1 === provenAfter(p0, 2, readFileSync(g, 'utf8')) && p1.includes('and exits 0\n\n      Evidence:') };
    },
  },
  // Every write path the script has (backlog Status, proven append, rollup new row, rollup update in place)
  // × every file ending (none, one newline, extra blank lines), each file compared whole.
  ...[['no final newline', (t) => t.replace(/\s*$/, '')], ['one final newline', (t) => t.replace(/\s*$/, '\n')], ['extra trailing blank lines', (t) => t.replace(/\s*$/, '\n\n\n')]]
    .flatMap(([how, end]) => ['new rollup row', 'rollup row updated in place'].map((path) => ({
      name: `close with backlog, proven and rollup ending in ${how}, ${path}: every file written exactly`,
      src: DEMO, code: 0,
      go: (c) => {
        const [bf, pf, rf] = files(c);
        if (path === 'rollup row updated in place') {
          writeFileSync(rf, readFileSync(rf, 'utf8').replace(/(\| 1 \| CLI total[^\n]*)/, '$1\n| 2 | JSON output | in progress | 1 | — | — |'));
        }
        for (const f of [bf, pf, rf]) writeFileSync(f, end(readFileSync(f, 'utf8')));
        const [b0, p0, r0] = snap(c);
        const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
        const [b1, p1, r1] = snap(c);
        const d = TODAY();
        const verdict = `closed: APPROVE (${d}; item-1/C1, item-2/C1, AC1; ${APPROVE})`;
        const rExpected = path === 'new rollup row'
          ? addRollupRow(r0, `| 2 | JSON output | ${verdict} | — | — | — |`)
          : setCell(r0, 2, 'outcome', `${verdict} — in progress`, '## Per sub-goal');
        return { r, ok: b1 === setCell(b0, 2, 'status', `done (closed ${d} by loop-close)`)
          && p1 === provenAfter(p0, 2, readFileSync(join(c.loop, 'goal.md'), 'utf8'))
          && r1 === rExpected };
      },
    }))),
  strict('a done backlog row whose `#` is a word label', B, (t) => t.replace('| 1 | CLI total', '| one | CLI total'), '| one | CLI total', 'is done but its `#` is a word label'),
  {
    // item 9 (D-eci-033): the verifier's `### Flags` section rides in the verdict message; its contract shape must not trip the reader
    name: 'an APPROVE verdict carrying a contract-shaped `### Flags` block closes',
    src: DEMO, code: 0,
    go: (c) => {
      const v = verdictFrom(c, APPROVE, (t) => `${t.replace(/\s*$/, '')}\n\n### Flags\n- flag: CRLF line endings in a backlog row — repro: node scripts/loop-close.mjs plan --item 2 → exit 1; refused, nothing written\n- flag: a subdirectory inside a session directory — repro: mkdir .loop/.agents-running/s1/x → exit 0; silent\n`);
      const r = run(c, ['close', '--item', '2', '--verdict-file', v]);
      return { r, ok: statusCell(c, 2).startsWith('done') };
    },
  },
  // C9 (D-eci-030): nothing that is done can leave the re-run list, and every listed text belongs to its id
  strict('a pending backlog row whose `#` is a word label (`one`)', B, (t) => t.replace(/\s*$/, '\n| one | extra | x | y | 1 | — | small | pending |\n'), '| one | extra', 'is a word label — backlog `#` cells are numbers only'),
  strict('a done row written `Done` under a word label', B, (t) => t.replace('| 1 | CLI total', '| one | CLI total').replace('done (item 1 closed)', 'Done (item 1 closed)'), '| one | CLI total', 'is done but its `#` is a word label'),
  strict('a done row written `**done**` under a word label', B, (t) => t.replace('| 1 | CLI total', '| one | CLI total').replace('done (item 1 closed)', '**done** (item 1 closed)'), '| one | CLI total', 'is done but its `#` is a word label'),
  strict('a done row written `✅ done` under a word label', B, (t) => t.replace('| 1 | CLI total', '| one | CLI total').replace('done (item 1 closed)', '✅ done (item 1 closed)'), '| one | CLI total', 'puts done behind markup'),
  strict('a done upstream row whose `## Item N` block holds no criterion (`Source:` only)', P, (t) => t.slice(0, t.indexOf("Source: item 1's goal.md at close\n") + "Source: item 1's goal.md at close\n".length), '## Item 1', '`## Item 1` holds no criterion but row 1 is done'),
  strict('plan: a done upstream row whose `## Item N` block holds no criterion', P, (t) => t.slice(0, t.indexOf("Source: item 1's goal.md at close\n") + "Source: item 1's goal.md at close\n".length), '## Item 1', '`## Item 1` holds no criterion but row 1 is done', ['plan', '--item', '2']),
  {
    name: 'a row claiming `AC1, AC2`: plan pairs each AC with its own epic.md block',
    src: DEMO, code: 0,
    go: (c) => {
      const ep = join(files(c)[0], '..', 'epic.md');
      writeFileSync(ep, readFileSync(ep, 'utf8').replace(/\s*$/, '\n- [ ] AC2 — `node src/total.mjs --json` prints JSON.\n      Evidence: `node src/total.mjs --json 2 3` prints `{"total":5}`.\n'));
      writeFileSync(files(c)[0], readFileSync(files(c)[0], 'utf8').replace('| 1 | AC1 | small | designed |', '| 1 | AC1, AC2 | small | designed |'));
      // the test's own read of epic.md: each AC block runs from its bullet to the line before the next bullet or heading
      const lines = readFileSync(ep, 'utf8').split('\n');
      const blockOf = (id) => {
        const i = lines.findIndex((l) => l.startsWith(`- [ ] ${id} `));
        let j = i + 1;
        while (j < lines.length && lines[j].trim() !== '' && !/^- \[|^#/.test(lines[j])) j += 1;
        return lines.slice(i, j).join('\n');
      };
      const r = run(c, ['plan', '--item', '2']);
      const b1 = blockOf('AC1');
      const b2 = blockOf('AC2');
      return { r, ok: b1 !== b2 && b2.includes('AC2') && r.stdout.includes(`## AC1\n${b1}\n`) && r.stdout.includes(`## AC2\n${b2}`) };
    },
  },
  {
    name: 'a three-criterion own item: the plan pairs each id with its own Done when',
    src: DEMO, code: 0,
    go: (c) => {
      const g = join(c.loop, 'goal.md');
      writeFileSync(g, readFileSync(g, 'utf8').replace('\n## Tier',
        '- [x] C2 exit code\n      Done when: `node src/total.mjs --json 2 3` exits 0\n\n- [x] C3 no stderr\n      Done when: `node src/total.mjs --json 2 3` writes nothing to stderr\n\n## Tier'));
      const r = run(c, ['plan', '--item', '2']);
      const o = r.stdout;
      return { r, ok: o.includes('## item-2/C1\nDone when: `node src/total.mjs --json 2 3` prints `{"total":5}` and exits 0\n')
        && o.includes('## item-2/C2\nDone when: `node src/total.mjs --json 2 3` exits 0\n')
        && o.includes('## item-2/C3\nDone when: `node src/total.mjs --json 2 3` writes nothing to stderr\n') };
    },
  },
  {
    name: 'multi-digit ids (item-12/C12, AC10) are read whole',
    src: DEMO, code: 0,
    go: (c) => {
      const edit = (f, fn) => writeFileSync(f, fn(readFileSync(f, 'utf8')));
      edit(join(c.loop, 'goal.md'), (t) => t.replace('backlog item #2', 'backlog item #12').replace('- [x] C1 JSON total', '- [x] C12 JSON total'));
      edit(join(c.loop, 'epics', 'demo', 'backlog.md'), (t) => t.replace('| 2 | JSON output', '| 12 | JSON output').replaceAll('| AC1 |', '| AC10 |'));
      edit(join(c.loop, 'epics', 'demo', 'epic.md'), (t) => t.replace('- [ ] AC1 —', '- [ ] AC10 —'));
      const v = verdictFrom(c, APPROVE, (t) => t.replace('- item-2/C1: met', '- item-12/C12: met').replace('- AC1: met', '- AC10: met'));
      const r = run(c, ['close', '--item', '12', '--verdict-file', v]);
      return { r, ok: statusCell(c, 12).startsWith('done') };
    },
  },
  {
    name: 'a suffixed id in id-line form ("- item-1/C2b: met") closes on the real snapshot',
    src: REAL, code: 0,
    go: (c) => {
      const v = verdictFrom(c, NATIVE, (t) => {
        const lines = t.split('\n');
        const i = lines.findIndex((l) => l.includes('oldhalf-{1,2,3}'));
        if (i < 0) throw new Error('C2b line not found');
        lines[i] = '- item-1/C2b: met — oldhalf 3/3 APPROVE';
        return lines.join('\n');
      });
      const r = run(c, ['close', '--item', '3', '--verdict-file', v]);
      return { r, ok: statusCell(c, 3).startsWith('done') };
    },
  },
  {
    name: 'a rollup whose # column is not first: the existing row is updated in place, its text kept',
    src: DEMO, code: 0,
    go: (c) => {
      const rp = files(c)[2];
      writeFileSync(rp, readFileSync(rp, 'utf8')
        .replace('| # | Sub-goal | Outcome | Iterations | What it taught | Slice verdict |', '| Sub-goal | # | Outcome | Iterations | What it taught | Slice verdict |')
        .replace('|---|----------|---------|-----------|----------------|---------------|', '|----------|---|---------|-----------|----------------|---------------|')
        .replace('| 1 | CLI total | done | 1 | — | well-sliced |', '| CLI total | 1 | done | 1 | — | well-sliced |\n| JSON output | 2 | in progress | 1 | — | — |'));
      const beforeNF = readFileSync(rp, 'utf8');
      const r = run(c, ['close', '--item', '2', '--verdict-file', APPROVE]);
      const rows = readFileSync(rp, 'utf8').split('\n').filter((l) => l.startsWith('| JSON output'));
      const ok = rows.length === 1 && /^closed: APPROVE \(.*\) — in progress$/.test(rollupCell(c, 2, 'outcome'))
        && readFileSync(rp, 'utf8') === setCell(beforeNF, 2, 'outcome', `closed: APPROVE (${TODAY()}; item-1/C1, item-2/C1, AC1; ${APPROVE}) — in progress`, '## Per sub-goal');
      return { r, ok };
    },
  },
];

let failed = 0;
for (const c of CASES) {
  const t = copy(c.src);
  let ok = true;
  let detail = '';
  try {
    const { r, ok: disk } = c.go(t);
    if (r.code !== c.code) { ok = false; detail += ` (exit ${r.code}, want ${c.code}; stderr: ${r.stderr.trim().slice(0, 200)})`; }
    if (c.stderr && !r.stderr.includes(c.stderr)) { ok = false; detail += ` (stderr missing ${JSON.stringify(c.stderr)}: ${r.stderr.trim().slice(0, 200)})`; }
    if (!disk) { ok = false; detail += ' (on-disk check failed)'; }
  } catch (e) {
    ok = false; detail = ` (threw: ${e.message})`;
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${detail}`);
}

if (!existsSync(SCRIPT)) { console.log('FAIL  loop-close.mjs is missing'); failed++; }

console.log(failed === 0 ? `\nall ${CASES.length} checks passed` : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
