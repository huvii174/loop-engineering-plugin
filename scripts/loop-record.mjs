#!/usr/bin/env node
/**
 * loop-record — write one iteration into .loop/state.json.
 *
 * The record is code, for the same reason the breaker is. A loop that writes its
 * own history in prose and then asks a script to count it has two contracts and
 * keeps only one: a real store held 37 of 311 history entries outside
 * `pass|fail|escalate`, including two consecutive verifier REJECTs recorded as
 * `"verifier: REJECT (criterion 3) / APPROVE (1,2,4,5)"`. The stagnation counter
 * that exists to catch exactly that streak read it as zero. This script is the
 * one writer, so the verdict the counters read is the verdict that was meant.
 *
 *   node loop-record.mjs --verdict pass --kind criterion --criterion C3 \
 *     --criteria-passed 4 --intent "…" --approach "…" [--signature "…"]
 *
 * Exit codes:
 *   0  recorded — state.json updated, .loop/.recall-log emptied
 *   1  refused  — nothing written; stderr says what to fix
 *
 * Refusing beats writing something the breaker will misread later, so this
 * script fails CLOSED where the hooks fail open: a hook that breaks must not
 * block a user, while a recorder that breaks must not leave a half-written
 * history behind. Every check runs before the single write.
 *
 * What it refuses:
 *   - a verdict outside the enum, or a `kind` outside criterion|review-fix|bookkeeping
 *   - a missing or unparseable state file, or one whose `iteration` disagrees
 *     with `history` (the mismatch 27 of 75 archived runs carry)
 *   - an iteration record file that does not exist, or that lacks a section in
 *     REQUIRED_SECTIONS (the list, with why each is required, is below)
 *   - a `.recall-log` ID the record's `Recall:` line never accounts for
 *   - a missing `Sweep:` line, or one that classifies no hit, where one is owed:
 *     every review fix, and any record whose --criterion names a goal.md block
 *     carrying `Sites:` (see sweepRequirement)
 *
 * The recall reconciliation is the half no gate could do before. `.recall-log`
 * is an inbox: the recall hook appends every injected ID, and Record empties it
 * once each one is marked applied or dismissed. Checking that here — against the
 * record about to be committed — is what makes emptying it safe, because the log
 * is cleared only after the accounting that replaces it is on disk.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const VERDICTS = ['pass', 'fail', 'escalate'];

/**
 * `kind` says what an iteration aimed at, and only the plateau counter reads it.
 *
 * - `criterion`   — aimed at a success criterion; the plateau counter reads it.
 * - `review-fix`  — closed a review-gate finding. The criteria count is flat by
 *                   construction while these run, so counting them as a plateau
 *                   punishes the thorough gate and rewards the shallow one.
 * - `bookkeeping` — records, archives, memory. Already transparent to the
 *                   failure chain via `criteria_passed`; named here so the
 *                   intent is on the record rather than inferred from a number.
 *
 * The failure chain ignores `kind` entirely: a review-fix that fails is a
 * failure like any other.
 */
const KINDS = ['criterion', 'review-fix', 'bookkeeping'];

// ------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'dry-run') { out.dryRun = true; continue; }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) { out[key] = true; continue; }
    out[key] = value;
    i++;
  }
  return out;
}

const USAGE = `loop-record — write one iteration into .loop/state.json

  --verdict pass|fail|escalate     required
  --kind criterion|review-fix|bookkeeping   required
  --intent <text>                  required — one sentence
  --criteria-passed <n>            required — verifier-APPROVED criteria after this iteration
  --criterion <id>                 which criterion this aimed at (omit for bookkeeping)
  --approach <text>                what was tried, for the frustration counter
  --signature <text>               the failure's error signature, for stagnation
  --status <s>                     state.json status to write (default: running)
  --dir <path>                     loop directory (default: .loop)
  --dry-run                        run every check, write nothing

  --review-gate "<summary>"        record that the review gate ran, and what it
                                   found; writes state.review_gate, appends no
                                   history entry
  --epic-gate "<summary>"          record that the epic gate ran (loop-review,
                                   Epic gate); writes state.epic_gate, leaves
                                   review_gate as it is, appends no history entry
`;

