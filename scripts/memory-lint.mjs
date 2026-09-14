#!/usr/bin/env node
/**
 * memory-lint — check the memory store for the properties that matter.
 *
 *   node memory-lint.mjs [--dir .loop/memory] [--json]
 *
 * Exit codes:
 *   0  clean, or warnings only
 *   2  a blocking finding — maintenance is due before the store grows further
 *   1  the store is missing or unreadable
 *
 * Why this exists, in one measured example. A real maintenance pass folded 152
 * index lines into cluster maps, verified by script that all 358 IDs still had
 * their `### L-NNN` anchors, and recorded "zero IDs lost". Every anchor did
 * survive. But 126 of 509 bodies ended with no index line AND no mention in any
 * map, and 115 of those are cited nowhere in the store at all — the recall hook
 * scores the index, nothing walks body anchors, so they are unreachable by
 * auto-recall and by a tag grep alike. The pass proved the property that was
 * easy to check (the anchor exists) rather than the one that mattered
 * (something can reach it). That is `an-assertion-that-proves-less-than-it-looks`,
 * from this store's own corpus, landing on the machinery that maintains it.
 *
 * So `reach` is the headline check, and it is deliberately not satisfiable by
 * the thing the pass already did.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const INDEX_BUDGET_BYTES = 40 * 1024;  // matches hooks/memory-gate.mjs
const COMMENTARY_SHARE = 0.05;         // of the budget, before it is worth moving out
const INDEX_LINE_CHARS = 200;

/** The closed `root_cause` set from the loop-memory contract. */
const ROOT_CAUSES = new Set([
  'wrong-api', 'missing-config', 'async-timing', 'scope', 'test-isolation',
  'data-shape', 'dependency', 'logic', 'unknown',
]);

const SOLUTION_KEYS = ['type', 'area', 'date', 'run', 'severity', 'root_cause', 'status'];

// ------------------------------------------------------------------- utilities

function read(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }

function mdFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md')
      .map((e) => join(dir, e.name));
  } catch { return []; }
}

function walkMd(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, acc);
    else if (e.name.endsWith('.md') && e.name !== '_index.md') acc.push(p);
  }
  return acc;
}

/** Split an index into its entry half and its HTML-comment commentary half. */
function splitIndex(text) {
  let commentary = '';
  let entries = '';
  let inComment = false;
  for (const raw of text.split('\n')) {
    if (inComment) {
      commentary += raw + '\n';
      inComment = !raw.includes('-->');
      continue;
    }
    if (/^\s*<!--/.test(raw)) {
      commentary += raw + '\n';
      inComment = !raw.includes('-->');
      continue;
    }
    entries += raw + '\n';
  }
  return { entries, commentary };
}

/** Bodies under `### <ID>` anchors in one file, as a map id → heading text. */
function anchors(text) {
  const out = new Map();
  const re = /^###\s+([A-Z]-[A-Za-z0-9-]*\d)\b(.*)$/gm;
  let m;
  while ((m = re.exec(text))) out.set(m[1], m[2].trim());
  return out;
}

/** The text of each `### C-NN` cluster map body, joined — a map's members. */
function mapBodies(text) {
  let out = '';
  const re = /^###\s+C-\d+[\s\S]*?(?=^###\s+|\Z)/gm;
  let m;
  while ((m = re.exec(text))) out += m[0] + '\n';
  return out;
}

// --------------------------------------------------------------------- checks

/**
 * Every body is reachable: its own index line, or named inside a cluster map.
 *
 * The contract's Demote outcome is "drop an entry's trigger, keep its body" —
 * and the body stays reachable through the neighbour whose trigger absorbed it.
 * An entry with neither has not been demoted; it has been dropped.
 */
