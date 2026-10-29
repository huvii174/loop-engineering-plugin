#!/usr/bin/env node
/**
 * Fixture tests for loop-critique. Run: node scripts/test-loop-critique.mjs
 * Exits 0 when every check passes, 1 otherwise. No dependencies.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { critiqueStanding, loopDirOf, parseVerdict, recordCritique } from './loop-critique.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'loop-critique.mjs');
const BREAKER = join(dirname(fileURLToPath(import.meta.url)), 'loop-breaker.mjs');
const NO_CC = { ...process.env, CLAUDECODE: '' };
const APPROVE = '## Verdict: APPROVE\n\n### Attacks mounted\n1. x — grep — SURVIVED\n\n### Dissent on record\nthe cache key\n';
const REVISE = '## Verdict: REVISE\n\n### If REVISE — findings\n- **Finding 1:** y\n';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : ` (${detail})`}`);
}

function project(state = { run_id: 'run-a', tier: 'medium', iteration: 0, history: [] }) {
  const root = mkdtempSync(join(tmpdir(), 'loop-critique-'));
  const dir = join(root, '.loop');
  mkdirSync(dir, { recursive: true });
  if (state) writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return { root, dir };
}

// ---------------------------------------------------------------- parseVerdict
check('parseVerdict: APPROVE heading', parseVerdict(APPROVE) === 'APPROVE');
check('parseVerdict: REVISE heading, lower case and bold tolerated', parseVerdict('### verdict: **revise**') === 'REVISE');
check('parseVerdict: the unfilled template is no verdict', parseVerdict('## Verdict: APPROVE | REVISE') === null);
check('parseVerdict: a verdict outside the contract is no verdict', parseVerdict('## Verdict: LGTM') === null);
check('parseVerdict: prose mentioning approve is no verdict', parseVerdict('I would approve this design.') === null);
check('parseVerdict: the first word decides — "REVISE — would APPROVE once…" is REVISE',
  parseVerdict('## Verdict: REVISE — would APPROVE once finding 1 is fixed') === 'REVISE');
check('loopDirOf: reads the opening `Loop:` line', loopDirOf('Loop: `/w/slice/.loop`\n## Verdict: APPROVE') === '/w/slice/.loop');

// ------------------------------------------------------------ record + standing
{
  const { root, dir } = project();
  const s0 = critiqueStanding(dir);
  check('standing: nothing recorded → no latest, not approved', !s0.latest && !s0.approved && s0.records.length === 0);

  const r1 = recordCritique(dir, REVISE, { source: 'hook', agentId: 'a1', now: new Date('2026-10-29T00:00:00Z') });
  const r2 = recordCritique(dir, APPROVE, { source: 'hook', agentId: 'a2' });
  const s = critiqueStanding(dir);
  check('record: rounds number themselves from disk', r1.round === 1 && r2.round === 2, JSON.stringify([r1, r2]));
  check('standing: latest APPROVE after a REVISE is approved, one revise round',
    s.approved && s.latest.round === 2 && s.revise_rounds === 1 && s.latest.source === 'hook', JSON.stringify(s));
  const text = readFileSync(r1.file, 'utf8');
  check('record: the critic output is stored verbatim under the frontmatter',
    text.includes('run_id: run-a') && text.includes('agent_id: a1') && text.endsWith(REVISE.trim() + '\n'));

  // The next goal's state: run-a's records must not count for run-b.
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ run_id: 'run-b', tier: 'medium', iteration: 0, history: [] }));
  const sb = critiqueStanding(dir);
  check('standing: another run_id’s APPROVE does not count', !sb.approved && sb.records.length === 0);
  const rb = recordCritique(dir, APPROVE, { source: 'relay' });
  check('record: a leftover file name is skipped, not overwritten',
    rb.round === 1 && rb.file.endsWith('r3.md') && readFileSync(r1.file, 'utf8') === text, rb.file);
  check('standing: relay source is carried through', critiqueStanding(dir).latest.source === 'relay');
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, dir } = project();
  const r = recordCritique(dir, 'the critic ran out of turns', { source: 'hook' });
  check('record: output without a verdict heading is kept as unreadable', r.verdict === 'unreadable' && !critiqueStanding(dir).approved);
  check('record: empty output is refused', Boolean(recordCritique(dir, '   ').error));
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, dir } = project(null);
  check('record: no state.json is refused', Boolean(recordCritique(dir, APPROVE).error));
  rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------------------ CLI
{
  const { root, dir } = project();
  const refused = spawnSync(process.execPath, [SCRIPT, 'record', '--dir', dir], { input: APPROVE, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' } });
  check('cli record: refused inside Claude Code, where the hook is the route', refused.status === 1 && /agent-track/.test(refused.stderr));
  const rec = spawnSync(process.execPath, [SCRIPT, 'record', '--dir', dir], { input: APPROVE, encoding: 'utf8', env: NO_CC });
  check('cli record: exit 0, source relay', rec.status === 0 && /source relay/.test(rec.stdout), rec.stderr);
  const st = spawnSync(process.execPath, [SCRIPT, 'status', '--dir', dir, '--json'], { encoding: 'utf8' });
  check('cli status --json: approved', st.status === 0 && JSON.parse(st.stdout).approved === true, st.stderr);
  const bad = spawnSync(process.execPath, [SCRIPT, 'record', '--dir', dir], { input: '', encoding: 'utf8', env: NO_CC });
  check('cli record: empty stdin exits 1', bad.status === 1);
  const none = spawnSync(process.execPath, [SCRIPT, 'frobnicate'], { encoding: 'utf8' });
  check('cli: unknown subcommand exits 1 with usage', none.status === 1 && /usage/.test(none.stderr));
  rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------- breaker against real disk
{
  const { root, dir } = project();
  const breaker = () => spawnSync(process.execPath, [BREAKER, '--state', join(dir, 'state.json'), '--json'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'goal.md'), '# Goal\nG\n');
  writeFileSync(join(dir, 'design.md'), '# Design\nD\n');
  check('breaker on disk: no record → exit 1 tenth-man', breaker().status === 1);
  recordCritique(dir, APPROVE, { source: 'hook' });
  check('breaker on disk: a hook APPROVE → exit 0', breaker().status === 0, breaker().stdout);
  writeFileSync(join(dir, 'design.md'), '# Design\nD\n\n## Tenth-man dissent\nthe cache key (critique/r1.md)\n');
  check('breaker on disk: quoting the dissent into design.md keeps the APPROVE', breaker().status === 0);
  writeFileSync(join(dir, 'design.md'), '# Design\nD, quietly widened\n');
  const stale = breaker();
  check('breaker on disk: editing the design after the APPROVE makes it stale', stale.status === 1 && /design_hash/.test(stale.stdout), stale.stdout);
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, dir } = project({ run_id: 'run-r', tier: 'medium', iteration: 0, tenth_man_ruling: 'D-077', history: [] });
  const breaker = () => spawnSync(process.execPath, [BREAKER, '--state', join(dir, 'state.json'), '--json'], { encoding: 'utf8' });
  recordCritique(dir, REVISE, { source: 'hook', now: new Date(Date.now() - 60_000) });
  recordCritique(dir, REVISE, { source: 'hook', now: new Date(Date.now() - 30_000) });
  check('breaker on disk: two REVISE and a ruling ID with no decision → exit 1', breaker().status === 1);
  mkdirSync(join(dir, 'memory', 'decisions'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'decisions', 'durable.md'), '### D-077 · active · 2026-10-29\n**Decision:** ship as designed\n');
  check('breaker on disk: the ruling resolves to a decision written after the last REVISE → exit 0', breaker().status === 0, breaker().stdout);
  rmSync(root, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nall loop-critique checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