// ----------------------------------------------------------------------- state

function loadState(statePath) {
  if (!existsSync(statePath)) {
    throw new Error(`no state file at ${statePath} — run /loop-engineering:design first`);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    throw new Error(`state file is not valid JSON: ${statePath} (${e.message})`);
  }
  if (!Array.isArray(state.history)) state.history = [];
  return state;
}

/**
 * The iteration record this call is about to account for.
 *
 * Numbered from `iteration + 1` rather than from the directory listing, so a
 * gap in the files cannot silently renumber the history. 42 of 308 records in a
 * real archive were missing while `state.json` still counted them; a recorder
 * that trusts the listing turns that into a wrong number instead of an error.
 */
function recordPath(dir, n) {
  return join(dir, 'iterations', String(n).padStart(4, '0') + '.md');
}

// ---------------------------------------------------------------------- checks

/**
 * The iteration-record fields a later reader cannot reconstruct from state.json.
 *
 * Not all ten of the format's fields: `Delegated`, `Learning` and `Next` are
 * narrative, and requiring them turns a record into a form. These seven each
 * have a consumer that breaks without them —
 *
 *   Verdict / Evidence            what the run claims, and what proves it
 *   Recall                        the accounting `.recall-log` is emptied against
 *   Goal criterion targeted       what the verifier graded; cross-checked below
 *   Verification                  the commands Evidence came out of — output
 *                                 without provenance is a screenshot
 *   Actions                       what changed, when the diff is long gone
 *   Injected                      what shaped this iteration's context
 *
 * Compliance across a real archive ran 61-80% on the full ten and 100% on
 * nothing; these are the subset worth refusing over.
 */
const REQUIRED_SECTIONS = [
  ['Verdict', /^\s*[-*]?\s*\*{0,2}Verdict\*{0,2}\s*:/im],
  ['Evidence', /^\s*[-*]?\s*\*{0,2}Evidence\*{0,2}\s*:/im],
  ['Recall', /^\s*[-*]?\s*\*{0,2}Recall\*{0,2}\s*:/im],
  ['Goal criterion targeted', /^\s*[-*]?\s*\*{0,2}Goal criterion targeted\*{0,2}\s*:/im],
  ['Verification', /^\s*[-*]?\s*\*{0,2}Verification\*{0,2}\s*:/im],
  ['Actions', /^\s*[-*]?\s*\*{0,2}Actions\*{0,2}\s*:/im],
  ['Injected', /^\s*[-*]?\s*\*{0,2}Injected\*{0,2}\s*:/im],
];

/**
 * The record's criterion line must name the criterion being recorded.
 *
 * `--criterion C3` beside a record reading `Goal criterion targeted: C7` is a
 * silent mismatch that corrupts the `criteria_passed` accounting the plateau
 * counter runs on, and nothing downstream can see it. Checked only for a short,
 * id-shaped value: a criterion quoted as a whole sentence is matched by the
 * reader, not by a substring test.
 */
const ID_SHAPED = 24;

function criterionMismatch(record, criterion) {
  if (!criterion || criterion.length > ID_SHAPED) return null;
  const line = /^\s*[-*]?\s*\*{0,2}Goal criterion targeted\*{0,2}\s*:(.*)$/im.exec(record);
  if (!line) return null; // its absence is already a REQUIRED_SECTIONS failure
  if (line[1].toLowerCase().includes(criterion.toLowerCase())) return null;
  return (
    `--criterion ${JSON.stringify(criterion)} is not named on the record's ` +
    `\`Goal criterion targeted:\` line (${JSON.stringify(line[1].trim().slice(0, 60))}). ` +
    `The two must agree, or criteria_passed counts one criterion while the record grades another.`
  );
}

