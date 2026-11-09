#!/usr/bin/env node
/**
 * loop-breaker — deterministic circuit breaker for the loop-engineering plugin.
 *
 * Reads .loop/state.json and decides whether the loop may continue. No model
 * call, no dependencies: the decision is code, so it cannot be reasoned around.
 *
 *   node loop-breaker.mjs [--state <path>] [--context] [--json]
 *
 * Exit codes:
 *   0  continue — no breaker tripped
 *   2  stop     — a breaker tripped; the loop must halt and report
 *   1  error    — state file missing/unreadable (a config problem, not a verdict)
 *
 * --context  print the "already tried (do NOT repeat)" block for the next
 *            iteration's prompt instead of checking. Exits 0 on success.
 * --json     machine-readable output for check mode.
 *
 * Two rules keep the counters honest, both derived from recorded state rather
 * than from anything the loop declares about itself:
 *
 *   Bookkeeping passes are TRANSPARENT to the failure chain. A pass that closed
 *   no criterion (criteria_passed did not rise) neither counts as an attempt nor
 *   resets one, so "fail, fail, tidy the records, fail" still reads as three
 *   consecutive failures. Recording work is not progress, and it must not be
 *   able to launder a stuck loop. Fails are never transparent — marking a failed
 *   attempt as bookkeeping buys nothing.
 *
 *   One counter short of a threshold prints an ADVISORY and still exits 0. The
 *   loop gets one warning it can act on before the breaker takes the decision
 *   away from it.
 *
 * It also re-reads two gates rather than trusting them: the design gate's
 * confidence (designGate) and, before iteration 1, the tenth man's recorded
 * verdict (tenthManGate). Either one refusing is exit 1 — a record to fix.
 *
 * Thresholds live in `breaker_thresholds`; the older `breaker` spelling is still
 * read when that field is absent. Nothing in state.json ever holds a counter —
 * see resolveThresholds() for why the distinction had to be made loud.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURED_SOURCES, critiqueStanding, rulingStanding } from './loop-critique.mjs';

/** Plugin version read from disk — the session's cached skill text can be stale
 *  after an update ("restart to apply"), but this script always runs from disk.
 *  Printing it on every check makes version skew visible instead of silent. */
export function pluginVersion() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const host of ['.claude-plugin', '.codex-plugin']) {
    try {
      const version = JSON.parse(readFileSync(join(root, host, 'plugin.json'), 'utf8')).version;
      if (typeof version === 'string' && version) return version;
    } catch { /* Try the other host's manifest in a standalone package. */ }
  }
  return 'unknown';
}

const DEFAULTS = { stagnation: 3, frustration: 3, noProgress: 5, plateau: 4, similarity: 0.85 };

/** Thresholds counted in whole iterations — each must be a positive integer-ish
 *  number. (`similarity` is a 0..1 ratio and is not one of these.) */
const COUNT_THRESHOLDS = ['stagnation', 'frustration', 'noProgress', 'plateau'];

/**
 * Resolve the thresholds a check runs against.
 *
 * `breaker` reads like a set of live counters and is not one: it has always
 * held THRESHOLDS. A real run wrote `{stagnation: 0, frustration: 0, ...}`
 * meaning "reset my counters", which made every `counter >= threshold`
 * comparison true and tripped a stop on the first check of a brand-new run.
 * `breaker_thresholds` is the honest spelling and wins wherever both appear;
 * `breaker` is still honoured alone so existing state files keep working.
 *
 * A count threshold that is not a positive number is refused, not obeyed — a
 * breaker that stops everything and a breaker that stops nothing are both
 * broken, and silently accepting either hides the mistake in the state file.
 *
 * Warnings are returned rather than printed: analyze() stays pure, and main()
 * puts them on stderr where a mis-set field is visible without changing stdout.
 */
