#!/usr/bin/env node
/**
 * loop-close — the per-item close of an epic, as code.
 *
 * Closing a backlog item used to end with "tick any epic acceptance criteria
 * now met": a judgement the loop model made about its own work. This script
 * replaces that step with two commands and no judgement of its own.
 *
 *   node loop-close.mjs plan  --item <n> [--dir .loop]
 *   node loop-close.mjs close --item <n> --verdict-file <path> [--agent-id <id>] [--dir .loop]
 *
 * `plan` lists what the closing item's verifier must re-run, verbatim: every
 * `done` upstream item's refined criteria (from `epics/<slug>/proven.md`), the
 * closing item's own criteria (from `goal.md`), and the epic acceptance
 * criteria its backlog row claims (from `epic.md`). It runs nothing — the
 * verifier runs every check.
 *
 * `close` takes that verifier's final message as a file and writes `done` only
 * when the message has exactly one `## Verdict:` line, it says APPROVE, and
 * every listed id is marked met — `- <id>: met`, or in the verifier's own
 * contract shape `Criterion: "<exact Done when text>" → met`. It then appends
 * the item's criteria to `proven.md`, puts the verdict on the item's row of
 * the epic rollup, and marks the backlog row `done` last, so `done` is only
 * ever visible once the records behind it are on disk.
 *
 * It never reads a finished run's frozen copy (proven.md is what keeps that frozen),
 * starts no process and calls no model: the verdict arrives as input.
 *
 * Exit codes:
 *   0  planned / closed
 *   1  refused — nothing written; stderr says what to fix
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** The flags loop-close takes; anything else, a flag given twice, or a value-taking flag with no value refuses. */
const FLAGS = { item: 'value', dir: 'value', 'verdict-file': 'value', 'agent-id': 'value', help: 'bool' };

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [] };
  const problems = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (!Object.hasOwn(FLAGS, key)) { problems.push(`unknown flag ${a}`); continue; }
    if (Object.hasOwn(out, key)) problems.push(`${a} given more than once — only one value would be used`);
    if (FLAGS[key] === 'bool') { out[key] = true; continue; }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) { problems.push(`${a} needs a value`); continue; }
    out[key] = value;
    i++;
  }
  if (problems.length) out._problems = problems;
  return out;
}

const USAGE = `loop-close — the per-item close of an epic

  plan  --item <n> [--dir .loop]                        list what the verifier re-runs
  close --item <n> --verdict-file <path> [--dir .loop]  write done on a full APPROVE
        [--agent-id <id>]                               the verifier's agent id, recorded on the rollup
`;