function checkReach(memDir, findings) {
  for (const root of ['learnings', 'decisions']) {
    const dir = join(memDir, root);
    const index = read(join(dir, '_index.md'));
    if (index === null) continue;

    const indexed = new Set([...index.matchAll(/^-\s*([A-Z]-[A-Za-z0-9-]*\d)\b/gm)].map((m) => m[1]));
    // A folded group line names a range ("D-759-001…102"); its prefix reaches them.
    const foldedPrefixes = [...index.matchAll(/^-\s*([A-Z]-[A-Za-z0-9-]+?)-?\d+\s*…/gm)].map((m) => m[1]);

    let maps = '';
    const bodies = new Map();
    for (const f of walkMd(dir)) {
      const text = read(f);
      if (!text) continue;
      maps += mapBodies(text);
      for (const [id] of anchors(text)) if (!/^C-/.test(id)) bodies.set(id, f);
    }

    const unreachable = [];
    for (const [id, file] of bodies) {
      if (indexed.has(id)) continue;
      if (maps.includes(id)) continue;
      if (foldedPrefixes.some((p) => id.startsWith(p))) continue;
      unreachable.push({ id, file: relative(memDir, file) });
    }
    if (unreachable.length) {
      findings.push({
        check: 'reach', level: 'block', root,
        count: unreachable.length,
        message:
          `${unreachable.length} of ${bodies.size} ${root} bodies have no index line and are named in no ` +
          `cluster map — unreachable by auto-recall (which scores the index) and by a tag grep alike. ` +
          `Fold each trigger into the neighbouring entry that absorbed it, per the Demote outcome.`,
        ids: unreachable.slice(0, 12).map((u) => u.id),
      });
    }
  }
}

/** The index stays inside its reading budget, and says why when it does not. */
function checkBudget(memDir, findings) {
  for (const root of ['learnings', 'decisions', 'solutions']) {
    const p = join(memDir, root, '_index.md');
    const text = read(p);
    if (text === null) continue;
    const total = Buffer.byteLength(text, 'utf8');
    const { commentary } = splitIndex(text);
    const commentaryBytes = Buffer.byteLength(commentary, 'utf8');

    if (total > INDEX_BUDGET_BYTES) {
      // Naming the commentary share turns "consolidate something" into a move
      // that costs no entry at all, when that is what the numbers say.
      const entriesBytes = total - commentaryBytes;
      const hint = entriesBytes <= INDEX_BUDGET_BYTES
        ? ` Moving the ${Math.round(commentaryBytes / 1024)}KB of maintenance commentary into ` +
          `${root}/_maintenance.md brings it to ${Math.round(entriesBytes / 1024)}KB without touching an entry.`
        : ` Consolidate a cluster: state the principle it shares as one entry naming its cases.`;
      findings.push({
        check: 'budget', level: 'block', root,
        message: `${root}/_index.md is ${Math.round(total / 1024)}KB, over the ${INDEX_BUDGET_BYTES / 1024}KB reading budget.${hint}`,
      });
    } else if (commentaryBytes > INDEX_BUDGET_BYTES * COMMENTARY_SHARE) {
      findings.push({
        check: 'budget', level: 'warn', root,
        message:
          `${Math.round(commentaryBytes / 1024)}KB of ${root}/_index.md is maintenance commentary ` +
          `(${Math.round((commentaryBytes / total) * 100)}% of the file) — it is read every run and ` +
          `triggers nothing. ${root}/_maintenance.md is its home.`,
      });
    }

    const long = splitIndex(text).entries.split('\n')
      .filter((l) => /^\s*-\s+\S/.test(l) && l.trim().length > INDEX_LINE_CHARS);
    if (long.length) {
      findings.push({
        check: 'budget', level: 'block', root,
        message: `${long.length} trigger line(s) in ${root}/_index.md exceed ${INDEX_LINE_CHARS} chars — move the detail into the body under its \`###\` anchor.`,
      });
    }
  }
}