export function resolveThresholds(state = {}, overrides = {}) {
  const warnings = [];
  const preferred = state.breaker_thresholds;
  const legacy = state.breaker;
  if (preferred && legacy) {
    warnings.push(
      'state.json sets both `breaker_thresholds` and the legacy `breaker` — ' +
      'using `breaker_thresholds` and ignoring `breaker`. Delete `breaker`.'
    );
  }
  const configured = preferred ?? legacy ?? {};
  const isObject = configured && typeof configured === 'object' && !Array.isArray(configured);
  if (!isObject && (preferred !== undefined || legacy !== undefined)) {
    warnings.push(
      `thresholds must be an object, got ${JSON.stringify(configured)} — using the defaults.`
    );
  }
  const raw = isObject ? configured : {};

  const t = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULTS)) {
      warnings.push(
        `unknown threshold \`${k}\` ignored — known fields: ${Object.keys(DEFAULTS).join(', ')}. ` +
        'A misspelled field silently reverts its real one to the default.'
      );
      continue;
    }
    if (COUNT_THRESHOLDS.includes(k) && !(Number.isFinite(v) && v > 0)) {
      warnings.push(
        `ignoring \`${k}: ${JSON.stringify(v)}\` in favour of the default ${DEFAULTS[k]} — ` +
        'this field holds thresholds, not counters — counters are computed from history on every run.'
      );
      continue;
    }
    // similarity is a 0..1 ratio, not a count: 0 makes every approach "the
    // same approach" and trips frustration on three different attempts; >1 or
    // a non-number silently disables the frustration breaker.
    if (k === 'similarity' && !(Number.isFinite(v) && v > 0 && v <= 1)) {
      warnings.push(
        `ignoring \`similarity: ${JSON.stringify(v)}\` in favour of the default ${DEFAULTS.similarity} — ` +
        'similarity is a ratio in (0, 1].'
      );
      continue;
    }
    t[k] = v;
  }
  return { thresholds: { ...t, ...overrides }, warnings };
}

// -------------------------------------------------------------------- verdicts

/** The three verdicts every counter reads. Anything else is a record defect. */
const VERDICTS = new Set(['pass', 'fail', 'escalate']);

/** Ordered because a verdict naming both outcomes reports the worse one:
 *  "APPROVE (1-5) / REJECT (6)" is an iteration with a rejected criterion. */
const COERCIONS = [
  [/\b(reject|rejected|incomplete|partial|failed|failing)\b/i, 'fail'],
  [/\b(approved?|passed|clean|cleared|verified|green)\b/i, 'pass'],
  [/\bescalat/i, 'escalate'],
];

/**
 * Read a recorded verdict as one of the three the counters understand.
 *
 * Free-text verdicts are why this exists. A real store held 37 of 311 entries
 * outside the enum — `"verifier: REJECT (criterion 3) / APPROVE (1,2,4,5)"`,
 * `"self-verified green"`, `"partial"`, `null` — and every one was invisible to
 * `trailingFails`, which compares `=== 'fail'`. Two consecutive REJECTs on one
 * criterion scored a stagnation of 0: the breaker could not see the failures it
 * exists to count.
 *
 * Coercion is a migration path, never the contract. `loop-record.mjs` writes the
 * enum, and `recordContractFrom()` marks the iteration from which that held, so
 * an entry written under the contract is refused rather than guessed at.
 * Everything older is coerced and named in a warning — the point is that a
 * mapping the breaker had to guess stays visible, rather than moving the defect
 * somewhere harder to see than the breaker.
 */
export function normalizeVerdict(raw) {
  const text = String(raw ?? '').trim();
  const lower = text.toLowerCase();
  if (VERDICTS.has(lower)) return { verdict: lower, coerced: false, raw: text };
  for (const [re, verdict] of COERCIONS) {
    if (re.test(text)) return { verdict, coerced: true, raw: text };
  }
  // An unreadable verdict is an unverifiable attempt, which is what `escalate`
  // already means — and `countable()` drops those, so a guess cannot invent a
  // failure streak out of a record nobody can read.
  return { verdict: 'escalate', coerced: true, raw: text };
}

/**
 * The iteration from which `loop-record.mjs` owned this state file, or
 * Infinity when it never has. Entries at or after it are held to the enum.
 */
function recordContractFrom(state) {
  const n = Number(state.record_contract_since);
  return Number.isFinite(n) ? n : Infinity;
}

/**
 * Attach the normalized verdict to every entry, and collect what it cost.
 *
 * `unparseable` carries entries the contract covers and the enum does not —
 * those are a hard error, because a record written by the script and still
 * out of enum means the script was bypassed.
 */
function readVerdicts(state, entries) {
  const from = recordContractFrom(state);
  const coerced = [];
  const unparseable = [];
  const out = entries.map((h) => {
    const v = normalizeVerdict(h.verdict);
    if (v.coerced) {
      const where = { n: h.n, raw: v.raw, as: v.verdict };
      if (Number(h.n ?? 0) >= from) unparseable.push(where);
      else coerced.push(where);
    }
    return { ...h, _verdict: v.verdict, _coerced: v.coerced };
  });
  return { entries: out, coerced, unparseable };
}

// --------------------------------------------------------------- normalization

/**
 * Collapse volatile detail so "the same error" is recognized across iterations
 * despite timestamps, addresses and paths that differ every run.
 */
