#!/usr/bin/env node
/**
 * Fixture tests for loop-archive. Run: node scripts/test-loop-archive.mjs
 * Spawns the script as a real subprocess against a temp .loop/, asserting on
 * exit codes, output and what is left on disk. Exits 0 when all pass.
 *
 * The captured dogfood run in `evd/` is the source of the shapes tested here.
 * It is read-only: the suite copies it and works on the copy. When it is absent
 * (it is not tracked) those checks report as skipped rather than failing.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'loop-archive.mjs');
const EVD = join(HERE, '..', 'evd');

function archive(...args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const cleanup = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'loop-archive-test-'));
  cleanup.push(d);
  return d;
}

/** A `.loop/` holding one finished run, plus whatever extras a case needs. */
function loopDir({ runId = 'run-2026-08-17-pmA3b-walkers', iterations = 3, epic = null, history = null, skipRecords = [] } = {}) {
  const dir = join(scratch(), '.loop');
  mkdirSync(join(dir, 'iterations'), { recursive: true });
  writeFileSync(join(dir, 'goal.md'), '# Goal\n');
  writeFileSync(join(dir, 'design.md'), '# Design\n');
  writeFileSync(join(dir, 'prompt.md'), '# Prompt\n');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    status: 'done', run_id: runId, ...(epic ? { epic } : {}),
    ...(history ? { history } : {}),
  }));
  for (let i = 1; i <= iterations; i++) {
    if (skipRecords.includes(i)) continue;
    writeFileSync(join(dir, 'iterations', String(i).padStart(4, '0') + '.md'), `# iter ${i}\n`);
  }
  return dir;
}

/** One archived run under `<dir>/archive/`, dated by name and by mtime. */
function archivedRun(dir, name, { epic = null, day = null } = {}) {
  const p = join(dir, 'archive', name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'state.json'), JSON.stringify({ status: 'done', run_id: name, ...(epic ? { epic } : {}) }));
  if (day) utimesSync(p, day, day);
  return p;
}

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
}
function skip(name, why) {
  console.log(`skip  ${name}  (${why})`);
}

// ------------------------------------------------------------------------- run
{
  const dir = loopDir();
  let r = archive('run', '--dir', dir, '--id', 'run-2026-08-17-pmA3b-walkers', '--dry-run');
  const target = join(dir, 'archive', 'run-2026-08-17-pmA3b-walkers');
  check('run: --dry-run prints the plan and writes nothing',
    r.code === 0 && r.out.includes('(dry-run)') && !existsSync(target), `code=${r.code}`);
  check('run: --dry-run names full destination paths, not a directory to drop into',
    r.out.includes(join(target, 'iterations')), r.out);

  r = archive('run', '--dir', dir, '--id', 'run-2026-08-17-pmA3b-walkers');
  check('run: files and iterations/ land at named paths',
    r.code === 0 && existsSync(join(target, 'goal.md')) && existsSync(join(target, 'iterations', '0001.md')),
    `code=${r.code} err=${r.err}`);
  check('run: sources are gone from the top of .loop', !existsSync(join(dir, 'goal.md')) && !existsSync(join(dir, 'iterations')));
  check('run: no staging directory survives', !readdirSync(join(dir, 'archive')).some((n) => n.startsWith('.staging')));

  r = archive('run', '--dir', dir, '--id', 'run-2026-08-17-pmA3b-walkers');
  check('run: a second archive under the same id is refused',
    r.code === 1 && r.err.includes('already exists'), `code=${r.code} err=${r.err}`);
}

// ---------------------------------------------- run: the iterations/iterations bug
{
  // The exact sequence that produced archive/<id>/iterations/iterations/ in the
  // real run: archive, start a new run under the same id, archive again.
  const dir = loopDir();
  const target = join(dir, 'archive', 'run-2026-08-17-pmA3b-walkers');
  archive('run', '--dir', dir, '--id', 'run-2026-08-17-pmA3b-walkers');

  mkdirSync(join(dir, 'iterations'), { recursive: true });
  writeFileSync(join(dir, 'iterations', '0009.md'), '# iter 9\n');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ status: 'done', run_id: 'run-2026-08-17-pmA3b-walkers' }));

  let r = archive('run', '--dir', dir, '--id', 'run-2026-08-17-pmA3b-walkers');
  check('doubling: the re-archive is refused rather than nested', r.code === 1, `code=${r.code}`);
  check('doubling: nothing nested while refusing', !existsSync(join(target, 'iterations', 'iterations')));

  r = archive('run', '--dir', dir, '--id', 'run-2026-08-17-pmA3b-walkers', '--force');
  check('doubling: --force replaces the entry instead of nesting inside it',
    r.code === 0 && !existsSync(join(target, 'iterations', 'iterations')) && existsSync(join(target, 'iterations', '0009.md')),
    `code=${r.code} err=${r.err}`);
  check('doubling: --force left the replaced entry with only the new contents',
    readdirSync(join(target, 'iterations')).join() === '0009.md');
  check('doubling: --force left untouched entries alone', existsSync(join(target, 'goal.md')));
}

