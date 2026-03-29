import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cyan, dim, yellow } from './colors.js';
import type { HudConfig } from './types.js';
import { createParserState, parseIncremental } from './incremental-parser.js';

interface SessionSummary {
  sessionId?: string;
  cwd?: string;
  model?: string;
  contextUsedPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  turnState: 'idle' | 'running';
  rolloutPath: string;
  modifiedAt: Date;
}

function collectRolloutFiles(sessionsDir: string): Array<{ path: string; mtimeMs: number }> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      try {
        files.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        // noop
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function quickParseSummary(rolloutPath: string, mtimeMs: number): SessionSummary {
  const state = createParserState(rolloutPath);
  parseIncremental(state);

  const s = state.snapshot;
  return {
    sessionId: s.sessionId,
    cwd: s.cwd,
    model: s.model,
    contextUsedPercent: s.contextUsedPercent,
    contextTokens: s.contextTokens,
    contextWindow: s.contextWindow,
    turnState: s.turnState,
    rolloutPath,
    modifiedAt: new Date(mtimeMs),
  };
}

function contextBar(percent: number | undefined): string {
  if (percent === undefined) return dim('---%');
  const size = 8;
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * size);
  const barStr = `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
  if (percent >= 85) return `\x1b[31m${barStr} ${percent}%\x1b[0m`;
  if (percent >= 50) return `\x1b[33m${barStr} ${percent}%\x1b[0m`;
  return `\x1b[34m${barStr} ${percent}%\x1b[0m`;
}

function shortPath(cwd: string | undefined): string {
  if (!cwd) return '?';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || '?';
}

function timeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function renderOverview(_config: HudConfig): string[] {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return ['No sessions directory found.'];
  }

  const files = collectRolloutFiles(sessionsDir);
  // Show recent sessions (last 24h with activity, max 10)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = files.filter((f) => f.mtimeMs > cutoff).slice(0, 10);

  if (recent.length === 0) {
    return ['No active sessions in the last 24 hours.'];
  }

  const lines: string[] = [
    `${cyan('[Sessions Overview]')} ${dim(`${recent.length} active`)}`,
    '',
  ];

  for (const file of recent) {
    const summary = quickParseSummary(file.path, file.mtimeMs);
    const stateIcon = summary.turnState === 'running' ? yellow('◐') : dim('○');
    const model = summary.model ? cyan(`[${summary.model}]`) : dim('[?]');
    const project = shortPath(summary.cwd);
    const context = contextBar(summary.contextUsedPercent);
    const age = dim(timeAgo(summary.modifiedAt));

    lines.push(`  ${stateIcon} ${model} ${project} ${context} ${age}`);
  }

  return lines;
}
