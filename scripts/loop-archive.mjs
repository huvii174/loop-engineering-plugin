#!/usr/bin/env node
/**
 * loop-archive — deterministic filing for `.loop/`.
 *
 * Archiving used to be prose the model followed by hand ("move goal.md,
 * design.md, prompt.md, state.json and iterations/ into .loop/archive/<run_id>/").
 * Prose that says "move X into Y" reads as `mv X Y/`, and `mv` into a target that
 * already holds an X puts the second one *inside* the first: the dogfood run
 * really contains archive/run-2026-08-17-pmA3b-walkers/iterations/iterations/.
 * Here every destination is a full explicit path, never a directory to drop
 * things into, and the finished archive is checked for exactly that shape — so
 * the doubling cannot be recreated, not even by a retry after a crash.
 *
 *   node loop-archive.mjs run     [--id <run_id>] [--dir .loop] [--dry-run] [--force] [--allow-gaps]
 *   node loop-archive.mjs epic    --slug <epic-slug> [--dir .loop] [--dry-run] [--force]
 *   node loop-archive.mjs hygiene [--dir .loop] [--dry-run]
 *   node loop-archive.mjs prune   [--keep 20] [--dir .loop] [--dry-run] [--yes]
 *
 * Exit codes:
 *   0  done — the plan was applied, or printed under --dry-run
 *   1  refused — a guard fired (destination occupied, epic rollup missing,
 *      unusable id, nothing to archive) or the filesystem said no
 *
 * --dry-run prints the plan and writes nothing, on every subcommand. `prune` is
 * the only subcommand whose whole job is deletion, so it *starts* in dry-run:
 * it prints what it would remove and removes nothing until an explicit --yes.
 *
 * --force replaces exactly the destination entries this command is about to
 * write, and nothing else. It never empties an archive directory wholesale.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { integrationPoint } from './loop-close.mjs';

/** What a finished run leaves behind at the top of `.loop/`. */
const RUN_ITEMS = ['goal.md', 'design.md', 'prompt.md', 'state.json', 'iterations'];

/** Directories that are tool exhaust: never authored, never worth keeping. */
const DROPPING_DIRS = ['.omc', '__pycache__'];
const DROPPING_FILES = ['.DS_Store'];
const DROPPING_SUFFIX = '.pyc';

// ------------------------------------------------------------------- utilities

/**
 * Names we are willing to build a destination path out of. A run id and an epic
 * slug both arrive from a file or an argument, and both end up concatenated into
 * a path that gets written to — `..` or a leading dot must never survive that.
 */
export function safeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

/**
 * A refusal, and which flag is an answer to it. `--force` answers only "the
 * destination is occupied"; `--allow-gaps` answers only "records are missing",
 * and recording that loss is the point of the flag rather than waiving it.
 * A missing epic rollup or an interrupted archive has to be looked at by a
 * person. Tagging each here rather than matching on the message keeps the
 * flag and its refusal from drifting apart.
 */
const refusal = (text, { waivedByForce = false, waivedByAllowGaps = false } = {}) =>
  ({ text, waivedByForce, waivedByAllowGaps });

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function readIfExists(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** Rename, falling back to copy-then-remove when the two paths straddle mounts. */
function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * The check that makes the original bug unrepeatable: no entry of `root` may
 * contain a child of its own name. `iterations/iterations` is the shape a
 * hand-written `mv` produces on a second pass, and it is cheap to refuse.
 */
function assertNoDoubling(root) {
  for (const name of readdirSync(root)) {
    if (existsSync(join(root, name, name))) {
      throw new Error(`refusing to leave a nested copy: ${join(root, name, name)}`);
    }
  }
}

/** Sorted, symlink-safe scan for tool droppings; a dropping dir is not descended into. */
function scanDroppings(root) {
  const hits = [];
  const visit = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (DROPPING_DIRS.includes(e.name)) hits.push({ path: p, why: `${e.name}/ is tool exhaust` });
        else visit(p);
      } else if (DROPPING_FILES.includes(e.name) || e.name.endsWith(DROPPING_SUFFIX)) {
        hits.push({ path: p, why: `${e.name} is tool exhaust` });
      }
    }
  };
  visit(root);
  return hits;
}

// ------------------------------------------------------------------- run

/**
 * Plan the archive of one finished run.
 *
 * `target` is built fresh and items land at named paths inside it. A target that
 * already exists is a refusal rather than a merge, because the two ways to
 * "merge" — dropping items into it, or renaming onto it — are the two ways the
 * nested directory appears.
 */