// ------------------------------------------------------------------ run: guards
{
  const dir = loopDir({ runId: 'run-2026-08-31-759-35' });
  let r = archive('run', '--dir', dir);
  check('run: --id defaults to state.json run_id',
    r.code === 0 && existsSync(join(dir, 'archive', 'run-2026-08-31-759-35', 'state.json')), `code=${r.code} err=${r.err}`);

  r = archive('run', '--dir', dir, '--id', 'run-x');
  check('run: nothing left to archive is refused, not a no-op success',
    r.code === 1 && r.err.includes('nothing to archive'), `code=${r.code} err=${r.err}`);

  // 42 of 308 iteration records in a real archive did not exist while state.json
  // still counted them. Archiving is the last moment anyone can still find them.
  const HIST = [1, 2, 3, 4].map((n) => ({ n, verdict: 'pass', criteria_passed: n }));
  const gapped = loopDir({ runId: 'run-gapped', iterations: 4, history: HIST, skipRecords: [2, 4] });
  r = archive('run', '--dir', gapped);
  check('run: history naming records that do not exist is refused',
    r.code === 1 && r.err.includes('0002, 0004'), `code=${r.code} err=${r.err}`);
  check('run: the gap refusal wrote nothing', existsSync(join(gapped, 'goal.md')));

  r = archive('run', '--dir', gapped, '--allow-gaps');
  const gappedState = r.code === 0
    ? JSON.parse(readFileSync(join(gapped, 'archive', 'run-gapped', 'state.json'), 'utf8'))
    : {};
  check('run: --allow-gaps archives and records the loss as data',
    r.code === 0 && JSON.stringify(gappedState.missing_iteration_records) === JSON.stringify(['0002', '0004']),
    `code=${r.code} err=${r.err} recorded=${JSON.stringify(gappedState.missing_iteration_records)}`);

  const whole = loopDir({ runId: 'run-whole', iterations: 3, history: [1, 2, 3].map((n) => ({ n, verdict: 'pass' })) });
  r = archive('run', '--dir', whole);
  check('run: a complete history archives without the flag',
    r.code === 0 && !('missing_iteration_records' in JSON.parse(readFileSync(join(whole, 'archive', 'run-whole', 'state.json'), 'utf8'))),
    `code=${r.code} err=${r.err}`);

  const fresh = loopDir();
  r = archive('run', '--dir', fresh, '--id', '../escape');
  check('run: a traversing id is refused', r.code === 1 && r.err.includes('unusable run id'), `err=${r.err}`);
  check('run: the traversing id wrote nothing', existsSync(join(fresh, 'goal.md')));

  const stale = loopDir();
  mkdirSync(join(stale, 'archive', '.staging-run-2026-08-17-pmA3b-walkers'), { recursive: true });
  r = archive('run', '--dir', stale, '--id', 'run-2026-08-17-pmA3b-walkers');
  check('run: a leftover staging dir from an interrupted archive is refused',
    r.code === 1 && r.err.includes('interrupted'), `err=${r.err}`);
}

