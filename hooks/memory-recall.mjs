#!/usr/bin/env node
/**
 * memory-recall — UserPromptSubmit hook.
 *
 * The pull-model gap: slash commands recall memory because their text says to;
 * an ad-hoc prompt ("fix this bug") recalls nothing. This hook is the push:
 * on every user prompt it greps .loop/memory/ for entries whose text shares
 * keywords with the prompt and injects the top matches as context.
 *
 * Two injection strengths, because a pointer the model does not follow is a
 * recall that did not happen:
 *   - strong match  -> the entry's BODY is inlined, so there is nothing to follow
 *   - weaker match  -> the trigger line plus the exact grep that opens the body
 *
 * Reads the index/body layout (learnings/_index.md, decisions/_index.md) and
 * falls back to the flat layout (learnings.md, decisions.md) for stores that
 * have not migrated. Deterministic keyword match only — no model, no embeddings,
 * no network. Obeys the loop-memory recall budget (max 5 entries) and its
 * discipline line: memory is supplementary context, current code outranks notes.
 *
 * Injected IDs are appended to .loop/.recall-log, which is what the iteration
 * record's `Recall:` line is checked against. The log lives OUTSIDE .loop/memory/
 * so that writing it can never make the store look "touched" to memory-gate.
 *
 * Silent when: LOOP_HOOKS_OFF=1, no .loop/memory/ in cwd, the prompt is a
 * slash command (commands own their recall), or nothing scores. Fail-open.
 *
 * Honest limitation: keyword match, not semantics. The SessionStart digest
 * (loop-reminder) covers the gap by telling the model the store exists so it can
 * grep deliberately.
 */

import { join, relative } from 'node:path';
import { existsSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { readStdinJson, hooksOff, readIfExists } from './lib.mjs';

const MAX_ENTRIES = 5;          // loop-memory recall budget
const MAX_INLINE = 2;           // entries whose body is inlined rather than pointed at
const INLINE_MIN_SCORE = 2;     // below this a match is too weak to spend a body on
const MAX_BODY_CHARS = 1500;    // per inlined body
const MAX_LINE_CHARS = 220;
const MAX_KEYWORDS = 16;
const SOLUTION_HEAD_LINES = 25; // frontmatter + title — never the body
const RECALL_LOG_MAX_LINES = 500;

// Common English + Vietnamese filler. Keywords must clear MIN_KEYWORD_LEN and
// not appear here.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been', 'were',
  'will', 'into', 'when', 'what', 'where', 'which', 'then', 'than', 'them',
  'they', 'there', 'here', 'some', 'more', 'only', 'also', 'very', 'just',
  'like', 'make', 'made', 'need', 'needs', 'want', 'please', 'should', 'could',
  'would', 'about', 'after', 'before', 'because', 'does', 'doing', 'done',
  'file', 'files', 'code', 'their', 'these', 'those', 'update', 'right',
  'hãy', 'của', 'trong', 'không', 'được', 'các', 'cho', 'với', 'này', 'giúp',
  'tôi', 'bạn', 'đang', 'nhưng', 'cũng', 'như', 'vậy', 'thì', 'là', 'và',
  'một', 'có', 'thể', 'nào', 'gì', 'lại', 'nữa', 'rồi', 'khi', 'để',
  'chúng', 'ta', 'ở', 'từ', 'hay', 'hoặc', 'vì', 'nên', 'phải', 'đó',
  'nếu', 'sẽ', 'đã', 'còn', 'mà', 'ai', 'ra', 'vào', 'trên', 'dưới',
]);

/**
 * Minimum keyword length is 3, not 4: at 4 the filter drops both halves of this
 * plugin's actual traffic — technical acronyms that are the sharpest possible
 * match (`ssl`, `api`, `dom`, `css`, `git`) and most Vietnamese syllables, which
 * left non-English prompts recalling almost nothing. Three-character keywords
 * match on a word boundary instead of as a bare substring, which is what keeps
 * `api` out of `rapid`.
 */
const MIN_KEYWORD_LEN = 3;