export function errorSignature(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>');
  s = s.replace(/0x[0-9a-fA-F]+/g, '<addr>');
  // path/to/file.ext:12:5 → file.ext (basename kept, line/col dropped)
  s = s.replace(/(?:[\w.~-]*\/)+([\w.-]+)/g, '$1');
  s = s.replace(/:\d+:\d+/g, '').replace(/:\d+\b/g, '');
  s = s.replace(/\b\d+\b/g, '#');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Character trigrams — cheap similarity, no embedding call. */
function trigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length < 3) return new Set(t ? [t] : []);
  const out = new Set();
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Trigram count below which containment is untrustworthy ("fix" ⊂ "fix the parser"). */
const MIN_CONTAINMENT_SIZE = 12;

/**
 * Jaccard over trigrams, raised by containment when one description is wholly
 * inside the other — "retry the migration" vs "retry the migration again" is the
 * same action reworded, and plain Jaccard scores that just under any useful
 * threshold. Containment is ignored for short strings, where it fires on
 * anything sharing a prefix.
 */
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return A.size === B.size ? 1 : 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const smaller = Math.min(A.size, B.size);
  if (smaller < MIN_CONTAINMENT_SIZE) return jaccard;
  return Math.max(jaccard, inter / smaller);
}

// ----------------------------------------------------------------------- state

function loadState(path) {
  const abs = resolve(path);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`cannot read state file: ${abs} — run /loop-engineering:design first`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    throw new Error(`state file is not valid JSON: ${abs} (${e.message})`);
  }
  if (!Array.isArray(state.history)) state.history = [];
  return state;
}

/**
 * Entries the breaker counts: after any reset point, and never `escalate` —
 * an unverifiable attempt is not a failed approach.
 */
function countable(state) {
  const from = Number(state.breaker_reset_at_iteration ?? 0);
  const after = state.history.filter((h) => Number(h.n ?? 0) > from);
  const read = readVerdicts(state, after);
  return {
    entries: read.entries.filter((h) => h._verdict !== 'escalate'),
    coerced: read.coerced,
    unparseable: read.unparseable,
  };
}

/**
 * Tag each entry with `_transparent`: a passing iteration that closed no
 * criterion (`criteria_passed` did not rise above the previous recorded value).
 * Such an iteration did bookkeeping, not work on the goal, and is invisible to
 * the failure chain — it neither counts nor resets.
 *
 * Only passes can be transparent, and only when `criteria_passed` is recorded on
 * both sides of the comparison; an entry from before that field existed stays
 * opaque, so old runs keep their previous behavior.
 */
function markTransparency(entries) {
  let previous = 0;
  return entries.map((h) => {
    const scored = typeof h.criteria_passed === 'number';
    const transparent = h._verdict === 'pass' && scored && h.criteria_passed <= previous;
    if (scored) previous = h.criteria_passed;
    return { ...h, _transparent: transparent };
  });
}

/**
 * Iterations the plateau counter must not read.
 *
 * An iteration whose `kind` is `review-fix` closes a review-gate finding, not a
 * criterion, so the criteria-met count is flat by construction while it runs.
 * Counting it as a plateau punishes the thorough gate and rewards the shallow
 * one — a real run tripped `STOP (plateau)` at the close of a goal whose every
 * criterion was already verifier-approved, because three gate-fix iterations
 * followed. The failure chain is untouched: a review-fix that fails is a
 * failure like any other.
 *
 * Read from a recorded field rather than inferred from the `criterion` string,
 * because a machine reading prose is the defect the verdict enum just closed.
 */
function isReviewFix(h) {
  return String(h.kind ?? '').toLowerCase() === 'review-fix';
}

/** Entries the plateau counter reads: scored, and aimed at a criterion. */
function plateauEntries(entries) {
  return entries.filter((h) => typeof h.criteria_passed === 'number' && !isReviewFix(h));
}

/**
 * Consecutive trailing failures, newest first. Stops at the first entry that is
 * neither a failure nor transparent — a real pass closes the streak, a
 * bookkeeping pass is stepped over as if it never happened.
 */
function trailingFails(entries) {
  const out = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]._transparent) continue;
    if (entries[i]._verdict === 'fail') out.push(entries[i]);
    else break;
  }
  return out;
}

// ---------------------------------------------------------------------- checks

/**
 * The newest failure, or an empty stand-in. A counter can reach its threshold
 * with nothing in `fails` — a threshold of 1 makes the "one short" advisory fire
 * at 0 — so every read of the newest failure has to survive an empty streak.
 * Reporting a stop with no detail beats throwing a TypeError at the caller.
 */
function newestFail(fails) {
  return fails[0] ?? {};
}

/** Quote a recorded field for a message, when there is one to quote. */
function quoted(value) {
  return value ? `: "${value}"` : ' (nothing recorded)';
}

/**
 * `env` carries what lives beside state.json rather than in it: `critique` (the
 * tenth man's standing, from loop-critique.mjs), `handsOff` (run.json, or the
 * state's own `hands_off` in a worktree slice) and `ruling` (whether
 * `tenth_man_ruling` resolves to a decision written after the last REVISE).
 * main() always passes them; a caller that passes no `critique` skips the
 * tenth-man gate, which keeps analyze() a pure function of what it is handed.
 */