export function planRun(dir, runId, { force = false, allowGaps = false } = {}) {
  const refusals = [];
  const notes = [];
  const id = runId ?? runIdFromState(dir);

  if (!id) {
    refusals.push(refusal(`no run id: pass --id, or leave a run_id in ${join(dir, 'state.json')}`));
    return { kind: 'run', actions: [], refusals, notes };
  }
  if (!safeName(id)) {
    refusals.push(refusal(`unusable run id ${JSON.stringify(id)} — letters, digits, dot, dash and underscore only`));
    return { kind: 'run', actions: [], refusals, notes };
  }

  const target = join(dir, 'archive', id);
  const staging = join(dir, 'archive', `.staging-${id}`);
  const actions = [];
  const missing = [];
  for (const name of RUN_ITEMS) {
    const from = join(dir, name);
    if (existsSync(from)) actions.push({ verb: 'move', from, to: join(target, name), name });
    else missing.push(name);
  }
  if (missing.length && actions.length) notes.push(`not present, so not archived: ${missing.join(', ')}`);

  if (!actions.length) {
    refusals.push(refusal(`nothing to archive: none of ${RUN_ITEMS.join(', ')} exist under ${dir}`));
  }
  if (existsSync(target)) {
    refusals.push(refusal(
      actions.length
        ? `${target} already exists — a second archive under one id is how iterations/iterations happened. ` +
          'Check it, then re-run with --force to replace the entries above.'
        : `${target} already exists and this run has already been archived — nothing left to move.`,
      { waivedByForce: true }
    ));
  }
  if (existsSync(staging)) {
    refusals.push(refusal(`${staging} is left over from an interrupted archive — inspect and remove it, then retry`));
  }

  // A run is archived once and read forever. 42 of 308 iteration records in a
  // real archive did not exist while state.json still counted them, and 16 runs
  // had none at all — the evidence half of "done" was gone and nothing had said
  // so. Refusing here is the last moment anyone can still find them.
  const gaps = missingRecords(dir);
  if (gaps.length) {
    refusals.push(refusal(
      `state.json's history names ${gaps.length} iteration(s) with no record on disk: ${gaps.join(', ')}. ` +
      `Write them, or archive with --allow-gaps to record the loss in the archived state.json instead of losing it.`,
      { waivedByAllowGaps: true }
    ));
  }
  // The epic's integration point: its epic gate runs before the next item's design gate, and that
  // design gate archives this run first — so the run leaves only once the gate is on its state.
  const warnings = [];
  const state = parseJson(readIfExists(join(dir, 'state.json')));
  if (state && state.status === 'done' && !(state.epic_gate && typeof state.epic_gate === 'object')) {
    const p = integrationPoint(dir);
    if (p?.refusal) {
      warnings.push(`not checked for an epic integration point — loop-close's reader refused: ${p.refusal}`);
    } else if (p?.point) {
      refusals.push(refusal(
        `item ${p.item} is epic ${p.slug}'s integration point and state.json has no epic_gate — run the epic gate ` +
        '(loop-engineering:loop-review skill, Epic gate) and record it with `loop-record.mjs --epic-gate "<summary>"`, then archive.'
      ));
    }
  }
  return { kind: 'run', actions, refusals, notes, warnings, target, staging, force, gaps, allowGaps };
}

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Iteration numbers `history` claims that `iterations/` does not hold.
 *
 * Read from `history` rather than from `iteration`, so a run whose counter also
 * drifted still reports against something recorded per entry.
 */
export function missingRecords(dir) {
  const history = parseJson(readIfExists(join(dir, 'state.json')))?.history;
  if (!Array.isArray(history) || !history.length) return [];
  let present;
  try {
    present = new Set(readdirSync(join(dir, 'iterations'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => String(parseInt(f, 10))));
  } catch { present = new Set(); }
  return history
    .map((h) => Number(h.n))
    .filter((n) => Number.isFinite(n) && !present.has(String(n)))
    .map((n) => String(n).padStart(4, '0'));
}

/** The run id recorded by the run itself, when `--id` was not given. */
function runIdFromState(dir) {
  return parseJson(readIfExists(join(dir, 'state.json')))?.run_id ?? null;
}

/**
 * Items go to a staging directory first, which is then renamed into place, so an
 * interruption leaves either the old shape or the new one — never a half-filled
 * target that the next attempt would file things *inside* of.
 */
function applyRun(plan) {
  const { target, staging, actions, force } = plan;
  mkdirSync(staging, { recursive: true });
  for (const a of actions) move(a.from, join(staging, a.name));
  assertNoDoubling(staging);

  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
  } else if (force) {
    // Replace the entries we just archived; anything else already in the target
    // is someone's earlier work and stays.
    for (const a of actions) {
      rmSync(a.to, { recursive: true, force: true });
      move(join(staging, a.name), a.to);
    }
    rmSync(staging, { recursive: true, force: true });
  } else {
    // main() refuses before reaching here; a direct caller gets the same answer
    // rather than a silent no-op that leaves everything in staging.
    throw new Error(`${target} already exists — pass force to replace its entries (staged at ${staging})`);
  }
  assertNoDoubling(target);
  recordGaps(target, plan.gaps);
}

