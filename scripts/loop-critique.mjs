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
 * calls recordCritique() on SubagentStop of a plan-critic, with the agent's own
 * last message. Each round lands in `.loop/critique/r<N>.md`, bound to the run
 * by `run_id`, and the breaker refuses iteration 1 of a goal that owes the
 * critique without an APPROVE there (see tenthManGate in loop-breaker.mjs).
 *
 *   node loop-critique.mjs record [--dir .loop] [--agent-id <id>] < critic-output.md
 *   node loop-critique.mjs status [--dir .loop] [--json]
 *
 * `record` from the CLI writes `source: relay` — the orchestrating session
 * passing the critic's output through. That is the only route on a host without
 * lifecycle hooks (Codex), and it is weaker than `source: hook` by construction:
 * the breaker counts it only on a run whose state.json says `"host": "codex"`,
 * and the CLI refuses it inside Claude Code (CLAUDECODE=1), where the hook is
 * the route. A record forged with a shell redirect is outside what code can
 * hold; boundary-gate stops the Edit/Write tools, not `cat >`.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Verdicts the output contract in agents/plan-critic.md allows. */
const VERDICTS = ['APPROVE', 'REVISE'];

/** Records are written by code; this is the directory boundary-gate protects. */
export const CRITIQUE_DIR = 'critique';

/**
 * The verdict a critic's output carries, or null. Reads the contract's
 * `## Verdict: APPROVE | REVISE` heading — the first word after `Verdict:`, so
 * "REVISE — would APPROVE once…" is REVISE. The unfilled template, a word
 * followed by `|`, is no verdict.
 */
export function parseVerdict(text) {
  const m = /^#{1,6}\s*Verdict:\s*\**\s*([A-Za-z]+)\**\s*(\|?)/im.exec(String(text ?? ''));
  if (!m || m[2]) return null;
  const word = m[1].toUpperCase();
  return VERDICTS.includes(word) ? word : null;
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
    out.push({
      file: join(CRITIQUE_DIR, name),
      round: Number(fm.round) || Number(name.slice(1, -3)),
      verdict: VERDICTS.includes(fm.verdict) ? fm.verdict : 'unreadable',
      source: fm.source || 'unknown',
      design_hash: fm.design_hash || null,
      recorded: fm.recorded || null,
    });
  }
  return out.sort((a, b) => a.round - b.round);
}

/**
 * Where the run's critique stands. `revise_rounds` counts REVISE records — the
 * design gate's two-round bound reads it, and the runner stops on it under
 * --hands-off, where no user is present to rule.
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
  const verdict = parseVerdict(body) ?? 'unreadable';
  const head = [
    '---',
    `run_id: ${runId}`,
    `round: ${round}`,
    `verdict: ${verdict}`,
    `source: ${source === 'hook' ? 'hook' : 'relay'}`,
    `design_hash: ${designHash(dir)}`,
    ...(agentId ? [`agent_id: ${String(agentId).replace(/\s+/g, '')}`] : []),
    `recorded: ${now.toISOString()}`,
    '---',
    '',
  ].join('\n');
  const file = join(root, `r${n}.md`);
  writeFileSync(file, head + body + '\n');
  return { file, run_id: runId, round, verdict };
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
        'the critic from its own last message. Spawn loop-engineering:plan-critic; if the hook is off ' +
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
      process.stderr.write('loop-critique: no `## Verdict: APPROVE|REVISE` heading — the record is kept, and counts as no verdict\n');
    }
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
  process.stderr.write('usage: loop-critique.mjs record|status [--dir .loop] [--json] [--agent-id <id>]\n');
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exit(main(process.argv));
