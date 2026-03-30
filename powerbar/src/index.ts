#!/usr/bin/env node

import { dim } from './colors.js';
import { findLatestRollout, findLatestRolloutForCwd, findRolloutForSession } from './rollout.js';
import { buildSnapshotFromEnv, mergeSnapshotsPreferEnv } from './incremental-parser.js';
import { createParseQueue } from './parse-queue.js';
import { render, renderStatusLine } from './render.js';
import { renderOverview } from './overview.js';
import { runSelfCheck } from './self-check.js';
import { loadConfig } from './config.js';
import { fetchAndCacheLatestVersion, fireAndForgetUpdateCheck, getUpdateHint } from './update-check.js';
import { POWERBAR_VERSION } from './version.js';

interface CliArgs {
  once: boolean;
  clear: boolean;
  statusLine: boolean;
  overview: boolean;
  selfCheck: boolean;
  updateCheckBg: boolean;
  intervalMs?: number;
  rolloutPath?: string;
  sessionId?: string;
  cwdHint?: string;
  codexHome?: string;
  updateCheckVersion?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    once: false,
    clear: true,
    statusLine: false,
    overview: false,
    selfCheck: false,
    updateCheckBg: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once' || arg === 'print') {
      out.once = true;
    } else if (arg === '--status-line') {
      out.statusLine = true;
      out.clear = false;
    } else if (arg === '--overview') {
      out.overview = true;
    } else if (arg === '--self-check') {
      out.selfCheck = true;
    } else if (arg === '--update-check-bg') {
      out.updateCheckBg = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        out.updateCheckVersion = argv[i + 1];
        i += 1;
      }
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
  console.log(`powerbar\n
Usage:
  powerbar             Watch latest Codex rollout and refresh HUD
  powerbar --once      Print once and exit
  powerbar --status-line --once
  powerbar --overview  Show all active sessions
  powerbar --self-check  Validate installation
  powerbar --rollout <path> [--once]
  powerbar --session-id <id> [--cwd <path>] [--once]
  powerbar --codex-home <path>

Options:
  --interval <ms>       Refresh interval (default from ~/.powerbar/config.json)
  --status-line         Print status-line (used by codex status_line_command)
  --overview            Show all active sessions with context usage
  --self-check          Validate installation and configuration
  --session-id <id>     Resolve the rollout file for one Codex session id
  --cwd <path>          Optional cwd hint when resolving a session id
  --no-clear            Do not clear the terminal between refreshes
  --help                Show this help

Environment:
  CODEX_STATUS_LINE_ITEMS  Comma-separated codex /statusline items to render
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const queue = createParseQueue();

/** Last frame string for diff rendering — skip output if unchanged. */
let lastFrame: string | null = null;

function outputFrame(frame: string): void {
  if (frame === lastFrame) return;
  lastFrame = frame;
  process.stdout.write(frame);
}

async function tick(args: CliArgs): Promise<number> {
  const config = loadConfig();

  // Overview mode: show all sessions.
  if (args.overview) {
    const lines = renderOverview(config);
    const frame = lines.join('\n') + '\n';
    if (args.clear) process.stdout.write('\x1Bc');
    outputFrame(frame);
    return args.intervalMs ?? config.refreshMs;
  }

  const sessionId = args.sessionId ?? process.env.POWERBAR_SESSION_ID ?? process.env.CODEX_SESSION_ID;
  const cwdHint = args.cwdHint ?? process.env.POWERBAR_CWD ?? process.cwd();
  // When a session ID is known, only use that session's rollout — never fall
  // back to an older session's file which would show stale compacts/tools.
  const rolloutPath = args.rolloutPath
    ?? process.env.POWERBAR_ROLLOUT_PATH
    ?? (sessionId ? await findRolloutForSession(sessionId, args.codexHome, cwdHint) : null)
    ?? (!sessionId && cwdHint ? await findLatestRolloutForCwd(cwdHint, args.codexHome) : null)
    ?? (!sessionId ? await findLatestRollout(args.codexHome) : null);

  const envSnapshot = await buildSnapshotFromEnv();
  const snapshot = rolloutPath
    ? mergeSnapshotsPreferEnv(envSnapshot, await queue.request(rolloutPath))
    : envSnapshot;

  if (!rolloutPath && !snapshot.model && snapshot.contextUsedPercent === undefined) {
    const waiting = args.statusLine
      ? 'HUD waiting: no rollout'
      : '[powerbar] No rollout file found. Start a Codex session first.';
    console.log(waiting);
    return args.intervalMs ?? config.refreshMs;
  }

  if (args.statusLine) {
    fireAndForgetUpdateCheck(POWERBAR_VERSION);
    const hint = getUpdateHint(POWERBAR_VERSION, sessionId);
    const suffix = hint ? `${dim(' | ')}${dim(`update: v${hint.version}`)}` : '';
    const frame = `${renderStatusLine(snapshot, config)}${suffix}\n`;
    outputFrame(frame);
    return args.intervalMs ?? config.refreshMs;
  }

  const lines = render(snapshot, {
    ...config,
    refreshMs: args.intervalMs ?? config.refreshMs,
  });

  const frame = lines.map((l) => `${l}\n`).join('');
  if (args.clear) process.stdout.write('\x1Bc');
  outputFrame(frame);

  return args.intervalMs ?? config.refreshMs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.updateCheckBg) {
    await fetchAndCacheLatestVersion(args.updateCheckVersion ?? POWERBAR_VERSION);
    return;
  }

  if (args.selfCheck) {
    runSelfCheck();
    return;
  }

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
