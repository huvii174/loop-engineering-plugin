#!/usr/bin/env node
/**
 * loop-reminder — SessionStart hook.
 *
 * Two context lines a new session must not start without:
 * 1. Open loop (running or stuck) — so the session resumes instead of redoing.
 * 2. Memory digest — when .loop/memory/ exists, one line naming what the store
 *    holds, so ad-hoc sessions (no slash command) know memory exists, that
 *    relevant entries auto-inject per prompt (memory-recall hook), and where
 *    ad-hoc findings go (scratch/adhoc.md). This is the cheap layer of the
 *    layered recall design; the per-prompt grep is the targeted layer.
 *
 * Never blocks; fail-open; LOOP_HOOKS_OFF=1 bypass.
 */

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readStdinJson, hooksOff, loadState, readIfExists } from './lib.mjs';

const MAX_SLUGS = 8;

function mdSlugs(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')); }
  catch { return []; }
}

function memoryDigest(cwd) {
  const memDir = join(cwd, '.loop', 'memory');
  if (!existsSync(memDir)) return '';
  const learnings = readIfExists(join(memDir, 'learnings.md')) || '';
  const oneLiners = learnings.split('\n').filter((l) => /^-\s*\[/.test(l.trim())).length;
  const solutions = mdSlugs(join(memDir, 'solutions'));
  const epics = mdSlugs(join(memDir, 'epics'));
  const slugList = solutions.length
    ? ` (${solutions.slice(0, MAX_SLUGS).join(', ')}${solutions.length > MAX_SLUGS ? ', …' : ''})`
    : '';
  return (
    `[loop-engineering] Project memory: ${oneLiners} learnings, ` +
    `${solutions.length} solution entr${solutions.length === 1 ? 'y' : 'ies'}${slugList}, ` +
    `${epics.length} epic rollup${epics.length === 1 ? '' : 's'} under .loop/memory/. ` +
    `Relevant entries auto-inject on each prompt; for deliberate recall grep by [type][area] tag ` +
    `(budget: 5). Capture ad-hoc findings as one-liners in .loop/memory/scratch/adhoc.md; ` +
    `distil with /loop-engineering:memory.\n`
  );
}

async function main() {
  if (hooksOff()) return 0;
  const input = await readStdinJson();
  const cwd = input.cwd || process.cwd();

  let out = '';
  const state = loadState(cwd);
  if (state) {
    const { status, iteration = 0, max_iterations = 12, history = [], tier } = state.data;
    if (status === 'running' || status === 'stuck') {
      const last = history[history.length - 1];
      const lastLine = last ? ` Last: iter ${last.n} "${last.intent ?? last.approach ?? ''}" → ${last.verdict}.` : '';
      out +=
        `[loop-engineering] Open loop in this project: status=${status}, ` +
        `iteration ${iteration}/${max_iterations}${tier ? `, tier ${tier}` : ''}.${lastLine} ` +
        `Resume with /loop-engineering:loop (state: .loop/state.json — read it before doing loop work; never redo completed iterations).\n`;
    }
  }
  out += memoryDigest(cwd);

  if (out) process.stdout.write(out);
  return 0;
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