export function analyze(state, overrides = {}, env = {}) {
  const { thresholds: t, warnings } = resolveThresholds(state, overrides);
  const counted = countable(state);
  const entries = markTransparency(counted.entries);
  const fails = trailingFails(entries);
  const iteration = Number(state.iteration ?? 0);
  const maxIterations = Number(state.max_iterations ?? 12);

  for (const c of counted.coerced) {
    warnings.push(
      `history n=${c.n} records verdict ${JSON.stringify(c.raw)}, which is not ` +
      `pass|fail|escalate — counted as "${c.as}". Record through ` +
      `scripts/loop-record.mjs so the verdict the counters read is the verdict written.`
    );
  }

  // A record written under the contract and still out of enum means the script
  // was bypassed. Refusing beats counting a guess: the mapping above is a
  // migration path for history that predates the script, not a second contract.
  if (counted.unparseable.length) {
    const list = counted.unparseable.map((u) => `n=${u.n} ${JSON.stringify(u.raw)}`).join(', ');
    return {
      stop: true, status: 'stuck', reason: 'unreadable-record', error: true,
      counters: { iteration, max_iterations: maxIterations }, warnings,
      detail:
        `${counted.unparseable.length} history entr${counted.unparseable.length === 1 ? 'y' : 'ies'} ` +
        `at or after the record contract (iteration ${state.record_contract_since}) carry a verdict ` +
        `outside pass|fail|escalate: ${list}. Rewrite through scripts/loop-record.mjs.`,
    };
  }

  const counters = {
    iteration,
    max_iterations: maxIterations,
    trailing_fails: fails.length,
    stagnation: 0,
    frustration: 0,
    plateau: 0,
    bookkeeping: entries.filter((h) => h._transparent).length,
    review_fixes: entries.filter(isReviewFix).length,
  };

  // plateau — iterations keep "passing" while the criteria-met count stays flat.
  // A different death than failure streaks: the loop looks busy (verified
  // increments!) but the goal is not moving. Needs `criteria_passed` recorded
  // per history entry; entries without it are skipped (backward compatible).
  {
    const scored = plateauEntries(entries);
    if (scored.length) {
      const last = scored[scored.length - 1].criteria_passed;
      let flat = 0;
      for (let i = scored.length - 1; i >= 0; i--) {
        if (scored[i].criteria_passed === last) flat++;
        else break;
      }
      counters.plateau = flat;
    }
  }

  // stagnation — same normalized failure signature repeated consecutively
  if (fails.length) {
    const sig = errorSignature(fails[0].error_signature);
    if (sig) {
      let n = 0;
      for (const f of fails) {
        if (errorSignature(f.error_signature) === sig) n++;
        else break;
      }
      counters.stagnation = n;
    }
  }

  // frustration — same approach retried, even when the error differs
  if (fails.length) {
    const approach = fails[0].approach;
    if (approach) {
      let n = 0;
      for (const f of fails) {
        if (f.approach && similarity(f.approach, approach) >= t.similarity) n++;
        else break;
      }
      counters.frustration = n;
    }
  }

  // The design gate, re-read from state rather than trusted once. A goal whose
  // min-across-dimensions confidence never reached 95% may still run — the
  // numbered-assumption escape hatch is deliberate — but it leaves a machine
  // readable trace, because ten runs shipped at 85-93% with nothing recording
  // what was assumed in place of the answers the interview never got.
  const gate = designGate(state);
  if (gate.warning) warnings.push(gate.warning);
  if (gate.stop) {
    return {
      stop: true, status: 'stuck', reason: 'design-gate', error: true,
      counters, warnings, detail: gate.detail,
    };
  }

  const tenth = tenthManGate(state, env);
  if (tenth.warning) warnings.push(tenth.warning);
  if (tenth.stop) {
    return {
      stop: true, status: 'stuck', reason: 'tenth-man', error: true,
      counters, warnings, detail: tenth.detail,
    };
  }

  // Most actionable first.
  if (maxIterations > 0 && iteration >= maxIterations) {
    return {
      stop: true, status: 'stopped-max-iterations', reason: 'max-iterations', counters, warnings,
      detail: `iteration ${iteration} reached the budget of ${maxIterations}`,
    };
  }
  if (counters.stagnation >= t.stagnation) {
    return {
      stop: true, status: 'stuck', reason: 'stagnation', counters, warnings,
      detail: `the same failure repeated ${counters.stagnation}x consecutively${quoted(newestFail(fails).error_signature)}`,
    };
  }
  if (counters.frustration >= t.frustration) {
    return {
      stop: true, status: 'stuck', reason: 'frustration', counters, warnings,
      detail: `the same approach was retried ${counters.frustration}x consecutively${quoted(newestFail(fails).approach)}`,
    };
  }
  if (counters.trailing_fails >= t.noProgress) {
    return {
      stop: true, status: 'stuck', reason: 'no-progress', counters, warnings,
      detail: `${counters.trailing_fails} consecutive failures with no pass in between (each failing differently)`,
    };
  }
  if (counters.plateau >= t.plateau && plateauWindowHasPass(entries, t.plateau)) {
    const scored = plateauEntries(entries);
    return {
      stop: true, status: 'stuck', reason: 'plateau', counters, warnings,
      detail: `criteria-met count stuck at ${scored[scored.length - 1].criteria_passed} for ${counters.plateau} iterations despite passing verdicts — busy but not progressing`,
    };
  }
  return {
    stop: false, status: state.status ?? 'running', reason: null, counters, warnings,
    detail: 'no breaker tripped',
    advisories: advisories(entries, fails, counters, t),
  };
}

