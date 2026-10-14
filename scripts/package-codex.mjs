#!/usr/bin/env node
// Build a standalone Codex ZIP from runtime files only. No npm dependencies.
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPERS = [
  'loop-breaker', 'loop-record', 'loop-close', 'loop-archive', 'memory-lint', 'migrate-memory',
];

export function runtimeFiles(root = ROOT) {
  const files = ['.codex-plugin/plugin.json', 'codex/runtime.md', 'LICENSE'];
  // These trees contain agent-consumed documents, including disclosed references
  // and attribution notices. Add other asset types deliberately when needed.
  function walk(relative) {
    const path = join(root, relative);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlink: ${relative}`);
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${child}`);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name === 'NOTICE')) files.push(child);
    }
  }
  for (const tree of ['codex/skills', 'commands', 'skills', 'agents']) walk(tree);
  for (const helper of HELPERS) files.push(`scripts/${helper}.mjs`);
  for (const file of files) {
    if (!lstatSync(join(root, file)).isFile()) throw new Error(`Expected regular file: ${file}`);
    // lstat(...).isFile() also rejects individually allowlisted symlinks.
  }
  return files.sort();
}

export function packageCodex(outputDir = join(ROOT, 'dist'), root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  const claude = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
  if (manifest.name !== claude.name || manifest.version !== claude.version) {
    throw new Error('Claude and Codex manifest names/versions must match before packaging.');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)
      || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Expected a kebab-case plugin name and a release semantic version.');
  }
  const files = runtimeFiles(root);
  const stage = mkdtempSync(join(tmpdir(), 'loop-codex-package-'));
  const output = resolve(outputDir);
  const archive = join(output, `${manifest.name}-codex-${manifest.version}.zip`);
  try {
    for (const relative of files) {
      const dest = join(stage, manifest.name, relative);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, relative), dest);
    }
    // Build a new archive every time, so deleted files can't survive a rebuild.
    const stagedZip = join(stage, 'plugin.zip');
    const result = spawnSync('zip', ['-q', '-X', stagedZip, ...files.map((file) => `${manifest.name}/${file}`)], {
      cwd: stage, encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
      throw new Error(`ZIP build failed (install the zip CLI): ${result.error?.message ?? result.stderr}`);
    }
    mkdirSync(output, { recursive: true });
    copyFileSync(stagedZip, archive);
    return { archive, files };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/package-codex.mjs [--output-dir DIR]');
  } else if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1])) {
    console.error('Usage: node scripts/package-codex.mjs [--output-dir DIR]');
    process.exitCode = 1;
  } else {
    try {
      const result = packageCodex(args[1]);
      console.log(`Packaged ${result.files.length} runtime files: ${result.archive}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