// ------------------------------------------------------------------------ epic
{
  const dir = loopDir();
  mkdirSync(join(dir, 'epics', '692-block-identity', 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'epics', '692-block-identity', 'epic.md'), '# Epic\n');

  let r = archive('epic', '--dir', dir, '--slug', '692-block-identity');
  check('epic: refused while memory/epics/<slug>.md is missing',
    r.code === 1 && r.err.includes('retained knowledge'), `code=${r.code} err=${r.err}`);
  check('epic: the refusal left the instance in place', existsSync(join(dir, 'epics', '692-block-identity', 'epic.md')));

  mkdirSync(join(dir, 'memory', 'epics'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'epics', '692-block-identity.md'), '# Rollup\n');
  writeFileSync(join(dir, 'active-epic'), '692-block-identity\n');

  r = archive('epic', '--dir', dir, '--slug', '692-block-identity', '--dry-run');
  check('epic: --dry-run writes nothing', r.code === 0 && existsSync(join(dir, 'epics', '692-block-identity')));
  check('epic: --dry-run warns that active-epic still points there', r.out.includes('active-epic'), r.out);

  r = archive('epic', '--dir', dir, '--slug', '692-block-identity');
  const moved = join(dir, 'archive', 'epics', '692-block-identity');
  check('epic: instance moves once the rollup exists',
    r.code === 0 && existsSync(join(moved, 'epic.md')) && !existsSync(join(dir, 'epics', '692-block-identity')),
    `code=${r.code} err=${r.err}`);
  check('epic: the rollup is never archived', existsSync(join(dir, 'memory', 'epics', '692-block-identity.md')));
  check('epic: no nesting under the archived slug', !existsSync(join(moved, '692-block-identity')));

  r = archive('epic', '--dir', dir, '--slug', 'never-existed');
  check('epic: an unknown slug is refused', r.code === 1 && r.err.includes('does not exist'), `err=${r.err}`);
}

// --------------------------------------- epic: decisions retire with the epic
{
  const dir = loopDir();
  mkdirSync(join(dir, 'epics', 'pm-cutover'), { recursive: true });
  writeFileSync(join(dir, 'epics', 'pm-cutover', 'epic.md'), '# Epic\n');
  mkdirSync(join(dir, 'memory', 'epics'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'epics', 'pm-cutover.md'), '# Rollup\n');
  mkdirSync(join(dir, 'memory', 'decisions', 'pm-cutover'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'decisions', 'pm-cutover', 'item-3.md'), '### D-pmc-001 · active · 2026-08-01\n**Decision:** x\n');
  writeFileSync(join(dir, 'memory', 'decisions', '_index.md'), '# Decisions index\n## pm-cutover\n- D-pmc-001 [active] item 3 — x\n');

  let r = archive('epic', '--dir', dir, '--slug', 'pm-cutover', '--dry-run');
  check('epic: dry-run names the promote-then-drop-index note',
    r.code === 0 && r.out.includes('durable.md') && r.out.includes('_index.md'), r.out.slice(0, 200));
  check('epic: dry-run leaves the decisions dir', existsSync(join(dir, 'memory', 'decisions', 'pm-cutover', 'item-3.md')));

  r = archive('epic', '--dir', dir, '--slug', 'pm-cutover');
  check('epic: decisions dir retires into the epic archive',
    r.code === 0 && existsSync(join(dir, 'archive', 'epics', 'pm-cutover', 'decisions', 'item-3.md')) &&
    !existsSync(join(dir, 'memory', 'decisions', 'pm-cutover')),
    `code=${r.code} err=${r.err}`);
  check('epic: durable.md and the decisions index are not touched by the move',
    existsSync(join(dir, 'memory', 'decisions', '_index.md')));

  // an epic with no decisions dir archives exactly as before
  mkdirSync(join(dir, 'epics', 'no-decisions'), { recursive: true });
  writeFileSync(join(dir, 'epics', 'no-decisions', 'epic.md'), '# Epic\n');
  writeFileSync(join(dir, 'memory', 'epics', 'no-decisions.md'), '# Rollup\n');
  r = archive('epic', '--dir', dir, '--slug', 'no-decisions');
  check('epic: no decisions dir → archives without the note',
    r.code === 0 && existsSync(join(dir, 'archive', 'epics', 'no-decisions', 'epic.md')) && !r.out.includes('durable.md'),
    `code=${r.code} out=${r.out.slice(0, 120)}`);
}