export function keywords(prompt) {
  const words = String(prompt).toLowerCase().split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= MIN_KEYWORD_LEN && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

/** A keyword matching more than this share of index lines discriminates nothing. */
const MAX_DOCUMENT_FREQUENCY = 0.15;

/**
 * Drop the keywords this particular store cannot tell entries apart with.
 *
 * `score()` counts matches, so a prompt's common words decide the ranking: in a
 * real store one entry — a "Not fixed (minor)" note about a window query in
 * `document_instances.py` — took 34 of 127 injections, 27% of every recall
 * budget, because "document", "status" and "query" appear in most backend
 * triggers. It arrived inlined, spending a body, on runs about generators and
 * Temporal workers.
 *
 * The store computes its own stopwords rather than carrying a hand-written list:
 * what is generic is a property of this index, not of English. Everything is
 * dropped only if that would leave nothing — a weak ranking beats no recall.
 */
export function discriminating(kws, indexLines) {
  if (!indexLines.length) return kws;
  const limit = Math.max(1, Math.floor(indexLines.length * MAX_DOCUMENT_FREQUENCY));
  const kept = kws.filter((k) => indexLines.filter((l) => score(l, [k])).length <= limit);
  return kept.length ? kept : kws;
}

/**
 * The `[area]` half of a trigger's `[type][area]` tag.
 *
 * Used to gate inlining, not matching: an entry may still be listed as a pointer
 * on a weak match, but spending one of two body slots asks that the prompt be
 * about the same subsystem. `L-315` carried an explicit "ONLY when editing
 * document_instances.py" prefix and over-matched anyway — a prefix is prose, and
 * keyword matching does not read it. The tag is the structured half.
 */
export function areaOf(line) {
  const m = /\[[^\]]+\]\[([^\]]+)\]/.exec(String(line));
  return m ? m[1].toLowerCase() : null;
}