/**
 * `Sweep:` — the record's half of "fix the class, not the instance".
 *
 * Required on every review fix, and on a record whose targeted criterion
 * carries `Sites:` in `.loop/goal.md` (shape: the loop-engine skill, "Sites and
 * Sweep"). `Sites: none (<reason>)` is the visible opt-out: it waives the
 * design-time sweep, never a review fix's.
 * The criterion's block is found from `--criterion`, never guessed: an id-shaped
 * value matches a block header as a word, a sentence matches the header or the
 * block's `Done when:` line. When goal.md carries `Sites:` and no single block
 * matches, the record is refused — a misspelled `--criterion` must not be the
 * way a sweep is skipped. A required sweep that classifies no hit ("none",
 * "n/a", "TBD") is refused too: it is silence in a longer form.
 */
const SWEEP_LINE = /^\s*[-*]?\s*\*{0,2}Sweep\*{0,2}\s*:(.*)$/im;
const SITES_LINE = /^\s*Sites\s*:(.*)$/im;
const SITES_ALL = /^\s*Sites\s*:(.*)$/gim;
const CLASSIFIED_HIT = /[\w./-]+:\d+\b[^;]*?\b(fixed|held|not-this-class)\b/i;

function criterionBlocks(goal) {
  const section = /^##\s+Success criteria[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(goal);
  const blocks = [];
  let cur = null;
  for (const line of (section ? section[1] : '').split('\n')) {
    if (/^\s*-\s*\[[ xX]\]/.test(line)) { cur = { header: line.trim(), lines: [line] }; blocks.push(cur); }
    else if (cur) cur.lines.push(line);
  }
  return blocks.map((b) => {
    const text = b.lines.join('\n');
    const done = /^\s*Done when\s*:(.*)$/im.exec(text);
    return { header: b.header, text, doneWhen: done ? done[1] : '' };
  });
}