/**
 * Write the missing-record numbers into the archived state, so the loss is data
 * rather than an absence a later reader has to notice. The reader of an archive
 * cannot tell "iteration 10 was never written" from "iteration 10 never ran"
 * unless the archive says which.
 */
function recordGaps(target, gaps) {
  if (!gaps?.length) return;
  const p = join(target, 'state.json');
  const raw = readIfExists(p);
  if (!raw) return;
  try {
    const state = JSON.parse(raw);
    state.missing_iteration_records = gaps;
    writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  } catch { /* an unparseable state file was already the caller's problem */ }
}

// ------------------------------------------------------------------ epic

/**
 * Plan the archive of a finished epic instance.
 *
 * The instance directory is scaffolding; the epic's knowledge lives in
 * `memory/epics/<slug>.md`, which is never archived. Filing the instance without
 * that rollup written first throws the epic away, so this refuses rather than
 * lets it happen quietly.
 */
export function planEpic(dir, slug) {
  const refusals = [];
  const notes = [];

  if (!safeName(slug ?? '')) {
    refusals.push(refusal(`unusable epic slug ${JSON.stringify(slug)} — pass --slug <epic-slug>`));
    return { kind: 'epic', actions: [], refusals, notes };
  }

  const from = join(dir, 'epics', slug);
  const to = join(dir, 'archive', 'epics', slug);
  const rollup = join(dir, 'memory', 'epics', `${slug}.md`);

  if (!isDir(from)) refusals.push(refusal(`${from} does not exist — nothing to archive`));
  if (!existsSync(rollup)) {
    refusals.push(refusal(
      `${rollup} does not exist. That rollup is the retained knowledge; the instance directory is ` +
      'scaffolding. Archiving one without the other loses the epic — write the epic retro first.'
    ));
  }
  if (existsSync(to)) {
    refusals.push(refusal(
      `${to} already exists — check it, then re-run with --force to replace it`, { waivedByForce: true }
    ));
  }

  const active = (readIfExists(join(dir, 'active-epic')) ?? '').split('\n')[0].trim();
  if (active === slug) notes.push(`${join(dir, 'active-epic')} still points at ${slug} — clear it after this`);

  const actions = [{ verb: 'move', from, to }];

  // Decisions retire WITH their epic (the loop-memory contract's designed
  // exception to "memory/ is never archived") — that is the point of sharding
  // them by epic. Still-binding ones are promoted to durable.md BEFORE this
  // runs; the archive move is what happens to the rest, and doing it here keeps
  // the hand-`mv` that doubled a directory once from coming back for decisions.
  const decisionsDir = join(dir, 'memory', 'decisions', slug);
  if (isDir(decisionsDir)) {
    actions.push({ verb: 'move', from: decisionsDir, to: join(to, 'decisions') });
    notes.push(
      `promote any still-binding decision from ${decisionsDir} into memory/decisions/durable.md ` +
      `(keeping its ID) BEFORE confirming, then drop the retired \`## ${slug}\` group from ` +
      `memory/decisions/_index.md — index lines must not outlive their bodies`
    );
  }

  return { kind: 'epic', actions, refusals, notes, target: to };
}

// --------------------------------------------------------------- hygiene

/**
 * Plan the removal of tool droppings, and *report* evidence that looks misfiled.
 *
 * Deleting exhaust is safe: nobody wrote it and nobody reads it. Moving someone's
 * evidence is not — the file may be deliberately global, and a silent relocation
 * costs more than the mess it tidies. So the loose-evidence half prints the move
 * and leaves the decision with the person holding the context.
 */
