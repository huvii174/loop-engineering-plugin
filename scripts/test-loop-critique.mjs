#!/usr/bin/env node
/**
 * Fixture tests for loop-critique. Run: node scripts/test-loop-critique.mjs
 * Exits 0 when every check passes, 1 otherwise. No dependencies.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { critiqueStanding, loopDirOf, parseVerdict, recordCritique, recordRuling, rulingStanding } from './loop-critique.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'loop-critique.mjs');
const BREAKER = join(dirname(fileURLToPath(import.meta.url)), 'loop-breaker.mjs');
const NO_CC = { ...process.env, CLAUDECODE: '' };
const APPROVE = '## Verdict: APPROVE\n\n### Attacks mounted\n1. x — grep — SURVIVED\n\n### Dissent on record\nthe cache key\n';
const REVISE = '## Verdict: REVISE\n\n### If REVISE — findings\n- **Finding 1 (major):** y\n';

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

// ------------------------------------------------------- severity and REJECT
check('parseVerdict: REJECT heading', parseVerdict('## Verdict: REJECT') === 'REJECT');
check('parseVerdict: two Verdict headings are no verdict', parseVerdict('## Verdict: APPROVE\n\n## Verdict: REJECT\n') === null);
check('parseVerdict: the unfilled three-way template is no verdict', parseVerdict('## Verdict: APPROVE | REVISE | REJECT') === null);
{
  // Expected records are built here from the contract, not from the writer:
  // frontmatter lines in contract order, then the body trimmed plus one newline.
  const EMPTY_HASH = createHash('sha256').update('').update('\0').update('').digest('hex').slice(0, 16);
  const AT = new Date('2026-11-05T00:00:00Z');
  const expected = (round, fields, body) =>
    ['---', 'run_id: run-s', `round: ${round}`, ...fields, 'source: hook', `design_hash: ${EMPTY_HASH}`, `recorded: ${AT.toISOString()}`, '---', ''].join('\n')
    + body.replace(/\s+$/, '').replace(/^\s+/, '') + '\n';
  const findings = (...sev) => sev.map((v, i) => `- **Finding ${i + 1} (${v}):** f${i + 1}\n  - Failure scenario: s${i + 1}\n  - Evidence: e${i + 1}`).join('\n');
  const doc = (verdict, region) => `Loop: /p/.loop\n## Verdict: ${verdict}\n\n### Attacks mounted\n1. a — SURVIVED\n\n### If REVISE — findings (numbered, severity-ordered)\n${region}\n\n### Dissent on record (when APPROVE)\nNone\n`;
  const ENDINGS = [['no newline', (t) => t.replace(/\s+$/, '')], ['one newline', (t) => t.replace(/\s+$/, '') + '\n'], ['blank lines', (t) => t.replace(/\s+$/, '') + '\n\n\n']];
  const cases = [
    ['REVISE with majors and a minor keeps REVISE', doc('REVISE', findings('major', 'minor', 'major')),
      ['verdict: REVISE', 'severities: blocker=0 critical=0 major=2 minor=1', 'findings: 1=major,2=minor,3=major']],
    ['REVISE holding a critical rounds up to REJECT', doc('REVISE', findings('critical', 'major')),
      ['verdict: REJECT', 'declared: REVISE', 'severities: blocker=0 critical=1 major=1 minor=0', 'findings: 1=critical,2=major']],
    ['APPROVE holding a blocker rounds up to REJECT', doc('APPROVE', findings('blocker')),
      ['verdict: REJECT', 'declared: APPROVE', 'severities: blocker=1 critical=0 major=0 minor=0', 'findings: 1=blocker']],
    ['REJECT as declared', doc('REJECT', findings('blocker', 'critical', 'minor')),
      ['verdict: REJECT', 'severities: blocker=1 critical=1 major=0 minor=1', 'findings: 1=blocker,2=critical,3=minor']],
    ['APPROVE writing None under the findings heading is an APPROVE', doc('APPROVE', 'None'),
      ['verdict: APPROVE', 'severities: blocker=0 critical=0 major=0 minor=0']],
    ['APPROVE with no findings heading at all is an APPROVE', 'Loop: /p/.loop\n## Verdict: APPROVE\n\n### Dissent on record\nthe cache key\n',
      ['verdict: APPROVE', 'severities: blocker=0 critical=0 major=0 minor=0']],
    ['APPROVE writing prose under the findings heading is unreadable', doc('APPROVE', 'Not applicable — verdict is APPROVE'),
      ['verdict: unreadable', 'declared: APPROVE', 'unreadable: line 8: not a finding, a sub-line or `None` — "Not applicable — verdict is APPROVE"']],
    ['a finding without a severity in the enum is unreadable', doc('REVISE', '- **Finding 1 (severe):** x'),
      ['verdict: unreadable', 'declared: REVISE', 'unreadable: line 8: a finding head not in the `- **Finding N (<severity>):**` shape — "- **Finding 1 (severe):** x"']],
    ['a finding with no severity at all is unreadable', doc('REVISE', '- **Finding 1:** x'),
      ['verdict: unreadable', 'declared: REVISE', 'unreadable: line 8: a finding head not in the `- **Finding N (<severity>):**` shape — "- **Finding 1:** x"']],
    ['a REVISE that names no finding is unreadable', doc('REVISE', ''),
      ['verdict: unreadable', 'declared: REVISE', 'unreadable: REVISE names no finding']],
    ['a REJECT that names no finding is unreadable', doc('REJECT', ''),
      ['verdict: unreadable', 'declared: REJECT', 'unreadable: REJECT names no finding']],
    ['an indented finding head is refused, not taken as a sub-line', doc('REVISE', '- **Finding 1 (major):** x\n  - **Finding 2 (critical):** y'),
      ['verdict: unreadable', 'declared: REVISE', 'unreadable: line 9: a finding head not in the `- **Finding N (<severity>):**` shape — " - **Finding 2 (critical):** y"']],
    ['two Verdict headings are no verdict, not the first of them', doc('APPROVE', 'None') + '\n## Verdict: REJECT\n',
      ['verdict: unreadable', 'unreadable: 2 Verdict headings (lines 2, 13)']],
    ['a finding outside the findings section is unreadable', 'Loop: /p/.loop\n## Verdict: REVISE\n- **Finding 1 (major):** x\n',
      ['verdict: unreadable', 'declared: REVISE', 'unreadable: line 3: a finding outside the findings section']],
    ['None beside a finding is unreadable', doc('REVISE', 'None\n' + findings('major')),
      ['verdict: unreadable', 'declared: REVISE', 'unreadable: `None` beside a finding']],
    ['a repeated finding number is unreadable', doc('REVISE', '- **Finding 1 (major):** a\n- **Finding 1 (minor):** b'),
      ['verdict: unreadable', 'declared: REVISE', 'unreadable: line 9: finding 1 appears twice']],
    ['two findings sections are unreadable', doc('REVISE', findings('major')) + '\n### Findings\n- **Finding 2 (major):** z\n',
      ['verdict: unreadable', 'declared: REVISE', 'unreadable: two findings sections (lines 7, 15)']],
  ];
  for (const [label, text, fields] of cases) {
    for (const [ending, shape] of ENDINGS) {
      const { root, dir } = project({ run_id: 'run-s', tier: 'medium', iteration: 0, history: [] });
      const body = shape(text);
      const r = recordCritique(dir, body, { source: 'hook', now: AT });
      const got = r.file ? readFileSync(r.file, 'utf8') : '';
      const want = expected(1, fields, body);
      check(`record severity: ${label} (${ending}) — whole record`, got === want, `\n--- got\n${got}--- want\n${want}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
}
{
  const { root, dir } = project();
  const at = (s) => new Date(`2026-11-05T00:00:0${s}Z`);
  recordCritique(dir, REVISE, { source: 'hook', now: at(1) });
  recordCritique(dir, '## Verdict: REJECT\n\n### Findings\n- **Finding 1 (blocker):** b\n', { source: 'hook', now: at(2) });
  recordCritique(dir, 'no verdict here', { source: 'hook', now: at(3) });
  const s = critiqueStanding(dir);
  check('standing: open_rounds counts REVISE and REJECT, not unreadable', s.open_rounds === 2 && s.revise_rounds === 1, JSON.stringify(s));
  check('standing: a record carries its findings list from frontmatter',
    JSON.stringify(s.records[1].findings) === JSON.stringify([{ n: 1, severity: 'blocker' }]), JSON.stringify(s.records[1]));
  // A record whose findings frontmatter is malformed is unreadable, not "no findings".
  const r2 = join(dir, 'critique', 'r2.md');
  writeFileSync(r2, readFileSync(r2, 'utf8').replace('findings: 1=blocker', 'findings: 1=blocker,two=major'));
  const m = critiqueStanding(dir);
  check('standing: a malformed findings frontmatter makes the record unreadable',
    m.records[1].verdict === 'unreadable' && m.open_rounds === 1, JSON.stringify(m.records[1]));
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

{
  // The CLI relay path writes the whole record too — with and without
  // --agent-id, over three input endings. `recorded:` is read back; the rest is
  // built here from the contract.
  const EMPTY_HASH = createHash('sha256').update('').update('\0').update('').digest('hex').slice(0, 16);
  const body0 = '## Verdict: APPROVE\n\n### If REVISE — findings\n- **Finding 1 (blocker):** the gate\n  - Evidence: e\n- **Finding 2 (major):** m\n';
  const ENDINGS = [['no newline', (x) => x.trimEnd()], ['one newline', (x) => x.trimEnd() + '\n'], ['blank lines', (x) => x.trimEnd() + '\n\n\n']];
  for (const [label, extra, idLines] of [['without --agent-id', [], []], ['with --agent-id', ['--agent-id', 'relay-7'], ['agent_id: relay-7']]]) {
    for (const [ending, shape] of ENDINGS) {
      const { root, dir } = project({ run_id: 'run-c', tier: 'medium', iteration: 0, history: [] });
      const body = shape(body0);
      const rec = spawnSync(process.execPath, [SCRIPT, 'record', '--dir', dir, ...extra], { input: body, encoding: 'utf8', env: NO_CC });
      const file = join(dir, 'critique', 'r1.md');
      const got = rec.status === 0 ? readFileSync(file, 'utf8') : '';
      const recorded = (/^recorded: (.*)$/m.exec(got) || [])[1];
      const want = ['---', 'run_id: run-c', 'round: 1', 'verdict: REJECT', 'declared: APPROVE',
        'severities: blocker=1 critical=0 major=1 minor=0', 'findings: 1=blocker,2=major',
        'source: relay', `design_hash: ${EMPTY_HASH}`, ...idLines, `recorded: ${recorded}`, '---', ''].join('\n') + body.trim() + '\n';
      check(`cli record ${label} (${ending}): the whole record, severity frontmatter and round-up included`,
        rec.status === 0 && got === want, `${rec.stderr}\n--- got\n${got}--- want\n${want}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// ------------------------------------------------------ the arbiter's ruling
{
  const EMPTY_HASH = createHash('sha256').update('').update('\0').update('').digest('hex').slice(0, 16);
  const CLOSE = join(dirname(fileURLToPath(import.meta.url)), 'loop-close.mjs');
  const AT = new Date('2026-11-06T00:00:00Z');
  const ENDINGS = [['no newline', (x) => x.trimEnd()], ['one newline', (x) => x.trimEnd() + '\n'], ['blank lines', (x) => x.trimEnd() + '\n\n\n']];
  const R1 = '## Verdict: REVISE\n\n### Findings\n- **Finding 1 (major):** a\n- **Finding 2 (minor):** b\n';
  const R2 = '## Verdict: REVISE\n\n### Findings\n- **Finding 1 (major):** the cache\n- **Finding 2 (critical):** the gate\n- **Finding 3 (minor):** a typo\n';
  // A project whose run has two open critic rounds on record; r2 judges findings 1=major, 2=critical, 3=minor.
  const disputed = (extra = {}) => {
    const p = project({ run_id: 'run-q', tier: 'medium', iteration: 0, history: [], ...extra });
    recordCritique(p.dir, R1, { source: 'hook', now: new Date('2026-11-05T00:00:01Z') });
    recordCritique(p.dir, R2, { source: 'hook', now: new Date('2026-11-05T00:00:02Z') });
    return p;
  };
  const arb = (ruling, lines, tail = '') => `Loop: /p/.loop\n## Ruling: ${ruling}\n\n### Findings ruled\n${lines.join('\n')}\n\n### Why\nweighed both records\n${tail}`;
  const L = (n, call, sev, why = `reason ${n}`) => `- r2#${n} — ${call} — ${sev} — ${why}`;
  const expected = (fields, body, { source = 'hook', agentId = null } = {}) =>
    ['---', 'run_id: run-q', 'kind: ruling', ...fields, `source: ${source}`, `design_hash: ${EMPTY_HASH}`,
      ...(agentId ? [`agent_id: ${agentId}`] : []), `recorded: ${AT.toISOString()}`, '---', ''].join('\n') + body.trim() + '\n';
  const OK = [L(1, 'UPHELD', 'major', 'the cache key drifts'), L(2, 'OVERRULED', 'critical', 'the gate already refuses it'), L(3, 'UPHELD', 'minor', 'a typo in the brief')];
  const cases = [
    ['PROCEED: no upheld blocker or critical', arb('PROCEED', OK),
      ['seq: 1', 'ruling: PROCEED', 'judged: r2', 'upheld: blocker=0 critical=0 major=1 minor=1', 'overruled: 1']],
    ['a declared PROCEED with an upheld critical is recorded REDESIGN', arb('PROCEED', [L(1, 'UPHELD', 'major'), L(2, 'UPHELD', 'critical'), L(3, 'OVERRULED', 'minor')]),
      ['seq: 1', 'ruling: REDESIGN', 'declared: PROCEED', 'judged: r2', 'upheld: blocker=0 critical=1 major=1 minor=0', 'overruled: 1']],
    ['an UPHELD blocker alone (no critical) is recorded REDESIGN', arb('PROCEED', [L(1, 'OVERRULED', 'major'), L(2, 'UPHELD', 'blocker'), L(3, 'OVERRULED', 'minor')]),
      ['seq: 1', 'ruling: REDESIGN', 'declared: PROCEED', 'judged: r2', 'upheld: blocker=1 critical=0 major=0 minor=0', 'overruled: 2']],
    ['a declared REDESIGN with nothing blocking upheld is recorded PROCEED', arb('REDESIGN', [L(1, 'UPHELD', 'major'), L(2, 'UPHELD', 'major', 'downgraded'), L(3, 'OVERRULED', 'minor')]),
      ['seq: 1', 'ruling: PROCEED', 'declared: REDESIGN', 'judged: r2', 'upheld: blocker=0 critical=0 major=2 minor=0', 'overruled: 1']],
    ['continuation lines under a ruled line are taken', arb('PROCEED', [OK[0], '  evidence: scripts/x.mjs:3', OK[1], OK[2]]),
      ['seq: 1', 'ruling: PROCEED', 'judged: r2', 'upheld: blocker=0 critical=0 major=1 minor=1', 'overruled: 1']],
    ['a finding of the judged round left unruled is unreadable', arb('PROCEED', OK.slice(0, 2)),
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: unruled: r2#3', 'judged: r2']],
    ['a ruled line for another round is unreadable (foreign)', arb('PROCEED', [...OK, '- r1#1 — UPHELD — major — r1 still open']),
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: line 8: rules r1#1, but the judged round is r2 (foreign)', 'judged: r2']],
    ['a ruled line for a finding the round does not have is unreadable', arb('PROCEED', [...OK, L(9, 'UPHELD', 'major')]),
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: line 8: r2#9 is not a finding of r2', 'judged: r2']],
    ['a finding ruled twice is unreadable', arb('PROCEED', [...OK, L(1, 'OVERRULED', 'major')]),
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: line 8: r2#1 is ruled twice', 'judged: r2']],
    ['an indented ruled line is refused, not taken as a continuation', arb('PROCEED', [OK[0], '  - r2#2 — UPHELD — critical — hidden', OK[1], OK[2]]),
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: line 6: a ruled line not in the `- r<round>#<N> — UPHELD|OVERRULED — <severity> — <reason>` shape — " - r2#2 — UPHELD — critical — hidden"', 'judged: r2']],
    ['a ruled line with a word out of the enum is refused', arb('PROCEED', [OK[0], '- r2#2 — DISMISSED — critical — no', OK[2]]),
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: line 6: a ruled line not in the `- r<round>#<N> — UPHELD|OVERRULED — <severity> — <reason>` shape — "- r2#2 — DISMISSED — critical — no"', 'judged: r2']],
    ['a prose line in the ruled region is unreadable', arb('PROCEED', ['All three findings are minor in practice.', ...OK]),
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: line 5: not a ruled line or a continuation — "All three findings are minor in practice."', 'judged: r2']],
    ['a ruled line outside the region is unreadable', `Loop: /p/.loop\n## Ruling: PROCEED\n${OK[0]}\n\n### Findings ruled\n${OK.join('\n')}\n`,
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: line 3: a ruled line outside `### Findings ruled`', 'judged: r2']],
    ['no ruled region is unreadable', 'Loop: /p/.loop\n## Ruling: PROCEED\n\nall fine\n',
      ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: no `### Findings ruled` section', 'judged: r2']],
    ['two Ruling headings are no ruling', arb('PROCEED', OK) + '\n## Ruling: REDESIGN\n',
      ['seq: 1', 'ruling: unreadable', 'unreadable: 2 Ruling headings (lines 2, 12)', 'judged: r2']],
    ['the unfilled template is no ruling', arb('PROCEED | REDESIGN', OK),
      ['seq: 1', 'ruling: unreadable', 'unreadable: no `## Ruling: PROCEED|REDESIGN` heading', 'judged: r2']],
  ];
  for (const [label, text, fields] of cases) {
    for (const [ending, shape] of ENDINGS) {
      const { root, dir } = disputed();
      const body = shape(text);
      const r = recordRuling(dir, body, { source: 'hook', agentId: 'arb-1', now: AT });
      const got = r.file ? readFileSync(r.file, 'utf8') : `(error ${r.error})`;
      const want = expected(fields, body, { agentId: 'arb-1' });
      check(`ruling: ${label} (${ending}) — whole record`, got === want && r.file.endsWith('a1.md'), `\n--- got\n${got}--- want\n${want}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
  {
    // No open critic round to judge: the only record is an APPROVE.
    const { root, dir } = project({ run_id: 'run-q', tier: 'medium', iteration: 0, history: [] });
    recordCritique(dir, APPROVE, { source: 'hook' });
    const body = arb('PROCEED', OK);
    const r = recordRuling(dir, body, { source: 'hook', now: AT });
    check('ruling: with no open critic round on record it is unreadable', readFileSync(r.file, 'utf8') ===
      expected(['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: no open critic round (REVISE or REJECT) on record to judge', 'judged: none'], body));
    check('ruling: empty output and a missing state.json are refused, nothing written',
      Boolean(recordRuling(dir, '  ').error) && Boolean(recordRuling(join(root, 'nowhere'), body).error) && !existsSync(join(dir, 'critique', 'a2.md')));
    rmSync(root, { recursive: true, force: true });
  }

  // CLI relay: whole record with and without --agent-id, three endings; refused inside Claude Code.
  for (const [label, extra, agentId] of [['without --agent-id', [], null], ['with --agent-id', ['--agent-id', 'relay-a'], 'relay-a']]) {
    for (const [ending, shape] of ENDINGS) {
      const { root, dir } = disputed();
      const body = shape(arb('PROCEED', OK));
      const rec = spawnSync(process.execPath, [SCRIPT, 'rule', '--dir', dir, ...extra], { input: body, encoding: 'utf8', env: NO_CC });
      const file = join(dir, 'critique', 'a1.md');
      const got = rec.status === 0 ? readFileSync(file, 'utf8') : '';
      const recorded = (/^recorded: (.*)$/m.exec(got) || [])[1];
      const want = ['---', 'run_id: run-q', 'kind: ruling', 'seq: 1', 'ruling: PROCEED', 'judged: r2', 'upheld: blocker=0 critical=0 major=1 minor=1', 'overruled: 1',
        'source: relay', `design_hash: ${EMPTY_HASH}`, ...(agentId ? [`agent_id: ${agentId}`] : []), `recorded: ${recorded}`, '---', ''].join('\n') + body.trim() + '\n';
      check(`cli rule ${label} (${ending}): the whole record, source relay`, rec.status === 0 && got === want, `${rec.stderr}\n--- got\n${got}--- want\n${want}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
  {
    const { root, dir } = disputed();
    const refused = spawnSync(process.execPath, [SCRIPT, 'rule', '--dir', dir], { input: arb('PROCEED', OK), encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' } });
    check('cli rule: refused inside Claude Code, nothing written', refused.status === 1 && /tenth-man-arbiter/.test(refused.stderr) && !existsSync(join(dir, 'critique', 'a1.md')), refused.stderr);
    rmSync(root, { recursive: true, force: true });
  }

  // Every branch of the writer, whole files: epic none/set × cwd default/passed ×
  // outcome × caller (direct with agent_id, CLI relay) × three endings. The
  // record and — where one must exist — the ledger copy are both compared with
  // text built here; where no copy may exist, its absence is checked, with the
  // positive control (the PROCEED+epic cell) in the same matrix.
  {
    const OUTCOMES = [
      ['PROCEED', arb('PROCEED', OK), ['seq: 1', 'ruling: PROCEED', 'judged: r2', 'upheld: blocker=0 critical=0 major=1 minor=1', 'overruled: 1']],
      ['REDESIGN', arb('REDESIGN', [L(1, 'UPHELD', 'major'), L(2, 'UPHELD', 'critical'), L(3, 'OVERRULED', 'minor')]),
        ['seq: 1', 'ruling: REDESIGN', 'judged: r2', 'upheld: blocker=0 critical=1 major=1 minor=0', 'overruled: 1']],
      ['unreadable', arb('PROCEED', OK.slice(0, 1)), ['seq: 1', 'ruling: unreadable', 'declared: PROCEED', 'unreadable: unruled: r2#2, r2#3', 'judged: r2']],
    ];
    const CALLERS = [
      ['direct, agent_id', 'hook', 'arb-9'],
      ['CLI relay', 'relay', null],
    ];
    for (const epic of [null, 'demo']) {
      for (const cwdKind of ['default', 'passed']) {
        for (const [caller, source, agentId] of CALLERS) {
          if (caller === 'CLI relay' && cwdKind === 'passed') continue; // the CLI takes no cwd: the default is its only branch
          for (const [outcome, text, fields] of OUTCOMES) {
            for (const [ending, shape] of ENDINGS) {
              const { root, dir } = disputed(epic ? { epic } : {});
              const other = mkdtempSync(join(tmpdir(), 'loop-critique-cwd-'));
              const tree = cwdKind === 'passed' ? other : root;
              const body = shape(text);
              let status = 0;
              if (caller === 'CLI relay') {
                status = spawnSync(process.execPath, [SCRIPT, 'rule', '--dir', dir], { input: body, encoding: 'utf8', env: NO_CC }).status;
              } else {
                recordRuling(dir, body, { source, agentId, now: AT, ...(cwdKind === 'passed' ? { cwd: other } : {}) });
              }
              const file = join(dir, 'critique', 'a1.md');
              const got = existsSync(file) ? readFileSync(file, 'utf8') : '(none)';
              const recorded = (/^recorded: (.*)$/m.exec(got) || [])[1];
              const want = ['---', 'run_id: run-q', 'kind: ruling', ...fields, `source: ${source}`, `design_hash: ${EMPTY_HASH}`,
                ...(agentId ? [`agent_id: ${agentId}`] : []), `recorded: ${caller === 'CLI relay' ? recorded : AT.toISOString()}`, '---', ''].join('\n') + body.trim() + '\n';
              const copy = join(tree, '.loop', 'epics', 'demo', 'rulings', 'run-q.md');
              const owesCopy = epic && outcome === 'PROCEED';
              const copyOk = owesCopy ? existsSync(copy) && readFileSync(copy, 'utf8') === want
                : !existsSync(join(root, '.loop', 'epics')) && !existsSync(join(other, '.loop', 'epics'));
              const label = `ruling matrix: epic ${epic ?? 'none'} × cwd ${cwdKind} × ${caller} × ${outcome} (${ending})`;
              check(`${label} — whole record`, status === 0 && got === want, `\n--- got\n${got}--- want\n${want}`);
              check(`${label} — ledger ${owesCopy ? 'copy, whole file' : 'absent'}`, copyOk,
                owesCopy ? `\n--- copy\n${existsSync(copy) ? readFileSync(copy, 'utf8') : '(missing)'}--- want\n${want}` : 'a ledger directory exists');
              rmSync(other, { recursive: true, force: true });
              rmSync(root, { recursive: true, force: true });
            }
          }
        }
      }
    }
  }

  // The whole store, after every write of every two-ruling sequence. A matrix
  // over single writes found one more writer branch per review round (epic,
  // then seq > 1, then the passed-cwd unlink); this compares everything the
  // store holds — critique/ and both trees' ledgers — against a model built
  // here, after each step of every ordered pair of outcomes, so a branch on
  // seq, on the previous outcome, or on where the copy lives shows up as a
  // diff in some cell.
  {
    const snapshot = (tree) => {
      const out = {};
      const walk = (d) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p); else out[relative(tree, p)] = readFileSync(p, 'utf8');
        }
      };
      walk(join(tree, '.loop'));
      return out;
    };
    const OUT = {
      PROCEED: [arb('PROCEED', OK), ['ruling: PROCEED', 'judged: r2', 'upheld: blocker=0 critical=0 major=1 minor=1', 'overruled: 1']],
      REDESIGN: [arb('REDESIGN', [L(1, 'UPHELD', 'major'), L(2, 'UPHELD', 'critical'), L(3, 'OVERRULED', 'minor')]),
        ['ruling: REDESIGN', 'judged: r2', 'upheld: blocker=0 critical=1 major=1 minor=0', 'overruled: 1']],
      unreadable: [arb('PROCEED', OK.slice(0, 1)), ['ruling: unreadable', 'declared: PROCEED', 'unreadable: unruled: r2#2, r2#3', 'judged: r2']],
    };
    const COMBOS = [];
    for (const epic of [null, 'demo']) {
      COMBOS.push({ epic, cwdKind: 'default', caller: 'direct', source: 'hook', agentId: 'arb-9' });
      COMBOS.push({ epic, cwdKind: 'passed', caller: 'direct', source: 'hook', agentId: 'arb-9' });
      COMBOS.push({ epic, cwdKind: 'default', caller: 'CLI relay', source: 'relay', agentId: null }); // the CLI has no cwd option
    }
    // Starting stores: empty, or holding another run's leftovers — two ruling
    // records in critique/ (design.md:99-104 leaves them on a non-terminal
    // overwrite) and that run's ledger copy in both trees. Leftovers stay byte
    // for byte; this run's records take the next free a<N>.md, seq counted for
    // this run alone.
    const LEFTOVER = (seq) => `---\nrun_id: run-old\nkind: ruling\nseq: ${seq}\nruling: PROCEED\njudged: r2\nupheld: blocker=0 critical=0 major=0 minor=0\noverruled: 0\nsource: hook\ndesign_hash: 0000000000000000\nrecorded: 2026-11-01T00:00:00.000Z\n---\nold run ${seq}\n`;
    // `edited`: design.md changed after r2 and before any ruling — the arbiter
    // would rule on a design no critic read, so no PROCEED may reach the ledger.
    const EDITED = '# Design\nedited after r2\n';
    const EDITED_HASH = createHash('sha256').update('').update('\0').update('# Design\nedited after r2').digest('hex').slice(0, 16);
    const STARTS = {
      empty: { files: {}, names: ['a1.md', 'a2.md'] },
      edited: { files: { [join('.loop', 'design.md')]: EDITED }, names: ['a1.md', 'a2.md'], hash: EDITED_HASH, noLedger: true },
      leftover: {
        files: { [join('.loop', 'critique', 'a1.md')]: LEFTOVER(1), [join('.loop', 'critique', 'a2.md')]: LEFTOVER(2),
          [join('.loop', 'epics', 'demo', 'rulings', 'run-old.md')]: LEFTOVER(2) },
        names: ['a3.md', 'a4.md'],
      },
    };
    for (const [startName, start] of Object.entries(STARTS))
    for (const combo of COMBOS) {
      for (const first of Object.keys(OUT)) {
        for (const second of Object.keys(OUT)) {
          for (const [ending, shape] of ENDINGS) {
            const { root, dir } = disputed(combo.epic ? { epic: combo.epic } : {});
            const other = mkdtempSync(join(tmpdir(), 'loop-critique-cwd-'));
            for (const [rel, text] of Object.entries(start.files)) {
              for (const t of rel.includes('epics') ? [root, other] : [root]) {
                mkdirSync(dirname(join(t, rel)), { recursive: true });
                writeFileSync(join(t, rel), text);
              }
            }
            const tree = combo.cwdKind === 'passed' ? other : root;
            const base = snapshot(root); // state.json, r1.md, r2.md and any leftover — the store before any ruling
            const baseOther = snapshot(other);
            const model = { ...base };
            const steps = [first, second];
            let ok = true;
            let detail = '';
            steps.forEach((outcome, k) => {
              const seq = k + 1;
              const body = shape(OUT[outcome][0]);
              if (combo.caller === 'CLI relay') spawnSync(process.execPath, [SCRIPT, 'rule', '--dir', dir], { input: body, encoding: 'utf8', env: NO_CC });
              else recordRuling(dir, body, { source: combo.source, agentId: combo.agentId, now: AT, ...(combo.cwdKind === 'passed' ? { cwd: other } : {}) });
              const rel = join('.loop', 'critique', start.names[k]);
              const written = existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '';
              const recorded = combo.caller === 'CLI relay' ? (/^recorded: (.*)$/m.exec(written) || [])[1] : AT.toISOString();
              const text = ['---', 'run_id: run-q', 'kind: ruling', `seq: ${seq}`, ...OUT[outcome][1], `source: ${combo.source}`, `design_hash: ${start.hash ?? EMPTY_HASH}`,
                ...(combo.agentId ? [`agent_id: ${combo.agentId}`] : []), `recorded: ${recorded}`, '---', ''].join('\n') + body.trim() + '\n';
              model[rel] = text;
              const ledgerRel = join('.loop', 'epics', 'demo', 'rulings', 'run-q.md');
              const wantRoot = { ...model };
              const wantOther = { ...baseOther };
              if (combo.epic && outcome === 'PROCEED' && !start.noLedger) (tree === root ? wantRoot : wantOther)[ledgerRel] = text;
              const gotRoot = snapshot(root);
              const gotOther = snapshot(other);
              // The ledger directory itself may outlive its file (unlink leaves rulings/); only files are compared.
              const same = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()) && Object.keys(a).every((key) => a[key] === b[key]);
              if (!same(gotRoot, wantRoot) || !same(gotOther, wantOther)) {
                ok = false;
                detail ||= `after step ${seq} (${outcome}): root files ${JSON.stringify(Object.keys(gotRoot).sort())} want ${JSON.stringify(Object.keys(wantRoot).sort())}; ` +
                  `other files ${JSON.stringify(Object.keys(gotOther).sort())} want ${JSON.stringify(Object.keys(wantOther).sort())}; ` +
                  `differing: ${Object.keys(wantRoot).filter((key) => gotRoot[key] !== wantRoot[key]).concat(Object.keys(wantOther).filter((key) => gotOther[key] !== wantOther[key])).join(', ')}`;
              }
            });
            check(`ruling store: start ${startName} × epic ${combo.epic ?? 'none'} × cwd ${combo.cwdKind} × ${combo.caller} × ${first} then ${second} (${ending}) — whole store after each write`, ok, detail);
            rmSync(other, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
    }
  }

  // The epic ledger: a PROCEED is copied byte for byte; anything later removes the copy.
  {
    const { root, dir } = disputed({ epic: 'demo' });
    const copy = join(root, '.loop', 'epics', 'demo', 'rulings', 'run-q.md');
    const r = recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT });
    check('ledger: a PROCEED in an epic is copied byte for byte to epics/<slug>/rulings/<run_id>.md',
      existsSync(copy) && readFileSync(copy, 'utf8') === readFileSync(r.file, 'utf8') && r.ledger === copy);
    recordRuling(dir, arb('REDESIGN', [L(1, 'UPHELD', 'major'), L(2, 'UPHELD', 'critical'), L(3, 'UPHELD', 'minor')]), { source: 'hook', now: AT });
    check('ledger: a REDESIGN after the PROCEED removes the copy', !existsSync(copy));
    recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT });
    recordRuling(dir, 'no ruling at all', { source: 'hook', now: AT });
    check('ledger: an unreadable ruling after a PROCEED removes the copy too', !existsSync(copy) && existsSync(join(dir, 'critique', 'a4.md')));
    rmSync(root, { recursive: true, force: true });
  }
  {
    const { root, dir } = disputed({ epic: 'demo' });
    const other = mkdtempSync(join(tmpdir(), 'loop-critique-cwd-'));
    recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT, cwd: other });
    check('ledger: the copy lands under the caller\'s cwd tree, not beside the judged .loop/',
      existsSync(join(other, '.loop', 'epics', 'demo', 'rulings', 'run-q.md')) && !existsSync(join(root, '.loop', 'epics')));
    rmSync(other, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
  {
    const { root, dir } = disputed();
    recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT });
    check('ledger: no epic in state.json → no copy', !existsSync(join(root, '.loop', 'epics')));
    rmSync(root, { recursive: true, force: true });
  }

  // rulingStanding: current, then stale on a design edit or on a newer open round.
  {
    const { root, dir } = disputed();
    recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT });
    const s0 = rulingStanding(dir);
    check('standing: a PROCEED on the current design is the ruling', s0.ruling === 'PROCEED' && !s0.stale, JSON.stringify(s0));
    writeFileSync(join(dir, 'design.md'), '# Design\nedited after the ruling\n');
    const s1 = rulingStanding(dir);
    check('standing: an edit to design.md after the ruling makes it stale', s1.stale && s1.ruling === null, JSON.stringify(s1));
    rmSync(root, { recursive: true, force: true });
  }
  {
    // A ruling record whose upheld counts are malformed is unreadable, not a PROCEED with zero deferred.
    const { root, dir } = disputed();
    const r = recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT });
    writeFileSync(r.file, readFileSync(r.file, 'utf8').replace('upheld: blocker=0 critical=0 major=1 minor=1', 'upheld: major=1'));
    const s2 = rulingStanding(dir);
    check('standing: a ruling with a malformed `upheld:` line is unreadable', s2.latest.ruling === 'unreadable' && s2.ruling === 'unreadable', JSON.stringify(s2.latest));
    rmSync(root, { recursive: true, force: true });
  }
  {
    const { root, dir } = disputed();
    recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT });
    recordCritique(dir, R2, { source: 'hook' });
    check('standing: a newer open critic round than the one judged makes the ruling stale', rulingStanding(dir).stale);
    rmSync(root, { recursive: true, force: true });
  }
  {
    // An edit between the judged critic round and the ruling: the ruling's hash
    // is the current design's, but no critic read it.
    const { root, dir } = disputed();
    writeFileSync(join(dir, 'design.md'), '# Design\nrewritten after r2\n');
    recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT });
    const s3 = rulingStanding(dir);
    check('standing: a ruling on a design the judged critic round never saw is stale', s3.stale && s3.ruling === null, JSON.stringify(s3));
    rmSync(root, { recursive: true, force: true });
  }

  // deferred --epic: the ledger's upheld majors and minors, one block; then the real append takes it.
  {
    const base = mkdtempSync(join(tmpdir(), 'loop-critique-epic-'));
    const loop = join(base, '.loop');
    for (const [run, lines] of [['run-p', [L(1, 'UPHELD', 'minor', 'rename the flag'), L(2, 'OVERRULED', 'major', 'not a defect: already guarded'), L(3, 'UPHELD', 'major', 'the | pipe in a cell')]],
      ['run-q', OK]]) {
      const { root, dir } = disputed({ run_id: run, epic: 'demo' });
      recordRuling(dir, arb('PROCEED', lines), { source: 'hook', now: AT, cwd: base });
      rmSync(root, { recursive: true, force: true });
    }
    const out = spawnSync(process.execPath, [SCRIPT, 'deferred', '--epic', 'demo', '--dir', loop], { encoding: 'utf8' });
    const want = ['```loop-findings',
      '- major: rename the flag (tenth-man deferred run-p r2#1, minor)',
      '- major: the | pipe in a cell (tenth-man deferred run-p r2#3, major)',
      '- major: the cache key drifts (tenth-man deferred run-q r2#1, major)',
      '- major: a typo in the brief (tenth-man deferred run-q r2#3, minor)',
      '```', ''].join('\n');
    check('deferred: every upheld major and minor of the ledger, one block, whole stdout', out.status === 0 && out.stdout === want, `${out.stderr}\n--- got\n${out.stdout}--- want\n${want}`);

    // The real consumer: loop-close.mjs append on a temp epic tree.
    writeFileSync(join(loop, 'active-epic'), 'demo\n');
    const backlog = join(loop, 'epics', 'demo', 'backlog.md');
    writeFileSync(backlog, '# Backlog\n\n| # | Sub-goal | Done when | Depends on | Tier | Status |\n|---|---|---|---|---|---|\n| 1 | first | it works | — | small | done |\n');
    const findingsFile = join(base, 'deferred.md');
    writeFileSync(findingsFile, out.stdout);
    const ap = spawnSync(process.execPath, [CLOSE, 'append', '--findings-file', findingsFile, '--dir', loop], { encoding: 'utf8' });
    const cell = ['major: rename the flag (tenth-man deferred run-p r2#1, minor)', 'major: the \\| pipe in a cell (tenth-man deferred run-p r2#3, major)',
      'major: the cache key drifts (tenth-man deferred run-q r2#1, major)', 'major: a typo in the brief (tenth-man deferred run-q r2#3, minor)'].join('; ');
    const wantBacklog = '# Backlog\n\n| # | Sub-goal | Done when | Depends on | Tier | Status |\n|---|---|---|---|---|---|\n| 1 | first | it works | — | small | done |\n'
      + `| 2 | integration — 4 finding(s) from the epic gate | ${cell} | 1 | medium | pending |\n`;
    const gotBacklog = readFileSync(backlog, 'utf8');
    check('deferred → loop-close.mjs append: exit 0, and the integration row carries every deferred finding (whole backlog)',
      ap.status === 0 && gotBacklog === wantBacklog, `${ap.stderr}\n--- got\n${gotBacklog}--- want\n${wantBacklog}`);

    const empty = spawnSync(process.execPath, [SCRIPT, 'deferred', '--epic', 'none-here', '--dir', loop], { encoding: 'utf8' });
    check('deferred: an epic with no rulings prints `no deferred findings`, exit 0', empty.status === 0 && empty.stdout === 'no deferred findings\n', empty.stdout + empty.stderr);
    const bad = spawnSync(process.execPath, [SCRIPT, 'deferred', '--dir', loop], { encoding: 'utf8' });
    check('deferred: no --epic exits 1', bad.status === 1 && /--epic/.test(bad.stderr));
    writeFileSync(join(loop, 'epics', 'demo', 'rulings', 'run-z.md'), '---\nrun_id: run-z\nkind: ruling\nruling: REDESIGN\njudged: r2\n---\nbody\n');
    const notProceed = spawnSync(process.execPath, [SCRIPT, 'deferred', '--epic', 'demo', '--dir', loop], { encoding: 'utf8' });
    check('deferred: a ledger file that is not a PROCEED ruling refuses, naming it', notProceed.status === 1 && /run-z\.md: not a PROCEED ruling record/.test(notProceed.stderr), notProceed.stderr);
    rmSync(base, { recursive: true, force: true });
  }

  // excluded: the upheld blockers and criticals of a REDESIGN, quoted with the record path.
  {
    const { root, dir } = disputed();
    const none = spawnSync(process.execPath, [SCRIPT, 'excluded', '--dir', dir], { encoding: 'utf8' });
    check('excluded: no ruling → exit 1', none.status === 1 && /no ruling recorded/.test(none.stderr), none.stderr);
    recordRuling(dir, arb('PROCEED', OK), { source: 'hook', now: AT });
    const proceed = spawnSync(process.execPath, [SCRIPT, 'excluded', '--dir', dir], { encoding: 'utf8' });
    check('excluded: a PROCEED → exit 1', proceed.status === 1 && /not REDESIGN/.test(proceed.stderr), proceed.stderr);
    recordRuling(dir, arb('REDESIGN', [L(1, 'UPHELD', 'blocker', 'the hook never sees a teammate'), L(2, 'UPHELD', 'critical', 'the gate reads the wrong file'), L(3, 'UPHELD', 'minor', 'a typo')]), { source: 'hook', now: AT });
    const ex = spawnSync(process.execPath, [SCRIPT, 'excluded', '--dir', dir], { encoding: 'utf8' });
    const want = ['## Excluded directions', '',
      `- the hook never sees a teammate — critic r2#1 (blocker), ruled in ${join('.loop', 'critique', 'a2.md')}`,
      `- the gate reads the wrong file — critic r2#2 (critical), ruled in ${join('.loop', 'critique', 'a2.md')}`, ''].join('\n');
    check('excluded: a REDESIGN prints one item per upheld blocker/critical (whole stdout)', ex.status === 0 && ex.stdout === want, `${ex.stderr}\n--- got\n${ex.stdout}--- want\n${want}`);
    rmSync(root, { recursive: true, force: true });
  }
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