const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** { required, why } or { problem }; `required: false` costs the record nothing. */
function sweepRequirement(kind, criterion, goal) {
  if (kind === 'review-fix') return { required: true, why: 'every review fix carries a sweep' };
  if (!goal || !SITES_LINE.test(goal)) return { required: false };
  // Any kind that names a criterion is looked up: a bookkeeping entry carrying
  // `--criterion` must not be the way a `Sites:` criterion closes unswept.
  if (!criterion) {
    if (kind !== 'criterion') return { required: false };
    return { problem: '.loop/goal.md carries `Sites:` but no --criterion names the targeted criterion, so the recorder cannot tell whether this record owes a `Sweep:` line. Pass --criterion.' };
  }
  const c = String(criterion);
  const word = new RegExp(`(^|[^\\w])${escapeRe(c)}([^\\w]|$)`, 'i');
  const lower = c.toLowerCase();
  const matches = criterionBlocks(goal).filter((b) => (c.length <= ID_SHAPED
    ? word.test(b.header)
    : b.header.toLowerCase().includes(lower) || b.doneWhen.toLowerCase().includes(lower)));
  if (matches.length !== 1) {
    const found = matches.length ? `${matches.length} blocks (${matches.map((b) => JSON.stringify(b.header.slice(0, 40))).join(', ')})` : 'no block';
    return {
      problem: `--criterion ${JSON.stringify(c.slice(0, 60))} matches ${found} under \`## Success criteria\` in .loop/goal.md, ` +
        'which carries `Sites:` — the recorder refuses rather than guess whether this record owes a `Sweep:` line. ' +
        'Name the criterion by its id or quote its `Done when:` text.',
    };
  }
  // One grep per criterion: a second `Sites:` line is a second criterion. Reading
  // only the first would let a `Sites: none (…)` placed above the real grep waive
  // the sweep, so a block with more than one is refused rather than resolved.
  const all = [...matches[0].text.matchAll(SITES_ALL)];
  if (all.length > 1) {
    return {
      problem: `the targeted criterion (${JSON.stringify(matches[0].header.slice(0, 50))}) carries ${all.length} ` +
        '`Sites:` lines — one grep per criterion (loop-engine skill, "Sites and Sweep"); a second grep is a ' +
        'second criterion. The recorder refuses rather than pick one.',
    };
  }
  const sites = all[0];
  if (!sites || /^\s*none\s*\(/i.test(sites[1])) return { required: false };
  return { required: true, why: `the targeted criterion (${JSON.stringify(matches[0].header.slice(0, 50))}) carries \`Sites:\`` };
}

function sweepProblem(record, rp, need) {
  if (!need.required) return null;
  const line = SWEEP_LINE.exec(record);
  const value = line ? line[1].replace(/^[\s*]+/, '').trim() : '';
  if (!line) {
    return `${rp} has no \`Sweep:\` line — required because ${need.why}. One \`Sweep:\` line, its hits separated by \`;\` — ` +
      'shape in the loop-engine skill, "Sites and Sweep".';
  }
  // A sweep classifies hits: at least one `file:line` followed, in the same
  // clause, by fixed, held or not-this-class. A vocabulary word alone (`fixed`,
  // `TBD — nothing fixed yet`) or a placeholder (`n/a`, "none") names no hit.
  if (!CLASSIFIED_HIT.test(value)) {
    return `${rp} says \`Sweep: ${JSON.stringify(value || '(empty)').slice(1, -1)}\` but a sweep is required because ` +
      `${need.why} — account for each grep hit as fixed, held or not-this-class, on that one line, hits separated by \`;\`.`;
  }
  return null;
}

/** IDs the recall hook injected and nobody has accounted for yet. */
function recallLogIds(dir) {
  const text = readIfExists(join(dir, '.recall-log'));
  if (!text) return [];
  const ids = new Set();
  for (const line of text.split('\n')) {
    const id = line.split('\t')[1];
    if (id && id.trim()) ids.add(id.trim());
  }
  return [...ids];
}

function readIfExists(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Every injected ID must appear on the record's `Recall:` line.
 *
 * Presence is all a string match can prove; whether the judgement behind it was
 * any good is the verifier's check 7. That split is deliberate — this script
 * closes the hole where an ID was injected and the record simply never
 * mentioned it, which is indistinguishable from memory that was never read.
 */
function reconcileRecall(record, ids) {
  if (!ids.length) return [];
  const line = /^\s*[-*]?\s*\*{0,2}Recall\*{0,2}\s*:(.*)$/im.exec(record);
  const body = line ? record.slice(line.index) : '';
  return ids.filter((id) => !body.includes(id));
}

// ------------------------------------------------------------------------ main

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) { process.stdout.write(USAGE); return 0; }

  const dir = resolve(String(args.dir ?? '.loop'));
  const statePath = join(dir, 'state.json');
  const problems = [];

  // The review gate ran on 51 of 58 runs in a real archive and left a trace on
  // four: nothing wrote the field, so the most expensive gate in the loop was
  // the least visible afterwards. It is not an iteration, so it appends no
  // history — the fixes it produces are recorded as `kind: review-fix`.
  // The epic gate (item 5) is recorded the same way, in its own field: an item's
  // per-goal gate and the epic's cross-item gate must not overwrite each other.
  for (const [flag, field] of [['review-gate', 'review_gate'], ['epic-gate', 'epic_gate']]) {
    if (args[flag] === undefined) continue;
    const summary = String(args[flag]).trim();
    if (!summary || summary === 'true') {
      process.stderr.write(
        `loop-record: --${flag} needs a summary — the dimensions that ran, findings raised, ` +
        'confirmed after refutation, and fixed. "Clean" is a result; silence is not.\n'
      );
      return 1;
    }
    let state;
    try { state = loadState(statePath); } catch (e) {
      process.stderr.write(`loop-record: ${e.message}\n`); return 1;
    }
    state[field] = { recorded: new Date().toISOString(), summary };
    state.updated = state[field].recorded;
    if (args.dryRun) {
      process.stdout.write(`loop-record: would record ${field} — ${summary}\n`);
      return 0;
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    process.stdout.write(`recorded ${field} — ${summary}\n`);
    return 0;
  }

  const verdict = String(args.verdict ?? '').toLowerCase();
  if (!VERDICTS.includes(verdict)) {
    problems.push(
      `--verdict must be one of ${VERDICTS.join('|')}, got ${JSON.stringify(args.verdict ?? null)}. ` +
      `A verifier that APPROVED some criteria and REJECTED others is a \`fail\` — the rejected ` +
      `criterion is what the next iteration owes. Put the detail on the record's Verdict: line.`
    );
  }
  const kind = String(args.kind ?? '').toLowerCase();
  if (!KINDS.includes(kind)) {
    problems.push(`--kind must be one of ${KINDS.join('|')}, got ${JSON.stringify(args.kind ?? null)}.`);
  }
  const criteriaPassed = Number(args['criteria-passed']);
  if (!Number.isInteger(criteriaPassed) || criteriaPassed < 0) {
    problems.push(
      `--criteria-passed must be a non-negative integer (the count of verifier-APPROVED criteria ` +
      `after this iteration). Without it the plateau counter is blind and a bookkeeping pass ` +
      `silently resets the failure streak.`
    );
  }
  const intent = String(args.intent ?? '').trim();
  if (!intent) problems.push('--intent is required — one sentence naming what this iteration set out to do.');

  let state = null;
  if (!problems.length) {
    try { state = loadState(statePath); } catch (e) { problems.push(e.message); }
  }

  let n = 0;
  let record = null;
  if (state) {
    const recorded = state.history.length;
    const claimed = Number(state.iteration ?? 0);
    if (recorded !== claimed) {
      problems.push(
        `state.json claims iteration ${claimed} but history holds ${recorded} entr${recorded === 1 ? 'y' : 'ies'} — ` +
        `reconcile them before recording, or the next entry is numbered against a count nobody can trust.`
      );
    }
    n = claimed + 1;
    const rp = recordPath(dir, n);
    record = readIfExists(rp);
    if (record === null) {
      problems.push(`no iteration record at ${rp} — write it first; state.json is the index, the record is the evidence.`);
    } else {
      for (const [name, re] of REQUIRED_SECTIONS) {
        if (!re.test(record)) problems.push(`${rp} has no \`${name}:\` line (required by the iteration-record format).`);
      }
      const mismatch = criterionMismatch(record, args.criterion ? String(args.criterion) : null);
      if (mismatch) problems.push(mismatch);
      const need = sweepRequirement(kind, args.criterion ? String(args.criterion) : null, readIfExists(join(dir, 'goal.md')));
      if (need.problem) problems.push(need.problem);
      else {
        const sweep = sweepProblem(record, rp, need);
        if (sweep) problems.push(sweep);
      }
      const missing = reconcileRecall(record, recallLogIds(dir));
      if (missing.length) {
        problems.push(
          `${missing.length} recall injection(s) unaccounted on the record's \`Recall:\` line: ${missing.join(', ')}. ` +
          `Mark each \`applied (what it changed)\` or \`dismissed (why it does not apply here)\`.`
        );
      }
    }
  }

  if (problems.length) {
    process.stderr.write('loop-record: refused, nothing written.\n' + problems.map((p) => `  - ${p}`).join('\n') + '\n');
    return 1;
  }

  const entry = { n, intent, verdict, kind, criteria_passed: criteriaPassed };
  if (args.criterion) entry.criterion = String(args.criterion);
  if (args.approach) entry.approach = String(args.approach);
  if (args.signature) entry.error_signature = String(args.signature);

  state.history.push(entry);
  state.iteration = n;
  state.status = String(args.status ?? state.status ?? 'running');
  state.updated = new Date().toISOString();
  // Stamped on first use and never moved: it marks where the enum began to hold,
  // so the breaker coerces the history that predates this script and refuses
  // anything written under the contract that still misses it.
  if (!Number.isFinite(Number(state.record_contract_since))) state.record_contract_since = n;

  if (args.dryRun) {
    process.stdout.write(`loop-record: would record ${JSON.stringify(entry)}\n`);
    return 0;
  }

  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  // Emptied only now: the accounting that replaces the inbox is on disk, so a
  // crash between the two leaves the IDs to be answered again rather than lost.
  writeFileSync(join(dir, '.recall-log'), '');

  process.stdout.write(
    `recorded iteration ${n} — ${verdict} (${kind}), criteria_passed ${criteriaPassed}` +
    `${entry.criterion ? `, criterion ${entry.criterion}` : ''}; .recall-log emptied\n`
  );
  return 0;
}

export { parseArgs, reconcileRecall, recallLogIds, VERDICTS, KINDS };

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));