export function planHygiene(dir) {
  const actions = scanDroppings(dir).map((h) => ({ verb: 'delete', from: h.path, why: h.why }));
  const notes = [];
  const suggestions = [];
  const doomed = new Set(actions.map((a) => a.from));

  const active = (readIfExists(join(dir, 'active-epic')) ?? '').split('\n')[0].trim();
  const loose = join(dir, 'evidence');
  const owned = join(dir, 'epics', active, 'evidence');

  if (active && safeName(active) && isDir(loose) && isDir(owned)) {
    const strays = readdirSync(loose).sort().filter((n) => !doomed.has(join(loose, n)));
    if (strays.length) {
      notes.push(
        `${strays.length} item(s) sit loose at ${loose} while the active epic ${active} has its own ` +
        `${owned}. Nothing was moved — check each, then:`
      );
      for (const n of strays) suggestions.push(`git mv ${join(loose, n)} ${join(owned, n)}`);
    }
  }
  // Sweeping the FILES out of a dropping tree leaves the tree. `.loop/memory/`
  // really held an empty `.claude/.cc-writes/` after an earlier sweep, and an
  // empty dot-directory under the store is the same lie the files were: it makes
  // the store look like something wrote to it.
  for (const d of emptyDotDirs(dir, doomed)) {
    actions.push({ verb: 'delete', from: d, why: 'an empty dot-directory left by an earlier sweep' });
  }

  // A hand-written resume file is someone's evidence, so it is never deleted —
  // only named, and only once `parallel.json` has made it redundant.
  for (const n of readdirSync(dir).filter((f) => /^RESUME-.*\.md$/.test(f))) {
    if (existsSync(join(dir, 'parallel.json'))) {
      suggestions.push(
        `${join(dir, n)} predates .loop/parallel.json, which now records the slices it was written to ` +
        `carry. Fold anything still live into the run's record, then remove it by hand.`
      );
    }
  }

  return { kind: 'hygiene', actions, refusals: [], notes, suggestions };
}

/** Dot-directories under `dir` that hold nothing but other empty dot-directories. */
export function emptyDotDirs(dir, doomed = new Set()) {
  const hits = [];
  const visit = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return false; }
    let live = false;
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (doomed.has(p)) continue;              // already being removed this pass
      if (e.isDirectory()) { if (visit(p)) live = true; }
      else live = true;
    }
    // Report only dot-directories; a real empty directory may be a scaffold
    // someone meant to leave.
    if (!live && d !== dir && basename(d).startsWith('.')) { hits.push(d); return false; }
    return live;
  };
  visit(dir);
  return hits;
}

// ----------------------------------------------------------------- prune

/** Sort key for archived runs: the date in the id first, mtime inside a day. */
/**
 * Sort key for archived runs: id date first, mtime within a day, name last.
 * mtime is floored to whole ms before padding — fractional mtimes (common on
 * macOS) have varying digit counts, and padding the raw string misaligns the
 * comparison exactly between same-day runs, where mtime is the tiebreak.
 */
function runOrder(dir, name) {
  const m = /^run-(\d{4}-\d{2}-\d{2})/.exec(name);
  let mtime = 0;
  try { mtime = statSync(join(dir, name)).mtimeMs; } catch { /* unreadable sorts oldest */ }
  return `${m ? m[1] : '0000-00-00'}|${String(Math.floor(mtime)).padStart(20, '0')}|${name}`;
}

/**
 * Plan the deletion of archived runs that no longer carry anything.
 *
 * Two independent rules, applied in this order so the survivor count is the one
 * that was asked for: a run whose epic is already archived goes regardless of
 * age (its lessons are in `memory/epics/<slug>.md`), and of what is left, the
 * newest `keep` stay.
 */
export function planPrune(dir, keep) {
  const archive = join(dir, 'archive');
  const refusals = [];
  const notes = [];

  if (!Number.isFinite(keep) || keep < 0) {
    refusals.push(refusal(`unusable --keep ${JSON.stringify(keep)} — pass a non-negative number`));
    return { kind: 'prune', actions: [], refusals, notes };
  }
  if (!isDir(archive)) {
    notes.push(`${archive} does not exist — nothing archived yet`);
    return { kind: 'prune', actions: [], refusals, notes };
  }

  const archivedEpics = new Set(
    isDir(join(archive, 'epics'))
      ? readdirSync(join(archive, 'epics')).filter((n) => isDir(join(archive, 'epics', n)))
      : []
  );
  const runs = readdirSync(archive)
    .filter((n) => n.startsWith('run-') && isDir(join(archive, n)))
    .sort((a, b) => runOrder(archive, b).localeCompare(runOrder(archive, a)));  // newest first

  const actions = [];
  const standing = [];
  for (const name of runs) {
    const epic = epicOfRun(join(archive, name));
    if (epic && archivedEpics.has(epic)) {
      actions.push({
        verb: 'delete', from: join(archive, name),
        why: `epic ${epic} is archived; its lessons live in ${join(dir, 'memory', 'epics', `${epic}.md`)}`,
      });
    } else standing.push(name);
  }
  for (const name of standing.slice(keep)) {
    actions.push({ verb: 'delete', from: join(archive, name), why: `older than the newest ${keep}` });
  }
  notes.push(`${runs.length} archived run(s); ${Math.min(standing.length, keep)} kept, ${actions.length} to remove`);
  return { kind: 'prune', actions, refusals, notes };
}

