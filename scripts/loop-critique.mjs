#!/usr/bin/env node
/**
 * loop-critique — the tenth man's verdicts, recorded by code.
 *
 * The plan-critic gate used to end in prose: "copy its Dissent on record line
 * into design.md". The session that wrote the design was also the one that
 * transcribed the critic's verdict — and, when the critic could not be spawned,
 * the one tempted to write a critique of its own design and approve it. A gate
 * the designer can both fill in and grade is not a gate.
 *
 * So the verdict is captured where the designer is not: the agent-track hook
 * calls recordCritique() with the plan-critic's own report — the message it
 * hands back through the SubagentHandback tool (PostToolUse), or its last
 * message on SubagentStop where no hand-back happened. Each round lands in
 * `.loop/critique/r<N>.md`, bound to the run by `run_id`, and the breaker
 * refuses iteration 1 of a goal that owes the critique without an APPROVE
 * there (see tenthManGate in loop-breaker.mjs).
 *
 *   node loop-critique.mjs record   [--dir .loop] [--agent-id <id>] < critic-output.md
 *   node loop-critique.mjs rule     [--dir .loop] [--agent-id <id>] < arbiter-output.md
 *   node loop-critique.mjs status   [--dir .loop] [--json]
 *   node loop-critique.mjs recover  [--dir .loop] [--transcripts <dir>] [--dry-run]   # the hook did not run
 *   node loop-critique.mjs excluded [--dir .loop]          # a REDESIGN's excluded directions
 *   node loop-critique.mjs deferred --epic <slug> [--dir .loop]   # the epic ledger, as loop-findings
 *
 * `record` from the CLI writes `source: relay` — the orchestrating session
 * passing the critic's output through. That is the only route on a host without
 * lifecycle hooks (Codex), and it is weaker than `source: hook` by construction:
 * the breaker counts it only on a run whose state.json says `"host": "codex"`,
 * and the CLI refuses it inside Claude Code (CLAUDECODE=1), where the hook is
 * the route. A record forged with a shell redirect is outside what code can
 * hold; boundary-gate stops the Edit/Write tools, not `cat >`.
 *
 * `recover` is the route when the hook did not run (on Windows a Git Bash that
 * fails to start takes every hook with it): it reads the subagent transcript
 * Claude Code wrote and records with `source: transcript`, which the breaker
 * accepts like `hook` and names in a warning. See recoverFromTranscripts.
 *
 * Every record pins `design_hash` — goal.md plus design.md, the
 * `## Tenth-man dissent` section excluded because Step 2.5 writes it after the
 * APPROVE. An APPROVE whose hash no longer matches judged another design, so it
 * is `stale` and counts as no verdict.
 *
 * Exit codes:
 *   0  recorded / status printed
 *   1  refused — no state.json or run_id, empty input, or a bad argument
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Verdicts the output contract in agents/plan-critic.md allows. */
const VERDICTS = ['APPROVE', 'REVISE', 'REJECT'];

/** Finding severities, most severe first. Any of the first two makes the round a REJECT. */
export const SEVERITIES = ['blocker', 'critical', 'major', 'minor'];
const BLOCKING = new Set(['blocker', 'critical']);

/** Records are written by code; this is the directory boundary-gate protects. */
export const CRITIQUE_DIR = 'critique';

/**
 * Sources whose words never passed through the designer: `hook` (agent-track
 * at the time) and `transcript` (recover, reading the subagent transcript
 * Claude Code wrote, after the hook did not run). `relay` is the session's.
 */
export const CAPTURED_SOURCES = new Set(['hook', 'transcript']);

function sourceLabel(source) {
  return CAPTURED_SOURCES.has(source) ? source : 'relay';
}

/**
 * The verdict a critic's output carries, or null. Reads the contract's
 * `## Verdict: APPROVE | REVISE | REJECT` heading — the first word after `Verdict:`, so
 * "REVISE — would APPROVE once…" is REVISE. The unfilled template, a word
 * followed by `|`, is no verdict.
 */
export function parseVerdict(text) {
  if (verdictHeadings(text).length !== 1) return null;
  const m = /^#{1,6}\s*Verdict:\s*\**\s*([A-Za-z]+)\**\s*(\|?)/im.exec(String(text ?? ''));
  if (!m || m[2]) return null;
  const word = m[1].toUpperCase();
  return VERDICTS.includes(word) ? word : null;
}

