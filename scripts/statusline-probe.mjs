#!/usr/bin/env node
// statusline-probe.mjs — DIAGNOSTIC: capture everything about the invocation
// to find where the statusLine payload actually arrives.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const SAFE_LOG = '/Users/hungnguyen/Documents/poc/loop/loop-engineering-plugin/.loop/scratch/probe-crash.log';
function safeLog(msg) {
  try { appendFileSync(SAFE_LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
}

try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(__dirname, '..');
  const SCRATCH_DIR = resolve(REPO_ROOT, '.loop', 'scratch');
  const CAPTURE_FILE = resolve(SCRATCH_DIR, 'statusline-payload.jsonl');
  if (!existsSync(SCRATCH_DIR)) mkdirSync(SCRATCH_DIR, { recursive: true });

  // Capture ALL environment variables
  const allEnv = Object.fromEntries(
    Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))
  );
  safeLog('ENV_KEYS: ' + Object.keys(allEnv).join(', '));
  safeLog('ARGV: ' + JSON.stringify(process.argv));
  safeLog('CWD: ' + process.cwd());
  safeLog('STDIN_IS_TTY: ' + process.stdin.isTTY);

  let stdinRaw = '';
  let settled = false;

  function finalize() {
    if (settled) return;
    settled = true;

    safeLog('STDIN_LENGTH: ' + stdinRaw.length);
    if (stdinRaw.length > 0) {
      safeLog('STDIN_PREVIEW: ' + stdinRaw.substring(0, 2000));
    }

    // Try to parse stdin
    let input = null;
    if (stdinRaw.trim()) {
      try { input = JSON.parse(stdinRaw); safeLog('PARSED_STDIN_OK, keys: ' + Object.keys(input).join(',')); }
      catch (e) { safeLog('PARSE_ERROR: ' + e.message); }
    }

    // Check if any env var contains JSON
    for (const [k, v] of Object.entries(allEnv)) {
      if (v && v.startsWith('{') && v.length < 10000) {
        try {
          const parsed = JSON.parse(v);
          safeLog('ENV_JSON_FOUND: ' + k + ' -> keys: ' + Object.keys(parsed).join(','));
        } catch (_) {}
      }
    }

    // Check interesting env vars
    const interesting = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_PROJECT_DIR',
      'CLAUDE_CODE_TRANSCRIPT_DIR', 'CLAUDE_CODE_STATUS_LINE_PAYLOAD',
      'CLAUDE_STATUS_LINE', 'STATUS_LINE_PAYLOAD', 'CLAUDE_CODE_SETTINGS'];
    for (const k of interesting) {
      safeLog(`ENV_${k}: ${process.env[k] || 'NOT_SET'}`);
    }

    // Build rendered line
    let rendered;
    if (input) {
      function findFields(obj, path = '', results = []) {
        if (obj === null || obj === undefined) return results;
        if (typeof obj !== 'object') return results;
        for (const [key, val] of Object.entries(obj)) {
          const cp = path ? `${path}.${key}` : key;
          if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
            results.push({ path: cp, value: val });
          }
          if (typeof val === 'object' && val !== null) findFields(val, cp, results);
        }
        return results;
      }
      const allFields = findFields(input);
      const modelCandidates = allFields.filter(f => f.path.toLowerCase().includes('model') && typeof f.value === 'string' && f.value.length > 0);
      const ctxCandidates = allFields.filter(f => f.path.toLowerCase().includes('context') || f.path.toLowerCase().includes('token') || f.path.toLowerCase().includes('usage') || f.path.toLowerCase().includes('percentage'));

      let mp = 'unknown';
      if (modelCandidates.length > 0) {
        const d = modelCandidates.find(f => f.path.includes('display_name'));
        const n = modelCandidates.find(f => f.path.endsWith('.name'));
        mp = String((d || n || modelCandidates[0]).value);
      }
      let cp = '';
      if (ctxCandidates.length > 0) {
        const pct = ctxCandidates.find(f => f.path.includes('percentage') || f.path.includes('pct'));
        const tok = ctxCandidates.find(f => f.path.includes('token'));
        const parts = [];
        if (pct) parts.push(`${pct.value}%`);
        if (tok) parts.push(`${tok.value} tokens`);
        cp = parts.join(' | ');
      }
      rendered = mp + (cp ? ' — ' + cp : '');
      if (mp === 'unknown' && !cp) rendered = `[unknown: ${Object.keys(input).join(', ')}]`;

      const record = JSON.stringify({ ts: new Date().toISOString(), input, rendered }) + '\n';
      appendFileSync(CAPTURE_FILE, record, 'utf-8');
    } else {
      rendered = '●';
    }

    process.stdout.write(rendered);
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdinRaw += chunk; safeLog('GOT_CHUNK: ' + chunk.length + ' bytes'); });
  process.stdin.on('end', () => { safeLog('STDIN_END'); finalize(); });
  process.stdin.on('error', (e) => { safeLog('STDIN_ERROR: ' + (e.code || e.message)); finalize(); });
  process.stdin.resume();

  setTimeout(() => { safeLog('TIMEOUT'); finalize(); }, 5000);
} catch (e) {
  safeLog('CRASH: ' + e.stack);
  process.stdout.write('!');
}
