import { RESET, bar, blue, cyan, dim, green, magenta, red, yellow } from './colors.js';
import type { HudConfig, HudSnapshot, ToolActivity } from './types.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const STATUS_LINE_MAX_LINES = 4;

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${value}`;
}

function formatRemaining(to?: Date): string {
  if (!to) return '';
  const diff = to.getTime() - Date.now();
  if (diff <= 0) return '';
  const mins = Math.ceil(diff / 60000);
  if (mins >= 24 * 60) {
    const d = Math.floor(mins / (24 * 60));
    const h = Math.floor((mins % (24 * 60)) / 60);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDuration(from?: Date): string | null {
  if (!from) return null;
  const diffMs = Math.max(0, Date.now() - from.getTime());
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function formatElapsed(start: Date, end?: Date): string {
  const diffMs = Math.max(0, (end ?? new Date()).getTime() - start.getTime());
  const secs = Math.round(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function detectStatusWidth(): number {
  const envWidth = Number.parseInt(process.env.CODEX_HUD_WIDTH ?? process.env.COLUMNS ?? '', 10);
  if (!Number.isNaN(envWidth) && envWidth > 0) return envWidth;
  if (process.stdout.isTTY && process.stdout.columns && process.stdout.columns > 0) return process.stdout.columns;
  return 120;
}

function shortenModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/^gpt-/, 'g')
    .replace(/-codex-spark$/, 's')
    .replace(/-codex$/, 'c')
    .replace(/\s+/g, '');
}

function modelTier(model: string): string {
  if (model.toLowerCase().includes('spark')) return 'Spark';
  return 'Max';
}

function projectFromCwd(cwd: string | undefined, levels: number): string {
  if (!cwd) return 'project';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-Math.max(1, levels)).join('/') || 'project';
}

function visibleLength(text: string): number {
  return text.replace(ANSI_RE, '').length;
}

function truncateVisible(text: string, maxVisible: number): string {
  if (maxVisible <= 0) return '';
  if (visibleLength(text) <= maxVisible) return text;

  let out = '';
  let visible = 0;
  for (let i = 0; i < text.length && visible < maxVisible;) {
    if (text[i] === '\x1b') {
      const rest = text.slice(i);
      const match = rest.match(ANSI_RE);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }

    out += text[i];
    visible += 1;
    i += 1;
  }

  if (out.endsWith(RESET)) return out;
  return `${out}${RESET}`;
}

function trimToWidth(text: string, width: number): string {
  const visibleLen = visibleLength(text);
  if (visibleLen <= width) return `${text}${' '.repeat(Math.max(0, width - visibleLen))}`;
  if (width < 6) return `${truncateVisible(text, width)}${RESET}`;
  const truncated = truncateVisible(text, Math.max(1, width - 1));
  return `${truncated}…${RESET}`;
}

function colorPercent(percent: number, text: string): string {
  if (percent >= 85) return red(text);
  if (percent >= 50) return yellow(text);
  return green(text);
}

function renderWindow(label: string, percent: number, resetsAt?: Date): string {
  const resetText = formatRemaining(resetsAt);
  const body = `${colorPercent(percent, bar(percent, 10))} ${colorPercent(percent, `${percent}%`)}`;
  if (!resetText) return `${label} ${body}`;
  return `${label} ${body} (${blue(`resets in ${resetText}`)})`;
}

function gitDetails(snapshot: HudSnapshot, config: HudConfig): string {
  if (!snapshot.gitBranch) return '';

  const parts = [`${snapshot.gitBranch}${snapshot.gitDirty ? '*' : ''}`];
  if (config.showGitAheadBehind) {
    if (snapshot.gitAhead && snapshot.gitAhead > 0) parts.push(`↑${snapshot.gitAhead}`);
    if (snapshot.gitBehind && snapshot.gitBehind > 0) parts.push(`↓${snapshot.gitBehind}`);
  }

  if (config.showGitFileStats) {
    if (snapshot.gitModified && snapshot.gitModified > 0) parts.push(`!${snapshot.gitModified}`);
    if (snapshot.gitAdded && snapshot.gitAdded > 0) parts.push(`+${snapshot.gitAdded}`);
    if (snapshot.gitDeleted && snapshot.gitDeleted > 0) parts.push(`✘${snapshot.gitDeleted}`);
    if (snapshot.gitUntracked && snapshot.gitUntracked > 0) parts.push(`?${snapshot.gitUntracked}`);
  }

  return `git:(${parts.join(' ')})`;
}

function toolBucket(tool: ToolActivity): string {
  if (tool.source === 'exec') return 'Bash';

  const lower = tool.label.toLowerCase();
  if (lower.includes('read')) return 'Read';
  if (lower.includes('write') || lower.includes('edit') || lower.includes('patch')) return 'Edit';
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find') || lower.includes('query')) return 'Search';
  if (lower.includes('list')) return 'List';
  return 'Tool';
}

function toolPrefix(status: ToolActivity['status']): string {
  if (status === 'running') return yellow('◐');
  if (status === 'failed') return red('✗');
  return green('✓');
}

function summarizeTools(snapshot: HudSnapshot): string | null {
  const groups = new Map<string, { count: number; status: ToolActivity['status'] }>();
  const recent = [...snapshot.recentTools.slice(-24), ...snapshot.activeTools];

  for (const tool of recent) {
    const bucket = toolBucket(tool);
    const existing = groups.get(bucket);
    if (existing) {
      existing.count += 1;
      if (tool.status === 'failed') existing.status = 'failed';
      else if (tool.status === 'running' && existing.status !== 'failed') existing.status = 'running';
      continue;
    }
    groups.set(bucket, { count: 1, status: tool.status });
  }

  if (groups.size === 0) return null;
  return Array.from(groups.entries())
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([bucket, info]) => `${toolPrefix(info.status)} ${bucket} ×${info.count}`)
    .join(' | ');
}

function renderPlan(snapshot: HudSnapshot): string | null {
  if (snapshot.plan.length === 0) return null;

  const completed = snapshot.plan.filter((p) => p.status === 'completed').length;
  const running = snapshot.plan.find((p) => p.status === 'in_progress');
  const pending = snapshot.plan.find((p) => p.status === 'pending');
  const title = running?.step ?? pending?.step ?? snapshot.plan[snapshot.plan.length - 1]?.step;
  const state = running ? '◐' : completed === snapshot.plan.length ? '✓' : '▸';

  return `${state} ${completed}/${snapshot.plan.length}${title ? ` • ${title}` : ''}`;
}

function buildHeader(snapshot: HudSnapshot, config: HudConfig, compact = false): string {
  const modelRaw = snapshot.model ?? 'unknown-model';
  const modelBadge = compact
    ? cyan(`[${shortenModel(modelRaw)} | ${modelTier(modelRaw)}]`)
    : cyan(`[${modelRaw.replace(/^gpt-/i, 'g')}${modelRaw.toLowerCase().includes('spark') ? ' | Spark' : ' | Max'}]`);
  const project = projectFromCwd(snapshot.cwd, config.pathLevels);
  const git = gitDetails(snapshot, config);
  const duration = formatDuration(snapshot.sessionStart);

  const parts = [modelBadge, git ? `${project} ${git}` : project];
  if (duration) parts.push(`${yellow('⏱')} ${duration}`);
  return parts.join(compact ? ' | ' : ' │ ');
}

function buildContextUsageLine(snapshot: HudSnapshot, config: HudConfig): string | null {
  const parts: string[] = [];

  if (snapshot.contextUsedPercent !== undefined) {
    const contextPercent = snapshot.contextUsedPercent;
    let contextPart = renderWindow('Context', contextPercent);
    if (config.contextDisplay === 'tokens' || config.contextDisplay === 'both') {
      const tokenText = snapshot.contextTokens !== undefined
        ? `${formatTokens(snapshot.contextTokens)}/${formatTokens(snapshot.contextWindow ?? 0)}`
        : undefined;
      if (tokenText) contextPart += ` ${dim(tokenText)}`;
    }
    parts.push(contextPart);
  }

  if (config.showRates && snapshot.ratePrimary) {
    const primaryPercent = Math.round(snapshot.ratePrimary.usedPercent);
    let usagePart = renderWindow('Usage', primaryPercent, snapshot.ratePrimary.resetsAt);

    if (snapshot.rateSecondary && Math.round(snapshot.rateSecondary.usedPercent) >= config.sevenDayThreshold) {
      const secondaryPercent = Math.round(snapshot.rateSecondary.usedPercent);
      usagePart += ` | ${renderWindow('', secondaryPercent, snapshot.rateSecondary.resetsAt).trim()}`;
    }

    parts.push(usagePart);
  }

  if (parts.length === 0) return null;
  return parts.join(' │ ');
}

function buildExpandedLines(snapshot: HudSnapshot, config: HudConfig): string[] {
  const lines = [buildHeader(snapshot, config, false)];
  const contextUsage = buildContextUsageLine(snapshot, config);
  if (contextUsage) lines.push(contextUsage);

  if (config.showPlan) {
    const plan = renderPlan(snapshot);
    if (plan) lines.push(plan);
  }

  if (config.showTools && config.maxTools > 0) {
    const tools = summarizeTools(snapshot);
    if (tools) lines.push(tools);
  }

  if (config.showSessionPath) lines.push(dim(snapshot.sessionPath));
  return lines;
}

function buildCompactLine(snapshot: HudSnapshot, config: HudConfig): string {
  const parts = [buildHeader(snapshot, config, true)];
  if (snapshot.contextUsedPercent !== undefined) {
    parts.push(`Ctx ${colorPercent(snapshot.contextUsedPercent, `${snapshot.contextUsedPercent}%`)}`);
  }
  if (config.showRates && snapshot.ratePrimary) {
    const primaryPercent = Math.round(snapshot.ratePrimary.usedPercent);
    const primaryRemain = formatRemaining(snapshot.ratePrimary.resetsAt);
    parts.push(`U5 ${colorPercent(primaryPercent, `${primaryPercent}%`)}${primaryRemain ? ` ${blue(primaryRemain)}` : ''}`);
  }
  if (snapshot.rateSecondary && Math.round(snapshot.rateSecondary.usedPercent) >= config.sevenDayThreshold) {
    const secondaryPercent = Math.round(snapshot.rateSecondary.usedPercent);
    const secondaryRemain = formatRemaining(snapshot.rateSecondary.resetsAt);
    parts.push(`U7 ${colorPercent(secondaryPercent, `${secondaryPercent}%`)}${secondaryRemain ? ` ${blue(secondaryRemain)}` : ''}`);
  }
  return parts.join(' | ');
}

export function render(snapshot: HudSnapshot, config: HudConfig): string[] {
  return buildExpandedLines(snapshot, config);
}

export function renderStatusLine(snapshot: HudSnapshot, config: HudConfig): string {
  const width = detectStatusWidth();
  if (config.lineLayout === 'compact') {
    return trimToWidth(buildCompactLine(snapshot, config), width);
  }

  return buildExpandedLines(snapshot, config)
    .slice(0, STATUS_LINE_MAX_LINES)
    .map((line) => trimToWidth(line, width))
    .join('\n');
}

export function renderTmuxLine(snapshot: HudSnapshot, config: HudConfig): string {
  return trimToWidth(buildCompactLine(snapshot, config), detectStatusWidth());
}
