import { RESET, bar, blue, bold, cyan, dim, green, magenta, red, yellow } from './colors.js';
import type { CodexStatusLineItem, EnvironmentInfo, HudConfig, HudSnapshot, ToolActivity } from './types.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const STATUS_LINE_MAX_LINES = 4;

/**
 * Check whether a codex status-line item is active.  When `statusLineItems`
 * is undefined (no env var) ALL items are shown (legacy / standalone mode).
 * When set, only items in the set are rendered.
 */
function itemEnabled(snapshot: HudSnapshot, ...items: CodexStatusLineItem[]): boolean {
  if (!snapshot.statusLineItems) return true;
  return items.some((item) => snapshot.statusLineItems!.has(item));
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${value}`;
}

function formatRemaining(to?: Date): string {
  if (!to) return '';
  const ts = to.getTime();
  if (Number.isNaN(ts)) return '';
  const diff = ts - Date.now();
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
  // POWERBAR_WIDTH is the TUI's actual content area width (already excludes indent).
  const hudWidth = Number.parseInt(process.env.POWERBAR_WIDTH ?? '', 10);
  if (!Number.isNaN(hudWidth) && hudWidth > 0) return hudWidth;
  const cols = Number.parseInt(process.env.COLUMNS ?? '', 10);
  if (!Number.isNaN(cols) && cols > 0) return cols;
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

function effortLabel(effort?: string): string {
  if (!effort || effort === 'default' || effort === 'none') return '';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
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

function trimToWidth(text: string, width: number, pad = false): string {
  const visibleLen = visibleLength(text);
  if (visibleLen <= width) return pad ? `${text}${' '.repeat(Math.max(0, width - visibleLen))}` : text;
  if (width < 6) return `${truncateVisible(text, width)}${RESET}`;
  const truncated = truncateVisible(text, Math.max(1, width - 1));
  return `${truncated}…${RESET}`;
}

function colorPercent(percent: number, text: string): string {
  if (percent >= 85) return red(text);
  if (percent >= 50) return yellow(text);
  return blue(text);
}

function renderWindow(label: string, percent: number, resetsAt?: Date, windowMinutes?: number): string {
  const resetText = formatRemaining(resetsAt);
  const body = `${colorPercent(percent, bar(percent, 10))} ${colorPercent(percent, `${percent}%`)}`;
  if (resetText) return `${dim(label)} ${body} ${dim(`(resets in ${resetText})`)}`;
  if (windowMinutes && windowMinutes > 0) {
    const windowLabel = windowMinutes >= 24 * 60
      ? `${Math.round(windowMinutes / (24 * 60))}d`
      : `${Math.round(windowMinutes / 60)}h`;
    return `${dim(label)} ${body} ${dim(`(${windowLabel} window)`)}`;
  }
  return `${dim(label)} ${body}`;
}

function gitDetails(snapshot: HudSnapshot, config: HudConfig): string {
  if (!snapshot.gitBranch) return '';

  const branch = snapshot.gitBranch;
  const dirty = snapshot.gitDirty ? yellow('*') : '';
  const indicators: string[] = [];
  if (config.showGitAheadBehind) {
    if (snapshot.gitAhead && snapshot.gitAhead > 0) indicators.push(green(`↑${snapshot.gitAhead}`));
    if (snapshot.gitBehind && snapshot.gitBehind > 0) indicators.push(red(`↓${snapshot.gitBehind}`));
  }

  if (config.showGitFileStats) {
    if (snapshot.gitModified && snapshot.gitModified > 0) indicators.push(yellow(`!${snapshot.gitModified}`));
    if (snapshot.gitAdded && snapshot.gitAdded > 0) indicators.push(green(`+${snapshot.gitAdded}`));
    if (snapshot.gitDeleted && snapshot.gitDeleted > 0) indicators.push(red(`✘${snapshot.gitDeleted}`));
    if (snapshot.gitUntracked && snapshot.gitUntracked > 0) indicators.push(dim(`?${snapshot.gitUntracked}`));
  }

  const suffix = indicators.length > 0 ? ` ${indicators.join(' ')}` : '';
  return `git:(${branch}${dirty}${suffix})`;
}

function toolBucket(tool: ToolActivity): string {
  const lower = tool.label.toLowerCase();

  // Codex file edits via patch_apply
  if (lower === 'patch_apply') return 'Edit';

  // Web searches
  if (lower === 'web_search') return 'Search';

  // Shell commands — classify by the leading command
  if (tool.source === 'exec') {
    // Extract the first word (the actual command)
    const firstWord = lower.replace(/^['"]/, '').split(/[\s|;&]/)[0].split('/').pop() ?? '';
    if (['cat', 'head', 'tail', 'less', 'bat'].includes(firstWord)) return 'Read';
    if (['sed', 'awk'].includes(firstWord) && /['"]?\d+[,p]/.test(lower)) return 'Read';
    if (['rg', 'grep', 'ag', 'ack'].includes(firstWord)) return 'Grep';
    if (['find', 'ls', 'tree', 'fd', 'exa'].includes(firstWord)) return 'List';
    if (['sed', 'patch', 'tee'].includes(firstWord)) return 'Edit';
    if (firstWord === 'git') return 'Git';
    return 'Bash';
  }

  // MCP tools
  if (lower.includes('read')) return 'Read';
  if (lower.includes('write') || lower.includes('edit') || lower.includes('patch')) return 'Edit';
  if (lower.includes('grep') || lower.includes('search') || lower.includes('find') || lower.includes('query')) return 'Grep';
  if (lower.includes('list') || lower.includes('glob')) return 'List';
  return 'Tool';
}

function toolPrefix(status: ToolActivity['status']): string {
  if (status === 'running') return yellow('◐');
  if (status === 'failed') return red('✗');
  return green('✓');
}

function summarizeTools(snapshot: HudSnapshot): string | null {
  const groups = new Map<string, { count: number; status: ToolActivity['status']; lastTarget?: string }>();
  const recent = [...snapshot.recentTools.slice(-24), ...snapshot.activeTools];

  for (const tool of recent) {
    const bucket = toolBucket(tool);
    const existing = groups.get(bucket);
    if (existing) {
      existing.count += 1;
      if (tool.target) existing.lastTarget = tool.target;
      if (tool.status === 'failed') existing.status = 'failed';
      else if (tool.status === 'running' && existing.status !== 'failed') existing.status = 'running';
      continue;
    }
    groups.set(bucket, { count: 1, status: tool.status, lastTarget: tool.target });
  }

  if (groups.size === 0) return null;
  return Array.from(groups.entries())
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([bucket, info]) => {
      const targetSuffix = info.lastTarget ? `: ${info.lastTarget}` : '';
      return `${toolPrefix(info.status)} ${dim(`${bucket}${targetSuffix} ×${info.count}`)}`;
    })
    .join(dim(' | '));
}

function renderPlan(snapshot: HudSnapshot): string | null {
  if (snapshot.plan.length === 0) return null;

  const total = snapshot.plan.length;
  const completed = snapshot.plan.filter((p) => p.status === 'completed').length;

  if (completed === total) {
    return `${green('✓')} ${dim(`All steps complete (${completed}/${total})`)}`;
  }

  const running = snapshot.plan.find((p) => p.status === 'in_progress');
  const pending = snapshot.plan.find((p) => p.status === 'pending');
  const active = running ?? pending;
  const icon = running ? yellow('◐') : '▸';

  return `${icon} ${dim(`${completed}/${total}`)}${active?.step ? dim(` ${active.step}`) : ''}`;
}

/** Header split into left content and optional right-aligned badges. */
interface HeaderParts {
  left: string;
  badges: string;
}

function buildHeaderParts(snapshot: HudSnapshot, config: HudConfig, compact = false): HeaderParts {
  const left: string[] = [];

  // Model badge: shown for model-name or model-with-reasoning items.
  if (itemEnabled(snapshot, 'model-name', 'model-with-reasoning')) {
    const modelRaw = snapshot.model ?? 'unknown-model';
    const effort = itemEnabled(snapshot, 'model-with-reasoning') ? effortLabel(snapshot.reasoningEffort) : '';
    const collab = snapshot.environment?.collaborationMode;
    const isPlan = collab && collab.toLowerCase() === 'plan';
    const parts = [effort, isPlan ? 'Plan' : ''].filter(Boolean);
    const suffix = parts.length > 0 ? ` | ${parts.join(' | ')}` : '';
    const modelBadge = compact
      ? cyan(`[${shortenModel(modelRaw)}${suffix}]`)
      : cyan(`[${modelRaw.replace(/^gpt-/i, 'g')}${suffix}]`);
    left.push(modelBadge);
  }

  if (itemEnabled(snapshot, 'codex-version') && snapshot.cliVersion) {
    left.push(dim(`v${snapshot.cliVersion}`));
  }

  // Project path and git.
  if (itemEnabled(snapshot, 'current-dir', 'project-root')) {
    const project = projectFromCwd(snapshot.cwd, config.pathLevels);
    const git = itemEnabled(snapshot, 'git-branch') ? gitDetails(snapshot, config) : '';
    left.push(git ? `${project} ${cyan(git)}` : project);
  } else if (itemEnabled(snapshot, 'git-branch')) {
    const git = gitDetails(snapshot, config);
    if (git) left.push(cyan(git));
  }

  // Session duration is a HUD extra and remains visible regardless of /statusline filtering.
  const duration = formatDuration(snapshot.sessionStart);
  if (config.showDetails && duration) left.push(dim(`⏱ ${duration}`));

  const leftStr = left.join(dim(compact ? ' | ' : ' │ '));

  // Feature badges: fast mode + experimental features.
  const badgeKeys: string[] = [];
  if (snapshot.fastMode && itemEnabled(snapshot, 'fast-mode')) badgeKeys.push('fast');
  if (config.showDetails && snapshot.experimentalFeatures) {
    for (const feat of snapshot.experimentalFeatures) badgeKeys.push(feat);
  }
  const badgeStr = badgeKeys.length > 0
    ? badgeKeys
        .map((key) => {
          const badge = config.badges[key];
          if (!badge) return dim(key);
          return `${dim(badge.icon)} ${cyan(badge.label)}`;
        })
        .join(' ')
    : '';

  return { left: leftStr, badges: badgeStr };
}

/** Compose header left + right badges into a single line, fitting within width. */
function assembleHeader(parts: HeaderParts, width: number): string {
  if (!parts.badges) return parts.left;

  const badgeWidth = visibleLength(parts.badges);
  const leftWidth = visibleLength(parts.left);
  const gap = width - leftWidth - badgeWidth;

  if (gap >= 2) {
    // Cap the gap so badges stay near content rather than at the far-right edge.
    // The TUI footer rendering area may be slightly narrower than the reported
    // width (due to indent, borders, or stale POWERBAR_WIDTH), which clips
    // right-aligned content.  A small fixed gap avoids this fragility.
    const MAX_BADGE_GAP = 4;
    return `${parts.left}${' '.repeat(Math.min(gap, MAX_BADGE_GAP))}${parts.badges}`;
  }

  // Truncate left to make room for badges.
  const maxLeft = width - badgeWidth - 3; // 3 = " │ " separator
  if (maxLeft > 10) {
    const truncatedLeft = trimToWidth(parts.left, maxLeft);
    return `${truncatedLeft}${dim(' │ ')}${parts.badges}`;
  }

  // Extreme narrow — inline fallback.
  return `${parts.left}${dim(' │ ')}${parts.badges}`;
}

function buildContextUsageLine(snapshot: HudSnapshot, config: HudConfig): string | null {
  const parts: string[] = [];

  if (snapshot.contextUsedPercent !== undefined && itemEnabled(snapshot, 'context-used', 'context-remaining')) {
    const contextPercent = snapshot.contextUsedPercent;
    let contextPart = renderWindow('Context', contextPercent);
    if (config.contextDisplay === 'tokens' || config.contextDisplay === 'both') {
      const showTokens = itemEnabled(snapshot, 'context-window-size', 'used-tokens');
      const tokenText = showTokens && snapshot.contextTokens !== undefined
        ? `${formatTokens(snapshot.contextTokens)}/${formatTokens(snapshot.contextWindow ?? 0)}`
        : undefined;
      if (tokenText) contextPart += ` ${dim(tokenText)}`;
    }
    parts.push(contextPart);
  }

  if (config.showRates && snapshot.ratePrimary && itemEnabled(snapshot, 'five-hour-limit')) {
    const primaryPercent = Math.round(snapshot.ratePrimary.usedPercent);
    let usagePart = renderWindow('Usage', primaryPercent, snapshot.ratePrimary.resetsAt, snapshot.ratePrimary.windowMinutes);

    if (snapshot.rateSecondary && itemEnabled(snapshot, 'weekly-limit')) {
      const secondaryPercent = Math.round(snapshot.rateSecondary.usedPercent);
      const meetsThreshold = secondaryPercent >= config.sevenDayThreshold;
      const wideEnough = detectStatusWidth() >= 140;
      if (meetsThreshold || wideEnough) {
        usagePart += ` | ${renderWindow('', secondaryPercent, snapshot.rateSecondary.resetsAt, snapshot.rateSecondary.windowMinutes).trim()}`;
      }
    }

    parts.push(usagePart);
  }

  if (parts.length === 0) return null;
  return parts.join(dim(' │ '));
}

/** Map raw approval-policy strings to user-friendly labels. */
function formatApprovalPolicy(raw: string): string {
  // Strip "+guardian" suffix, handle separately.
  const base = raw.replace(/\+guardian$/, '');
  const guardian = raw.endsWith('+guardian');
  let label: string;
  switch (base.toLowerCase()) {
    case 'on-request':
    case 'on_request':
    case 'onrequest':
      label = 'Manual';
      break;
    case 'auto-edit':
    case 'auto_edit':
    case 'autoedit':
      label = 'Auto';
      break;
    case 'full-auto':
    case 'full_auto':
    case 'fullauto':
      label = 'Off';
      break;
    default:
      label = base;
  }
  if (guardian) label += '+Guardian';
  return label;
}

/** Parse Rust Debug-formatted sandbox into compact badges. */
function formatSandbox(raw: string): string {
  const lower = raw.toLowerCase();

  // Top-level full access — only when FullAccess is the sandbox TYPE, not a field value.
  // Rust formats it as just "FullAccess" (no braces/fields).
  if (lower === 'off' || lower === 'none' || /^fullaccess$/i.test(raw.trim())) {
    return 'off | [FULL ACCESS]';
  }

  const tags: string[] = [];

  // Write access level (top-level sandbox type).
  if (lower.includes('workspacewrite') || lower.includes('workspace_write')) {
    tags.push('[W:WS]');
  } else if (lower.includes('readonlyfilesystem') || lower.includes('readonly_filesystem')) {
    tags.push('[W:RO]');
  }

  // Read access level (field within the struct).
  if (/read_only_access:\s*FullAccess/i.test(raw)) {
    tags.push('[R:FULL]');
  } else if (/read_only_access:\s*\w/i.test(raw)) {
    tags.push('[R:WS]');
  }

  // Optional flags — only show when enabled.
  if (/network_access:\s*true/i.test(raw)) {
    tags.push('[NET]');
  }
  if (/exclude_tmpdir_env_var:\s*false/i.test(raw) && /exclude_slash_tmp:\s*false/i.test(raw)) {
    tags.push('[TMP]');
  }

  return tags.length > 0 ? tags.join(' ') : raw;
}

function renderEnvironment(env: EnvironmentInfo): string | null {
  const parts: string[] = [];

  // Approvals label (no collaboration mode here — moved to header).
  if (env.approvalPolicy) {
    parts.push(`Approvals: ${formatApprovalPolicy(env.approvalPolicy)}`);
  }

  if (env.activeShells > 0) parts.push(`shells:${env.activeShells}`);
  if (env.sandboxMode) parts.push(`sandbox: ${formatSandbox(env.sandboxMode)}`);
  if (env.agentsCount > 0) parts.push(`agents:${env.agentsCount}`);
  if (env.instructionsCount > 0) parts.push(`instructions:${env.instructionsCount}`);
  if (env.rulesCount > 0) parts.push(`rules:${env.rulesCount}`);
  if (env.mcpServers > 0) parts.push(`mcp:${env.mcpServers}`);
  if (parts.length === 0) return null;
  return dim(parts.join(' | '));
}

function renderCompactCount(count: number): string | null {
  if (count <= 0) return null;
  return dim(`↻ ${count} compact${count > 1 ? 's' : ''}`);
}

function combinePlanAndTools(planLine: string | null, toolsLine: string | null): string | null {
  if (planLine && toolsLine) return `${planLine}${dim(' | ')}${toolsLine}`;
  return planLine ?? toolsLine;
}

function buildExpandedLines(snapshot: HudSnapshot, config: HudConfig): string[] {
  // Header is returned as parts so the caller can assemble with badge-aware truncation.
  const headerParts = buildHeaderParts(snapshot, config, false);
  const lines: string[] = [];
  if (headerParts.left || headerParts.badges) {
    lines.push(assembleHeader(headerParts, detectStatusWidth()));
  }
  const contextUsage = buildContextUsageLine(snapshot, config);
  if (contextUsage) {
    const compactTag = config.showDetails ? renderCompactCount(snapshot.compactCount) : null;
    lines.push(compactTag ? `${contextUsage} ${compactTag}` : contextUsage);
  }

  const envLine = config.showDetails && config.showEnvironment && snapshot.environment
    ? renderEnvironment(snapshot.environment)
    : null;
  const planLine = config.showDetails && config.showPlan
    ? renderPlan(snapshot)
    : null;
  const toolsLine = config.showDetails && config.showTools && config.maxTools > 0
    ? summarizeTools(snapshot)
    : null;

  const detailLines = [
    envLine,
    combinePlanAndTools(planLine, toolsLine),
  ];
  for (const line of detailLines) {
    if (line) lines.push(line);
  }

  if (config.showSessionPath && itemEnabled(snapshot, 'session-id')) lines.push(dim(snapshot.sessionPath));
  return lines;
}

function buildCompactLine(snapshot: HudSnapshot, config: HudConfig): string {
  const headerParts = buildHeaderParts(snapshot, config, true);
  const extra: string[] = [];
  if (snapshot.contextUsedPercent !== undefined && itemEnabled(snapshot, 'context-used', 'context-remaining')) {
    extra.push(`${dim('Ctx')} ${colorPercent(snapshot.contextUsedPercent, `${snapshot.contextUsedPercent}%`)}`);
  }
  if (config.showRates && snapshot.ratePrimary && itemEnabled(snapshot, 'five-hour-limit')) {
    const primaryPercent = Math.round(snapshot.ratePrimary.usedPercent);
    const primaryRemain = formatRemaining(snapshot.ratePrimary.resetsAt);
    extra.push(`${dim('U5')} ${colorPercent(primaryPercent, `${primaryPercent}%`)}${primaryRemain ? ` ${dim(primaryRemain)}` : ''}`);
  }
  if (snapshot.rateSecondary && itemEnabled(snapshot, 'weekly-limit')) {
    const secondaryPercent = Math.round(snapshot.rateSecondary.usedPercent);
    const meetsThreshold = secondaryPercent >= config.sevenDayThreshold;
    const wideEnough = detectStatusWidth() >= 140;
    if (meetsThreshold || wideEnough) {
      const secondaryRemain = formatRemaining(snapshot.rateSecondary.resetsAt);
      extra.push(`${dim('U7')} ${colorPercent(secondaryPercent, `${secondaryPercent}%`)}${secondaryRemain ? ` ${dim(secondaryRemain)}` : ''}`);
    }
  }
  // Merge extra metrics into the left side, then assemble with badges.
  const leftWithExtra = extra.length > 0
    ? `${headerParts.left}${dim(' | ')}${extra.join(dim(' | '))}`
    : headerParts.left;
  return assembleHeader({ left: leftWithExtra, badges: headerParts.badges }, detectStatusWidth());
}

export function render(snapshot: HudSnapshot, config: HudConfig): string[] {
  return buildExpandedLines(snapshot, config);
}

export function renderStatusLine(snapshot: HudSnapshot, config: HudConfig): string {
  const width = detectStatusWidth();
  if (config.lineLayout === 'compact') {
    return trimToWidth(buildCompactLine(snapshot, config), width);
  }

  const lines = buildExpandedLines(snapshot, config);
  return lines
    .slice(0, STATUS_LINE_MAX_LINES)
    .map((line, i) => {
      // Line 0 (header) already handles its own width via assembleHeader.
      // Only trim non-header lines.
      return i === 0 ? line : trimToWidth(line, width);
    })
    .join('\n');
}