// --------------------------------------------------------------------- hygiene
{
  const dir = loopDir();
  const droppings = [
    join(dir, '.omc', 'state'),
    join(dir, 'memory', '.omc'),
    join(dir, 'memory', 'epics', '.omc'),
    join(dir, 'epics', '264-split-scope-parity', 'evidence', '.omc'),
    join(dir, 'epics', '264-split-scope-parity', 'evidence', '__pycache__'),
  ];
  for (const d of droppings) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, 'epics', '264-split-scope-parity', 'evidence', '__pycache__', 'splice.cpython-311.pyc'), 'x');
  writeFileSync(join(dir, 'memory', '.DS_Store'), 'x');
  writeFileSync(join(dir, 'memory', 'learnings.md'), '# Learnings\n');

  let r = archive('hygiene', '--dir', dir, '--dry-run');
  check('hygiene: --dry-run lists every dropping and deletes none',
    r.code === 0 && existsSync(join(dir, 'memory', '.omc')) && r.out.split('\n').filter((l) => l.includes('delete')).length === 6,
    `code=${r.code} out=${r.out}`);

  r = archive('hygiene', '--dir', dir);
  check('hygiene: droppings are gone from every depth',
    r.code === 0 && droppings.every((d) => !existsSync(d)) && !existsSync(join(dir, 'memory', '.DS_Store')),
    `code=${r.code} err=${r.err}`);
  check('hygiene: authored files are untouched', existsSync(join(dir, 'memory', 'learnings.md')));
}

// ------------------------------------------------------- hygiene: loose evidence
{
  const dir = loopDir();
  writeFileSync(join(dir, 'active-epic'), '759-document-tab-parity\n');
  mkdirSync(join(dir, 'epics', '759-document-tab-parity', 'evidence'), { recursive: true });
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'evidence', 'item5-prefix-red.txt'), 'red\n');

  const r = archive('hygiene', '--dir', dir);
  check('hygiene: loose evidence is reported, not moved',
    r.code === 0 && existsSync(join(dir, 'evidence', 'item5-prefix-red.txt')), `code=${r.code}`);
  check('hygiene: the report is a copy-pasteable git mv',
    r.out.includes(`suggest git mv ${join(dir, 'evidence', 'item5-prefix-red.txt')} ` +
      `${join(dir, 'epics', '759-document-tab-parity', 'evidence', 'item5-prefix-red.txt')}`), r.out);

  // No epic-owned evidence dir → nothing to suggest, so say nothing.
  const plain = loopDir();
  writeFileSync(join(plain, 'active-epic'), '759-document-tab-parity\n');
  mkdirSync(join(plain, 'evidence'), { recursive: true });
  writeFileSync(join(plain, 'evidence', 'probe.txt'), 'x');
  const q = archive('hygiene', '--dir', plain);
  check('hygiene: no epic evidence dir → no suggestion', q.code === 0 && !q.out.includes('git mv'), q.out);
}

// ----------------------------------------------------------------------- prune
{
  const dir = join(scratch(), '.loop');
  mkdirSync(join(dir, 'archive', 'epics', '692-block-identity'), { recursive: true });
  const day = (n) => new Date(`2026-08-${String(n).padStart(2, '0')}T12:00:00Z`).getTime() / 1000;
  for (const n of [10, 11, 12, 13, 14]) archivedRun(dir, `run-2026-08-${n}-sg${n}`, { day: day(n) });
  archivedRun(dir, 'run-2026-08-21-692i1-oracle', { epic: '692-block-identity', day: day(21) });
  archivedRun(dir, 'run-2026-08-22-692i7-edit', { epic: '692-block-identity', day: day(22) });
  archivedRun(dir, 'run-2026-08-20-pmD7-slots', { epic: 'pm-tiptap-editor', day: day(20) });

  let r = archive('prune', '--dir', dir, '--keep', '3');
  check('prune: without --yes it only reports', r.code === 0 && r.out.includes('pass --yes')
    && existsSync(join(dir, 'archive', 'run-2026-08-10-sg10')), `code=${r.code} out=${r.out}`);

  r = archive('prune', '--dir', dir, '--keep', '3', '--yes');
  const left = readdirSync(join(dir, 'archive')).filter((n) => n.startsWith('run-')).sort();
  check('prune: runs of an archived epic go regardless of age',
    !left.includes('run-2026-08-21-692i1-oracle') && !left.includes('run-2026-08-22-692i7-edit'), `left=${left}`);
  check('prune: a run of a still-live epic is kept if recent enough', left.includes('run-2026-08-20-pmD7-slots'), `left=${left}`);
  check('prune: exactly --keep runs survive', left.length === 3, `left=${left}`);
  check('prune: the newest are the survivors',
    left.join() === 'run-2026-08-13-sg13,run-2026-08-14-sg14,run-2026-08-20-pmD7-slots', `left=${left}`);

  r = archive('prune', '--dir', dir, '--keep', '0', '--yes');
  check('prune: --keep 0 is honoured, not treated as absent',
    r.code === 0 && readdirSync(join(dir, 'archive')).filter((n) => n.startsWith('run-')).length === 0, `out=${r.out}`);

  const empty = join(scratch(), '.loop');
  mkdirSync(empty, { recursive: true });
  r = archive('prune', '--dir', empty);
  check('prune: no archive/ yet → says so and exits 0', r.code === 0 && r.out.includes('nothing archived'), r.out);

  r = archive('prune', '--dir', empty, '--keep', 'twenty');
  check('prune: a non-numeric --keep is refused', r.code === 1 && r.err.includes('unusable --keep'), r.err);
}

