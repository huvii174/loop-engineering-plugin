#!/usr/bin/env node
/**
 * memory-recall — UserPromptSubmit hook.
 *
 * The pull-model gap: slash commands recall memory because their text says to;
 * an ad-hoc prompt ("fix this bug") recalls nothing. This hook is the push:
 * on every user prompt it greps .loop/memory/ for entries whose text shares
 * keywords with the prompt and injects the top matches as context.
 *
 * Deterministic keyword match only — no model, no embeddings, no network.
 * Obeys the loop-memory recall budget (max 5 entries) and its discipline line:
 * memory is supplementary context, current code outranks notes.
 *
 * Silent when: LOOP_HOOKS_OFF=1, no .loop/memory/ in cwd, the prompt is a
 * slash command (commands own their recall), or nothing scores. Fail-open.
 *
 * Honest limitation: keyword grep, not semantics — short or non-English
 * prompts may miss. The SessionStart digest (loop-reminder) covers the gap by
 * telling the model the store exists so it can grep deliberately.
 */

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readStdinJson, hooksOff, readIfExists } from './lib.mjs';

const MAX_ENTRIES = 5;       // loop-memory recall budget
const MAX_LINE_CHARS = 220;
const MAX_KEYWORDS = 16;
const SOLUTION_HEAD_LINES = 25; // frontmatter + title — never the body

// Common English + Vietnamese filler; keywords must be >=4 chars and not here.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been', 'were',
  'will', 'into', 'when', 'what', 'where', 'which', 'then', 'than', 'them',
  'they', 'there', 'here', 'some', 'more', 'only', 'also', 'very', 'just',
  'like', 'make', 'made', 'need', 'needs', 'want', 'please', 'should', 'could',
  'would', 'about', 'after', 'before', 'because', 'does', 'doing', 'done',
  'file', 'files', 'code', 'them', 'their', 'these', 'those', 'update', 'right',
  'hãy', 'của', 'trong', 'không', 'được', 'các', 'cho', 'với', 'này', 'giúp',
  'tôi', 'bạn', 'đang', 'nhưng', 'cũng', 'như', 'vậy', 'thì', 'là', 'và',
]);

function keywords(prompt) {
  const words = String(prompt).toLowerCase().split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

function score(text, kws) {
  const t = text.toLowerCase();
  let s = 0;
  for (const k of kws) if (t.includes(k)) s++;
  return s;
}

function listLines(text) {
  if (!text) return [];
  return text.split('\n').map((l) => l.trim()).filter((l) => /^-\s+\S/.test(l));
}

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();
  const prompt = (input.prompt || '').trim();
  if (!prompt || prompt.startsWith('/')) return 0;

  const memDir = join(cwd, '.loop', 'memory');
  if (!existsSync(memDir)) return 0; // fast path: one stat in .loop-less projects

  const kws = keywords(prompt);
  if (!kws.length) return 0;

  const candidates = [];
  for (const f of ['learnings.md', 'decisions.md', join('scratch', 'adhoc.md')]) {
    for (const line of listLines(readIfExists(join(memDir, f)))) {
      const s = score(line, kws);
      if (s > 0) candidates.push({ s, text: line.slice(0, MAX_LINE_CHARS) });
    }
  }

  let solutionFiles = [];
  try { solutionFiles = readdirSync(join(memDir, 'solutions')).filter((f) => f.endsWith('.md')); } catch { /* no solutions dir */ }
  for (const f of solutionFiles) {
    const head = (readIfExists(join(memDir, 'solutions', f)) || '')
      .split('\n').slice(0, SOLUTION_HEAD_LINES).join('\n');
    const s = score(f + '\n' + head, kws);
    if (s > 0) {
      const title = (head.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
      candidates.push({ s, text: `solutions/${f} — "${title.slice(0, 120)}" (read the file for the full entry)` });
    }
  }

  if (!candidates.length) return 0;
  candidates.sort((a, b) => b.s - a.s);
  const top = candidates.slice(0, MAX_ENTRIES);

  process.stdout.write(
    `[loop-engineering] Auto-recall from .loop/memory/ (${top.length} match${top.length === 1 ? '' : 'es'} for this prompt; ` +
    `supplementary context — current code and command output outrank past notes; ignore what does not apply):\n` +
    top.map((c) => `  ${c.text.startsWith('-') ? c.text : '- ' + c.text}`).join('\n') + '\n'
  );
  return 0;
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