/** 1-based numbers of every `Verdict:` heading line. More than one is no verdict, never the first of them. */
export function verdictHeadings(text) {
  return String(text ?? '').split('\n').map((l, i) => (/^#{1,6}\s*Verdict:/i.test(l) ? i + 1 : 0)).filter(Boolean);
}

/**
 * The findings a critic's output carries, classified line by line — a gate
 * reader that skipped a line it did not recognise would count a mislabelled
 * finding as no finding (memory S-003). The region runs from the one `### `
 * heading opening `If REVISE` or `Findings` to the next `### ` or `## `
 * heading. Inside it every line is one of:
 *
 *   blank · finding head `- **Finding N (<severity>):**` · indented sub-line ·
 *   `None` (the contract's line for an APPROVE with nothing to report)
 *
 * and anything else makes the whole output unreadable. A finding-like line in
 * any other shape (indented, missing its severity) is refused before the
 * sub-line kind can take it. A finding head outside
 * the region, two regions, a repeated finding number, or `None` beside a
 * finding is unreadable too. Returns `{ findings: [{ n, severity }], error }`.
 */
export function parseFindings(text) {
  const lines = String(text ?? '').split('\n');
  const isRegionHead = (l) => /^###\s+(If REVISE|Findings)\b/i.test(l);
  const isFindingLike = (l) => /^\s*-\s*\*\*\s*Finding\b/i.test(l);
  const heads = lines.map((l, i) => (isRegionHead(l) ? i : -1)).filter((i) => i >= 0);
  if (heads.length > 1) return { findings: [], error: `two findings sections (lines ${heads.map((i) => i + 1).join(', ')})` };
  let end = lines.length;
  if (heads.length === 1) {
    for (let i = heads[0] + 1; i < lines.length; i++) {
      if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
    }
  }
  const inRegion = (i) => heads.length === 1 && i > heads[0] && i < end;
  const findings = [];
  const seen = new Set();
  let none = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inRegion(i)) {
      if (isFindingLike(line)) return { findings: [], error: `line ${i + 1}: a finding outside the findings section` };
      continue;
    }
    if (line.trim() === '') continue;
    const head = /^- \*\*Finding (\d+) \((blocker|critical|major|minor)\):\*\*/.exec(line);
    if (head) {
      const n = Number(head[1]);
      if (seen.has(n)) return { findings: [], error: `line ${i + 1}: finding ${n} appears twice` };
      seen.add(n);
      findings.push({ n, severity: head[2] });
      continue;
    }
    if (isFindingLike(line)) return { findings: [], error: `line ${i + 1}: a finding head not in the \`- **Finding N (<severity>):**\` shape — ${JSON.stringify(line.slice(0, 60))}` };
    if (/^\s{2,}\S/.test(line)) continue;
    if (line === 'None') { none = true; continue; }
    return { findings: [], error: `line ${i + 1}: not a finding, a sub-line or \`None\` — ${JSON.stringify(line.slice(0, 60))}` };
  }
  if (none && findings.length) return { findings: [], error: '`None` beside a finding' };
  return { findings, error: null };
}

/**
 * What a critic output records as: the effective verdict (REJECT whenever a
 * blocker or critical finding is present — a mislabel rounds up, never down),
 * the declared one when it differs, and the severity counts. A REVISE or
 * REJECT that lists no finding is unreadable: it asks for a change it never
 * names.
 */
export function classifyCritique(text) {
  const declared = parseVerdict(text);
  const { findings, error } = parseFindings(text);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) counts[f.severity]++;
  let verdict;
  let reason = null;
  const headings = verdictHeadings(text);
  if (headings.length > 1) { verdict = 'unreadable'; reason = `${headings.length} Verdict headings (lines ${headings.join(', ')})`; }
  else if (!declared) { verdict = 'unreadable'; reason = 'no `## Verdict: APPROVE|REVISE|REJECT` heading'; }
  else if (error) { verdict = 'unreadable'; reason = error; }
  else if (declared !== 'APPROVE' && findings.length === 0) { verdict = 'unreadable'; reason = `${declared} names no finding`; }
  else verdict = findings.some((f) => BLOCKING.has(f.severity)) ? 'REJECT' : declared;
  return { verdict, declared, reason, findings: verdict === 'unreadable' ? [] : findings, counts };
}

/** `blocker=0 critical=1 major=2 minor=0` — the frontmatter form of a severity count. */
export function formatCounts(counts) {
  return SEVERITIES.map((s) => `${s}=${counts[s] ?? 0}`).join(' ');
}

/** The line a critic's output opens with to name the `.loop/` it judged (worktree runs). */
export function loopDirOf(text) {
  const m = /^\s*Loop:\s*`?([^`\n]+?)`?\s*$/im.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** Drop one `## <heading>` section — up to the next `## ` heading or the end. */
function withoutSection(text, heading) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^## /.test(line)) skipping = line.trim().toLowerCase() === `## ${heading}`.toLowerCase();
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/** What an APPROVE is an approval of: goal.md + design.md, minus the dissent section written after it. */
export function designHash(dir) {
  const read = (name) => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return ''; } };
  const design = withoutSection(read('design.md'), 'Tenth-man dissent').replace(/\s+$/, '');
  return createHash('sha256').update(read('goal.md')).update('\0').update(design).digest('hex').slice(0, 16);
}

/** Frontmatter `key: value` pairs of a record; values are single-line. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** `1=major,2=critical` → [{ n: 1, severity: 'major' }, …]; absent → []; malformed → null (the record is unreadable). */
function parseFindingList(value) {
  if (value === undefined) return [];
  const out = [];
  for (const part of String(value).split(',')) {
    const m = /^(\d+)=(blocker|critical|major|minor)$/.exec(part.trim());
    if (!m) return null;
    out.push({ n: Number(m[1]), severity: m[2] });
  }
  return out;
}