/** The confidence the design gate reached, and whether it may proceed.
 *
 *  `confidence_at_design` holds a number. It used to hold a placeholder string,
 *  and 22 of 75 real runs filled it with an essay ("hands-off: no interview; 6
 *  numbered assumptions") — unreadable to anything but a person. A legacy string
 *  still warns rather than stops: the run it describes is already history.
 */
const CONFIDENCE_GATE = 95;

function designGate(state) {
  const raw = state.confidence_at_design;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'number') {
    return {
      warning:
        `confidence_at_design is ${JSON.stringify(String(raw).slice(0, 60))}, not a number — ` +
        `the design gate cannot be checked. Write the min-across-dimensions percent as an integer ` +
        `and put the prose in confidence_note.`,
    };
  }
  const assumptions = Array.isArray(state.assumptions) ? state.assumptions.filter(Boolean) : [];
  if (raw >= CONFIDENCE_GATE || assumptions.length) return {};
  return {
    stop: true,
    detail:
      `the design gate closed at ${raw}%, under the ${CONFIDENCE_GATE}% minimum, and state.json records ` +
      `no assumptions. Either run another interview round, or record the numbered assumptions that ` +
      `stand in for the answers — in "assumptions": ["…"] — so what was guessed is on the record.`,
  };
}

/** Tiers that always face the critic; a missing tier rounds up into them. */
const CRITIQUED_TIERS = new Set(['medium', 'large']);

/**
 * The tenth man, re-read from disk before iteration 1 rather than trusted.
 *
 * A medium or large goal, and every goal under --hands-off, starts only with
 * an APPROVE from plan-critic on record for this run_id, judging the design
 * as it stands now (not `stale`) — or, once the two-round bound is spent,
 * `tenth_man_ruling` naming a decision on disk written after the last REVISE.
 * The record is written by the agent-track hook from the critic's own last
 * message (or by `loop-critique.mjs recover` from its transcript, when the hook
 * did not run); a relayed one counts only where no hook exists (`host: "codex"`).
 * A critique the designer wrote of its own design is the substitution this
 * gate exists to refuse.
 *
 * Only iteration 0 is checked. A run already past it started under the rules
 * of its day, and a rule change never re-prices work already under way.
 */
