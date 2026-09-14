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
import { execFileSync } from 'node:child_process';
import { readStdinJson, hooksOff, loadState, readIfExists } from './lib.mjs';

const MAX_SLUGS = 8;

/**
 * Is the memory store outside git?
 *
 * The maintenance contract permits **Delete**, and justifies it with "git
 * history is the archive". That sentence is only true of a tracked file. A real
 * store of 509 learnings, 547 decisions and 66 solution entries sat entirely
 * untracked — `git ls-files` returned 0 — so every Delete was unrecoverable and
 * nothing said so. One line at session start is the cheapest place to say it.
 *
 * `git check-ignore` exits 1 when the path is NOT ignored, which is the healthy
 * case; any other failure (no git, no repo) means there is nothing to warn about.
 */
function memoryUntracked(cwd) {
  const probe = join('.loop', 'memory', 'learnings', '_index.md');
  if (!existsSync(join(cwd, probe))) return false;
  try {
    execFileSync('git', ['check-ignore', '-q', probe], { cwd, stdio: 'ignore' });
    return true; // exit 0 — the store is ignored
  } catch {
    return false;
  }
}

function mdSlugs(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')); }
  catch { return []; }
}

/** Trigger lines in an index, else tagged one-liners in the flat legacy file. */
function countEntries(memDir, root, legacyFile) {
  const idx = readIfExists(join(memDir, root, '_index.md'));
  const text = idx !== null ? idx : (legacyFile ? readIfExists(join(memDir, legacyFile)) : null);
  if (!text) return 0;
  return text.split('\n').filter((l) => /^-\s*(?:[LD]-|\[)/.test(l.trim())).length;
}

function memoryDigest(cwd) {
  const memDir = join(cwd, '.loop', 'memory');
  if (!existsSync(memDir)) return '';
  const learnings = countEntries(memDir, 'learnings', 'learnings.md');
  const decisions = countEntries(memDir, 'decisions', 'decisions.md');
  const solutions = mdSlugs(join(memDir, 'solutions'));
  const epics = mdSlugs(join(memDir, 'epics'));
  const slugList = solutions.length
    ? ` (${solutions.slice(0, MAX_SLUGS).join(', ')}${solutions.length > MAX_SLUGS ? ', …' : ''})`
    : '';
  return (
    `[loop-engineering] Project memory: ${learnings} learnings, ${decisions} decisions, ` +
    `${solutions.length} solution entr${solutions.length === 1 ? 'y' : 'ies'}${slugList}, ` +
    `${epics.length} epic rollup${epics.length === 1 ? '' : 's'} under .loop/memory/. ` +
    `Relevant entries auto-inject on each prompt — strong matches arrive with their body, ` +
    `weaker ones with the grep that opens it; account for each injected ID in the run's Recall: line. ` +
    `For deliberate recall read _index.md and grep by [type][area] tag (budget: 5). ` +
    `Capture ad-hoc findings as one-liners in .loop/memory/scratch/adhoc.md; ` +
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
  if (memoryUntracked(cwd)) {
    out +=
      `[loop-engineering] .loop/memory/ is git-ignored, so a maintenance Delete cannot be recovered. ` +
      `The contract commits .loop/ by default — drop the \`.loop/\` line from .gitignore before the next ` +
      `/loop-engineering:memory pass. To keep run state out while still tracking the store, git cannot ` +
      `un-ignore a child of an ignored directory, so the parent must be \`.loop/*\` + \`!.loop/memory/\` ` +
      `+ \`.loop/memory/scratch/\`.\n`;
  }

  if (out) process.stdout.write(out);
  return 0;
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