/** Does the prompt name this entry's area, whole or in one of its parts? */
function areaMatches(area, kws) {
  if (!area) return true; // untagged entries keep the old behaviour
  const parts = [area, ...area.split(/[-_/]/)].filter((p) => p.length >= MIN_KEYWORD_LEN + 1);
  return parts.some((p) => kws.some((k) => p.includes(k) || k.includes(p)));
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function score(text, kws) {
  const t = text.toLowerCase();
  let s = 0;
  for (const k of kws) {
    if (k.length > MIN_KEYWORD_LEN) { if (t.includes(k)) s++; }
    else if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(k)}(?![\\p{L}\\p{N}])`, 'u').test(t)) s++;
  }
  return s;
}

/**
 * List items, joining hand-wrapped continuation lines into one logical entry.
 *
 * An entry stays open only until a blank line, a heading, or unindented prose —
 * without that bound, the indented tail of an HTML comment block (every index
 * file carries one) gets absorbed into whatever bullet preceded it, and the
 * comment's own words then match prompts on the polluted entry's behalf.
 */
export function listLines(text) {
  if (!text) return [];
  const out = [];
  let open = false;
  let inComment = false;
  for (const raw of text.split('\n')) {
    if (inComment) { inComment = !raw.includes('-->'); continue; }
    if (/^\s*<!--/.test(raw)) { inComment = !raw.includes('-->'); open = false; continue; }
    if (!raw.trim()) { open = false; continue; }
    if (/^\s*-\s+\S/.test(raw)) { out.push(raw.trim()); open = true; continue; }
    if (/^\s*#/.test(raw)) { open = false; continue; }
    if (open && /^\s+\S/.test(raw)) { out[out.length - 1] += ' ' + raw.trim(); continue; }
    open = false;
  }
  return out;
}

/** `- L-042 [gotcha][x] trigger…` → "L-042". Null for an untagged legacy bullet. */
export function entryId(line) {
  const m = /^-\s*((?:L|D)-[A-Za-z0-9-]*\d)\b/.exec(line);
  return m ? m[1] : null;
}

/** Every trigger line in the store's indexes — the corpus document frequency is measured over. */
function indexLines(memDir) {
  const out = [];
  for (const root of ['learnings', 'decisions']) {
    const idx = readIfExists(join(memDir, root, '_index.md'));
    if (idx !== null) out.push(...listLines(idx));
  }
  return out;
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

/**
 * The body under `### <id>`, up to the next `###` or EOF. Searched rather than
 * derived from the tag so a body stays reachable if it is filed off-convention.
 */
export function findBody(memDir, id) {
  for (const root of ['learnings', 'decisions']) {
    for (const p of walkMd(join(memDir, root))) {
      const text = readIfExists(p);
      if (!text) continue;
      const re = new RegExp(`^###\\s+${escapeRe(id)}\\b.*$`, 'm');
      const m = re.exec(text);
      if (!m) continue;
      const rest = text.slice(m.index + m[0].length);
      const next = rest.search(/^###\s+/m);
      const body = (next === -1 ? rest : rest.slice(0, next)).trim();
      return { file: p, heading: m[0].trim(), body };
    }
  }
  return null;
}

/**
 * Roots served by an index; the rest fall back to their flat file, per root.
 *
 * An index with no ID-bearing entries beside a still-present flat file is the
 * scaffolded-over-legacy mistake (migration renames the flat file away, so the
 * two never legitimately coexist): the empty index must not silence the store,
 * so that root falls back to the flat file until migration runs.
 */
function collectIndexed(memDir, kws, out) {
  const indexed = new Set();
  for (const root of ['learnings', 'decisions']) {
    const idx = readIfExists(join(memDir, root, '_index.md'));
    if (idx === null) continue;
    const lines = listLines(idx);
    if (!lines.some((l) => entryId(l)) && existsSync(join(memDir, `${root}.md`))) continue;
    indexed.add(root);
    for (const line of lines) {
      const s = score(line, kws);
      if (s > 0) out.push({ s, text: line.slice(0, MAX_LINE_CHARS), id: entryId(line), root, area: areaOf(line) });
    }
  }
  return indexed;
}

function collectFlat(memDir, kws, out, indexed) {
  for (const root of ['learnings', 'decisions']) {
    if (indexed.has(root)) continue; // its index is authoritative
    for (const line of listLines(readIfExists(join(memDir, `${root}.md`)))) {
      const s = score(line, kws);
      if (s > 0) out.push({ s, text: line.slice(0, MAX_LINE_CHARS), id: null });
    }
  }
}

function collectScratch(memDir, kws, out) {
  for (const f of ['adhoc.md', 'run.md']) {
    for (const line of listLines(readIfExists(join(memDir, 'scratch', f)))) {
      const s = score(line, kws);
      if (s > 0) out.push({ s, text: line.slice(0, MAX_LINE_CHARS), id: null });
    }
  }
}

/**
 * Solution entries, carrying an ID so they reach the recall accounting.
 *
 * They used to be logged as `id: null`, which `logRecall` filters out — so the
 * store's deepest tier was injected, spent one of five budget slots, and left no
 * trace for the verifier's check 7 or the hit-rate pass to read. The real store
 * recorded the consequence itself: four entries whose slugs are pure
 * abstractions were "injected on nearly every prompt of a generator/Jinja/
 * Temporal run they had nothing to do with, and were dismissed every time" —
 * a pattern the hit-rate pass can only find once the dismissals are attributable.
 *
 * The ID is `S:<slug>`, which is what the iteration records already write by
 * hand (`[[a-comment-that-outlived-its-truth]] applied`), so nothing has to be
 * renumbered for the accounting to close.
 */
function collectSolutions(memDir, kws, out) {
  let files = [];
  try { files = readdirSync(join(memDir, 'solutions')).filter((f) => f.endsWith('.md') && f !== '_index.md'); } catch { return; }
  for (const f of files) {
    const head = (readIfExists(join(memDir, 'solutions', f)) || '')
      .split('\n').slice(0, SOLUTION_HEAD_LINES).join('\n');
    const s = score(f + '\n' + head, kws);
    if (s > 0) {
      const title = (head.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
      const slug = f.replace(/\.md$/, '');
      out.push({
        s, id: `S:${slug}`, solution: f, area: (/^area:\s*(.+)$/m.exec(head) || [])[1]?.toLowerCase() ?? null,
        text: `solutions/${f} — "${title.slice(0, 120)}"`,
      });
    }
  }
}

/**
 * IDs recent records dismissed for the same reason, over and over.
 *
 * The contract's hit-rate pass reads exactly this and rewrites the trigger — but
 * it runs once per memory run, and between those the same entry keeps arriving.
 * Demoting a repeatedly-dismissed ID to a pointer costs it its body slot without
 * hiding it, so a genuinely relevant recurrence is still on the page.
 */
const DISMISSAL_WINDOW = 10;   // most recent iteration records read
const DISMISSAL_LIMIT = 3;     // dismissals before an ID loses its body slot

function repeatedlyDismissed(cwd) {
  const dir = join(cwd, '.loop', 'iterations');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(-DISMISSAL_WINDOW); }
  catch { return new Set(); }
  const counts = new Map();
  for (const f of files) {
    const text = readIfExists(join(dir, f));
    if (!text) continue;
    const line = /^\s*[-*]?\s*\*{0,2}Recall\*{0,2}\s*:(.*(?:\n(?![-*]\s|\s*#).*)*)/im.exec(text);
    if (!line) continue;
    // "L-315 dismissed", "`false-green-evidence` dismissed", "[[slug]] dismissed"
    for (const m of line[1].matchAll(/([A-Za-z][\w:-]{2,})[`\]\s]*\s+dismissed/gi)) {
      const id = m[1].replace(/^\[+|\]+$/g, '');
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, n]) => n >= DISMISSAL_LIMIT).map(([id]) => id));
}

/** Append injected IDs so the run's `Recall:` line can be checked against them. */
function logRecall(cwd, injected) {
  const ids = injected.filter((c) => c.id).map((c) => ({ id: c.id, mode: c.inlined ? 'inlined' : 'pointer', s: c.s }));
  if (!ids.length) return;
  const p = join(cwd, '.loop', '.recall-log');
  try {
    const stamp = new Date().toISOString();
    appendFileSync(p, ids.map((r) => `${stamp}\t${r.id}\t${r.s}\t${r.mode}`).join('\n') + '\n');
    const all = (readIfExists(p) || '').split('\n').filter(Boolean);
    if (all.length > RECALL_LOG_MAX_LINES) {
      writeFileSync(p, all.slice(-RECALL_LOG_MAX_LINES).join('\n') + '\n');
    }
  } catch { /* logging is best-effort; never block a prompt */ }
}

/** One leading `- `, whatever the source line carried. */
function bullet(text) {
  return `- ${String(text).replace(/^-\s*/, '')}`;
}

function render(memDir, cwd, top, kws, dismissed) {
  const lines = [];
  let inlined = 0;

  for (const c of top) {
    if (c.solution) {
      lines.push(`${bullet(c.text)} — read the file for the full entry`);
      continue;
    }
    lines.push(bullet(c.text));
    if (!c.id) continue;

    // A body slot is spent on a match that is strong, or merely at the
    // threshold but about the same subsystem. The area tag breaks the tie
    // rather than ruling — a prompt can be squarely about an entry without
    // ever naming its `[area]`, and a clearly strong match stands on its own.
    // An ID recent records keep dismissing loses the slot either way.
    const strong = c.s > INLINE_MIN_SCORE || areaMatches(c.area, kws);
    const eligible = inlined < MAX_INLINE
      && c.s >= INLINE_MIN_SCORE
      && strong
      && !dismissed.has(c.id)
      && !dismissed.has(String(c.id).replace(/^S:/, ''));
    const body = eligible ? findBody(memDir, c.id) : null;
    if (body) {
      inlined++;
      c.inlined = true;
      const text = body.body.length > MAX_BODY_CHARS
        ? body.body.slice(0, MAX_BODY_CHARS) + ' …(truncated — read the file)'
        : body.body;
      lines.push(`  ${body.heading}  [${relative(cwd, body.file)}]`);
      for (const l of text.split('\n')) lines.push(`  ${l}`);
    } else {
      lines.push(`  body: grep -rA 20 '^### ${c.id}' .loop/memory/${c.root}/`);
    }
  }
  return lines.join('\n');
}

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();
  const prompt = (input.prompt || '').trim();
  if (!prompt || prompt.startsWith('/')) return 0;

  const memDir = join(cwd, '.loop', 'memory');
  if (!existsSync(memDir)) return 0; // fast path: one stat in .loop-less projects

  let kws = keywords(prompt);
  if (!kws.length) return 0;
  kws = discriminating(kws, indexLines(memDir));

  const candidates = [];
  collectFlat(memDir, kws, candidates, collectIndexed(memDir, kws, candidates));
  collectScratch(memDir, kws, candidates);
  collectSolutions(memDir, kws, candidates);

  if (!candidates.length) return 0;
  candidates.sort((a, b) => b.s - a.s);
  const top = candidates.slice(0, MAX_ENTRIES);

  const rendered = render(memDir, cwd, top, kws, repeatedlyDismissed(cwd));
  logRecall(cwd, top);

  process.stdout.write(
    `[loop-engineering] Auto-recall from .loop/memory/ (${top.length} match${top.length === 1 ? '' : 'es'} for this prompt; ` +
    `supplementary context — current code and command output outrank past notes; ignore what does not apply).\n` +
    `Account for each ID below in this iteration's \`Recall:\` line as applied or dismissed-with-reason:\n` +
    rendered + '\n'
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}