function tenthManGate(state, env) {
  const c = env.critique;
  if (!c || Number(state.iteration ?? 0) !== 0) return {};
  const tier = state.tier ?? 'medium';
  const handsOff = env.handsOff === true;
  if (!CRITIQUED_TIERS.has(tier) && !handsOff) return {};

  const why = handsOff ? 'hands-off' : `tier ${tier}`;
  // `host` is written by the designer, so it is checked against the one fact the
  // designer does not write: a breaker running under Claude Code (CLAUDECODE=1)
  // is on the host where the hook is the route, whatever state.json says.
  const relayAllowed = state.host === 'codex' && env.claudeCode !== true;
  if (c.approved && (CAPTURED_SOURCES.has(c.latest.source) || relayAllowed)) {
    if (c.latest.source === 'hook') return {};
    return {
      warning: c.latest.source === 'transcript'
        ? `the tenth man's APPROVE (${c.latest.file}) was recovered from the critic's transcript ` +
          `(loop-critique.mjs recover) — the hook did not run when it finished.`
        : `the tenth man's APPROVE (${c.latest.file}) was relayed by the session, not captured by ` +
          `a hook — the verdict on record passed through the designer's hands.`,
    };
  }
  // Open rounds: REVISE and REJECT both ask for a change. Readers that predate
  // REJECT pass only revise_rounds.
  const open = c.open_rounds ?? c.revise_rounds ?? 0;
  if (env.ruling === true && open >= 2) return {};

  // Under --hands-off no user is there to rule a dispute past two open rounds:
  // the tenth-man-arbiter's ruling settles it. Only here — an interactive run
  // still waits for the user's ruling, whatever an arbiter may have said.
  if (handsOff && open >= 2 && !c.approved && c.latest && (c.latest.verdict === 'REVISE' || c.latest.verdict === 'REJECT')) {
    // The arbiter rules on the design the critic saw. An edit after the latest
    // critic round is a revision: it goes back to a critic, not to the arbiter.
    if (c.stale) {
      return {
        stop: true,
        detail:
          `${why}: goal.md/design.md changed after the latest critic round (${c.latest.file}; design_hash), so no critic ` +
          `has read the design an arbiter would rule on. Resubmit it to a fresh loop-engineering:plan-critic; the agent-track hook records its round (design Step 2.5). A tenth-man-arbiter ruling on a design no critic read does not count.`,
      };
    }
    return arbiterGate(env.arbiter, state, env, why, open);
  }

  const how =
    'Spawn loop-engineering:plan-critic in a fresh context; the agent-track hook records its verdict ' +
    'under .loop/critique/. A critique the designer writes of its own design is not one — if the ' +
    'critic cannot be spawned, the gate stays pending (design Step 2.5). If a critic finished but its ' +
    'hook did not run (on Windows, a Git Bash that failed to start), `node scripts/loop-critique.mjs recover` ' +
    'records it from the transcript Claude Code wrote.';
  if (!c.latest) {
    return { stop: true, detail: `${why}: no tenth-man verdict is recorded for run ${c.run_id}. ${how}` };
  }
  if (c.approved) {
    return {
      stop: true,
      detail:
        `${why}: the APPROVE in ${c.latest.file} was relayed, and relay counts only on a host without ` +
        `hooks (state.json "host": "codex", and not under Claude Code). ${how}`,
    };
  }
  if (c.latest.verdict === 'APPROVE' && c.stale) {
    return {
      stop: true,
      detail:
        `${why}: the APPROVE in ${c.latest.file} judged another goal.md/design.md — they changed after it ` +
        `(design_hash). Resubmit the current design. ${how}`,
    };
  }
  if ((c.latest.verdict === 'REVISE' || c.latest.verdict === 'REJECT') && open >= 2) {
    return {
      stop: true,
      detail:
        `${why}: the tenth man left ${open} open rounds (REVISE or REJECT). The disagreement goes to ` +
        `the user verbatim; record their ruling under .loop/memory/decisions/ (a heading carrying its ID, ` +
        `written after the last open round) and the ID in state.json "tenth_man_ruling".`,
    };
  }
  return {
    stop: true,
    detail:
      `${why}: the latest tenth-man verdict (${c.latest.file}) is ${c.latest.verdict}, not APPROVE. ` +
      `Apply or rebut its findings in the design, then resubmit. ${how}`,
  };
}

/**
 * A hands-off dispute past two open rounds, settled by the arbiter's ruling on
 * disk (rulingStanding in loop-critique.mjs): a PROCEED on the current design,
 * captured by the hook, lets iteration 1 start with its deferred findings named;
 * a REDESIGN stops the item for the user, with the excluded directions printed
 * by code; anything else — no ruling, a stale one, an unreadable one, a relay
 * where the hook is the route — names the arbiter to spawn.
 */
function arbiterGate(a, state, env, why, open) {
  const spawn =
    'Spawn loop-engineering:tenth-man-arbiter in a fresh context (no `name`); the agent-track hook records its ' +
    'ruling under .loop/critique/ (design Step 2.5). If one finished but its hook did not run, ' +
    '`node scripts/loop-critique.mjs recover` records it from its transcript.';
  const latest = a?.latest ?? null;
  if (!latest) {
    return { stop: true, detail: `${why}: ${open} open tenth-man rounds and no ruling recorded. ${spawn}` };
  }
  if (a.stale) {
    return {
      stop: true,
      detail:
        `${why}: the ruling in ${latest.file} judged another goal.md/design.md (design_hash) or an older round — ` +
        `the design must stand as it was ruled. ${spawn}`,
    };
  }
  const relayAllowed = state.host === 'codex' && env.claudeCode !== true;
  if (!CAPTURED_SOURCES.has(latest.source) && !relayAllowed) {
    return {
      stop: true,
      detail:
        `${why}: the ruling in ${latest.file} was relayed, and relay counts only on a host without hooks ` +
        `(state.json "host": "codex", and not under Claude Code). ${spawn}`,
    };
  }
  if (latest.ruling === 'REDESIGN') {
    return {
      stop: true,
      detail:
        `${why}: the tenth-man-arbiter upheld a blocker or critical finding (${latest.file}) — the item stops as ` +
        `\`stuck — redesign\`. Print the excluded directions with \`node loop-critique.mjs excluded\` BEFORE ` +
        `archiving the run, and re-interview the user with them (design Step 2.5).`,
    };
  }
  if (latest.ruling !== 'PROCEED') {
    return { stop: true, detail: `${why}: the ruling in ${latest.file} is unreadable. ${spawn}` };
  }
  const deferred = (latest.upheld?.major ?? 0) + (latest.upheld?.minor ?? 0);
  return {
    warning:
      `the tenth-man-arbiter ruled PROCEED (${latest.file}): ${deferred} finding(s) deferred to the epic gate ` +
      `(loop-critique.mjs deferred).${latest.source === 'hook' ? '' : latest.source === 'transcript' ? ' The ruling was recovered from the arbiter\'s transcript (loop-critique.mjs recover).' : ' The ruling was relayed, not captured by a hook.'}`,
  };
}