/** Every record on disk for `runId`, oldest round first. */
export function critiqueRecords(dir, runId) {
  const root = join(dir, CRITIQUE_DIR);
  if (!runId || !existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    if (!/^r\d+\.md$/.test(name)) continue;
    let text;
    try { text = readFileSync(join(root, name), 'utf8'); } catch { continue; }
    const fm = frontmatter(text);
    if (fm.run_id !== runId) continue;
    const findings = parseFindingList(fm.findings);
    out.push({
      file: join(CRITIQUE_DIR, name),
      round: Number(fm.round) || Number(name.slice(1, -3)),
      verdict: VERDICTS.includes(fm.verdict) && findings ? fm.verdict : 'unreadable',
      findings: findings ?? [],
      source: fm.source || 'unknown',
      design_hash: fm.design_hash || null,
      recorded: fm.recorded || null,
    });
  }
  return out.sort((a, b) => a.round - b.round);
}

/**
 * Where the run's critique stands. `open_rounds` counts REVISE and REJECT
 * records — the design gate's two-round bound reads it; `revise_rounds` counts
 * REVISE alone and stays for readers that predate REJECT.
 */
export function critiqueStanding(dir, state = readState(dir)) {
  const runId = state?.run_id ?? null;
  const records = critiqueRecords(dir, runId);
  const latest = records[records.length - 1] ?? null;
  const stale = Boolean(latest) && latest.design_hash !== designHash(dir);
  return {
    run_id: runId,
    records,
    latest,
    stale,
    approved: latest?.verdict === 'APPROVE' && !stale,
    revise_rounds: records.filter((r) => r.verdict === 'REVISE').length,
    open_rounds: records.filter((r) => r.verdict === 'REVISE' || r.verdict === 'REJECT').length,
  };
}

/**
 * Write one round. The text is stored verbatim under a frontmatter the writer
 * fills from state, never from the caller — the run it belongs to and its round
 * number are facts on disk, not claims. Returns the record, or `{ error }`.
 */
export function recordCritique(dir, text, { source = 'relay', agentId = null, now = new Date() } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { error: 'empty critic output — nothing to record' };
  const state = readState(dir);
  const runId = state?.run_id;
  if (!runId) return { error: `no run_id in ${join(dir, 'state.json')} — the design gate writes state.json before the critique` };
  const round = critiqueRecords(dir, runId).reduce((n, r) => Math.max(n, r.round), 0) + 1;
  const root = join(dir, CRITIQUE_DIR);
  mkdirSync(root, { recursive: true });
  // A round number already taken by another run's leftover file is skipped,
  // not overwritten: the file name is storage, the frontmatter is the record.
  let n = round;
  while (existsSync(join(root, `r${n}.md`))) n++;
  const c = classifyCritique(body);
  const verdict = c.verdict;
  const head = [
    '---',
    `run_id: ${runId}`,
    `round: ${round}`,
    `verdict: ${verdict}`,
    ...(c.declared && c.declared !== verdict ? [`declared: ${c.declared}`] : []),
    ...(c.reason ? [`unreadable: ${c.reason.replace(/\s+/g, ' ')}`] : []),
    ...(verdict !== 'unreadable' ? [`severities: ${formatCounts(c.counts)}`] : []),
    ...(c.findings.length ? [`findings: ${c.findings.map((f) => `${f.n}=${f.severity}`).join(',')}`] : []),
    `source: ${sourceLabel(source)}`,
    `design_hash: ${designHash(dir)}`,
    ...(agentId ? [`agent_id: ${String(agentId).replace(/\s+/g, '')}`] : []),
    `recorded: ${now.toISOString()}`,
    '---',
    '',
  ].join('\n');
  const file = join(root, `r${n}.md`);
  writeFileSync(file, head + body + '\n');
  return { file, run_id: runId, round, verdict, reason: c.reason };
}

// --------------------------------------------------------- the arbiter's ruling
//
// Under --hands-off no user is there to rule a dispute that outlived two open
// rounds, so a fresh-context tenth-man-arbiter rules each finding of the latest
// open round UPHELD or OVERRULED, with its confirmed severity. The ruling is a
// record like a critic round — written by code, bound to run_id and
// design_hash, in `.loop/critique/a<N>.md` — and its outcome is computed here,
// never taken from the heading: REDESIGN iff a blocker or critical is upheld.
// A PROCEED in an epic is also copied to `<cwd>/.loop/epics/<slug>/rulings/
// <run_id>.md`, the ledger the epic gate's deferred line reads; anything else
// removes that copy, so an abandoned design's PROCEED never reaches the ledger.

/** Rulings the arbiter's output contract allows. */
const RULINGS = ['PROCEED', 'REDESIGN'];

/** A plain id: what a run_id or epic slug must be before it names a path. */
const PLAIN_ID = /^[A-Za-z0-9][\w.-]*$/;