/** Solutions frontmatter is typed, so the store stays greppable by field. */
function checkSchema(memDir, findings) {
  const dir = join(memDir, 'solutions');
  if (!existsSync(dir)) return;
  const missing = [];
  const badCause = [];
  const advisory = [];
  const unidentified = [];
  const byId = new Map();
  for (const f of mdFiles(dir)) {
    const text = read(f);
    if (!text) continue;
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const head = fm ? fm[1] : '';
    const name = relative(memDir, f);
    const absent = SOLUTION_KEYS.filter((k) => !new RegExp(`^${k}:`, 'm').test(head));
    if (absent.length) missing.push(`${name} (${absent.join(', ')})`);
    const cause = /^root_cause:\s*(.+)$/m.exec(head);
    if (cause && !ROOT_CAUSES.has(cause[1].trim())) badCause.push(`${name}: ${cause[1].trim().slice(0, 48)}`);
    // A `type: bug` entry without a `must_not:` is advice. The corpus records
    // what advice achieves: one entry was recalled and marked `applied` twice
    // in an epic that went on to produce its 13th and 14th instances of the
    // thing it warns about. Only a line the verifier already checks changes an
    // outcome, and `Must not:` is that line.
    if (/^type:\s*bug\s*$/m.test(head) && !/^must_not:\s*\S/m.test(head)) advisory.push(name);

    // The handle that lets a slug be renamed without breaking its references.
    const id = (/^id:\s*(S-\d+)\s*$/m.exec(head) || [])[1];
    if (!id) unidentified.push(name);
    else {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(name);
    }
  }

  // Two entries under one handle is the failure mode numeric ids introduce:
  // parallel runs each read the same max and each allocate the next. Cheap to
  // detect, and detection is what turns a silent overwrite into a finding.
  const collisions = [...byId].filter(([, files]) => files.length > 1);
  if (collisions.length) {
    findings.push({
      check: 'schema', level: 'block', root: 'solutions', count: collisions.length,
      message:
        `${collisions.length} solution id(s) are used by more than one entry — two runs allocated the same ` +
        `handle. Renumber the later one; every reference to a duplicated id is ambiguous until you do.`,
      ids: collisions.map(([id, files]) => `${id}: ${files.join(' + ')}`).slice(0, 6),
    });
  }
  if (unidentified.length) {
    findings.push({
      check: 'schema', level: 'warn', root: 'solutions', count: unidentified.length,
      message:
        `${unidentified.length} solution entr${unidentified.length === 1 ? 'y has' : 'ies have'} no \`id:\` — they are ` +
        `addressed by filename, so renaming the slug breaks every inbound reference. ` +
        `Run \`migrate-memory.mjs --solutions\` to assign handles.`,
      ids: unidentified.slice(0, 6),
    });
  }
  if (missing.length) {
    findings.push({
      check: 'schema', level: 'block', root: 'solutions', count: missing.length,
      message: `${missing.length} solution entr${missing.length === 1 ? 'y is' : 'ies are'} missing typed frontmatter keys.`,
      ids: missing.slice(0, 8),
    });
  }
  if (advisory.length) {
    findings.push({
      check: 'schema', level: 'warn', root: 'solutions', count: advisory.length,
      message:
        `${advisory.length} \`type: bug\` entr${advisory.length === 1 ? 'y has' : 'ies have'} no \`must_not:\` — ` +
        `they can be recalled and applied and still change nothing. Write one checkable prohibition each, ` +
        `phrased as a goal.md \`Must not:\` line, and the design gate will carry it into the criteria.`,
      ids: advisory.slice(0, 8),
    });
  }
  if (badCause.length) {
    findings.push({
      check: 'schema', level: 'block', root: 'solutions', count: badCause.length,
      message:
        `${badCause.length} \`root_cause\` value(s) outside the closed set (${[...ROOT_CAUSES].join(' | ')}) — ` +
        `a free-text cause cannot be grepped, which is the one thing the typed frontmatter buys.`,
      ids: badCause.slice(0, 8),
    });
  }
}