function readIfExists(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

/** An epic slug is one path segment: it names a directory under `epics/`, never a path out of it. */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

// ------------------------------------------------------------------ tables

/** Cells split on unescaped `|`, raw (spacing kept) so a row can be rebuilt byte-identically. */
const rawCells = (line) => line.split(/(?<!\\)\|/);

// ------------------------------------------------------------------ strict readers
//
// One rule for every file: find the region, then classify every line in it.
// A reader builds its model only from classified lines, so nothing it did not
// recognise can be skipped, picked first or defaulted over — an unknown line
// refuses, naming the file and the 1-based line number (D-eci-025).

/** A refusal raised on a line being read carries its place. */
const at = (file, no, msg) => `${file}:${no}: ${msg}`;

const BLANK = /^\s*$/;
const TABLE = /^\s*\|/;
const SEPARATOR = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
const CHECKBOX = /^\s*[-*+]\s*\[/;
const CONT = /^\s{2,}\S/;
const ANY = /[\s\S]*/;

/**
 * The lines under the one heading matching `headingRe`, up to the next `## `
 * (the whole file when `headingRe` is null), with the 1-based number of the
 * first. Zero matches → null; two → refuse.
 */
function region(file, text, headingRe, twiceMsg) {
  const lines = text.split('\n');
  if (!headingRe) return { lines, first: 1 };
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (headingRe.test(lines[i])) starts.push(i);
  if (!starts.length) return null;
  if (starts.length > 1) {
    refuse(at(file, starts[1] + 1, twiceMsg ??
      `two headings match (${lines[starts[0]].trim()} / ${lines[starts[1]].trim()}) — only one would be read, so the other's content would be silently skipped.`));
  }
  let end = starts[0] + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return { lines: lines.slice(starts[0] + 1, end), first: starts[0] + 2 };
}

/** Every line → exactly one kind (first match in order), or refuse. */
function classify(file, reg, kinds, what) {
  const out = [];
  for (let i = 0; i < reg.lines.length; i++) {
    const text = reg.lines[i];
    const hit = kinds.find(([, re]) => re.test(text));
    if (!hit) {
      refuse(at(file, reg.first + i, `${what}: this line is none of the shapes loop-close reads ` +
        `(${JSON.stringify(text.trim().slice(0, 80))}) — it would be silently skipped.`));
    }
    out.push({ kind: hit[0], no: reg.first + i, text, m: text.match(hit[1]) });
  }
  return out;
}

/** Table cells, trimmed, without the outer pipes. */
const cellsOf = (line) => rawCells(line.trim()).slice(1, -1).map((c) => c.trim());

/** The column whose lower-cased header matches `re`; more than one refuses with `twiceMsg`. */
function column(file, no, lower, re, twiceMsg) {
  const hits = lower.map((c, i) => (re.test(c) ? i : -1)).filter((i) => i >= 0);
  if (hits.length > 1) refuse(at(file, no, twiceMsg));
  return hits.length ? hits[0] : -1;
}
const twiceCol = (name) => `the backlog header has more than one ${name} column — which one holds the value would be a guess.`;

/**
 * One contiguous table in `lines` (classified `table`), header then a
 * separator, every row as wide as the header. A table line after a gap refuses.
 */
function tableOf(file, lines, secondTableMsg) {
  const tables = lines.filter((l) => l.kind === 'table');
  if (!tables.length) return null;
  const firstIdx = lines.indexOf(tables[0]);
  const run = lines.slice(firstIdx, firstIdx + tables.length);
  const gap = run.filter((l) => l.kind !== 'table');
  if (gap.length) refuse(at(file, tables.filter((t) => t.no > gap[0].no)[0].no, secondTableMsg));
  const [header, sep, ...rows] = tables;
  if (!sep || !SEPARATOR.test(sep.text)) refuse(at(file, (sep ?? header).no, 'the table has no separator row after its header — its first row would be misread as one.'));
  const width = cellsOf(header.text).length;
  for (const r of rows) {
    const n = cellsOf(r.text).length;
    if (n !== width) refuse(at(file, r.no, `this row has ${n} cells, the header has ${width} — a value would land in the wrong column.`));
  }
  return { header, rows, last: tables[tables.length - 1].no - 1 };
}

/** The backlog: its one table, read by header name. Row 0 counts (L-007). */
function readBacklog(file, text) {
  const reg = region(file, text, null);
  const lines = classify(file, reg, [['blank', BLANK], ['table', TABLE], ['prose', ANY]], 'backlog');
  const table = tableOf(file, lines, 'the backlog has a second table — only the first is read, so rows in the other would be silently skipped.');
  if (!table) return null;
  const lower = cellsOf(table.header.text).map((c) => c.toLowerCase());
  const cols = {
    id: column(file, table.header.no, lower, /^#$/, twiceCol('#')),
    status: column(file, table.header.no, lower, /^status$/, twiceCol('Status')),
    title: column(file, table.header.no, lower, /sub-?goal/, twiceCol('Sub-goal')),
    epic: column(file, table.header.no, lower, /^epic criteri/, twiceCol('Epic criterion')),
  };
  if (cols.id === -1 || cols.status === -1) return null;
  const rows = [];
  for (const r of table.rows) {
    const cells = cellsOf(r.text);
    const cell = cells[cols.id];
    if (/^\d+$/.test(cell)) {
      rows.push({
        n: Number(cell), lineIndex: r.no - 1, no: r.no, cells,
        title: cols.title >= 0 ? cells[cols.title] : '',
        epic: cols.epic >= 0 ? cells[cols.epic] : '',
        status: cells[cols.status],
      });
    } else if (/\d/.test(cell)) {
      refuse(at(file, r.no, `backlog row \`${cell}\` has a \`#\` that is not a plain number — it would be skipped or misread.`));
    } else if (!/^[A-Za-z][A-Za-z_-]*$/.test(cell)) {
      refuse(at(file, r.no, `backlog row \`${cell}\` has a \`#\` that is neither a number nor a word label.`));
    } else if (isDone(file, { status: cells[cols.status], no: r.no })) {
      // a done word-labelled row names the drop it would cause; any other word label refuses below (D-eci-030)
      refuse(at(file, r.no, `backlog row \`${cell}\` is done but its \`#\` is a word label — its proven criteria would drop out of every later close; number it.`));
    } else {
      refuse(at(file, r.no, `backlog row \`${cell}\` has a \`#\` that is a word label — backlog \`#\` cells are numbers only (an integration row gets the next free number).`));
    }
  }
  return { lines: reg.lines, cols, rows, headerNo: table.header.no };
}

/**
 * Done: the Status opens with `done` (any case) once `` ` `` `*` `_` are gone.
 * A `done` that opens the cell only behind markup — an emoji, `:shortcode:`, entity,
 * checkbox, `~…~` / `<s>` / `<del>` strikethrough, a tag or an HTML comment — refuses; a
 * `done` mid-sentence is not done (D-eci-026).
 */
function isDone(file, row) {
  const plain = row.status.replace(/[`*_]/g, '').trim();
  if (/^done\b/i.test(plain)) return true;
  const bare = plain
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(s|del|strike)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/~+[^~]*~+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/:[a-z0-9+-]+:/gi, ' ')
    .replace(/\[[ xX]\]/g, ' ')
    .replace(/^[^A-Za-z]+/, '');
  if (/^done\b/i.test(bare)) refuse(at(file, row.no, `Status \`${row.status}\` puts done behind markup — write \`done …\`, or it reads as not done.`));
  return false;
}

/** The ACs a backlog row claims: `AC<n>` tokens; an id-looking token of any other shape refuses. */
function claimedACs(file, row) {
  const out = [];
  for (const raw of row.epic.split(/\s+/)) {
    const t = raw.replace(/^[()[\],;.:`*_~]+|[()[\],;.:`*_~]+$/g, '');
    if (/^AC\d+$/.test(t)) {
      if (!out.includes(t)) out.push(t);
    } else if (/^acs?$/i.test(t) || /\d/.test(t)) {
      refuse(at(file, row.no, `Epic criterion \`${t}\` is not an \`AC<n>\` id — the claim would be dropped.`));
    }
  }
  return out;
}

/**
 * Checkbox blocks of a region: a head starts a block, continuations and blanks
 * join it. A checkbox bullet that is not a head, or a continuation before the
 * first head, refuses.
 */
function blocksOf(file, lines, oddMsg) {
  const out = [];
  for (const l of lines) {
    if (l.kind === 'head') out.push({ id: l.m[1], no: l.no, lines: [l.text] });
    else if (l.kind === 'odd') refuse(at(file, l.no, oddMsg(l.text.trim())));
    else if (l.kind === 'cont' && !out.length) refuse(at(file, l.no, 'a continuation line before the first bullet belongs to none — it would be silently skipped.'));
    else if (out.length) out[out.length - 1].lines.push(l.text);
  }
  return out.map((b) => ({ id: b.id, no: b.no, block: b.lines.join('\n').replace(/\s+$/, ''), lines: b.lines }));
}

const CRITERION_HEAD = /^- \[[ xX]\] (C\d+[a-z]?)\b/;

/**
 * Criterion blocks (`- [ ] C2b …`) with their one `Done when:` and their kind. A `Kind:` line
 * is proven.md's alone (`dated — <reason>`: the criterion names a moment or artifact that no
 * longer exists to re-check, so later closes show it as context; `re-run`: the same as none).
 */
function criteriaOf(file, reg, kinds = false) {
  const lines = classify(file, reg, [['blank', BLANK], ['head', CRITERION_HEAD], ['odd', CHECKBOX], ['cont', CONT]], 'criteria');
  return blocksOf(file, lines,
    (t) => `a criterion bullet does not open with \`C<n>\` at the line start and would be skipped: "${t}"`).map((c) => {
    const dones = c.lines.map((l) => l.match(/^\s*Done when:\s*(.*)$/)).filter(Boolean);
    if (dones.length > 1) refuse(at(file, c.no, `criterion ${c.id} has ${dones.length} \`Done when:\` lines — a verdict could prove one and skip the other.`));
    const j = c.lines.map((l) => /^\s*Done when:/.test(l)).indexOf(true);
    const next = j >= 0 ? c.lines[j + 1] : undefined;
    if (next !== undefined && CONT.test(next) && !/^\s*(Evidence|Sites|Must not|Kind):/.test(next)) {
      refuse(at(file, c.no + j + 1, `criterion ${c.id}'s \`Done when:\` wraps onto this line — only its first line would be re-run; write it on one line.`));
    }
    const tags = c.lines.map((l, k) => ({ m: l.match(/^\s*Kind:\s*(.*)$/), no: c.no + k })).filter((t) => t.m);
    if (tags.length && !kinds) refuse(at(file, tags[0].no, `criterion ${c.id} carries a \`Kind:\` line — only proven.md tags a criterion; the closing item's own criteria are always re-run.`));
    if (tags.length > 1) refuse(at(file, tags[1].no, `criterion ${c.id} has more than one \`Kind:\` line — which one holds would be a guess.`));
    const tag = tags.length ? tags[0].m[1].trim() : 're-run';
    if (!/^re-run$|^dated\s+—\s+\S/.test(tag)) refuse(at(file, tags[0].no, `criterion ${c.id}'s \`Kind:\` is "${tag}" — write \`Kind: dated — <reason>\` or \`Kind: re-run\`.`));
    return { id: c.id, no: c.no, block: c.block, doneWhen: dones.length ? dones[0][1].trim() : null, dated: tag.startsWith('dated') };
  });
}

const EPIC_LINK = /^\s*Epic:\s*(\S+)\s*—\s*backlog item #(\d+)/;
const ANY_CRITERION = /^\s*[-*+]\s*\[[ xX]\]\s*\**\s*C\d+/i;
const ANY_AC = /^\s*[-*+]\s*\[[ xX]\]\s*\**\s*AC\d+/i;

/** A criterion (or AC) bullet outside the one region that is read would be silently skipped. */
function outside(file, all, reg, name) {
  const lo = reg ? reg.first : Infinity;
  const hi = reg ? reg.first + reg.lines.length - 1 : -Infinity;
  const stray = all.filter((l) => l.kind === 'head' && (l.no < lo || l.no > hi));
  if (stray.length) refuse(at(file, stray[0].no, `a criterion bullet outside ${name} would be silently skipped: "${stray[0].text.trim()}"`));
}

/** goal.md: its one `Epic:` link and its criteria. */
function readGoal(file, text) {
  const all = classify(file, region(file, text, null), [['link', EPIC_LINK], ['head', ANY_CRITERION], ['other', ANY]], 'goal');
  const links = all.filter((l) => l.kind === 'link');
  if (links.length > 1) refuse(at(file, links[1].no, 'more than one `Epic: … — backlog item #N` line — which item it is would be a guess.'));
  const reg = region(file, text, /^##\s+Success criteria/i);
  outside(file, all, reg, '`## Success criteria`');
  return { link: links.length ? links[0].m : null, own: reg ? criteriaOf(file, reg) : [] };
}

/** proven.md: every `##` heading is `## Item N`; each block opens with `Source:`. */
function readProven(file, text) {
  const reg = region(file, text, null);
  const lines = classify(file, reg, [['item', /^## Item (\d+)\s*$/], ['h2', /^##(?!#)/], ['head', ANY_CRITERION], ['other', ANY]], 'proven');
  const bad = lines.filter((l) => l.kind === 'h2');
  if (bad.length) refuse(at(file, bad[0].no, `every \`##\` heading in proven.md must be \`## Item N\` — "${bad[0].text.trim()}" would be silently skipped.`));
  const heads = lines.filter((l) => l.kind === 'item');
  outside(file, lines, heads.length ? { first: heads[0].no, lines: reg.lines.slice(heads[0].no - 1) } : null, 'a `## Item N` block');
  const items = new Map();
  const at_ = new Map();
  heads.forEach((h, k) => {
    const n = Number(h.m[1]);
    if (items.has(n)) refuse(at(file, h.no, `more than one \`## Item ${n}\` block — which one is proven would be a guess.`));
    const end = k + 1 < heads.length ? heads[k + 1].no - 1 : reg.lines.length;
    const body = reg.lines.slice(h.no, end);
    const src = body.map((t, i) => ({ t, i })).filter(({ t }) => !BLANK.test(t));
    if (!src.length || !/^Source:/.test(src[0].t)) refuse(at(file, h.no, `\`## Item ${n}\` has no \`Source:\` line first.`));
    const rest = { lines: body.slice(src[0].i + 1), first: h.no + src[0].i + 2 };
    items.set(n, criteriaOf(file, rest, true));
    at_.set(n, h.no);
  });
  return { items, headingNo: at_, text };
}

const AC_HEAD = /^- \[[ xX]\] (AC\d+)\b/;

/** epic.md's `## Epic acceptance criteria`: AC blocks by id. */
function readEpicACs(file, text) {
  const reg = region(file, text, /^##\s+Epic acceptance criteria/i);
  outside(file, classify(file, region(file, text, null), [['head', ANY_AC], ['other', ANY]], 'epic'), reg, '`## Epic acceptance criteria`');
  if (!reg) return new Map();
  const lines = classify(file, reg, [['blank', BLANK], ['head', AC_HEAD], ['odd', CHECKBOX], ['cont', CONT]], 'epic acceptance criteria');
  const found = blocksOf(file, lines, (t) => `an AC bullet does not open with \`AC<n>\` and would be skipped: "${t}"`);
  const twice = dupes(found.map((c) => c.id));
  if (twice.length) refuse(at(file, found.filter((c) => c.id === twice[0])[1].no, `epic.md has more than one bullet for ${twice.join(', ')} — which one a close proves would be a guess.`));
  return new Map(found.map((c) => [c.id, c.block]));
}

/** The rollup's `## Per sub-goal`: one table, blank lines, nothing else. */
function readRollup(file, text) {
  const reg = region(file, text, /^##\s+Per sub-goal/i, 'the epic rollup has more than one `## Per sub-goal` heading.');
  if (!reg) refuse(`${file}: the epic rollup has no \`## Per sub-goal\` table.`);
  const lines = classify(file, reg, [['blank', BLANK], ['table', TABLE]], 'the rollup\'s `## Per sub-goal`');
  const table = tableOf(file, lines, 'the epic rollup\'s `## Per sub-goal` has table lines after its first table — only the first is read, so a row there would be left stale.');
  if (!table) refuse(`${file}: the epic rollup's \`## Per sub-goal\` has no table.`);
  const cols = cellsOf(table.header.text).map((c) => c.toLowerCase());
  const twice = 'the epic rollup table has more than one `#` or `Outcome` column.';
  const outcome = column(file, table.header.no, cols, /^outcome$/, twice);
  const idCol = column(file, table.header.no, cols, /^#$/, twice);
  if (outcome === -1 || idCol === -1) refuse(at(file, table.header.no, 'the epic rollup table needs `#` and `Outcome` columns.'));
  const title = column(file, table.header.no, cols, /sub-?goal/, 'the epic rollup table has more than one `Sub-goal` column — which one holds the title would be a guess.');
  const rows = table.rows.map((r) => {
    const cell = cellsOf(r.text)[idCol];
    if (/\d/.test(cell) && !/^\d+$/.test(cell)) refuse(at(file, r.no, `the epic rollup has a row numbered \`${cell}\`, not a plain number — it would be misread or left stale.`));
    if (cell !== '' && !/^\d+$/.test(cell) && !/^[A-Za-z][A-Za-z_-]*$/.test(cell)) refuse(at(file, r.no, `the epic rollup has a row whose \`#\` is \`${cell}\` — neither a number, a word label nor empty.`));
    return { n: /^\d+$/.test(cell) ? Number(cell) : null, index: r.no - 1 };
  });
  return { cols, outcome, idCol, title, rows, last: table.last };
}

/** Values that occur more than once — a Map keyed by them would keep one and silently drop the rest. */
const dupes = (values) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];

// ------------------------------------------------------------------ the list

function load(dir, item) {
  const slug = (readIfExists(join(dir, 'active-epic')) ?? '').trim();
  if (!slug) refuse(`no epic: ${join(dir, 'active-epic')} is missing or empty.`);
  if (!SLUG.test(slug)) refuse(`${join(dir, 'active-epic')} names ${JSON.stringify(slug)}, which is not a single directory name under epics/.`);
  const base = join(dir, 'epics', slug);
  const backlogFile = join(base, 'backlog.md');
  const backlogText = readIfExists(backlogFile);
  if (backlogText === null) refuse(`no backlog at ${backlogFile}.`);
  const backlog = readBacklog(backlogFile, backlogText);
  if (!backlog) refuse(`${backlogFile} has no table with \`#\` and \`Status\` columns.`);
  const twiceRows = dupes(backlog.rows.map((r) => r.n));
  if (twiceRows.length) refuse(at(backlogFile, backlog.rows.filter((r) => r.n === twiceRows[0])[1].no, `backlog has more than one row numbered ${twiceRows.join(', ')}.`));
  const row = backlog.rows.filter((r) => r.n === item)[0];
  if (!row) refuse(`backlog has no row ${item}.`);
  if (isDone(backlogFile, row)) refuse(`backlog row ${item} is already done — a close happens once.`);

  const provenFile = join(base, 'proven.md');
  const provenText = readIfExists(provenFile) ?? '';
  const proven = readProven(provenFile, provenText);
  if (proven.items.has(item)) {
    refuse(`${provenFile}:${proven.headingNo.get(item)}: ${provenFile} already has \`## Item ${item}\` while row ${item} is not done — ` +
      'an earlier close was interrupted after writing it. Remove that block and any `closed:` entry on the rollup\'s row ' +
      `${item}, then close again.`);
  }
  const goalFile = join(dir, 'goal.md');
  const goal = readIfExists(goalFile);
  if (goal === null) refuse(`no ${goalFile} — the closing item's criteria live there.`);
  const { link, own } = readGoal(goalFile, goal);
  if (!link || link[1] !== slug || Number(link[2]) !== item) {
    refuse(`${goalFile} is not item ${item} of epic ${slug} (it names ${link ? `${link[1]} item #${link[2]}` : 'no epic item'}).`);
  }
  if (!own.length) refuse(`${goalFile} has no criteria under \`## Success criteria\`.`);

  const list = [];
  const context = [];
  for (const up of backlog.rows.filter((r) => r.n !== item && isDone(backlogFile, r))) {
    const crit = proven.items.get(up.n);
    if (!crit) {
      refuse(`backlog row ${up.n} is done but ${provenFile} has no \`## Item ${up.n}\` block — ` +
        'its criteria would silently drop out of every later close. Append the block first.');
    }
    if (!crit.length) {
      refuse(at(provenFile, proven.headingNo.get(up.n), `\`## Item ${up.n}\` holds no criterion but row ${up.n} is done — ` +
        'nothing of it would be re-run by any later close. Copy its goal.md criteria into the block.'));
    }
    for (const c of crit) {
      if (!c.doneWhen) refuse(`proven.md item ${up.n} criterion ${c.id} has no \`Done when:\` line.`);
    }
    list.push(...crit.filter((c) => !c.dated).map((c) => ({ id: `item-${up.n}/${c.id}`, text: c.block, doneWhen: c.doneWhen, file: provenFile, no: c.no })));
    context.push(...crit.filter((c) => c.dated).map((c) => ({ label: `item ${up.n}, ${c.id}`, text: c.block })));
  }
  for (const c of own) {
    if (!c.doneWhen) refuse(`goal.md criterion ${c.id} has no \`Done when:\` line.`);
    list.push({ id: `item-${item}/${c.id}`, text: c.block, doneWhen: c.doneWhen, file: goalFile, no: c.no });
  }
  const epicFile = join(base, 'epic.md');
  const acs = readEpicACs(epicFile, readIfExists(epicFile) ?? '');
  if (backlog.cols.epic === -1 && acs.size) {
    refuse(at(backlogFile, backlog.headerNo, `the backlog has no \`Epic criterion\` column but epic.md defines ${[...acs.keys()].join(', ')} — no row can claim an AC, so none would ever be re-run.`));
  }
  if (backlog.cols.epic === -1 && row.cells.filter((c) => /\bAC\d+\b/i.test(c)).length) {
    refuse(at(backlogFile, row.no, 'this row names an AC but the backlog has no `Epic criterion` column — the claim would be dropped.'));
  }
  for (const ac of claimedACs(backlogFile, row)) {
    if (!acs.has(ac)) refuse(`backlog row ${item} claims ${ac} but epic.md has no \`${ac}\` bullet.`);
    list.push({ id: ac, text: acs.get(ac), doneWhen: null, file: backlogFile, no: row.no });
  }
  const twiceIds = dupes(list.map((e) => e.id));
  const second = list.filter((e) => e.id === twiceIds[0])[1];
  if (twiceIds.length) refuse(`${second.file}:${second.no}: the criteria list names ${twiceIds.join(', ')} more than once — two criteria with one id cannot be told apart in a verdict.`);
  return { slug, base, backlog, row, provenText, goal, own, list, context };
}

function renderPlan(ctx) {
  const out = [
    `# loop-close plan — epic ${ctx.slug}, item ${ctx.row.n}`,
    '',
    'Re-run every criterion below: its `Done when:`, and the `Sites:` grep under it',
    'when it has one. An upstream criterion\'s `Must not:` lines describe that item\'s',
    'own change — context, not re-run.',
    '',
    'End your message with one fenced block, its fences at column 0: a line ```loop-close, then one',
    '`- <id>: met` or `- <id>: not met — <reason>` line per id below (a',
    '`Criterion: "<Done when>" → met` line in the loop-verifier\'s own shape counts for',
    'the criterion it quotes), then a line ```. Only that block marks an id met; a',
    'not-met line anywhere in the message refuses the close. Inside the block, name an',
    'id on its own line only: any other line that mentions it blocks the close.',
  ];
  for (const e of ctx.list) out.push('', `## ${e.id}`, e.text);
  if (ctx.context.length) {
    out.push('', '## Context — dated, not re-run', '',
      'These criteria name a moment or artifact that no longer exists to re-check. Do not re-run them or mark them.');
    for (const e of ctx.context) out.push('', `${e.label}:`, e.text);
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ verdicts

/**
 * Refuse by default. A line NAMES an id when the id appears in it as a token
 * (any case, any separators between its parts, in backticks, bold, a table or a
 * quote) — except inside the quoted `Done when:` of a native line that matched,
 * which is the criterion's own text (compared with `**` dropped on both sides).
 * Naming blocks the id unless the line is that id's met statement, in one of
 * two shapes:
 *   `- <id>: met…`                          (the plan's instruction)
 *   `- Criterion: "<Done when>" → met…`     (the loop-verifier's own contract)
 * A met statement opens its status with lowercase `met` and never says
 * `not met`, `unmet` or `?`. So a not-met in a shape this reader does not know
 * is a false refuse, never a false close.
 */
const ID_LINE = /^\s*(?:-\s*)?([\w/-]+)\s*:(.*)/;
const NATIVE_LINE = /^\s*(?:-\s*)?Criterion\s*:\s*"(.*)"\s*→(.*)/;
const MET = /^met\b/;
const NEG = /not\s+met|unmet|\?/i;
/** Any line saying this outside a matched quote blocks the close — one naming an id is already blocked per id, and reported first; one naming none (a wrapped continuation, a prose aside) is caught only here. */
const UNMET = /not\s+met|unmet/i;

/** The id as a token: its letter and digit runs, any `[\s/-]` between them, no letter before it, no letter or digit after it. */
function tokenRe(id) {
  const runs = id.match(/[a-z]+|\d+/gi);
  return new RegExp(`(?<![a-z])${runs.join('[\\s/-]*')}(?![a-z0-9])`, 'i');
}

/**
 * Per entry: null (never marked), 'met', or the first naming line in the block that was not
 * its met statement; plus every line of the whole message that says not met outside a matched
 * quote. Only lines inside the one ```loop-close block mark or block an id (D-eci-030); a
 * not-met anywhere still refuses (D-eci-034), so prose cannot hide one.
 */
function marks(text, list, file) {
  const byId = new Map(list.map((e) => [e.id, [e]]));
  const byDone = new Map();
  const key = (t) => t.replace(/\*\*/g, '');
  for (const e of list) if (e.doneWhen) byDone.set(key(e.doneWhen), [...(byDone.get(key(e.doneWhen)) ?? []), e]);
  const tokens = list.map((e) => [e, tokenRe(e.id)]);
  const state = new Map(list.map((e) => [e.id, null]));
  const stray = [];
  const lines = text.split('\n');
  // A fence counts only at column 0: an indented one is a quotation of the format, never the verdict.
  const opens = lines.map((l, i) => (/^```loop-close\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!opens.length) {
    refuse(at(file, 1, 'the verdict has no ```loop-close block — end the message with a line ```loop-close, one `- <id>: met` line per planned id, and a line ```.'));
  }
  if (opens.length > 1) refuse(at(file, opens[1] + 1, 'the verdict has more than one ```loop-close block — which one is the verdict would be a guess.'));
  const end = lines.findIndex((l, i) => i > opens[0] && /^```\s*$/.test(l));
  if (end === -1) refuse(at(file, opens[0] + 1, 'the ```loop-close block is never closed with a line ``` — the verdict would run to the end of the message.'));
  for (const [i, raw] of lines.entries()) {
    const line = key(raw);
    const inBlock = i > opens[0] && i < end;
    const native = line.match(NATIVE_LINE);
    const nativeEntries = native && byDone.get(native[1]);
    const id = line.match(ID_LINE);
    const subject = nativeEntries ?? (id && byId.get(id[1])) ?? [];
    const rest = (nativeEntries ? native[2] : id ? id[2] : '').trim();
    const says = MET.test(rest) && !NEG.test(rest);
    const scan = nativeEntries ? line.replace(`"${native[1]}"`, '""') : line;
    if (UNMET.test(scan)) stray.push({ text: line.trim(), no: i + 1, quotes: nativeEntries ? nativeEntries.map((e) => e.id) : null });
    if (!inBlock) continue;
    for (const [e, re] of tokens) {
      const own = subject.includes(e);
      if (!own && !re.test(scan)) continue;
      const prev = state.get(e.id);
      if (prev !== null && prev !== 'met') continue;
      state.set(e.id, own && says ? 'met' : `not met ("${own ? rest : line.trim()}")`);
    }
  }
  return { state, stray, open: opens[0] + 1 };
}

function checkVerdict(text, list, file) {
  const verdicts = [...text.matchAll(/^\s*#+\s*Verdict:\s*\**\s*([A-Za-z_]+)/gm)].map((m) => m[1]);
  if (!verdicts.length) refuse('the verdict file has no `## Verdict:` line — pass the verifier\'s final message verbatim.');
  if (verdicts.length > 1) refuse(`the verdict file has ${verdicts.length} \`## Verdict:\` lines (${verdicts.join(', ')}) — pass exactly one verifier message.`);
  if (verdicts[0] !== 'APPROVE') refuse(`the verdict is ${verdicts[0]}, not APPROVE — the item is not closed; the rejected criteria are the next iteration.`);
  const { state, stray, open } = marks(text, list, file);
  const notMet = list.filter((e) => state.get(e.id)?.startsWith('not met')).map((e) => `${e.id} ${state.get(e.id)}`);
  const missing = list.filter((e) => state.get(e.id) === null).map((e) => e.id);
  if (notMet.length) refuse(`the verdict marks ${notMet.join('; ')} — every line naming an id must say met.`);
  if (stray.length) {
    const s0 = stray[0];
    refuse(at(file, s0.no, s0.quotes
      ? `the verdict says not met on a line quoting ${s0.quotes.join(', ')}'s \`Done when:\`: "${s0.text}" — a not-met anywhere in the message blocks the close.`
      : `the verdict says not met on a line naming no listed id: "${s0.text}" — name the id on that line.`));
  }
  if (missing.length) {
    refuse(at(file, open, `the verdict never marks ${missing.join(', ')} met in its \`\`\`loop-close block — every listed id needs a \`- <id>: met\` line there ` +
      '(or, for a criterion, the verifier\'s own `Criterion: "<Done when>" → met`).'));
  }
}

// ------------------------------------------------------------------ writes

function withStatus(backlog, row, status) {
  const lines = backlog.lines.slice();
  const cells = rawCells(lines[row.lineIndex]);
  cells[backlog.cols.status + 1] = ` ${status} `;
  lines[row.lineIndex] = cells.join('|');
  return lines.join('\n');
}

function withRollup(file, text, row, verdictLine) {
  const m = readRollup(file, text);
  const lines = text.split('\n');
  const same = m.rows.filter((r) => r.n === row.n);
  if (same.length > 1) refuse(at(file, same[1].index + 1, `the epic rollup has ${same.length} rows numbered ${row.n} — one would be updated and the other left stale.`));
  if (same.length) {
    const cells = rawCells(lines[same[0].index]);
    if (/^closed:/i.test(cells[m.outcome + 1].trim())) {
      refuse(at(file, same[0].index + 1, `the rollup's row ${row.n} already records a close while backlog row ${row.n} is not done — ` +
        'an earlier close was interrupted after writing it. Remove that `closed:` entry (and any `## Item` block it left in proven.md), then close again.'));
    }
    cells[m.outcome + 1] = ` ${verdictLine} — ${cells[m.outcome + 1].trim()} `;
    lines[same[0].index] = cells.join('|');
    return lines.join('\n');
  }
  const cells = m.cols.map(() => '—');
  cells[m.idCol] = String(row.n);
  // The title comes from a table cell, so any `|` in it is already escaped (`\|`); escaping again would double it.
  if (m.title !== -1) cells[m.title] = row.title.slice(0, 120);
  cells[m.outcome] = verdictLine;
  lines.splice(m.last + 1, 0, `| ${cells.join(' | ')} |`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ main

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args._problems) {
    process.stderr.write(`loop-close: refused, nothing written.\n  - ${args._problems.join('; ')}.\n`);
    return 1;
  }
  if (args.help || !['plan', 'close'].includes(cmd)) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 1;
  }
  const dir = args.dir ?? '.loop';
  try {
    if (args._.length > 1) refuse(`unexpected argument ${JSON.stringify(args._[1])} — loop-close takes one command and flags.`);
    if (typeof args.item !== 'string' || !/^\d+$/.test(args.item)) refuse('--item must be a backlog row number.');
    const item = Number(args.item);
    const ctx = load(dir, item);
    if (cmd === 'plan') { process.stdout.write(renderPlan(ctx)); return 0; }

    if (typeof args['verdict-file'] !== 'string') refuse('close needs --verdict-file <the verifier\'s final message>.');
    if (args['agent-id'] !== undefined && !/^[A-Za-z0-9_-]+$/.test(args['agent-id'])) {
      refuse(`--agent-id must be a plain id (letters, digits, \`_\`, \`-\`), not ${JSON.stringify(args['agent-id'])}.`);
    }
    const verdict = readIfExists(args['verdict-file']);
    if (verdict === null) refuse(`cannot read the verdict file ${args['verdict-file']}.`);
    checkVerdict(verdict, ctx.list, args['verdict-file']);

    const rollupPath = join(dir, 'memory', 'epics', `${ctx.slug}.md`);
    const rollup = readIfExists(rollupPath);
    if (rollup === null) refuse(`no epic rollup at ${rollupPath}.`);
    const date = new Date().toISOString().slice(0, 10);
    const ids = ctx.list.map((e) => e.id).join(', ');
    const agent = args['agent-id'];
    const verdictLine = `closed: APPROVE (${date}; ${ids}; ${args['verdict-file'].replace(/\|/g, '\\|')}${agent === undefined ? '' : `; agent ${agent}`})`;

    // Every check has passed and every write is staged. The backlog's `done`
    // is written last: a crash before it leaves an item that is simply not
    // closed yet, never a `done` row whose proven block is missing.
    const nextRollup = withRollup(rollupPath, rollup, ctx.row, verdictLine);
    const nextBacklog = withStatus(ctx.backlog, ctx.row, `done (closed ${date} by loop-close)`);
    const ownBlocks = ctx.own.map((c) => c.block).join('\n');
    const nextProven = ctx.provenText.replace(/\s*$/, '\n') +
      `\n## Item ${item}\nSource: goal.md at close (loop-close, ${date})\n\n${ownBlocks}\n`;

    writeFileSync(join(ctx.base, 'proven.md'), nextProven);
    writeFileSync(rollupPath, nextRollup);
    writeFileSync(join(ctx.base, 'backlog.md'), nextBacklog);
    process.stdout.write(`closed item ${item} — ${ctx.list.length} criteria met (${ids})\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stderr.write(`loop-close: refused, nothing written.\n  - ${e.message}\n`);
    return 1;
  }
}

export { readBacklog, readGoal, readProven, readEpicACs, readRollup, marks };

// Node already gives the main module's real path; argv[1] keeps the symlink (`/var` → `/private/var`), and a literal compare would skip main and exit 0 having done nothing.
if (fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exit(main(process.argv));
