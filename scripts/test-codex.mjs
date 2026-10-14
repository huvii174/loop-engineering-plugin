#!/usr/bin/env node
// Exercise the shipped ZIP in a clean project, not the repo's live .loop/.
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { packageCodex, runtimeFiles } from './package-codex.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = mkdtempSync(join(tmpdir(), 'loop-codex-test-'));
let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`PASS ${name}`);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: TEMP, ...options });
  assert.ifError(result.error);
  return result;
}
function extract(archive, dest) {
  const result = run('unzip', ['-q', archive, '-d', dest]);
  assert.equal(result.status, 0, result.stderr);
  return join(dest, 'loop-engineering');
}

async function checkCli(marketplaceRoot, expectedNames, version) {
  const profile = join(TEMP, 'codex-test-profile');
  mkdirSync(profile, { recursive: true });
  mkdirSync(join(marketplaceRoot, '.agents/plugins'), { recursive: true });
  const marketplace = JSON.parse(readFileSync(join(ROOT, '.agents/plugins/marketplace.json'), 'utf8'));
  marketplace.plugins[0].source.path = './loop-engineering';
  writeFileSync(join(marketplaceRoot, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace));
  // Use Codex's supported profile location in the subprocess only. Never change
  // the user's persisted configuration or install into their real plugin cache.
  const env = { ...process.env, CODEX_HOME: profile };
  const options = { cwd: marketplaceRoot, env, timeout: 30000 };
  let result = run('codex', ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], options);
  assert.equal(result.status, 0, result.stderr);
  result = run('codex', ['plugin', 'add', 'loop-engineering@loop-engineering-marketplace', '--json'], options);
  assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(result.stdout);
  assert.equal(installed.version, version);
  assert(installed.installedPath.startsWith(realpathSync(profile) + '/plugins/cache/'), installed.installedPath);
  const server = spawn('codex', ['app-server'], { cwd: marketplaceRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', (data) => { stderr += data; });
  const lines = createInterface({ input: server.stdout });
  const send = (message) => server.stdin.write(JSON.stringify(message) + '\n');
  try {
    const discovery = await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error(`Codex skill discovery timed out: ${stderr.slice(-1000)}`)), 15000);
      function finish(error, result) {
        clearTimeout(timer);
        if (error) reject(error); else resolveResult(result);
      }
      server.once('error', (error) => finish(error));
      server.once('exit', (code) => finish(new Error(`Codex app-server exited ${code}: ${stderr.slice(-1000)}`)));
      lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== 1 && message.id !== 2) return;
        if (message.error) { finish(new Error(JSON.stringify(message.error))); return; }
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'skills/list', params: { cwds: [marketplaceRoot], forceReload: true } });
        } else finish(null, message.result);
      });
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'loop-distribution-check', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      } });
    });
    check('Codex CLI installs the ZIP and discovers exactly the adapted skills', () => {
      assert.equal(discovery.data.length, 1);
      const entry = discovery.data[0];
      assert.deepEqual(entry.errors, []);
      const skills = entry.skills.filter((skill) => skill.pluginId === installed.pluginId);
      assert.deepEqual(skills.map((skill) => skill.name).sort(), expectedNames.map((name) => `loop-engineering:${name}`).sort());
      for (const skill of skills) {
        assert.equal(skill.enabled, true);
        assert(skill.path.startsWith(installed.installedPath + '/codex/skills/'), skill.path);
      }
    });
  } finally {
    lines.close();
    if (server.exitCode === null) {
      const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
      server.kill();
      await exited;
    }
  }
}

