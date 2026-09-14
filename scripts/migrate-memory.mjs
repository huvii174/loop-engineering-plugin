#!/usr/bin/env node
/**
 * migrate-memory — one-way migration of a .loop/memory store from the FLAT
 * layout (one `learnings.md`, one `decisions.md`) to the INDEX+BODY tree.
 *
 *   node migrate-memory.mjs [--dir <path>] [--dry-run] [--force]
 *
 * Exit codes:
 *   0  ok      — plan printed (--dry-run), migration written, or already migrated
 *   1  error   — unreadable source, target tree already present without --force,
 *                or a reconciliation mismatch (source entries != migrated entries)
 *
 * The flat files grew past the point where a session can read them: 108 learnings
 * and 479 decision bullets in one linear scan. The tree splits each store into a
 * cheap INDEX (one grep-able trigger line per entry) and BODY files fetched only
 * when a trigger matches, so recall costs a grep instead of a full read.
 *
 * Two rules make the migration safe to run against a real store:
 *
 *   NOTHING IS INVENTED. An entry's epic is taken from a slug this store already
 *   names — the `epics/` directory, a trailing `(run / slug)` marker, a leading
 *   `[759 item 26 ...]` tag — or it goes to `durable.md`. A `## Item N` section
 *   with no slug of its own inherits from the nearest preceding resolved bullet
 *   and is reported as inherited, because guessing an epic silently mis-files
 *   knowledge in a way no later reader can detect.
 *
 *   NOTHING IS DROPPED. Every source bullet lands in exactly one body file and
 *   the counts are reconciled at the end; prose that belongs to no bullet is
 *   preserved verbatim under a "Source prose" heading rather than discarded, and
 *   the source files are renamed to `.pre-migration` rather than deleted so a
 *   human can diff. A count that does not reconcile is an error, not a warning —
 *   a half-migrated memory store is worse than an un-migrated one.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ------------------------------------------------------------------ primitives

/** Collapse a hand-wrapped entry to one line. */
export function flatten(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Hard-truncate to `max` chars, marking the cut with an ellipsis. */
export function clip(s, max) {
  const t = flatten(s);
  if (max <= 1) return t.slice(0, Math.max(0, max));
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

/**
 * The entry's leading clause: up to the first em-dash separator or the end of
 * the first sentence, whichever is shorter. Mechanical on purpose — a human or
 * a later model refines these triggers; a clever summary here would be a guess
 * wearing the costume of a fact.
 */
export function firstClause(text) {
  const t = flatten(text);
  const candidates = [];
  const dash = t.indexOf(' — ');
  if (dash > 0) candidates.push(t.slice(0, dash));
  // A sentence ends at .!? followed by an opening capital or the end of the text.
  // Requiring the capital keeps "incl. both E2E legs" and "e.g. a value" whole,
  // which a bare /[.!?]\s/ would decapitate into a useless trigger.
  const stop = /[.!?](?:\s+(?=[A-Z(⛔])|$)/.exec(t);
  if (stop) candidates.push(t.slice(0, stop.index + 1));
  if (!candidates.length) return t;
  return candidates.reduce((a, b) => (a.length <= b.length ? a : b));
}

/** Leading `[type][area]...` tags, and the text with them removed. */
export function splitTags(text) {
  const tags = [];
  let rest = text;
  let m;
  while ((m = /^\[([^\]\s]+)\]\s*/.exec(rest))) {
    tags.push(m[1].toLowerCase());
    rest = rest.slice(m[0].length);
  }
  return { tags, rest: rest.trim() };
}

const LEARNING_TYPES = { env: 'env', gotcha: 'gotcha', pattern: 'pattern', dead: 'dead' };
const LEARNING_FILE = { env: 'env.md', gotcha: 'gotchas.md', pattern: 'patterns.md', dead: 'dead-ends.md' };

// ---------------------------------------------------------- markdown structure

/**
 * Split markdown into logical entries. A `- ` line opens an entry; an unindented
 * or indented non-blank line that is neither a heading nor a new bullet CONTINUES
 * it (the store hand-wraps long entries); a blank line closes it.
 *
 * Text that appears while no entry is open is section prose — kept, not parsed.
 * HTML comment blocks and blockquotes are routed out whole so a wrapped comment
 * body is never mistaken for an entry continuation.
 */
export function parseMarkdown(text) {
  const lines = text.split('\n');
  const sections = [];
  const comments = [];
  const quotes = [];
  let section = { heading: null, level: 0, entries: [], prose: [] };
  let entry = null;
  let prose = null;
  let comment = null;

  // An open entry already lives in section.entries — closing it is only
  // forgetting the append target. (An earlier version also pushed the section
  // here when `sections` was empty; pushSection then pushed it AGAIN, so a
  // heading directly after the file's first bullet duplicated every entry in
  // that section — and reconciliation could not see it, because both sides of
  // the count came from the same doubled list.)
  const closeEntry = () => { entry = null; };
  const closeProse = () => {
    if (prose && flatten(prose.join('\n'))) section.prose.push(prose.join('\n').trim());
    prose = null;
  };
  const pushSection = () => {
    closeEntry(); closeProse();
    if (section.heading !== null || section.entries.length || section.prose.length) sections.push(section);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (comment) {
      comment.push(line);
      if (line.includes('-->')) { comments.push(comment.join('\n')); comment = null; }
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      entry = null; closeProse();
      if (line.includes('-->')) comments.push(line);
      else comment = [line];
      continue;
    }
    if (/^\s*>/.test(line)) { entry = null; closeProse(); quotes.push(line); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      pushSection();
      section = { heading: heading[2].trim(), level: heading[1].length, entries: [], prose: [] };
      continue;
    }

    if (!line.trim()) { entry = null; closeProse(); continue; }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      closeProse();
      entry = { lines: [bullet[1]], section };
      section.entries.push(entry);
      continue;
    }

    if (entry) { entry.lines.push(line.trim()); continue; }
    if (!prose) prose = [];
    prose.push(line);
  }
  pushSection();

  for (const s of sections) for (const e of s.entries) e.text = flatten(e.lines.join(' '));
  return { sections, comments, quotes };
}

// -------------------------------------------------------------------- learnings

/**
 * Learnings are re-sharded by their `[type]` tag, not by the section they sat in
 * — the flat file's sections had already drifted apart from the tags (its own
 * maintenance comment says so), and the tag is the thing a reader greps.
 */
export function parseLearnings(text) {
  const { sections, comments, quotes } = parseMarkdown(text);
  const entries = [];
  const scratch = [];
  const unknownTypes = [];
  const untagged = [];
  const proseBlocks = [];
  const subheadings = [];
  let neverStore = null;

  for (const s of sections) {
    if (s.heading && /^never store$/i.test(s.heading)) {
      neverStore = ['## Never store', ...s.entries.map((e) => `- ${e.text}`)].join('\n');
      continue;
    }
    // Run scratch moved out of learnings.md into `scratch/run.md`, a sibling of
    // `scratch/adhoc.md`. Scratch is undistilled by definition, so it is copied
    // verbatim and never given an L- id — an id would imply it had earned one.
    if (s.heading && /^scratch\b/i.test(s.heading)) {
      for (const e of s.entries) scratch.push(e.text);
      for (const p of s.prose) proseBlocks.push({ heading: s.heading, text: p });
      continue;
    }
    if (s.level >= 3 && s.heading) subheadings.push(s.heading);
    for (const p of s.prose) proseBlocks.push({ heading: s.heading, text: p });

    for (const e of s.entries) {
      const { tags, rest } = splitTags(e.text);
      const rawType = tags[0] ?? null;
      let type = rawType && LEARNING_TYPES[rawType];
      if (!type) {
        type = 'gotcha';
        if (rawType) unknownTypes.push({ tag: rawType, text: clip(e.text, 120) });
        else untagged.push({ text: clip(e.text, 120) });
      }
      entries.push({
        type,
        tags: tags.length ? tags : ['gotcha'],
        section: s.heading,
        original: e.text,
        body: rest || e.text,
      });
    }
  }

  entries.forEach((e, i) => { e.id = `L-${String(i + 1).padStart(3, '0')}`; });
  return { entries, scratch, comments, quotes, neverStore, unknownTypes, untagged, proseBlocks, subheadings };
}

export function renderLearnings(parsed) {
  const files = new Map();
  const byType = { env: [], gotcha: [], pattern: [], dead: [] };

  for (const e of parsed.entries) {
    byType[e.type].push(e);
    const name = `learnings/${LEARNING_FILE[e.type]}`;
    if (!files.has(name)) files.set(name, []);
    const tagStr = e.tags.map((t) => `[${t}]`).join('');
    files.get(name).push(`### ${e.id} ${tagStr} ${clip(firstClause(e.body), 100)}\n\n${e.original}`);
  }

  const index = ['# Learnings index', ''];
  if (parsed.neverStore) index.push(parsed.neverStore, '');
  index.push(
    "<!-- One line per entry, <=200 chars. The line is a TRIGGER: it names the symptom",
    "     (error text, API/file names) a future session would recognise, not the lesson.",
    "     Body: grep -A 20 '^### L-042' .loop/memory/learnings/gotchas.md -->",
    ''
  );
  for (const q of parsed.quotes) index.push(q);
  if (parsed.quotes.length) index.push('');
  for (const c of parsed.comments) index.push(c, '');
  if (parsed.subheadings.length) {
    index.push('<!-- Source subsections, retired by the re-shard (kept for provenance):');
    for (const h of parsed.subheadings) index.push(`     - ${h}`);
    index.push('-->', '');
  }

  for (const type of ['env', 'gotcha', 'pattern', 'dead']) {
    if (!byType[type].length) continue;
    index.push(`## ${type}`);
    for (const e of byType[type]) {
      const prefix = `- ${e.id} ${e.tags.map((t) => `[${t}]`).join('')} `;
      index.push(prefix + clip(firstClause(e.body), Math.max(8, 200 - prefix.length)));
    }
    index.push('');
  }

  const out = new Map();
  out.set('learnings/_index.md', index.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
  if (parsed.scratch.length) {
    out.set('scratch/run.md', [
      '<!--',
      'Run scratch. One line per finding, written immediately, distilled by',
      '/loop-engineering:memory. Empty is the correct resting state.',
      '',
      '  - [<type>][<area>] <fact> — <why> (YYYY-MM-DD)',
      '',
      'Migrated verbatim from learnings.md\'s retired "## Scratch (this run)" section.',
      '-->',
      '',
      ...parsed.scratch.map((s) => `- ${s}`),
      '',
    ].join('\n'));
  }
  for (const [name, blocks] of files) {
    const title = `# ${name.replace(/^learnings\//, '').replace(/\.md$/, '')}`;
    const prose = parsed.proseBlocks.length && name === 'learnings/gotchas.md'
      ? ['## Source prose (unattached to any entry)', '', ...parsed.proseBlocks.map((p) => `> (from ${p.heading ?? 'file top'}) ${flatten(p.text)}`), '']
      : [];
    out.set(name, [title, '', ...prose, ...blocks.map((b) => b + '\n')].join('\n').trimEnd() + '\n');
  }
  return { files: out, counts: Object.fromEntries(Object.entries(byType).map(([k, v]) => [LEARNING_FILE[k], v.length])) };
}

// -------------------------------------------------------------------- decisions

/** `759-document-tab-parity` → `759`; `pm-schema-cutover` → `pmsc`; durable → `core`. */
export function epicKey(slug) {
  const num = /^(\d{2,5})-/.exec(slug);
  if (num) return num[1];
  const initials = slug.split(/[^a-z0-9]+/i).filter(Boolean).map((p) => p[0]).join('').toLowerCase();
  return initials || slug.toLowerCase().slice(0, 4);
}

/**
 * Every epic slug this store already names, from the `epics/` directory and from
 * slugs written into the decisions text itself. Aliases let a bare `[759 item 26]`
 * tag resolve to the full `759-document-tab-parity` slug without inventing one.
 */
export function buildEpicRegistry(dir, text) {
  const slugs = new Set();
  try {
    for (const f of readdirSync(join(dir, 'epics'))) if (f.endsWith('.md')) slugs.add(f.slice(0, -3));
  } catch { /* no epics/ — fall back to slugs the decisions text names explicitly */ }
  const fromDir = slugs.size > 0;

  // `epics/` is authoritative when it exists. Harvesting slug-shaped tokens out of
  // prose otherwise is a last resort: it cannot tell an epic from a UUID or a
  // hyphenated adjective, so it only runs when there is no directory to trust.
  if (!fromDir) {
    for (const m of text.matchAll(/\(((?:\d{2,5}-)?[a-z][a-z0-9]*(?:-[a-z0-9]+){1,5})\s*\/\s*item\s+\d+/gi)) {
      slugs.add(m[1].toLowerCase());
    }
  }

  const registry = [];
  const keys = new Map();
  for (const slug of [...slugs].sort()) {
    let key = epicKey(slug);
    while ([...keys.values()].includes(key) && keys.get(slug) !== key) key += '2';
    keys.set(slug, key);
    const aliases = new Set([slug, key]);
    const num = /^(\d{2,5})-/.exec(slug);
    if (num) aliases.add(num[1]);
    registry.push({ slug, key, aliases });
  }
  return registry;
}

const SUPERSEDED = /\b(supersed(?:e|es|ed|ing)|reversed|reversal|amended|amendment|amends)\b/i;

/** The sentence carrying the supersede/reverse/amend word, for a human pass. */
function supersededNote(text) {
  const m = SUPERSEDED.exec(text);
  if (!m) return null;
  const start = text.lastIndexOf('. ', m.index) + 1;
  const after = text.slice(m.index);
  const end = m.index + (/[.!?](?:\s|$)/.exec(after)?.index ?? after.length) + 1;
  return clip(text.slice(Math.max(0, start), end), 300);
}

/**
 * Split a bullet into decision / rationale / alternatives. Three shapes appear in
 * the real store, and anything that does not split cleanly keeps its whole text
 * under **Decision:** rather than being cut at a guessed boundary.
 */
export function splitDecision(text) {
  const altRe = /\b(alternatives?\s+rejected|rejected\s+alternatives?)\s*:?\s*/i;
  let decision = null, rationale = null, alternatives = null;

  const alt = altRe.exec(text);
  const head = alt ? text.slice(0, alt.index).trim().replace(/[;,.]\s*$/, '') : text;
  if (alt) alternatives = text.slice(alt.index + alt[0].length).trim();

  const bold = /^\*\*(.+?)\*\*\s*(?:—\s*)?(.*)$/s.exec(head);
  if (bold) {
    decision = bold[1].trim();
    rationale = bold[2].trim() || null;
  } else {
    const kw = /^(?:Choice|Decision|Confirmed|Deferred|Finding\s+\d+|Minor|Open\s+design\s+question)\b[^:]*:\s*/i.exec(head);
    const rest = kw ? head.slice(kw[0].length).trim() : head;
    // `Rationale (measured from globals.css, all 4 modes):` — the label carries a
    // parenthetical often enough that anchoring on `Rationale:` alone loses the split.
    const rat = /\bRationale\b[^:\n]{0,80}:\s*/i.exec(rest);
    if (rat) {
      decision = rest.slice(0, rat.index).trim().replace(/[;,.]\s*$/, '');
      rationale = rest.slice(rat.index + rat[0].length).trim();
    } else {
      const dash = rest.indexOf(' — ');
      if (dash > 0) { decision = rest.slice(0, dash).trim(); rationale = rest.slice(dash + 3).trim(); }
      else decision = rest;
    }
  }
  if (!decision) decision = text;
  // "Unsplit" = the bullet yielded no rationale and no alternatives, so its whole
  // text stands as the decision. Recorded so the report can name how much of the
  // store still needs a human to tease the fields apart.
  return { decision, rationale, alternatives, unsplit: !rationale && !alternatives };
}

export function parseDecisions(text, registry) {
  const { sections, comments, quotes } = parseMarkdown(text);
  const entries = [];
  const proseBlocks = [];
  const inherited = [];
  const unresolvedTags = new Map();
  let lastResolved = null;

  const resolve_ = (raw) => {
    const trail = /\(\s*(?:[^()]*\/\s*)?([a-z0-9]+(?:-[a-z0-9]+){1,5})\s*(?:\/\s*item\s+\d+)?[^()]*\)\s*$/i.exec(raw);
    if (trail) {
      const hit = registry.find((r) => r.slug === trail[1].toLowerCase());
      if (hit) return { epic: hit, via: 'trailing marker' };
    }
    for (const m of raw.matchAll(/\(([a-z0-9][a-z0-9-]*)\s*\/\s*item\s+\d+/gi)) {
      const hit = registry.find((r) => r.slug === m[1].toLowerCase());
      if (hit) return { epic: hit, via: 'item marker' };
    }
    const lead = /^\*\*\[([^\]]+)\]/.exec(raw) ?? /^\[([^\]]+)\]/.exec(raw);
    if (lead) {
      const token = lead[1].trim().split(/[\s,]+/)[0].toLowerCase().replace(/^#/, '');
      const hit = registry.find((r) => r.aliases.has(token));
      if (hit) return { epic: hit, via: 'leading tag' };
      unresolvedTags.set(token, (unresolvedTags.get(token) ?? 0) + 1);
    }
    const named = registry.filter((r) => raw.toLowerCase().includes(r.slug));
    if (named.length === 1) return { epic: named[0], via: 'slug named in text' };
    return null;
  };

  const itemOf = (raw, heading) => {
    const inTag = /^\*\*?\[[^\]]*?\bitem\s+(\d+)/i.exec(raw) ?? /\bitem\s+(\d+)\b/i.exec(raw.slice(0, 80));
    if (inTag) return Number(inTag[1]);
    const inHeading = heading && /^item\s+(\d+)\b/i.exec(heading);
    return inHeading ? Number(inHeading[1]) : null;
  };
  const dateOf = (raw, heading) => (/\b(\d{4}-\d{2}-\d{2})\b/.exec(raw) ?? /\b(\d{4}-\d{2}-\d{2})\b/.exec(heading ?? ''))?.[1] ?? null;

  // Pre-pass: which epic do DIRECTLY resolvable bullets claim for each item
  // number? A `## Item N` section with no slug of its own joins on that number,
  // which is evidence from anywhere in the file. Adjacency, the older fallback,
  // only reflects the order things were appended in — right in this store by
  // luck, and wrong the moment two epics interleave.
  const itemEpics = new Map();
  for (const s of sections) {
    for (const e of s.entries) {
      const found = resolve_(e.text);
      const item = itemOf(e.text, null);
      if (!found || item == null) continue;
      if (!itemEpics.has(item)) itemEpics.set(item, new Map());
      itemEpics.get(item).set(found.epic.slug, found.epic);
    }
  }
  unresolvedTags.clear(); // the pre-pass double-counts; the real pass tallies them

  for (const s of sections) {
    for (const p of s.prose) proseBlocks.push({ heading: s.heading, text: p });

    // A `## Item N` section carries no slug of its own: read one from its own
    // text, else join on its item number, else inherit the nearest preceding
    // bullet's — weakest last, and reported so a human can check it.
    let sectionEpic = null;
    if (s.heading && /^item\s+\d+/i.test(s.heading)) {
      const whole = [s.heading, ...s.prose, ...s.entries.map((e) => e.text)].join('\n');
      const n = Number(/^item\s+(\d+)/i.exec(s.heading)[1]);
      const byItem = itemEpics.get(n);
      sectionEpic = resolve_(whole)
        ?? (byItem?.size === 1 ? { epic: [...byItem.values()][0], via: 'joined on item number' } : null)
        ?? (lastResolved ? { epic: lastResolved, via: 'inherited from preceding decision' } : null);
    }

    for (const e of s.entries) {
      const found = resolve_(e.text) ?? sectionEpic;
      if (found) lastResolved = found.epic;
      if (found && /inherited/.test(found.via)) inherited.push({ heading: s.heading, epic: found.epic.slug, text: clip(e.text, 100) });

      const parts = splitDecision(e.text);
      const note = SUPERSEDED.test(e.text) ? supersededNote(e.text) : null;
      entries.push({
        epic: found ? found.epic : null,
        via: found ? found.via : 'none — durable',
        item: itemOf(e.text, s.heading),
        date: dateOf(e.text, s.heading),
        status: note ? 'superseded' : 'active',
        supersededNote: note,
        original: e.text,
        ...parts,
      });
    }
  }

  const counters = new Map();
  for (const e of entries) {
    const key = e.epic ? e.epic.key : 'core';
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    e.id = `D-${key}-${String(n).padStart(3, '0')}`;
  }
  return { entries, comments, quotes, proseBlocks, inherited, unresolvedTags };
}

export function renderDecisions(parsed) {
  const files = new Map();
  const groups = new Map();

  for (const e of parsed.entries) {
    const slug = e.epic ? e.epic.slug : 'durable';
    const name = e.epic
      ? `decisions/${slug}/${e.item == null ? 'general' : `item-${e.item}`}.md`
      : 'decisions/durable.md';
    const head = ['###', e.id, '·', e.status, ...(e.date ? ['·', e.date] : []), ...(e.item != null ? ['·', `item ${e.item}`] : [])].join(' ');
    const block = [head, `**Decision:** ${e.decision}`];
    if (e.rationale) block.push(`**Rationale:** ${e.rationale}`);
    block.push(`**Alternatives rejected:** ${e.alternatives ?? '(not recorded in source)'}`);
    if (e.supersededNote) block.push(`**Superseded-note:** ${e.supersededNote}`);

    if (!files.has(name)) files.set(name, []);
    files.get(name).push(block.join('\n'));
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(e);
  }

  const index = ['# Decisions index', ''];
  index.push(
    "<!-- One line per decision. Body: grep -A 8 '^### D-759-017' .loop/memory/decisions/<epic>/item-<N>.md",
    "     `durable.md` holds process and cross-epic decisions that carry no epic slug. -->",
    ''
  );
  for (const q of parsed.quotes) index.push(q);
  for (const c of parsed.comments) index.push(c, '');
  for (const slug of [...groups.keys()].sort()) {
    index.push(`## ${slug}`);
    for (const e of groups.get(slug)) {
      // Drop the leading `[759 item 14 design, 2026-08-29]` provenance tag from the
      // SUMMARY only — the id, item and date columns already carry it, and left in
      // it eats most of a 200-char line. The body keeps the tag verbatim.
      const summary = e.decision.replace(/^\*{0,2}\[[^\]]*\]\s*/, '');
      const prefix = `- ${e.id} [${e.status}]${e.item != null ? ` item ${e.item}` : ''} — `;
      index.push(prefix + clip(firstClause(summary || e.decision), Math.max(8, 200 - prefix.length)));
    }
    index.push('');
  }

  const out = new Map();
  out.set('decisions/_index.md', index.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
  for (const [name, blocks] of files) {
    const prose = parsed.proseBlocks.length && name === 'decisions/durable.md'
      ? ['## Source prose (unattached to any entry)', '', ...parsed.proseBlocks.map((p) => `> (from ${p.heading ?? 'file top'}) ${flatten(p.text)}`), '']
      : [];
    out.set(name, [`# ${name.slice('decisions/'.length)}`, '', ...prose, ...blocks.map((b) => b + '\n')].join('\n').trimEnd() + '\n');
  }
  return { files: out, groups };
}

// ----------------------------------------------------------------------- plan

/** Prefer the live source; fall back to a previous run's `.pre-migration` copy. */
function readSource(dir, base) {
  const live = join(dir, base);
  const kept = `${live}.pre-migration`;
  if (existsSync(live)) return { path: live, text: readFileSync(live, 'utf8'), needsRename: true };
  if (existsSync(kept)) return { path: kept, text: readFileSync(kept, 'utf8'), needsRename: false };
  return null;
}

export function buildPlan(dir) {
  const learningsSrc = readSource(dir, 'learnings.md');
  const decisionsSrc = readSource(dir, 'decisions.md');
  if (!learningsSrc && !decisionsSrc) {
    throw new Error(`no learnings.md or decisions.md (nor .pre-migration copies) under ${dir}`);
  }

  const files = new Map();
  const report = { dir, sourceEntries: 0, migratedEntries: 0 };

  if (learningsSrc) {
    const parsed = parseLearnings(learningsSrc.text);
    const rendered = renderLearnings(parsed);
    for (const [k, v] of rendered.files) files.set(k, v);
    const scratchOut = (rendered.files.get('scratch/run.md')?.match(/^- /gm) ?? []).length;
    report.learnings = {
      source: learningsSrc.path,
      count: parsed.entries.length,
      perFile: rendered.counts,
      scratch: parsed.scratch.length,
      scratchOut,
      unknownTypes: parsed.unknownTypes,
      untagged: parsed.untagged,
      prose: parsed.proseBlocks.length,
      neverStore: Boolean(parsed.neverStore),
      rename: learningsSrc.needsRename ? learningsSrc.path : null,
    };
    report.sourceEntries += parsed.entries.length + parsed.scratch.length;
    report.migratedEntries += Object.values(rendered.counts).reduce((a, b) => a + b, 0) + scratchOut;
  }

  if (decisionsSrc) {
    const registry = buildEpicRegistry(dir, decisionsSrc.text);
    const parsed = parseDecisions(decisionsSrc.text, registry);
    const rendered = renderDecisions(parsed);
    for (const [k, v] of rendered.files) files.set(k, v);
    const perFile = {};
    for (const [name, block] of rendered.files) {
      if (name.endsWith('_index.md')) continue;
      perFile[name] = (block.match(/^### D-/gm) ?? []).length;
    }
    report.decisions = {
      source: decisionsSrc.path,
      count: parsed.entries.length,
      registry: registry.map((r) => `${r.slug} → ${r.key}`),
      perFile,
      durable: parsed.entries.filter((e) => !e.epic).length,
      superseded: parsed.entries.filter((e) => e.status === 'superseded'),
      unsplit: parsed.entries.filter((e) => e.unsplit).length,
      noAlternatives: parsed.entries.filter((e) => !e.alternatives).length,
      routes: parsed.entries.reduce((acc, e) => ({ ...acc, [e.via]: (acc[e.via] ?? 0) + 1 }), {}),
      inherited: parsed.inherited,
      unresolvedTags: [...parsed.unresolvedTags.entries()].sort((a, b) => b[1] - a[1]),
      prose: parsed.proseBlocks.length,
      rename: decisionsSrc.needsRename ? decisionsSrc.path : null,
    };
    report.sourceEntries += parsed.entries.length;
    report.migratedEntries += Object.values(perFile).reduce((a, b) => a + b, 0);
  }

  return { files, report };
}

/**
 * The count gate: every source entry must land in exactly one body file.
 *
 * Its own function because no fixture can induce a mismatch without a bug in the
 * parser — a guard that can only be exercised on the day it matters is a guard
 * nobody has ever seen work. Exported so the suite can drive both branches.
 */
export function reconciliation(report, { dryRun = false } = {}) {
  const ok = report.sourceEntries === report.migratedEntries;
  return {
    ok,
    message: ok
      ? `reconciliation: ${report.sourceEntries} source entries → ${report.migratedEntries} migrated`
      : `RECONCILIATION FAILED — ${report.sourceEntries} source entries but ${report.migratedEntries} ` +
        `migrated. Refusing to ${dryRun ? 'report a plan' : 'write a half-migrated store'}.`,
  };
}

// --------------------------------------------------------------------- output

// memory-gate's INDEX_BUDGET_BYTES — a store this size migrates correctly and
// then owes a consolidation pass; saying so here beats a surprise block later.
const GATE_INDEX_BUDGET = 40 * 1024;

function printReport({ files, report }, { dryRun }) {
  const w = (s) => process.stdout.write(s + '\n');
  w(dryRun ? `PLAN (dry run — nothing written) for ${report.dir}` : `MIGRATED ${report.dir}`);
  w('');

  for (const name of ['learnings/_index.md', 'decisions/_index.md']) {
    const content = files.get(name);
    if (!content) continue;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > GATE_INDEX_BUDGET) {
      w(`⚠ ${name} is ${Math.round(bytes / 1024)}KB — over memory-gate's ${GATE_INDEX_BUDGET / 1024}KB reading budget.`);
      w(`  The migration is lossless either way; the gate will ask for a consolidation pass at the`);
      w(`  next loop stop, which a store this size is genuinely due for (Consolidate/Demote, not delete).`);
    }
  }

  const L = report.learnings;
  if (L) {
    w(`learnings  ${L.count} entries from ${L.source}`);
    for (const [f, n] of Object.entries(L.perFile)) w(`  ${`learnings/${f}`.padEnd(22)} ${n}`);
    w(`  ${'learnings/_index.md'.padEnd(22)} ${L.count} index lines${L.neverStore ? ' (+ "## Never store" verbatim)' : ''}`);
    if (L.scratch) w(`  ${'scratch/run.md'.padEnd(22)} ${L.scratchOut} live scratch entr(ies) from the retired "## Scratch (this run)" section`);
    else w(`  "## Scratch (this run)" was empty — no scratch/run.md written`);
    if (L.unknownTypes.length) {
      w(`  ⚠ ${L.unknownTypes.length} unknown type tag(s), filed as [gotcha]:`);
      for (const u of L.unknownTypes) w(`      [${u.tag}] ${u.text}`);
    }
    if (L.untagged.length) {
      w(`  ⚠ ${L.untagged.length} untagged entr(ies), filed as [gotcha]:`);
      for (const u of L.untagged) w(`      ${u.text}`);
    }
    if (L.prose) w(`  ⚠ ${L.prose} prose block(s) belonging to no entry — preserved under "Source prose" in gotchas.md`);
    w('');
  }

  const D = report.decisions;
  if (D) {
    w(`decisions  ${D.count} entries from ${D.source}`);
    w(`  epic registry: ${D.registry.join(', ') || '(none found)'}`);
    for (const [f, n] of Object.entries(D.perFile).sort()) w(`  ${f.padEnd(46)} ${n}`);
    w(`  ${'decisions/_index.md'.padEnd(46)} ${D.count} index lines`);
    w(`  epic resolved by: ${Object.entries(D.routes).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    w(`  ${D.unsplit} bullet(s) did not split at all → whole text under **Decision:**`);
    w(`  ${D.noAlternatives} bullet(s) name no alternatives → **Alternatives rejected:** (not recorded in source)`);
    if (D.inherited.length) {
      w(`  ⚠ ${D.inherited.length} decision(s) inherited their epic from the preceding bullet (## Item N sections) — VERIFY:`);
      const bySection = new Map();
      for (const i of D.inherited) bySection.set(`${i.heading} → ${i.epic}`, (bySection.get(`${i.heading} → ${i.epic}`) ?? 0) + 1);
      for (const [k, n] of bySection) w(`      ${n}x  ${k}`);
    }
    if (D.unresolvedTags.length) {
      w(`  ⚠ ${D.unresolvedTags.length} leading tag(s) matched no known epic (entries went to durable.md):`);
      w(`      ${D.unresolvedTags.map(([t, n]) => `${t}(${n})`).join(' ')}`);
    }
    if (D.superseded.length) {
      w(`  ⚠ ${D.superseded.length} decision(s) flagged status=superseded — NEED A HUMAN PASS to resolve what supersedes what:`);
      for (const s of D.superseded) w(`      ${s.id}  ${clip(s.decision, 100)}`);
    }
    if (D.prose) w(`  ⚠ ${D.prose} prose block(s) belonging to no entry — preserved under "Source prose" in durable.md`);
    w('');
  }

  w(`files: ${files.size}`);
  w(reconciliation(report, { dryRun }).message);
}

/**
 * Give every `solutions/` entry a stable numeric handle.
 *
 * Identity and name were the same thing: an entry was addressed by its filename,
 * so renaming a slug — which is exactly the fix the hit-rate pass prescribes for
 * a trigger made of abstractions — broke every inbound reference. A real store
 * measured the trap: 65 of 66 entries carry inbound references, 285 in total,
 * and the four renames the store had already scheduled would have broken 33 of
 * them. The cost of the fix was protecting the broken trigger from being fixed.
 *
 * `id:` is the handle and never changes. The slug stays the filename and stays a
 * trigger, free to be rewritten; `aliases:` carries the names it used to have,
 * so the hit-rate pass can still join a renamed entry to its own history.
 *
 * Numbering is deterministic — by `date:` then filename — so two people running
 * this on the same store get the same answer, and a re-run is a no-op.
 */
export function planSolutionIds(dir) {
  const sdir = join(dir, 'solutions');
  let files;
  try { files = readdirSync(sdir).filter((f) => f.endsWith('.md') && f !== '_index.md'); }
  catch { return { assignments: [], taken: new Set(), skipped: [] }; }

  const entries = files.map((f) => {
    const text = readFileSync(join(sdir, f), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const head = fm ? fm[1] : '';
    return {
      file: f,
      text,
      hasFrontmatter: Boolean(fm),
      id: (/^id:\s*(S-\d+)\s*$/m.exec(head) || [])[1] ?? null,
      date: (/^date:\s*(\S+)/m.exec(head) || [])[1] ?? '9999-99-99',
    };
  });

  const taken = new Set(entries.map((e) => e.id).filter(Boolean));
  let next = 1;
  const nextFree = () => {
    while (taken.has(`S-${String(next).padStart(3, '0')}`)) next++;
    const id = `S-${String(next).padStart(3, '0')}`;
    taken.add(id);
    return id;
  };

  const assignments = [];
  const skipped = [];
  for (const e of entries.sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file))) {
    if (e.id) { skipped.push(e); continue; }
    assignments.push({ ...e, id: nextFree() });
  }
  return { assignments, taken, skipped };
}

/** Write `id:` as the first frontmatter key, creating the block when absent. */
function applySolutionIds(dir, assignments) {
  for (const a of assignments) {
    const out = a.hasFrontmatter
      ? a.text.replace(/^---\n/, `---\nid: ${a.id}\n`)
      : `---\nid: ${a.id}\n---\n\n${a.text.replace(/^\n+/, '')}`;
    writeFileSync(join(dir, 'solutions', a.file), out);
  }
}

function main(argv) {
  const args = argv.slice(2);
  const i = args.indexOf('--dir');
  const dir = resolve(i >= 0 && args[i + 1] ? args[i + 1] : '.loop/memory');
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  if (!existsSync(dir)) {
    process.stderr.write(`migrate-memory: no such directory: ${dir}\n`);
    return 1;
  }

  // Orthogonal to the flat→tree migration: solutions/ was never flat, it only
  // lacked handles. Runnable on an already-migrated store, and idempotent.
  if (args.includes('--solutions')) {
    const { assignments, skipped } = planSolutionIds(dir);
    if (!assignments.length) {
      process.stdout.write(`migrate-memory: all ${skipped.length} solution entr${skipped.length === 1 ? 'y has' : 'ies have'} an id — nothing to assign\n`);
      return 0;
    }
    for (const a of assignments) process.stdout.write(`${dryRun ? '(dry-run) ' : ''}${a.id}  ${a.file}\n`);
    if (!dryRun) applySolutionIds(dir, assignments);
    process.stdout.write(
      `${dryRun ? 'would assign' : 'assigned'} ${assignments.length} id(s); ${skipped.length} already had one. ` +
      `The slug stays the filename and stays a trigger — record a rename in \`aliases:\` so the hit-rate pass keeps the entry's history.\n`
    );
    return 0;
  }

  // Only the two generated DIRECTORIES are ever removed and rebuilt. `scratch/run.md`
  // is guarded against but never deleted: an existing one may hold live scratch this
  // run has no replacement for, and scratch/adhoc.md is its untouched sibling.
  const targetDirs = ['learnings', 'decisions'].map((d) => join(dir, d)).filter(existsSync);
  const scratchOut = join(dir, 'scratch', 'run.md');
  const targets = [...targetDirs, ...(existsSync(scratchOut) ? [scratchOut] : [])];
  const migrated = targets.length > 0;
  const sourcesLive = ['learnings.md', 'decisions.md'].some((f) => existsSync(join(dir, f)));

  if (migrated && !sourcesLive && !force && !dryRun) {
    process.stdout.write(`migrate-memory: ${dir} is already migrated (${targets.join(', ')} exist, sources renamed) — nothing to do\n`);
    return 0;
  }
  if (migrated && !force && !dryRun) {
    process.stderr.write(
      `migrate-memory: target tree already exists — ${targets.join(', ')}\n` +
      `  re-run with --force to regenerate it (the generated tree is replaced; sources are never deleted)\n`
    );
    return 1;
  }

  let plan;
  try {
    plan = buildPlan(dir);
  } catch (e) {
    process.stderr.write(`migrate-memory: ${e.message}\n`);
    return 1;
  }

  const counts = reconciliation(plan.report, { dryRun });
  if (!counts.ok) {
    printReport(plan, { dryRun });
    process.stderr.write(`migrate-memory: ${counts.message}\n`);
    return 1;
  }

  if (dryRun) {
    printReport(plan, { dryRun: true });
    process.stdout.write('\nwould write:\n');
    for (const name of [...plan.files.keys()].sort()) process.stdout.write(`  ${join(dir, name)}\n`);
    for (const src of [plan.report.learnings?.rename, plan.report.decisions?.rename].filter(Boolean)) {
      process.stdout.write(`  ${src} → ${src}.pre-migration (renamed, not deleted)\n`);
    }
    return 0;
  }

  const renames = [plan.report.learnings?.rename, plan.report.decisions?.rename].filter(Boolean);
  try {
    for (const t of targetDirs) rmSync(t, { recursive: true, force: true });
    for (const [name, content] of plan.files) {
      const p = join(dir, name);
      mkdirSync(join(p, '..'), { recursive: true });
      // scratch/run.md may hold LIVE scratch a re-run has no replacement for —
      // the guard comment above promises it is never destroyed, so a --force
      // re-migration appends only the source lines it does not already carry
      // instead of overwriting.
      if (name === 'scratch/run.md' && existsSync(p)) {
        const existing = readFileSync(p, 'utf8');
        const have = new Set(existing.split('\n').map((l) => l.trim()));
        const add = content.split('\n').filter((l) => /^-\s+\S/.test(l) && !have.has(l.trim()));
        if (add.length) writeFileSync(p, existing.replace(/\n*$/, '\n') + add.join('\n') + '\n', 'utf8');
        continue;
      }
      writeFileSync(p, content, 'utf8');
    }
    for (const src of renames) renameSync(src, `${src}.pre-migration`);
  } catch (e) {
    process.stderr.write(`migrate-memory: write failed — ${e.message}\n`);
    return 1;
  }

  printReport(plan, { dryRun: false });
  if (renames.length) process.stdout.write('sources renamed to *.pre-migration (kept for diffing, not deleted)\n');
  else process.stdout.write('sources were already *.pre-migration from an earlier run — regenerated in place\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));