/** Is this goal hands-off — the open epic run beside it, or a worktree slice's own state? */
function handsOffFor(loopDir, state) {
  if (state.hands_off === true) return true;
  try {
    const run = JSON.parse(readFileSync(join(loopDir, 'run.json'), 'utf8'));
    if (run?.hands_off !== true) return false;
    return !run.epic || !state.epic || run.epic === state.epic;
  } catch {
    return false;
  }
}

/**
 * Does `tenth_man_ruling` name a decision on disk, written after the last
 * REVISE record? An ID with no heading behind it is a string anyone could type;
 * one older than the dispute cannot be its ruling.
 */
function rulingResolves(loopDir, state, critique) {
  const id = typeof state.tenth_man_ruling === 'string' ? state.tenth_man_ruling.trim() : '';
  if (!id || !/^[A-Za-z0-9][\w.-]*$/.test(id)) return false;
  const revisedAt = Math.max(0, ...critique.records.filter((r) => r.verdict === 'REVISE' || r.verdict === 'REJECT').map((r) => Date.parse(r.recorded) || 0));
  const heading = new RegExp(`^#{2,4}\\s+${id.replace(/[.]/g, '\\.')}\\b`, 'm');
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of names) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (walk(p)) return true; continue; }
      if (!e.name.endsWith('.md')) continue;
      try {
        if (statSync(p).mtimeMs > revisedAt && heading.test(readFileSync(p, 'utf8'))) return true;
      } catch { /* unreadable — not a ruling */ }
    }
    return false;
  };
  return walk(join(loopDir, 'memory', 'decisions'));
}

/** Does the plateau window contain a passing verdict? (A flat run of pure failures is no-progress, not plateau.) */
function plateauWindowHasPass(entries, size) {
  return plateauEntries(entries).slice(-size).some((h) => h._verdict === 'pass');
}

/**
 * One counter short of its threshold: warn, do not stop. The next iteration's
 * prompt carries these, so the loop gets a chance to change approach itself
 * before the breaker takes the choice away. Advisories never change the exit
 * code — a nudge that can halt a run is a stop condition wearing a disguise.
 *
 * A counter of 0 raises nothing: with a threshold of 1 the "one short" test is
 * `0 === 0`, and a warning about a streak that has not started yet is noise.
 */
function advisories(entries, fails, counters, t) {
  const out = [];
  if (counters.stagnation > 0 && counters.stagnation === t.stagnation - 1) {
    out.push({
      reason: 'stagnation',
      detail: `the same failure has repeated ${counters.stagnation}x${quoted(newestFail(fails).error_signature)} — one more trips the breaker. Attack a different cause, not the same one again.`,
    });
  }
  if (counters.frustration > 0 && counters.frustration === t.frustration - 1) {
    out.push({
      reason: 'frustration',
      detail: `the same approach has been retried ${counters.frustration}x${quoted(newestFail(fails).approach)} — one more trips the breaker. Change the approach, not its wording.`,
    });
  }
  if (counters.trailing_fails > 0 && counters.trailing_fails === t.noProgress - 1) {
    out.push({
      reason: 'no-progress',
      detail: `${counters.trailing_fails} consecutive failures with no pass in between — one more trips the breaker. Consider a smaller increment or a probe that yields evidence instead of a fix.`,
    });
  }
  if (counters.plateau > 0 && counters.plateau === t.plateau - 1 && plateauWindowHasPass(entries, t.plateau - 1)) {
    out.push({
      reason: 'plateau',
      detail: `${counters.plateau} iterations have passed verification without closing a criterion — one more trips the breaker. Target a success criterion directly.`,
    });
  }
  if (counters.bookkeeping) {
    out.push({
      reason: 'bookkeeping',
      detail: `${counters.bookkeeping} iteration(s) closed no criterion and are transparent to the failure counters — recording work does not reset a streak.`,
    });
  }
  if (counters.review_fixes) {
    out.push({
      reason: 'review-fix',
      detail: `${counters.review_fixes} iteration(s) closed a review-gate finding and are transparent to the plateau counter — a thorough gate costs iterations without moving the criteria count, and that is the gate working.`,
    });
  }
  return out;
}