/** 1-based numbers of every `Ruling:` heading line. */
function rulingHeadings(text) {
  return String(text ?? '').split('\n').map((l, i) => (/^#{1,6}\s*Ruling:/i.test(l) ? i + 1 : 0)).filter(Boolean);
}

/** The ruling an arbiter's output declares, or null — exactly one heading, no unfilled template. */
export function parseRulingHeading(text) {
  if (rulingHeadings(text).length !== 1) return null;
  const m = /^#{1,6}\s*Ruling:\s*\**\s*([A-Za-z]+)\**\s*(\|?)/im.exec(String(text ?? ''));
  if (!m || m[2]) return null;
  const word = m[1].toUpperCase();
  return RULINGS.includes(word) ? word : null;
}

/**
 * The ruled lines of an arbiter's output, classified line by line. The region
 * is the one `### Findings ruled` heading up to the next `### ` or `## `.
 * Inside it every line is blank, a ruled line
 * `- r<round>#<N> — UPHELD|OVERRULED — <severity> — <reason>`, or an indented
 * continuation; a ruled-like line in any other shape (indented, a word out of
 * the enum) is refused before the continuation kind can take it. Coverage is
 * checked against `judged` ({ round, findings }): every finding of that round
 * ruled exactly once, no line for another round (`foreign`), no line for a
 * finding the round does not have. Returns `{ ruled, error }`.
 */
export function parseRuled(text, judged) {
  const lines = String(text ?? '').split('\n');
  const isRuledLike = (l) => /^\s*-\s*r\d+\s*#/.test(l);
  const heads = lines.map((l, i) => (/^###\s+Findings ruled\b/i.test(l) ? i : -1)).filter((i) => i >= 0);
  if (heads.length !== 1) return { ruled: [], error: heads.length ? `two \`### Findings ruled\` sections (lines ${heads.map((i) => i + 1).join(', ')})` : 'no `### Findings ruled` section' };
  let end = lines.length;
  for (let i = heads[0] + 1; i < lines.length; i++) if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
  const ruled = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i <= heads[0] || i >= end) {
      if (isRuledLike(line)) return { ruled: [], error: `line ${i + 1}: a ruled line outside \`### Findings ruled\`` };
      continue;
    }
    if (line.trim() === '') continue;
    const m = /^- r(\d+)#(\d+) — (UPHELD|OVERRULED) — (blocker|critical|major|minor) — (\S.*)$/.exec(line);
    if (m) {
      const round = Number(m[1]);
      const n = Number(m[2]);
      if (round !== judged.round) return { ruled: [], error: `line ${i + 1}: rules r${round}#${n}, but the judged round is r${judged.round} (foreign)` };
      if (!judged.findings.some((f) => f.n === n)) return { ruled: [], error: `line ${i + 1}: r${round}#${n} is not a finding of r${judged.round}` };
      if (seen.has(n)) return { ruled: [], error: `line ${i + 1}: r${round}#${n} is ruled twice` };
      seen.add(n);
      ruled.push({ round, n, call: m[3], severity: m[4], reason: m[5].trim() });
      continue;
    }
    if (isRuledLike(line)) return { ruled: [], error: `line ${i + 1}: a ruled line not in the \`- r<round>#<N> — UPHELD|OVERRULED — <severity> — <reason>\` shape — ${JSON.stringify(line.slice(0, 60))}` };
    if (/^\s{2,}\S/.test(line)) continue;
    return { ruled: [], error: `line ${i + 1}: not a ruled line or a continuation — ${JSON.stringify(line.slice(0, 60))}` };
  }
  const missing = judged.findings.filter((f) => !seen.has(f.n)).map((f) => `r${judged.round}#${f.n}`);
  if (missing.length) return { ruled: [], error: `unruled: ${missing.join(', ')}` };
  return { ruled, error: null };
}

/**
 * Does a ruling written on `hash` apply to the design on disk and to the one
 * the open critic round saw? All three must be the same design.
 */
function rulingMatchesRound(hash, open, dir) {
  return Boolean(open) && hash === designHash(dir) && hash === open.design_hash;
}

/** The open critic round a ruling judges: the latest REVISE or REJECT record of the run. */
function judgedRound(dir, runId) {
  const open = critiqueRecords(dir, runId).filter((r) => r.verdict === 'REVISE' || r.verdict === 'REJECT');
  return open[open.length - 1] ?? null;
}

/**
 * What an arbiter output records as. `ruling` is computed from the ruled
 * lines: REDESIGN iff an UPHELD blocker or critical, PROCEED otherwise;
 * `unreadable` when the heading, the region or its coverage fails.
 */
export function classifyRuling(text, judged) {
  const declared = parseRulingHeading(text);
  const headings = rulingHeadings(text);
  const upheld = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  if (headings.length > 1) return { ruling: 'unreadable', declared: null, reason: `${headings.length} Ruling headings (lines ${headings.join(', ')})`, ruled: [], upheld, overruled: 0 };
  if (!declared) return { ruling: 'unreadable', declared: null, reason: 'no `## Ruling: PROCEED|REDESIGN` heading', ruled: [], upheld, overruled: 0 };
  if (!judged) return { ruling: 'unreadable', declared, reason: 'no open critic round (REVISE or REJECT) on record to judge', ruled: [], upheld, overruled: 0 };
  const { ruled, error } = parseRuled(text, judged);
  if (error) return { ruling: 'unreadable', declared, reason: error, ruled: [], upheld, overruled: 0 };
  for (const r of ruled) if (r.call === 'UPHELD') upheld[r.severity]++;
  const ruling = upheld.blocker + upheld.critical > 0 ? 'REDESIGN' : 'PROCEED';
  return { ruling, declared, reason: null, ruled, upheld, overruled: ruled.filter((r) => r.call === 'OVERRULED').length };
}

/** `blocker=0 critical=1 major=2 minor=0` → { blocker: 0, … }; anything else → null. */
function parseCounts(value) {
  const m = /^blocker=(\d+) critical=(\d+) major=(\d+) minor=(\d+)$/.exec(String(value ?? ''));
  return m ? { blocker: Number(m[1]), critical: Number(m[2]), major: Number(m[3]), minor: Number(m[4]) } : null;
}

/** Every ruling record on disk for `runId` (`a<N>.md`, `kind: ruling`), oldest first. */
export function rulingRecords(dir, runId) {
  const root = join(dir, CRITIQUE_DIR);
  if (!runId || !existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    if (!/^a\d+\.md$/.test(name)) continue;
    let text;
    try { text = readFileSync(join(root, name), 'utf8'); } catch { continue; }
    const fm = frontmatter(text);
    if (fm.run_id !== runId || fm.kind !== 'ruling') continue;
    const upheld = parseCounts(fm.upheld);
    const readable = RULINGS.includes(fm.ruling) && upheld;
    out.push({
      file: join(CRITIQUE_DIR, name),
      seq: Number(fm.seq) || Number(name.slice(1, -3)),
      ruling: readable ? fm.ruling : 'unreadable',
      upheld: upheld ?? Object.fromEntries(SEVERITIES.map((s) => [s, 0])),
      judged: fm.judged || null,
      source: fm.source || 'unknown',
      design_hash: fm.design_hash || null,
      recorded: fm.recorded || null,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Where the run's ruling stands: the latest ruling record, and whether it
 * still applies — `stale` when goal.md/design.md changed after it, when a
 * newer open critic round exists than the one it judged, or when the design
 * it ruled on is not the one that critic round saw (an edit between the
 * critic and the arbiter puts a design no critic read past the gate).
 */
export function rulingStanding(dir, state = readState(dir)) {
  const runId = state?.run_id ?? null;
  const records = rulingRecords(dir, runId);
  const latest = records[records.length - 1] ?? null;
  const open = judgedRound(dir, runId);
  const stale = Boolean(latest) && (!rulingMatchesRound(latest.design_hash, open, dir) || latest.judged !== `r${open.round}`);
  return { run_id: runId, records, latest, stale, ruling: latest && !stale ? latest.ruling : null };
}

/** The epic ledger copy of a run's ruling, or null when the slug or run id cannot name a path. */
function ledgerPath(cwd, slug, runId) {
  if (!PLAIN_ID.test(String(slug ?? '')) || !PLAIN_ID.test(String(runId ?? ''))) return null;
  return join(cwd, '.loop', 'epics', slug, 'rulings', `${runId}.md`);
}

/**
 * Write one ruling. Like recordCritique, the frontmatter is filled from state
 * and from the parse, never from the caller. `cwd` is the tree whose epic
 * ledger receives a PROCEED copy — the hook passes its own cwd (the
 * dispatching tree when the arbiter judged a worktree slice); the default is
 * the project the `.loop/` belongs to. Returns the record, or `{ error }`.
 */
export function recordRuling(dir, text, { source = 'relay', agentId = null, now = new Date(), cwd = dirname(dir) } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { error: 'empty arbiter output — nothing to record' };
  const state = readState(dir);
  const runId = state?.run_id;
  if (!runId) return { error: `no run_id in ${join(dir, 'state.json')} — the design gate writes state.json before the critique` };
  const judged = judgedRound(dir, runId);
  const c = classifyRuling(body, judged);
  const seq = rulingRecords(dir, runId).reduce((n, r) => Math.max(n, r.seq), 0) + 1;
  const root = join(dir, CRITIQUE_DIR);
  mkdirSync(root, { recursive: true });
  let n = seq;
  while (existsSync(join(root, `a${n}.md`))) n++;
  const head = [
    '---',
    `run_id: ${runId}`,
    'kind: ruling',
    `seq: ${seq}`,
    `ruling: ${c.ruling}`,
    ...(c.declared && c.declared !== c.ruling ? [`declared: ${c.declared}`] : []),
    ...(c.reason ? [`unreadable: ${c.reason.replace(/\s+/g, ' ')}`] : []),
    `judged: ${judged ? `r${judged.round}` : 'none'}`,
    ...(c.ruling !== 'unreadable' ? [`upheld: ${formatCounts(c.upheld)}`, `overruled: ${c.overruled}`] : []),
    `source: ${sourceLabel(source)}`,
    `design_hash: ${designHash(dir)}`,
    ...(agentId ? [`agent_id: ${String(agentId).replace(/\s+/g, '')}`] : []),
    `recorded: ${now.toISOString()}`,
    '---',
    '',
  ].join('\n');
  const content = head + body + '\n';
  const file = join(root, `a${n}.md`);
  writeFileSync(file, content);
  let ledger = null;
  const copy = state.epic ? ledgerPath(cwd, state.epic, runId) : null;
  // The ledger holds only a PROCEED the breaker would honour: one on the
  // design the judged critic round saw.
  if (copy && c.ruling === 'PROCEED' && rulingMatchesRound(designHash(dir), judged, dir)) {
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, content);
    ledger = copy;
  } else if (copy) {
    try { unlinkSync(copy); } catch { /* none to remove */ }
  }
  return { file, run_id: runId, seq, ruling: c.ruling, reason: c.reason, ledger };
}

/** A ruling file's body: the arbiter's output, below the frontmatter. */
function bodyOf(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/**
 * The epic's deferred findings: every UPHELD major or minor of every PROCEED
 * ruling in `<dir>/epics/<slug>/rulings/`, as one ```loop-findings block in
 * the shape `loop-close.mjs append` takes. A minor travels as a `- major:`
 * line tagged with its severity, because append takes only blocker|major
 * (goal A3). Returns `{ text }` or `{ error }`.
 */
export function deferredFindings(dir, slug) {
  if (!PLAIN_ID.test(String(slug ?? ''))) return { error: `"${slug}" is not an epic slug` };
  const root = join(dir, 'epics', slug, 'rulings');
  const names = existsSync(root) ? readdirSync(root).filter((n) => n.endsWith('.md')).sort() : [];
  const lines = [];
  for (const name of names) {
    const text = readFileSync(join(root, name), 'utf8');
    const fm = frontmatter(text);
    if (fm.kind !== 'ruling' || fm.ruling !== 'PROCEED' || !PLAIN_ID.test(String(fm.run_id ?? ''))) {
      return { error: `${join(root, name)}: not a PROCEED ruling record` };
    }
    const m = /^r(\d+)$/.exec(fm.judged ?? '');
    const found = m ? parseFindingCalls(bodyOf(text), Number(m[1])) : { error: 'no judged round' };
    if (found.error) return { error: `${join(root, name)}: ${found.error}` };
    for (const r of found.ruled) {
      if (r.call !== 'UPHELD' || (r.severity !== 'major' && r.severity !== 'minor')) continue;
      lines.push(`- major: ${r.reason} (tenth-man deferred ${fm.run_id} r${r.round}#${r.n}, ${r.severity})`);
    }
  }
  if (!lines.length) return { text: 'no deferred findings\n' };
  return { text: ['```loop-findings', ...lines, '```', ''].join('\n') };
}

/** The ruled lines of a stored ruling, re-read against the round it judged (its own numbers). */
function parseFindingCalls(body, round) {
  const nums = [...String(body).matchAll(/^- r(\d+)#(\d+) — /gm)].filter((x) => Number(x[1]) === round).map((x) => ({ n: Number(x[2]) }));
  return parseRuled(body, { round, findings: nums });
}

/**
 * The directions a REDESIGN excludes: every UPHELD blocker or critical of the
 * run's latest ruling, quoted, with the record path. Run before
 * `loop-archive.mjs run` moves the stuck run's critique/ away. Returns
 * `{ text }` or `{ error }`.
 */
export function excludedDirections(dir, state = readState(dir)) {
  const s = rulingStanding(dir, state);
  if (!s.latest) return { error: `no ruling recorded for ${s.run_id ?? '(no run_id)'}` };
  if (s.latest.ruling !== 'REDESIGN') return { error: `the latest ruling (${s.latest.file}) is ${s.latest.ruling}, not REDESIGN` };
  const text = readFileSync(join(dir, s.latest.file), 'utf8');
  const m = /^r(\d+)$/.exec(s.latest.judged ?? '');
  const found = m ? parseFindingCalls(bodyOf(text), Number(m[1])) : { error: 'no judged round' };
  if (found.error) return { error: `${s.latest.file}: ${found.error}` };
  const items = found.ruled.filter((r) => r.call === 'UPHELD' && BLOCKING.has(r.severity))
    .map((r) => `- ${r.reason} — critic r${r.round}#${r.n} (${r.severity}), ruled in ${join('.loop', s.latest.file)}`);
  return { text: ['## Excluded directions', '', ...items, ''].join('\n') };
}

// ------------------------------------------------- recovery from a transcript
//
// On Windows Claude Code runs every hook command through Git Bash, and a
// bash.exe that fails to start (MSYS under load, beside a bash status line)
// means agent-track never runs: the critic's report reaches no record, and the
// relay CLI is refused under Claude Code, so the gate stays pending however
// often the critic is re-spawned into the same crash. Claude Code still writes
// the subagent's transcript, `<projects>/<session>/subagents/agent-<id>.jsonl`
// beside `agent-<id>.meta.json`, without any hook. `recover` reads those files
// — code reading the critic's own words, as the hook would have — and records
// each unrecorded, finished plan-critic or arbiter as `source: transcript`.
//
// Two guards keep a recovered record from claiming more than it saw:
//   - it must have finished after goal.md and design.md were last written, so
//     the design_hash stamped on it is the design it read (an older one judged
//     another version, and a run's earlier critics are excluded the same way);
//   - it must have finished after the latest record on disk, so round order is
//     finish order.
// A skipped transcript is listed with its reason; nothing is written for it.

/** The tool a subagent in auto mode delivers its report through. */
export const HANDBACK_TOOL = 'SubagentHandback';

/**
 * What a subagent transcript (JSONL) holds of the report: `handback`, the
 * `message` of the last SubagentHandback tool_use when the agent handed its
 * report back, and `closing`, the last assistant text. Either is '' when absent.
 */
export function transcriptReport(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return { handback: '', closing: '' }; }
  const lines = raw.split('\n');
  let closing = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      if (!closing && typeof content === 'string' && content.trim()) closing = content;
      continue;
    }
    const handback = content.find((c) => c?.type === 'tool_use' && c.name === HANDBACK_TOOL);
    const message = typeof handback?.input?.message === 'string' ? handback.input.message : '';
    if (message.trim()) return { handback: message, closing };
    if (!closing) {
      const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
      if (text.trim()) closing = text;
    }
  }
  return { handback: '', closing };
}

/** `plan-critic`, `loop-engineering:plan-critic` — the namespace varies by install. */
export function isPlanCritic(type) {
  return typeof type === 'string' && /(^|:)plan-critic$/.test(type);
}

/** `tenth-man-arbiter`, `loop-engineering:tenth-man-arbiter`. */
export function isArbiter(type) {
  return typeof type === 'string' && /(^|:)tenth-man-arbiter$/.test(type);
}

/** Claude Code's transcript directory for a project: `<config>/projects/<cwd, every non-alphanumeric as ->`. */
export function defaultTranscriptsRoot(projectDir, env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(config, 'projects', resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-'));
}

/** agent_id of every record already in critique/, whatever run it belongs to. */
function recordedAgentIds(dir) {
  const root = join(dir, CRITIQUE_DIR);
  const ids = new Set();
  if (!existsSync(root)) return ids;
  for (const name of readdirSync(root)) {
    if (!/^[ra]\d+\.md$/.test(name)) continue;
    try {
      const id = frontmatter(readFileSync(join(root, name), 'utf8')).agent_id;
      if (id) ids.add(id);
    } catch { /* unreadable file: not a record of anyone */ }
  }
  return ids;
}

function mtimeOf(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/** Every finished plan-critic / arbiter transcript under `root`, oldest finish first. */
function critiqueTranscripts(root) {
  const out = [];
  let sessions = [];
  try { sessions = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const session of sessions) {
    const sub = join(root, session, 'subagents');
    let names = [];
    try { names = readdirSync(sub); } catch { continue; }
    for (const name of names) {
      const m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(name);
      if (!m) continue;
      let meta;
      try { meta = JSON.parse(readFileSync(join(sub, name), 'utf8')); } catch { continue; }
      const kind = isPlanCritic(meta?.agentType) ? 'critique' : isArbiter(meta?.agentType) ? 'ruling' : null;
      if (!kind) continue;
      const transcript = join(sub, `agent-${m[1]}.jsonl`);
      out.push({ agentId: m[1], kind, session, finished: meta.finished === true, transcript, ended: mtimeOf(transcript) });
    }
  }
  return out.sort((a, b) => a.ended - b.ended);
}

/**
 * Record every finished plan-critic / arbiter whose report no hook recorded.
 * Returns `{ root, recorded: [{ agentId, file, verdict|ruling }], skipped: [{ agentId, why }] }`
 * or `{ error }`. `dryRun` reports what would be recorded and writes nothing.
 */
export function recoverFromTranscripts(dir, { root = defaultTranscriptsRoot(dirname(resolve(dir))), dryRun = false, now = new Date() } = {}) {
  const state = readState(dir);
  if (!state?.run_id) return { error: `no run_id in ${join(dir, 'state.json')}` };
  if (!existsSync(root)) return { error: `no transcript directory at ${root} — pass --transcripts <dir>` };
  const done = recordedAgentIds(dir);
  const designAt = Math.max(mtimeOf(join(dir, 'goal.md')), mtimeOf(join(dir, 'design.md')));
  const latestAt = () => Math.max(0, ...[...critiqueRecords(dir, state.run_id), ...rulingRecords(dir, state.run_id)]
    .map((r) => Date.parse(r.recorded) || 0));
  const recorded = [];
  const skipped = [];
  const here = resolve(dir);
  for (const t of critiqueTranscripts(root)) {
    if (done.has(t.agentId)) continue;
    const skip = (why) => skipped.push({ agentId: t.agentId, kind: t.kind, why });
    if (!t.finished) { skip('still running (meta finished is not true)'); continue; }
    if (t.ended < designAt) { skip('finished before goal.md/design.md were last written — it judged another version'); continue; }
    if (t.ended < latestAt()) { skip('finished before the latest record on disk — recording it now would put rounds out of order'); continue; }
    const report = transcriptReport(t.transcript);
    const text = report.handback || report.closing;
    if (!text.trim()) { skip('the transcript holds no report'); continue; }
    const named = loopDirOf(text);
    if (named && isAbsolute(named) && basename(named) === '.loop' && resolve(named) !== here) {
      skip(`its report names another loop (${named}) — run recover with --dir ${named}`);
      continue;
    }
    if (dryRun) { recorded.push({ agentId: t.agentId, kind: t.kind, file: '(dry run)' }); continue; }
    const r = t.kind === 'critique'
      ? recordCritique(dir, text, { source: 'transcript', agentId: t.agentId, now })
      : recordRuling(dir, text, { source: 'transcript', agentId: t.agentId, now });
    if (r.error) { skip(r.error); continue; }
    done.add(t.agentId);
    recorded.push({ agentId: t.agentId, kind: t.kind, file: r.file, verdict: r.verdict ?? r.ruling });
  }
  return { root, recorded, skipped };
}

// ------------------------------------------------------------------------ main

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function main(argv) {
  const args = argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const dir = get('--dir', '.loop');
  const cmd = args[0];

  if (cmd === 'record') {
    if (process.env.CLAUDECODE === '1') {
      process.stderr.write(
        'loop-critique: refusing a relayed verdict inside Claude Code — there the agent-track hook records ' +
        'the critic from the report it hands back or its last message. Spawn loop-engineering:plan-critic; if the hook is off ' +
        '(LOOP_HOOKS_OFF), turn it on rather than relaying.\n'
      );
      return 1;
    }
    const r = recordCritique(dir, readStdin(), { source: 'relay', agentId: get('--agent-id', null) });
    if (r.error) {
      process.stderr.write(`loop-critique: ${r.error}\n`);
      return 1;
    }
    process.stdout.write(`recorded ${r.file} — round ${r.round}, verdict ${r.verdict}, source relay\n`);
    if (r.verdict === 'unreadable') {
      process.stderr.write(`loop-critique: ${r.reason} — the record is kept, and counts as no verdict\n`);
    }
    return 0;
  }
  if (cmd === 'rule') {
    if (process.env.CLAUDECODE === '1') {
      process.stderr.write(
        'loop-critique: refusing a relayed ruling inside Claude Code — there the agent-track hook records ' +
        'the arbiter from the report it hands back or its last message. Spawn loop-engineering:tenth-man-arbiter.\n'
      );
      return 1;
    }
    const r = recordRuling(dir, readStdin(), { source: 'relay', agentId: get('--agent-id', null) });
    if (r.error) {
      process.stderr.write(`loop-critique: ${r.error}\n`);
      return 1;
    }
    process.stdout.write(`recorded ${r.file} — ruling ${r.ruling}, source relay${r.ledger ? `, ledger ${r.ledger}` : ''}\n`);
    if (r.ruling === 'unreadable') process.stderr.write(`loop-critique: ${r.reason} — the record is kept, and counts as no ruling\n`);
    return 0;
  }
  if (cmd === 'recover') {
    const r = recoverFromTranscripts(dir, { root: get('--transcripts', undefined) ?? defaultTranscriptsRoot(dirname(resolve(dir))), dryRun: args.includes('--dry-run') });
    if (r.error) {
      process.stderr.write(`loop-critique: ${r.error}\n`);
      return 1;
    }
    for (const x of r.recorded) process.stdout.write(`recorded ${x.file} — ${x.kind} from agent ${x.agentId}${x.verdict ? `, ${x.verdict}` : ''}, source transcript\n`);
    for (const x of r.skipped) process.stdout.write(`skipped agent ${x.agentId} (${x.kind}): ${x.why}\n`);
    if (!r.recorded.length && !r.skipped.length) process.stdout.write(`nothing to recover under ${r.root}\n`);
    return 0;
  }
  if (cmd === 'excluded' || cmd === 'deferred') {
    let r;
    if (cmd === 'excluded') r = excludedDirections(dir);
    else {
      const slug = get('--epic', null);
      r = slug ? deferredFindings(dir, slug) : { error: 'deferred needs --epic <slug>' };
    }
    if (r.error) {
      process.stderr.write(`loop-critique: ${r.error}\n`);
      return 1;
    }
    process.stdout.write(r.text);
    return 0;
  }
  if (cmd === 'status') {
    const s = critiqueStanding(dir);
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    } else if (!s.records.length) {
      process.stdout.write(`tenth man: no verdict recorded for ${s.run_id ?? '(no run_id)'}\n`);
    } else {
      for (const r of s.records) process.stdout.write(`round ${r.round}: ${r.verdict} (${r.source}) — ${r.file}\n`);
    }
    return 0;
  }
  process.stderr.write('usage: loop-critique.mjs record|rule|status|excluded [--dir .loop] [--json] [--agent-id <id>] | recover [--dir .loop] [--transcripts <dir>] [--dry-run] | deferred --epic <slug> [--dir .loop]\n');
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exit(main(process.argv));