/** The epic an archived run belonged to, from its own state.json. */
function epicOfRun(runDir) {
  const raw = readIfExists(join(runDir, 'state.json'));
  if (!raw) return null;
  try {
    const epic = JSON.parse(raw).epic;
    return typeof epic === 'string' && epic ? epic : null;
  } catch { return null; }
}

// ------------------------------------------------------------------- apply

/** One line per action — the same text whether it is a plan or a receipt. */
export function describe(action) {
  return action.verb === 'move'
    ? `move    ${action.from} -> ${action.to}`
    : `delete  ${action.from}${action.why ? `  (${action.why})` : ''}`;
}

/**
 * Carry out a plan. `run` stages; everything else is independent per action, so
 * a failure part-way leaves the actions before it done and says which one broke.
 */
export function applyPlan(plan) {
  if (plan.kind === 'run') { applyRun(plan); return; }
  for (const a of plan.actions) {
    if (a.verb === 'move') {
      if (existsSync(a.to)) rmSync(a.to, { recursive: true, force: true });
      move(a.from, a.to);
    } else {
      rmSync(a.from, { recursive: true, force: true });
    }
  }
}

// -------------------------------------------------------------------- main

const USAGE = `loop-archive — deterministic filing for .loop/

  loop-archive run     [--id <run_id>] [--dir .loop] [--dry-run] [--force] [--allow-gaps]
  loop-archive epic    --slug <epic-slug> [--dir .loop] [--dry-run] [--force]
  loop-archive hygiene [--dir .loop] [--dry-run]
  loop-archive prune   [--keep 20] [--dir .loop] [--dry-run] [--yes]`;

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const has = (flag) => args.includes(flag);
  const dir = get('--dir', '.loop');
  const force = has('--force');
  const allowGaps = has('--allow-gaps');

  let plan;
  switch (cmd) {
    case 'run': plan = planRun(dir, get('--id', null), { force, allowGaps }); break;
    case 'epic': plan = planEpic(dir, get('--slug', null)); break;
    case 'hygiene': plan = planHygiene(dir); break;
    case 'prune': plan = planPrune(dir, Number(get('--keep', '20'))); break;
    default:
      process.stderr.write(`${cmd ? `loop-archive: unknown subcommand "${cmd}"\n\n` : ''}${USAGE}\n`);
      return 1;
  }

  // --force answers "the destination is occupied" and nothing else; a missing
  // epic rollup or an interrupted archive still has to be looked at.
  const refusals = plan.refusals.filter(
    (r) => !(force && r.waivedByForce) && !(allowGaps && r.waivedByAllowGaps));
  if (refusals.length) {
    for (const r of refusals) process.stderr.write(`loop-archive: ${r.text}\n`);
    return 1;
  }

  // prune deletes for a living, so it stays in dry-run until told otherwise.
  const dryRun = has('--dry-run') || (cmd === 'prune' && !has('--yes'));
  for (const w of plan.warnings ?? []) process.stderr.write(`loop-archive: ${w}\n`);
  for (const n of plan.notes) process.stdout.write(`note    ${n}\n`);
  for (const a of plan.actions) process.stdout.write(`${dryRun ? '(dry-run) ' : ''}${describe(a)}\n`);
  for (const s of plan.suggestions ?? []) process.stdout.write(`suggest ${s}\n`);

  if (!dryRun) {
    try {
      applyPlan(plan);
    } catch (e) {
      process.stderr.write(`loop-archive: ${e.message}\n`);
      return 1;
    }
  }
  const verb = dryRun ? 'would' : '';
  const what = plan.kind === 'hygiene' || plan.kind === 'prune' ? 'remove' : 'file';
  process.stdout.write(
    `${cmd}: ${verb ? `${verb} ${what}` : `${what}d`} ${plan.actions.length} item(s)` +
    `${plan.target ? ` into ${plan.target}` : ''}` +
    `${cmd === 'prune' && dryRun && plan.actions.length ? ' — pass --yes to delete' : ''}\n`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));
