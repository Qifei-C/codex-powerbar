#!/usr/bin/env node

import { buildSnapshot, findLatestRollout, findLatestRolloutForCwd, findRolloutForSession } from './rollout.js';
import { render, renderStatusLine, renderTmuxLine } from './render.js';
import { loadConfig } from './config.js';

interface CliArgs {
  once: boolean;
  clear: boolean;
  tmuxLine: boolean;
  statusLine: boolean;
  intervalMs?: number;
  rolloutPath?: string;
  sessionId?: string;
  cwdHint?: string;
  codexHome?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { once: false, clear: true, tmuxLine: false, statusLine: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once' || arg === 'print') {
      out.once = true;
    } else if (arg === '--tmux-line' || arg === '--status-line') {
      out.tmuxLine = arg === '--tmux-line';
      out.statusLine = arg === '--status-line';
      out.clear = false;
    } else if (arg === '--no-clear') {
      out.clear = false;
    } else if (arg === '--rollout' && argv[i + 1]) {
      out.rolloutPath = argv[i + 1];
      i += 1;
    } else if (arg === '--session-id' && argv[i + 1]) {
      out.sessionId = argv[i + 1];
      i += 1;
    } else if (arg === '--cwd' && argv[i + 1]) {
      out.cwdHint = argv[i + 1];
      i += 1;
    } else if (arg === '--codex-home' && argv[i + 1]) {
      out.codexHome = argv[i + 1];
      i += 1;
    } else if (arg === '--interval' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(n) && n > 0) out.intervalMs = n;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return out;
}

function printHelp(): void {
  console.log(`codex-hud\n
Usage:
  codex-hud             Watch latest Codex rollout and refresh HUD
  codex-hud --once      Print once and exit
  codex-hud --tmux-line --once
  codex-hud --status-line --once
  codex-hud --rollout <path> [--once]
  codex-hud --session-id <id> [--cwd <path>] [--once]
  codex-hud --codex-home <path>

Options:
  --interval <ms>       Refresh interval (default from ~/.codex-hud/config.json)
  --tmux-line           Print compact single line for tmux status bar
  --status-line         Print configured status-line layout (compact or expanded)
  --session-id <id>     Resolve the rollout file for one Codex session id
  --cwd <path>          Optional cwd hint when resolving a session id
  --no-clear            Do not clear the terminal between refreshes
  --help                Show this help
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function tick(args: CliArgs): Promise<number> {
  const config = loadConfig();
  const sessionId = args.sessionId ?? process.env.CODEX_HUD_SESSION_ID;
  const cwdHint = args.cwdHint ?? process.env.CODEX_HUD_CWD ?? process.cwd();
  const rolloutPath = args.rolloutPath
    ?? process.env.CODEX_HUD_ROLLOUT_PATH
    ?? (sessionId ? await findRolloutForSession(sessionId, args.codexHome, cwdHint) : null)
    ?? (cwdHint ? await findLatestRolloutForCwd(cwdHint, args.codexHome) : null)
    ?? await findLatestRollout(args.codexHome);

  if (!rolloutPath) {
    const waiting = args.tmuxLine || args.statusLine
      ? 'HUD waiting: no rollout'
      : '[codex-hud] No rollout file found. Start a Codex session first.';
    console.log(waiting);
    return args.intervalMs ?? config.refreshMs;
  }

  const snapshot = await buildSnapshot(rolloutPath);
  if (args.tmuxLine) {
    console.log(renderTmuxLine(snapshot, config));
    return args.intervalMs ?? config.refreshMs;
  }

  if (args.statusLine) {
    console.log(renderStatusLine(snapshot, config));
    return args.intervalMs ?? config.refreshMs;
  }

  const lines = render(snapshot, {
    ...config,
    refreshMs: args.intervalMs ?? config.refreshMs,
  });

  if (args.clear) {
    process.stdout.write('\x1Bc');
  }

  for (const line of lines) {
    console.log(line);
  }

  return args.intervalMs ?? config.refreshMs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.once) {
    await tick(args);
    return;
  }

  for (;;) {
    const next = await tick(args);
    await sleep(next);
  }
}

void main();
