import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

function check(label: string, fn: () => string): CheckResult {
  try {
    return { label, ok: true, detail: fn() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label, ok: false, detail: msg };
  }
}

function commandVersion(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim();
}

export function runSelfCheck(): void {
  const results: CheckResult[] = [];

  // Node.js
  results.push(check('Node.js', () => commandVersion('node', ['--version'])));

  // npm
  results.push(check('npm', () => commandVersion('npm', ['--version'])));

  // tmux
  results.push(check('tmux', () => commandVersion('tmux', ['-V'])));

  // codex CLI
  results.push(check('codex CLI', () => {
    const codexPath = path.join(os.homedir(), '.local', 'bin', 'codex');
    if (fs.existsSync(codexPath)) {
      return `found at ${codexPath}`;
    }
    // Try PATH
    return commandVersion('codex', ['--version']);
  }));

  // powerbar installation
  results.push(check('powerbar', () => {
    const hudBin = path.join(os.homedir(), '.local', 'bin', 'powerbar');
    if (fs.existsSync(hudBin)) {
      return `found at ${hudBin}`;
    }
    return 'not found in ~/.local/bin/';
  }));

  // ~/.codex directory
  results.push(check('~/.codex config dir', () => {
    const dir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(dir)) return 'not found';
    const configFile = path.join(dir, 'config.toml');
    if (fs.existsSync(configFile)) return `found, config.toml exists`;
    return 'found, no config.toml';
  }));

  // ~/.powerbar directory
  results.push(check('~/.powerbar dir', () => {
    const dir = path.join(os.homedir(), '.powerbar');
    if (!fs.existsSync(dir)) return 'not found';
    const configFile = path.join(dir, 'config.json');
    if (fs.existsSync(configFile)) return `found, config.json exists`;
    return 'found, no config.json';
  }));

  // sessions directory
  results.push(check('sessions dir', () => {
    const dir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(dir)) return 'not found — no sessions yet';
    const entries = fs.readdirSync(dir);
    return `found, ${entries.length} entries`;
  }));

  // shell config (status-line command)
  results.push(check('codex status-line config', () => {
    const configFile = path.join(os.homedir(), '.codex', 'config.toml');
    if (!fs.existsSync(configFile)) return 'no config.toml';
    const content = fs.readFileSync(configFile, 'utf8');
    if (content.includes('status_line_command')) {
      const match = content.match(/status_line_command\s*=\s*"([^"]*)"/);
      return match ? `configured: ${match[1]}` : 'configured';
    }
    return 'status_line_command not set';
  }));

  // PATH check
  results.push(check('PATH includes ~/.local/bin', () => {
    const pathEnv = process.env.PATH ?? '';
    const localBin = path.join(os.homedir(), '.local', 'bin');
    return pathEnv.includes(localBin) ? 'yes' : `no — add ${localBin} to PATH`;
  }));

  // Print results
  console.log('powerbar self-check\n');
  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon} ${r.label}: ${r.detail}`);
    if (!r.ok) allOk = false;
  }

  console.log('');
  if (allOk) {
    console.log('\x1b[32mAll checks passed.\x1b[0m');
  } else {
    console.log('\x1b[33mSome checks failed. See above for details.\x1b[0m');
  }
}