/** Two bodies citing the same `file:line` under different tags are one entry. */
function checkDuplicates(memDir, findings) {
  const byAnchor = new Map();
  for (const root of ['learnings']) {
    for (const f of walkMd(join(memDir, root))) {
      const text = read(f);
      if (!text) continue;
      const re = /^###\s+(L-\d+)\s*(\[[^\]]+\]\[[^\]]+\])?([\s\S]*?)(?=^###\s+|\Z)/gm;
      let m;
      while ((m = re.exec(text))) {
        const [, id, tag, body] = m;
        for (const ref of body.match(/[\w./-]+\.\w+:\d+/g) ?? []) {
          if (!byAnchor.has(ref)) byAnchor.set(ref, []);
          byAnchor.get(ref).push({ id, tag: tag ?? '' });
        }
      }
    }
  }
  const clusters = [];
  for (const [ref, members] of byAnchor) {
    const tags = new Set(members.map((x) => x.tag));
    if (members.length > 1 && tags.size > 1) {
      clusters.push(`${ref} — ${members.map((x) => `${x.id}${x.tag}`).join(' / ')}`);
    }
  }
  if (clusters.length) {
    findings.push({
      check: 'dup', level: 'warn', root: 'learnings', count: clusters.length,
      message:
        `${clusters.length} code anchor(s) are cited by entries under different \`[type][area]\` tags. ` +
        `Consolidation is keyed on the tag, so it cannot see these — judge each pair by hand.`,
      ids: clusters.slice(0, 8),
    });
  }
}

/** A rollup cites; it does not restate. And an index never points into archive/. */
function checkCitations(memDir, findings) {
  const thin = [];
  for (const f of mdFiles(join(memDir, 'epics'))) {
    const text = read(f);
    if (!text) continue;
    const rows = text.split('\n').filter((l) => /^\|\s*\*{0,2}\d/.test(l));
    if (!rows.length) continue;
    const cited = (text.match(/\bD-[A-Za-z0-9-]*\d\b/g) ?? []).length;
    if (cited === 0) thin.push(`${relative(memDir, f)} (${rows.length} rows, 0 decision IDs)`);
    if (/^status:\s*done/m.test(text) && !/##\s*Promotion candidates/m.test(text)) {
      findings.push({
        check: 'cite', level: 'warn', root: 'epics',
        message:
          `${relative(memDir, f)} is \`status: done\` with no \`## Promotion candidates\` block. ` +
          `Epic close is the event the host-tier gate fires on — list the IDs whose scope exceeds ` +
          `this epic, or write \`none — <reason>\`.`,
      });
    }
  }
  if (thin.length) {
    findings.push({
      check: 'cite', level: 'warn', root: 'epics', count: thin.length,
      message: `${thin.length} epic rollup(s) cite no decision IDs — a rollup cites, it does not restate.`,
      ids: thin.slice(0, 8),
    });
  }

  for (const root of ['learnings', 'decisions']) {
    const text = read(join(memDir, root, '_index.md'));
    if (text === null) continue;
    const into = splitIndex(text).entries.split('\n').filter((l) => /^\s*-\s/.test(l) && /\barchive\//.test(l));
    if (into.length) {
      findings.push({
        check: 'cite', level: 'warn', root,
        message:
          `${into.length} index line(s) send the reader into \`archive/\`, which the contract marks as a ` +
          `frozen snapshot. Promote what still binds current work, or say on the line that the pointer is historical.`,
      });
    }
  }
}

// ------------------------------------------------------------------------ main

export function lint(memDir) {
  const findings = [];
  checkReach(memDir, findings);
  checkBudget(memDir, findings);
  checkSchema(memDir, findings);
  checkDuplicates(memDir, findings);
  checkCitations(memDir, findings);
  return findings;
}

function main(argv) {
  const args = argv.slice(2);
  const i = args.indexOf('--dir');
  const memDir = resolve(i >= 0 && args[i + 1] ? args[i + 1] : join('.loop', 'memory'));

  if (!existsSync(memDir) || !statSync(memDir).isDirectory()) {
    process.stderr.write(`memory-lint: no memory store at ${memDir}\n`);
    return 1;
  }

  const findings = lint(memDir);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ dir: memDir, findings }, null, 2) + '\n');
  } else if (!findings.length) {
    process.stdout.write('memory-lint: clean\n');
  } else {
    for (const f of findings) {
      process.stdout.write(`${f.level === 'block' ? 'BLOCK' : 'warn '}  [${f.check}] ${f.message}\n`);
      if (f.ids?.length) process.stdout.write(`         ${f.ids.join(', ')}${f.count > f.ids.length ? ', …' : ''}\n`);
    }
  }
  return findings.some((f) => f.level === 'block') ? 2 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));