try {
  const { archive, files } = packageCodex(join(TEMP, 'output with spaces'));
  const plugin = extract(archive, join(TEMP, 'unpacked with spaces'));
  const manifest = JSON.parse(readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  const claude = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  check('host manifests agree and Codex hook autodiscovery is disabled', () => {
    assert.equal(manifest.name, claude.name);
    assert.equal(manifest.version, claude.version);
    assert.deepEqual(manifest.hooks, []);
    assert.deepEqual(manifest.commands, []);
    assert.deepEqual(manifest.agents, []);
  });
  check('standalone ZIP contains only runtime files in one plugin directory', () => {
    assert.deepEqual(readdirSync(dirname(plugin)), ['loop-engineering']);
    assert.equal(existsSync(join(plugin, '.claude-plugin')), false);
    assert.equal(existsSync(join(plugin, 'hooks')), false);
    for (const file of files) {
      assert(!/(^|\/)(\.env|\.loop|\.claude|\.git|fixtures|evd|loop-evd|test-[^/]+)(\/|\.|$)/.test(file), file);
      assert(existsSync(join(plugin, file)), file);
    }
    assert(existsSync(join(plugin, 'skills/prompt-craft/NOTICE')));
  });
  const skillRoot = join(plugin, manifest.skills);
  const names = readdirSync(skillRoot).sort();
  check('all commands, shared contracts, and roles are exposed as valid skills', () => {
    assert.equal(names.length, 14);
    const sources = new Set();
    for (const name of names) {
      const entry = readFileSync(join(skillRoot, name, 'SKILL.md'), 'utf8');
      assert(entry.startsWith(`---\nname: ${name}\ndescription: `), name);
      const paths = [...entry.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
      assert.equal(paths.length, 2, name);
      for (const path of paths) {
        const target = resolve(skillRoot, name, path);
        assert(target.startsWith(`${plugin}/`), target);
        assert(existsSync(target), target);
        sources.add(target);
      }
    }
    for (const [directory, filename] of [
      ['commands', 'breakdown.md'], ['commands', 'design.md'], ['commands', 'loop.md'],
      ['commands', 'run.md'], ['commands', 'status.md'], ['commands', 'memory.md'],
      ['agents', 'loop-verifier.md'], ['agents', 'plan-critic.md'], ['agents', 'epic-planner.md'],
    ]) assert(sources.has(join(plugin, directory, filename)), filename);
    for (const name of readdirSync(join(ROOT, 'skills'))) {
      assert(sources.has(join(plugin, 'skills', name, 'SKILL.md')), name);
    }
  });
  check('shared prompt references remain reachable after extraction', () => {
    const skill = readFileSync(join(plugin, 'skills/prompt-craft/SKILL.md'), 'utf8');
    const refs = [...skill.matchAll(/references\/[a-z-]+\.md/g)].map((match) => match[0]);
    assert(refs.length > 0);
    for (const ref of refs) assert(existsSync(join(plugin, 'skills/prompt-craft', ref)), ref);
  });
  const project = join(TEMP, 'target project');
  mkdirSync(join(project, '.loop/memory'), { recursive: true });
  const statePath = join(project, '.loop/state.json');
  const breaker = join(plugin, 'scripts/loop-breaker.mjs');
  const { pluginVersion } = await import(pathToFileURL(breaker).href);
  check('breaker reports version with only the Codex manifest present', () => {
    assert.equal(pluginVersion(), manifest.version);
  });
  check('extracted breaker enforces both continue and budget-stop outcomes', () => {
    writeFileSync(statePath, JSON.stringify({ iteration: 0, max_iterations: 3, history: [] }));
    let result = run(process.execPath, [breaker, '--json'], { cwd: project });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).stop, false);
    writeFileSync(statePath, JSON.stringify({ iteration: 3, max_iterations: 3, history: [] }));
    result = run(process.execPath, [breaker, '--json'], { cwd: project });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).stop, true);
  });
  check('all other extracted helpers execute without undeclared dependencies', () => {
    for (const [name, args] of [
      ['loop-record', ['--help']], ['loop-close', ['--help']],
      ['loop-archive', ['hygiene', '--dry-run']],
      ['memory-lint', ['--json']], ['migrate-memory', ['--dry-run']],
    ]) {
      if (name === 'migrate-memory') {
        writeFileSync(join(project, '.loop/memory/learnings.md'), '# Learnings\n\n- [gotcha][test] Use absolute installed helper paths because the project cwd differs.\n');
      }
      const result = run(process.execPath, [join(plugin, 'scripts', `${name}.mjs`), ...args], { cwd: project });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert(result.stdout.length + result.stderr.length > 0, name);
    }
  });
  const source = join(TEMP, 'source');
  for (const file of [...runtimeFiles(), '.claude-plugin/plugin.json']) {
    const dest = join(source, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, file), dest);
  }
  writeFileSync(join(source, '.env'), 'PRIVATE_TEST_MARKER=not-for-distribution');
  mkdirSync(join(source, '.loop'), { recursive: true });
  writeFileSync(join(source, '.loop/state.json'), 'private dogfood');
  writeFileSync(join(source, 'scripts/statusline-probe.mjs'), 'private experiment');
  check('local secrets, state, and unlisted scripts never enter the archive', () => {
    const result = packageCodex(join(TEMP, 'private-output'), source);
    const unpacked = extract(result.archive, join(TEMP, 'private-unpacked'));
    for (const forbidden of ['.env', '.loop', 'scripts/statusline-probe.mjs']) {
      assert.equal(existsSync(join(unpacked, forbidden)), false, forbidden);
    }
  });
  check('rebuilding drops removed runtime documents from an existing ZIP', () => {
    const obsolete = join(source, 'commands/obsolete.md');
    writeFileSync(obsolete, 'an obsolete command');
    const before = packageCodex(join(TEMP, 'rebuild'), source);
    assert(before.files.includes('commands/obsolete.md'));
    rmSync(obsolete);
    const after = packageCodex(join(TEMP, 'rebuild'), source);
    const unpacked = extract(after.archive, join(TEMP, 'rebuilt-unpacked'));
    assert.equal(existsSync(join(unpacked, 'commands/obsolete.md')), false);
  });
  check('packaging rejects symlinks rather than copying outside the runtime tree', () => {
    const link = join(source, 'commands/outside.md');
    symlinkSync(join(source, '.env'), link);
    assert.throws(() => packageCodex(join(TEMP, 'symlink-output'), source), /symlink/);
    rmSync(link);
  });
  check('packaging refuses divergent host releases', () => {
    writeFileSync(join(source, '.codex-plugin/plugin.json'), JSON.stringify({ ...manifest, version: '999.0.0' }));
    assert.throws(() => packageCodex(join(TEMP, 'mismatch-output'), source), /must match/);
  });
  check('repository catalog resolves the plugin from the marketplace root', () => {
    const marketplace = JSON.parse(readFileSync(join(ROOT, '.agents/plugins/marketplace.json'), 'utf8'));
    const entry = marketplace.plugins.find((entry) => entry.name === manifest.name);
    assert.equal(entry.source.source, 'local');
    assert.equal(resolve(ROOT, entry.source.path), ROOT);
    assert.equal(entry.policy.installation, 'AVAILABLE');
    assert.equal(entry.category, 'Productivity');
  });
  if (process.argv.includes('--with-cli')) await checkCli(dirname(plugin), names, manifest.version);
  console.log(`${checks} Codex distribution checks passed.`);
} finally {
  rmSync(TEMP, { recursive: true, force: true });
}