// --------------------------------------------------------------------- context

/** The "already tried (do NOT repeat)" block for the next iteration's prompt. */
export function contextBlock(state) {
  const entries = markTransparency(countable(state).entries);
  const attempts = entries.filter((h) => h.approach || h.error_signature || h.intent);
  const lines = ['## Already tried — do NOT repeat unchanged'];

  if (!attempts.length) {
    lines.push('- (nothing yet — this is the first attempt)');
  } else {
    for (const h of attempts) {
      const mark = h._transparent ? '[bookkeeping]'
        : isReviewFix(h) ? '[review-fix]'
        : h._verdict === 'pass' ? '[pass]' : '[fail]';
      const why = h.error_signature ? ` -> ${h.error_signature}` : '';
      lines.push(`- ${mark} iter ${h.n}: ${h.approach ?? h.intent ?? '(unrecorded)'}${why}`);
    }
    const fails = trailingFails(entries);
    if (fails.length) {
      const groups = new Map();
      for (const f of fails) {
        const sig = errorSignature(f.error_signature) || '(no signature)';
        groups.set(sig, (groups.get(sig) ?? 0) + 1);
      }
      lines.push('', '### Current failure streak');
      for (const [sig, n] of groups) lines.push(`- ${n}x ${sig}`);
    }
  }

  const a = analyze(state);
  lines.push('', '### Breaker status');
  lines.push(
    `- iteration ${a.counters.iteration}/${a.counters.max_iterations} | ` +
    `stagnation ${a.counters.stagnation} | frustration ${a.counters.frustration} | ` +
    `consecutive fails ${a.counters.trailing_fails} | criteria-flat ${a.counters.plateau} | ` +
    `bookkeeping ${a.counters.bookkeeping} | review-fixes ${a.counters.review_fixes}`
  );
  for (const adv of a.advisories ?? []) lines.push(`- ADVISORY (${adv.reason}): ${adv.detail}`);
  // A mis-set threshold field distorts every counter above it, so the next
  // iteration's prompt says so rather than quietly carrying skewed numbers.
  for (const w of a.warnings ?? []) lines.push(`- WARNING (state.json): ${w}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------------ main

function main(argv) {
  const args = argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const statePath = get('--state', '.loop/state.json');

  let state;
  try {
    state = loadState(statePath);
  } catch (e) {
    process.stderr.write(`loop-breaker: ${e.message}\n`);
    return 1;
  }

  // Warnings go to stderr in every mode: stdout is the verdict a caller parses,
  // and a broken threshold field must not be able to hide inside it.
  const warn = (list) => {
    for (const w of list ?? []) process.stderr.write(`loop-breaker: ${w}\n`);
  };

  if (args.includes('--context')) {
    warn(resolveThresholds(state).warnings);
    process.stdout.write(contextBlock(state) + '\n');
    return 0;
  }

  const loopDir = dirname(resolve(statePath));
  const critique = critiqueStanding(loopDir, state);
  const verdict = analyze(state, {}, {
    critique,
    handsOff: handsOffFor(loopDir, state),
    ruling: rulingResolves(loopDir, state, critique),
    arbiter: rulingStanding(loopDir, state),
    claudeCode: process.env.CLAUDECODE === '1',
  });
  warn(verdict.warnings);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  } else if (verdict.error) {
    // A record the breaker cannot read is a config problem, not a verdict on
    // the work — exit 1, the same code a missing state file gets.
    process.stderr.write(`loop-breaker: ${verdict.reason} — ${verdict.detail}\n`);
    return 1;
  } else if (verdict.stop) {
    process.stdout.write(`STOP (${verdict.reason}) [plugin v${pluginVersion()}] -> set status: "${verdict.status}"\n${verdict.detail}\n`);
  } else {
    process.stdout.write(
      `CONTINUE [plugin v${pluginVersion()}] — iteration ${verdict.counters.iteration}/${verdict.counters.max_iterations}, ` +
      `stagnation ${verdict.counters.stagnation}, frustration ${verdict.counters.frustration}, ` +
      `consecutive fails ${verdict.counters.trailing_fails}, criteria-flat ${verdict.counters.plateau}, ` +
      `bookkeeping ${verdict.counters.bookkeeping}, review-fixes ${verdict.counters.review_fixes}\n`
    );
    for (const adv of verdict.advisories ?? []) {
      process.stdout.write(`ADVISORY (${adv.reason}): ${adv.detail}\n`);
    }
  }
  if (verdict.error) return 1;
  return verdict.stop ? 2 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exit(main(process.argv));