// ------------------------------------------------------------------ real .loop/
if (!existsSync(EVD)) {
  skip('evd/: the captured run is not present', 'untracked fixture');
} else {
  const dir = join(scratch(), '.loop');
  cpSync(EVD, dir, { recursive: true });

  let r = archive('hygiene', '--dir', dir, '--dry-run');
  const listed = r.out.split('\n').filter((l) => l.includes('delete')).length;
  check('evd: every dropping in the real run is found', r.code === 0 && listed >= 7, `listed=${listed}`);
  check('evd: the loose evidence file is reported against the active epic',
    r.out.includes('git mv') && r.out.includes('item5-prefix-red.txt'), r.out.slice(0, 400));

  r = archive('hygiene', '--dir', dir);
  const leftovers = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (['.omc', '__pycache__'].includes(e.name)) leftovers.push(join(d, e.name));
        else walk(join(d, e.name));
      } else if (e.name === '.DS_Store' || e.name.endsWith('.pyc')) leftovers.push(join(d, e.name));
    }
  };
  walk(dir);
  check('evd: the real run comes out clean', r.code === 0 && leftovers.length === 0, `left=${leftovers}`);

  // The one directory the prose actually broke.
  const doubled = join(dir, 'archive', 'run-2026-08-17-pmA3b-walkers', 'iterations', 'iterations');
  check('evd: the captured doubling is still there to be reproduced against', existsSync(doubled));

  r = archive('prune', '--dir', dir, '--keep', '20');
  check('evd: prune reports the 692 runs whose epic is archived',
    r.code === 0 && r.out.includes('run-2026-08-21-692i1-oracle') && r.out.includes('epic 692-block-identity is archived'),
    r.out.slice(0, 400));
  check('evd: prune wrote nothing without --yes', existsSync(join(dir, 'archive', 'run-2026-08-21-692i1-oracle')));
}

// -------------------------------- hygiene: what an earlier sweep leaves behind
{
  const dir = loopDir();
  mkdirSync(join(dir, 'memory', '.claude', '.cc-writes'), { recursive: true });
  mkdirSync(join(dir, 'memory', 'learnings'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'learnings', '_index.md'), '# index\n');
  mkdirSync(join(dir, 'scaffold'), { recursive: true });   // a real empty dir, left alone
  writeFileSync(join(dir, 'RESUME-parallel-run.md'), '# resume\n');

  let r = archive('hygiene', '--dir', dir);
  check('hygiene: removes an empty dot-directory an earlier sweep left',
    r.code === 0 && !existsSync(join(dir, 'memory', '.claude')), `code=${r.code} err=${r.err}`);
  check('hygiene: leaves a non-dot empty directory alone', existsSync(join(dir, 'scaffold')));
  check('hygiene: leaves the store it was sweeping next to intact',
    existsSync(join(dir, 'memory', 'learnings', '_index.md')));
  check('hygiene: says nothing about RESUME while no parallel.json exists',
    !r.out.includes('RESUME'), r.out);

  // Once parallel.json records the slices, the hand-written file is redundant —
  // and it is still someone's evidence, so it is named, never deleted.
  writeFileSync(join(dir, 'parallel.json'), '{}');
  r = archive('hygiene', '--dir', dir);
  check('hygiene: names a stale RESUME file once parallel.json exists',
    r.code === 0 && r.out.includes('RESUME-parallel-run.md'), r.out);
  check('hygiene: never deletes the RESUME file itself',
    existsSync(join(dir, 'RESUME-parallel-run.md')));
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log(failed === 0 ? '\nall archive checks passed' : `\n${failed} archive check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
