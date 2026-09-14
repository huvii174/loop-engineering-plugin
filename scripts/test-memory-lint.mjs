#!/usr/bin/env node
/**
 * Fixture tests for memory-lint. Run: node scripts/test-memory-lint.mjs
 * Exits 0 when every case matches, 1 otherwise. No dependencies.
 *
 * The case that carries the point is `reach`: a body whose anchor survives a
 * maintenance pass while its trigger does not. The real pass that produced 126
 * of those verified the anchors and reported "zero IDs lost", so a lint that
 * could be satisfied the same way would be worth nothing.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lint } from './memory-lint.mjs';

/** Build a store from a {path: contents} map under a throwaway directory. */
function store(files) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-lint-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const FRONTMATTER = [
  '---', 'type: bug', 'area: testing', 'date: 2026-09-14', 'run: run-2026-09-14',
  'severity: high', 'root_cause: test-isolation', 'status: current', '---', '', '# A title', '',
].join('\n');

const CASES = [
  {
    name: 'a body with a trigger line is reachable',
    files: {
      'learnings/_index.md': '# Learnings index\n- L-001 [gotcha][api] the symptom line\n',
      'learnings/gotchas.md': '### L-001 [gotcha][api] the symptom line\n\nthe body\n',
    },
    absent: ['reach'],
  },
  {
    // The exact shape the real pass produced: anchor intact, trigger gone.
    name: 'a body whose trigger was dropped without a fold is unreachable',
    files: {
      'learnings/_index.md': '# Learnings index\n- L-002 [gotcha][api] another symptom\n',
      'learnings/gotchas.md': '### L-001 [gotcha][api] the symptom\n\nbody one\n\n### L-002 [gotcha][api] another symptom\n\nbody two\n',
    },
    expect: { check: 'reach', level: 'block', ids: ['L-001'] },
  },
  {
    name: 'a body named inside a cluster map is reachable — that is what Demote means',
    files: {
      'learnings/_index.md': '# Learnings index\n- C-01 [gotcha][api] the principle these share\n',
      'learnings/gotchas.md': [
        '### C-01 [gotcha][api] the principle these share',
        '',
        '- L-001 — its symptom',
        '- L-002 — its symptom',
        '',
        '### L-001 [gotcha][api] the symptom',
        '',
        'body one',
        '',
        '### L-002 [gotcha][api] another symptom',
        '',
        'body two',
      ].join('\n'),
    },
    absent: ['reach'],
  },
  {
    name: 'a folded group line reaches the range it names',
    files: {
      'decisions/_index.md': '# Decisions index\n- D-759-001…102 (102 decisions) — epic done; bodies in decisions/759/\n',
      'decisions/759/item-1.md': '### D-759-001 · active\n\nbody\n\n### D-759-017 · active\n\nbody\n',
    },
    absent: ['reach'],
  },
  {
    name: 'an over-budget index names the commentary share when moving it would be enough',
    files: {
      // ~36KB of entries (inside budget on their own) under ~9KB of commentary,
      // so the fix the message names — move the commentary — is the true one.
      'learnings/_index.md':
        '# Learnings index\n' +
        '<!-- ' + 'maintenance notes '.repeat(500) + ' -->\n' +
        '- L-001 [gotcha][api] short trigger\n' +
        ('- L-002 [gotcha][api] ' + 'x'.repeat(100) + '\n').repeat(290),
      'learnings/gotchas.md': '### L-001 [gotcha][api] short trigger\n\nbody\n\n### L-002 [gotcha][api] x\n\nbody\n',
    },
    expect: { check: 'budget', level: 'block', message: '_maintenance.md' },
  },
  {
    name: 'commentary inside budget still warns once it dominates the file',
    files: {
      'learnings/_index.md':
        '# Learnings index\n' +
        '<!-- ' + 'maintenance notes '.repeat(150) + ' -->\n' +
        '- L-001 [gotcha][api] short trigger\n',
      'learnings/gotchas.md': '### L-001 [gotcha][api] short trigger\n\nbody\n',
    },
    expect: { check: 'budget', level: 'warn', message: 'maintenance commentary' },
  },
  {
    name: 'an over-long trigger line blocks',
    files: {
      'learnings/_index.md': '# Learnings index\n- L-001 [gotcha][api] ' + 'x'.repeat(220) + '\n',
      'learnings/gotchas.md': '### L-001 [gotcha][api] x\n\nbody\n',
    },
    expect: { check: 'budget', level: 'block', message: 'exceed 200 chars' },
  },
  {
    name: 'a typed solution entry passes schema',
    files: { 'solutions/a-real-entry.md': FRONTMATTER },
    absent: ['schema'],
  },
  {
    name: 'a free-text root_cause blocks — it cannot be grepped',
    files: { 'solutions/a-real-entry.md': FRONTMATTER.replace('root_cause: test-isolation', 'root_cause: the harness measured nothing') },
    expect: { check: 'schema', level: 'block', message: 'closed set' },
  },
  {
    name: 'missing frontmatter keys block',
    files: { 'solutions/a-real-entry.md': '---\narea: testing\n---\n\n# A title\n' },
    expect: { check: 'schema', level: 'block', message: 'typed frontmatter' },
  },
  {
    // Identity decoupled from name: renaming the slug must not break the handle.
    name: 'an entry carrying an id raises no id finding',
    files: { 'solutions/a-real-entry.md': FRONTMATTER.replace('---\n', '---\nid: S-001\n') },
    absent: ['schema'],
  },
  {
    name: 'entries without an id warn — a rename would break their references',
    files: { 'solutions/a-real-entry.md': FRONTMATTER },
    expect: { check: 'schema', level: 'warn', message: 'no `id:`' },
  },
  {
    // The failure mode numeric handles introduce: two parallel runs each read
    // the same max and each allocate the next.
    name: 'two entries under one handle block',
    files: {
      'solutions/first.md': FRONTMATTER.replace('---\n', '---\nid: S-007\n'),
      'solutions/second.md': FRONTMATTER.replace('---\n', '---\nid: S-007\n'),
    },
    expect: { check: 'schema', level: 'block', message: 'more than one entry' },
  },
  {
    name: 'a done rollup with no promotion block warns — epic close is the gate event',
    files: { 'epics/e.md': '---\nepic: E\nstatus: done\n---\n\n| # | Sub-goal |\n|---|---|\n| 1 | x (D-e-001) |\n' },
    expect: { check: 'cite', level: 'warn', message: 'Promotion candidates' },
  },
  {
    name: 'a rollup that cites its decisions and lists candidates is clean',
    files: {
      'epics/e.md': [
        '---', 'epic: E', 'status: done', '---', '',
        '| # | Sub-goal |', '|---|---|', '| 1 | x (D-e-001) |', '',
        '## Promotion candidates', '', 'none — epic-local generator knowledge', '',
      ].join('\n'),
    },
    absent: ['cite'],
  },
  {
    // A store predating a rule fails it by the hundred; a gate that blocks every
    // stop until all of it is fixed is a gate nobody can work behind.
    name: 'debt at or under the baseline is reported, not blocking',
    files: {
      'learnings/_index.md': '# Learnings index\n',
      'learnings/gotchas.md': '### L-001 [gotcha][api] one\n\nbody\n\n### L-002 [gotcha][api] two\n\nbody\n',
    },
    baseline: { reach: 2 },
    absent: ['reach'],
    expect: { check: 'reach', level: 'debt' },
  },
  {
    name: 'debt above the baseline blocks again — the ratchet only turns one way',
    files: {
      'learnings/_index.md': '# Learnings index\n',
      'learnings/gotchas.md': '### L-001 [gotcha][api] one\n\nbody\n\n### L-002 [gotcha][api] two\n\nbody\n',
    },
    baseline: { reach: 1 },
    expect: { check: 'reach', level: 'block' },
  },
  {
    name: 'a baseline on one check does not silence another',
    files: {
      'learnings/_index.md': '# Learnings index\n',
      'learnings/gotchas.md': '### L-001 [gotcha][api] one\n\nbody\n',
      'solutions/e.md': FRONTMATTER.replace('root_cause: test-isolation', 'root_cause: a whole sentence'),
    },
    baseline: { reach: 1 },
    expect: { check: 'schema', level: 'block' },
  },
  {
    name: 'an empty store is clean',
    files: { 'learnings/_index.md': '# Learnings index\n' },
    absent: ['reach', 'budget', 'schema', 'cite'],
  },
];

let failed = 0;
for (const c of CASES) {
  const dir = store(c.files);
  let ok = true;
  let detail = '';
  try {
    const found = lint(dir, c.baseline ? { baseline: c.baseline } : {});
    if (c.expect) {
      const hit = found.find((f) =>
        f.check === c.expect.check
        && (!c.expect.level || f.level === c.expect.level)
        && (!c.expect.message || f.message.includes(c.expect.message))
        && (!c.expect.ids || c.expect.ids.every((id) => (f.ids ?? []).includes(id))));
      if (!hit) { ok = false; detail = ` (no ${c.expect.check}/${c.expect.level} finding; got ${JSON.stringify(found.map((f) => `${f.level}:${f.check}`))})`; }
    }
    for (const check of c.absent ?? []) {
      if (found.some((f) => f.check === check && f.level === 'block')) {
        ok = false; detail += ` (unexpected blocking ${check}: ${found.find((f) => f.check === check).message.slice(0, 110)})`;
      }
    }
  } catch (e) {
    ok = false; detail = ` (threw: ${e.message})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${detail}`);
}

console.log(failed === 0 ? `\nall ${CASES.length} checks passed` : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
