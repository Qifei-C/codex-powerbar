import * as fs from 'node:fs';
import { getGitInfo } from './git.js';
import { collectEnvironment } from './environment.js';
import type { CodexStatusLineItem, HudSnapshot, PlanItem, RateWindow, ToolActivity } from './types.js';

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: unknown;
}

interface ParsedRateWindows {
  limitId?: string;
  limitName?: string;
  primary?: { usedPercent: number; resetsAt?: Date; windowMinutes?: number };
  secondary?: { usedPercent: number; resetsAt?: Date; windowMinutes?: number };
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return value;
}

function simplifyCommand(command: unknown): string {
  if (!Array.isArray(command)) return 'command';
  const words = command.filter((v) => typeof v === 'string') as string[];
  if (words.length === 0) return 'command';
  const joined = words.join(' ');
  return joined.length > 42 ? `${joined.slice(0, 39)}...` : joined;
}

function parsePlan(payload: unknown): PlanItem[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as { plan?: unknown; steps?: unknown };
  const raw = Array.isArray(p.plan) ? p.plan : Array.isArray(p.steps) ? p.steps : [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const i = item as { status?: unknown; step?: unknown };
      if (typeof i.status !== 'string' || typeof i.step !== 'string') return null;
      return { status: i.status, step: i.step };
    })
    .filter((x): x is PlanItem => x !== null);
}

function parseRateWindow(value: unknown): { usedPercent: number; resetsAt?: Date; windowMinutes?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { used_percent?: unknown; resets_at?: unknown; window_minutes?: unknown };
  const usedPercent = toNumber(v.used_percent);
  if (usedPercent === undefined) return undefined;

  const resetsRaw = toNumber(v.resets_at);
  return {
    usedPercent,
    resetsAt: resetsRaw !== undefined ? new Date(resetsRaw * 1000) : undefined,
    windowMinutes: toNumber(v.window_minutes),
  };
}

function parseRatePayload(value: unknown): ParsedRateWindows | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;

  return {
    limitId: typeof raw.limit_id === 'string' ? raw.limit_id : undefined,
    limitName: typeof raw.limit_name === 'string' ? raw.limit_name : undefined,
    primary: parseRateWindow(raw.primary),
    secondary: parseRateWindow(raw.secondary),
  };
}

function isSparkModel(model?: string): boolean {
  return typeof model === 'string' && model.toLowerCase().includes('spark');
}

function isSparkLimit(raw: ParsedRateWindows): boolean {
  if (raw.limitId && /spark/i.test(raw.limitId)) return true;
  if (raw.limitName && /spark/i.test(raw.limitName)) return true;
  return false;
}

function extractToolTarget(event: Record<string, unknown>): string | undefined {
  // exec commands: extract the last path-like argument
  const command = event.command;
  if (Array.isArray(command)) {
    const args = command.filter((v) => typeof v === 'string') as string[];
    for (let i = args.length - 1; i >= 0; i--) {
      const arg = args[i];
      if (arg && /[/\\]/.test(arg) && !arg.startsWith('-')) {
        const base = arg.split(/[/\\]/).pop();
        if (base) return base;
      }
    }
  }

  // MCP tool invocations: extract target from arguments
  const invocation = event.invocation;
  if (invocation && typeof invocation === 'object') {
    const inv = invocation as { arguments?: unknown };
    if (inv.arguments && typeof inv.arguments === 'object') {
      const invArgs = inv.arguments as Record<string, unknown>;
      // Common file-path argument names
      for (const key of ['file_path', 'path', 'filePath', 'filename', 'file', 'pattern', 'query']) {
        const val = invArgs[key];
        if (typeof val === 'string' && val.length > 0) {
          if (/[/\\]/.test(val)) {
            return val.split(/[/\\]/).pop() ?? val;
          }
          return val.length > 30 ? `${val.slice(0, 27)}...` : val;
        }
      }
    }
  }

  return undefined;
}

/** Accumulated state for incremental rollout parsing. */
export interface ParserState {
  rolloutPath: string;
  byteOffset: number;
  snapshot: HudSnapshot;
  running: Map<string, ToolActivity>;
  allTools: ToolActivity[];
  defaultRatePrimary?: { usedPercent: number; resetsAt?: Date; windowMinutes?: number };
  defaultRateSecondary?: { usedPercent: number; resetsAt?: Date; windowMinutes?: number };
  sparkRatePrimary?: { usedPercent: number; resetsAt?: Date; windowMinutes?: number };
  sparkRateSecondary?: { usedPercent: number; resetsAt?: Date; windowMinutes?: number };
  compactCount: number;
  /** Trailing partial line from previous read (no newline at end). */
  partialLine: string;
}

export function createParserState(rolloutPath: string): ParserState {
  return {
    rolloutPath,
    byteOffset: 0,
    snapshot: {
      sessionPath: rolloutPath,
      turnState: 'idle',
      activeTools: [],
      recentTools: [],
      plan: [],
      compactCount: 0,
    },
    running: new Map(),
    allTools: [],
    compactCount: 0,
    partialLine: '',
  };
}

function processLine(line: string, state: ParserState): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let item: RolloutLine;
  try {
    item = JSON.parse(trimmed) as RolloutLine;
  } catch {
    return;
  }

  const at = toDate(item.timestamp) ?? new Date();
  const type = item.type;
  const payload = item.payload;
  const snapshot = state.snapshot;

  if (type === 'turn_context' && payload && typeof payload === 'object') {
    const p = payload as { cwd?: unknown; model?: unknown };
    if (typeof p.cwd === 'string') snapshot.cwd = p.cwd;
    if (typeof p.model === 'string') snapshot.model = p.model;
    return;
  }

  if (type === 'session_meta' && !snapshot.sessionStart) {
    snapshot.sessionStart = at;
    if (payload && typeof payload === 'object') {
      const meta = payload as { id?: unknown; cli_version?: unknown; cwd?: unknown };
      if (typeof meta.id === 'string') snapshot.sessionId = meta.id;
      if (typeof meta.cli_version === 'string') snapshot.cliVersion = meta.cli_version;
      if (!snapshot.cwd && typeof meta.cwd === 'string') snapshot.cwd = meta.cwd;
    }
    return;
  }

  if (type !== 'event_msg' || !payload || typeof payload !== 'object') {
    return;
  }

  const event = payload as Record<string, unknown>;
  const eventType = typeof event.type === 'string' ? event.type : '';

  if (eventType === 'turn_started') {
    snapshot.turnState = 'running';
    const window = toNumber(event.model_context_window);
    if (window !== undefined) snapshot.contextWindow = window;
    return;
  }

  if (eventType === 'turn_complete' || eventType === 'turn_aborted') {
    snapshot.turnState = 'idle';
    return;
  }

  if (eventType === 'context_compacted') {
    state.compactCount += 1;
    return;
  }

  if (eventType === 'token_count') {
    const info = event.info;
    if (info && typeof info === 'object') {
      const i = info as Record<string, unknown>;
      const last = i.last_token_usage;
      if (last && typeof last === 'object') {
        const l = last as Record<string, unknown>;
        const contextTokens = toNumber(l.input_tokens);
        if (contextTokens !== undefined) snapshot.contextTokens = contextTokens;
      }

      const cw = toNumber(i.model_context_window);
      if (cw !== undefined) snapshot.contextWindow = cw;
      if (snapshot.contextTokens !== undefined && snapshot.contextWindow && snapshot.contextWindow > 0) {
        snapshot.contextUsedPercent = Math.max(
          0,
          Math.min(100, Math.round((snapshot.contextTokens / snapshot.contextWindow) * 100)),
        );
      }
    }

    const rates = event.rate_limits;
    if (rates && typeof rates === 'object') {
      const parsed = parseRatePayload(rates);
      if (parsed) {
        if (isSparkLimit(parsed)) {
          state.sparkRatePrimary = parsed.primary;
          state.sparkRateSecondary = parsed.secondary;
        } else {
          state.defaultRatePrimary = parsed.primary;
          state.defaultRateSecondary = parsed.secondary;
        }
      }
    }
    return;
  }

  if (eventType === 'plan_update' || eventType === 'plan_delta') {
    const plan = parsePlan(payload);
    if (plan.length > 0) {
      snapshot.plan = plan;
    }
    return;
  }

  if (eventType === 'exec_command_begin') {
    const id = typeof event.call_id === 'string' ? event.call_id : `exec-${at.getTime()}`;
    const tool: ToolActivity = {
      id,
      label: simplifyCommand(event.command),
      target: extractToolTarget(event),
      source: 'exec',
      status: 'running',
      startTime: at,
    };
    state.running.set(id, tool);
    state.allTools.push(tool);
    return;
  }

  if (eventType === 'exec_command_end') {
    const id = typeof event.call_id === 'string' ? event.call_id : '';
    if (!id) return;
    const status = (typeof event.exit_code === 'number' && event.exit_code === 0) ? 'completed' : 'failed';
    const existing = state.running.get(id);
    if (existing) {
      existing.status = status;
      existing.endTime = at;
      state.running.delete(id);
    } else {
      state.allTools.push({
        id,
        label: simplifyCommand(event.command),
        target: extractToolTarget(event),
        source: 'exec',
        status,
        startTime: at,
        endTime: at,
      });
    }
    return;
  }

  if (eventType === 'mcp_tool_call_begin') {
    const id = typeof event.call_id === 'string' ? event.call_id : `mcp-${at.getTime()}`;
    const invocation = event.invocation;
    let label = 'mcp tool';
    if (invocation && typeof invocation === 'object') {
      const iv = invocation as { server?: unknown; tool?: unknown };
      if (typeof iv.server === 'string' && typeof iv.tool === 'string') {
        label = `${iv.server}/${iv.tool}`;
      }
    }
    const tool: ToolActivity = {
      id,
      label,
      target: extractToolTarget(event),
      source: 'mcp',
      status: 'running',
      startTime: at,
    };
    state.running.set(id, tool);
    state.allTools.push(tool);
    return;
  }

  if (eventType === 'mcp_tool_call_end') {
    const id = typeof event.call_id === 'string' ? event.call_id : '';
    if (!id) return;
    const existing = state.running.get(id);
    if (existing) {
      existing.status = 'completed';
      existing.endTime = at;
      state.running.delete(id);
    }
    return;
  }
}

/** Read new bytes from the rollout file incrementally. */
export function parseIncremental(state: ParserState): void {
  const { rolloutPath } = state;

  if (!rolloutPath || !fs.existsSync(rolloutPath)) return;

  let fileSize: number;
  try {
    fileSize = fs.statSync(rolloutPath).size;
  } catch {
    return;
  }

  // File truncated (e.g. new session overwrote the file) — reset.
  if (fileSize < state.byteOffset) {
    const fresh = createParserState(rolloutPath);
    state.byteOffset = 0;
    state.running = fresh.running;
    state.allTools = fresh.allTools;
    state.compactCount = 0;
    state.partialLine = '';
    state.defaultRatePrimary = undefined;
    state.defaultRateSecondary = undefined;
    state.sparkRatePrimary = undefined;
    state.sparkRateSecondary = undefined;
    // Reset snapshot fields but keep sessionPath
    state.snapshot = { ...fresh.snapshot, sessionPath: rolloutPath };
  }

  // Nothing new to read.
  if (fileSize === state.byteOffset) return;

  const fd = fs.openSync(rolloutPath, 'r');
  try {
    const buf = Buffer.alloc(fileSize - state.byteOffset);
    fs.readSync(fd, buf, 0, buf.length, state.byteOffset);
    state.byteOffset = fileSize;

    const chunk = state.partialLine + buf.toString('utf8');
    const lines = chunk.split('\n');

    // Last element may be a partial line (no trailing newline).
    state.partialLine = lines.pop() ?? '';

    for (const line of lines) {
      processLine(line, state);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse a reset-time string from codex env vars.
 * The Rust side sends human-readable local time like "2:30 PM" which
 * `new Date()` cannot parse.  Try ISO/epoch first, then interpret as
 * today-relative local time.  Returns undefined on failure.
 */
function parseResetDate(raw?: string): Date | undefined {
  if (!raw) return undefined;

  // Try ISO 8601 or epoch millis first.
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;

  // Try "H:MM AM/PM" style from Rust's human-readable formatter.
  const match = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (match) {
    let hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    const ampm = match[3]?.toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    // If target is in the past, assume tomorrow.
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target;
  }

  return undefined;
}

/** Apply env overrides for status-line mode. */
function applyCodexEnvOverrides(snapshot: HudSnapshot): void {
  const usedPct = Number.parseInt(process.env.CODEX_CONTEXT_USED_PCT ?? '', 10);
  const window = Number.parseInt(process.env.CODEX_CONTEXT_WINDOW ?? '', 10);
  const usedTokens = Number.parseInt(process.env.CODEX_CONTEXT_USED_TOKENS ?? '', 10);
  const model = process.env.CODEX_MODEL;

  if (!Number.isNaN(usedPct)) {
    snapshot.contextUsedPercent = Math.max(0, Math.min(100, usedPct));
  }
  if (!Number.isNaN(window) && window > 0) {
    snapshot.contextWindow = window;
  }
  if (!Number.isNaN(usedTokens) && usedTokens > 0) {
    snapshot.contextTokens = usedTokens;
  }
  if (model && model.trim()) {
    snapshot.model = model.trim();
  }
  const effort = process.env.CODEX_REASONING_EFFORT;
  if (effort && effort.trim()) {
    snapshot.reasoningEffort = effort.trim();
  }
  if (process.env.CODEX_FAST === '1') {
    snapshot.fastMode = true;
  }

  const primaryPct = Number.parseFloat(process.env.CODEX_RATE_PRIMARY_PCT ?? '');
  if (!Number.isNaN(primaryPct)) {
    const resetsRaw = process.env.CODEX_RATE_PRIMARY_RESETS;
    const windowMin = Number.parseInt(process.env.CODEX_RATE_PRIMARY_WINDOW_MIN ?? '', 10);
    snapshot.ratePrimary = {
      usedPercent: primaryPct,
      resetsAt: parseResetDate(resetsRaw),
      windowMinutes: !Number.isNaN(windowMin) ? windowMin : undefined,
    };
  }

  const secondaryPct = Number.parseFloat(process.env.CODEX_RATE_SECONDARY_PCT ?? '');
  if (!Number.isNaN(secondaryPct)) {
    const resetsRaw = process.env.CODEX_RATE_SECONDARY_RESETS;
    const windowMin = Number.parseInt(process.env.CODEX_RATE_SECONDARY_WINDOW_MIN ?? '', 10);
    snapshot.rateSecondary = {
      usedPercent: secondaryPct,
      resetsAt: parseResetDate(resetsRaw),
      windowMinutes: !Number.isNaN(windowMin) ? windowMin : undefined,
    };
  }

  // Turn state.
  const turnState = process.env.CODEX_TURN_STATE;
  if (turnState === 'running' || turnState === 'idle') {
    snapshot.turnState = turnState;
  }

  // Session identity.
  const sessionId = process.env.CODEX_SESSION_ID;
  if (sessionId && sessionId.trim()) {
    snapshot.sessionId = sessionId.trim();
  }
  const cliVersion = process.env.CODEX_CLI_VERSION;
  if (cliVersion && cliVersion.trim()) {
    snapshot.cliVersion = cliVersion.trim();
  }

  // Plan progress.
  const planCompleted = Number.parseInt(process.env.CODEX_PLAN_COMPLETED ?? '', 10);
  const planTotal = Number.parseInt(process.env.CODEX_PLAN_TOTAL ?? '', 10);
  if (!Number.isNaN(planCompleted) && !Number.isNaN(planTotal) && planTotal > 0) {
    // Build minimal plan items from counts (no step names available via env).
    const plan = [];
    for (let i = 0; i < planTotal; i++) {
      plan.push({ status: i < planCompleted ? 'completed' : 'pending', step: `Step ${i + 1}` });
    }
    snapshot.plan = plan;
  }

  // Running tool count — create placeholder active tools.
  const runningTools = Number.parseInt(process.env.CODEX_RUNNING_TOOLS ?? '', 10);
  if (!Number.isNaN(runningTools) && runningTools > 0 && snapshot.activeTools.length === 0) {
    for (let i = 0; i < runningTools; i++) {
      snapshot.activeTools.push({
        id: `env-tool-${i}`,
        label: 'command',
        source: 'exec',
        status: 'running',
        startTime: new Date(),
      });
    }
  }

  // Experimental features.
  const featuresRaw = process.env.CODEX_FEATURES;
  if (featuresRaw) {
    snapshot.experimentalFeatures = featuresRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Codex /statusline item selection — drives which HUD sections render.
  const itemsRaw = process.env.CODEX_STATUS_LINE_ITEMS;
  if (itemsRaw !== undefined) {
    const items = itemsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as CodexStatusLineItem[];
    snapshot.statusLineItems = new Set(items);
  }
}

/** Build a finalized snapshot from the parser state. */
export async function finalizeSnapshot(state: ParserState): Promise<HudSnapshot> {
  const snapshot = { ...state.snapshot };

  const git = await getGitInfo(snapshot.cwd);
  snapshot.gitBranch = git.branch;
  snapshot.gitDirty = git.dirty;
  snapshot.gitAhead = git.ahead;
  snapshot.gitBehind = git.behind;
  snapshot.gitModified = git.modified;
  snapshot.gitAdded = git.added;
  snapshot.gitDeleted = git.deleted;
  snapshot.gitUntracked = git.untracked;

  const ordered = [...state.allTools].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  snapshot.activeTools = ordered.filter((t) => t.status === 'running').slice(-10);
  snapshot.recentTools = ordered.filter((t) => t.status !== 'running').slice(-20);

  snapshot.compactCount = state.compactCount;

  if (isSparkModel(snapshot.model)) {
    snapshot.ratePrimary = state.sparkRatePrimary ?? state.defaultRatePrimary;
    snapshot.rateSecondary = state.sparkRateSecondary ?? state.defaultRateSecondary;
  } else {
    snapshot.ratePrimary = state.defaultRatePrimary ?? state.sparkRatePrimary;
    snapshot.rateSecondary = state.defaultRateSecondary ?? state.sparkRateSecondary;
  }

  snapshot.environment = collectEnvironment(snapshot.cwd);

  applyCodexEnvOverrides(snapshot);

  return snapshot;
}

/** Build snapshot from env vars only (no rollout file). */
export async function buildSnapshotFromEnv(): Promise<HudSnapshot> {
  const snapshot: HudSnapshot = {
    sessionPath: '',
    turnState: 'idle',
    activeTools: [],
    recentTools: [],
    plan: [],
    compactCount: 0,
    cwd: process.env.POWERBAR_CWD ?? process.cwd(),
  };
  applyCodexEnvOverrides(snapshot);

  const git = await getGitInfo(snapshot.cwd);
  snapshot.gitBranch = git.branch;
  snapshot.gitDirty = git.dirty;
  snapshot.gitAhead = git.ahead;
  snapshot.gitBehind = git.behind;
  snapshot.gitModified = git.modified;
  snapshot.gitAdded = git.added;
  snapshot.gitDeleted = git.deleted;
  snapshot.gitUntracked = git.untracked;

  snapshot.environment = collectEnvironment(snapshot.cwd);
  return snapshot;
}

function hasEnvVar(name: string): boolean {
  return process.env[name] !== undefined;
}

function mergeRateWindowPreferEnv(
  prefix: 'CODEX_RATE_PRIMARY' | 'CODEX_RATE_SECONDARY',
  envWindow?: RateWindow,
  rolloutWindow?: RateWindow,
): RateWindow | undefined {
  if (!envWindow) return rolloutWindow;
  if (!rolloutWindow) return envWindow;

  return {
    usedPercent: hasEnvVar(`${prefix}_PCT`) ? envWindow.usedPercent : rolloutWindow.usedPercent,
    resetsAt: hasEnvVar(`${prefix}_RESETS`)
      ? (envWindow.resetsAt ?? rolloutWindow.resetsAt)
      : (rolloutWindow.resetsAt ?? envWindow.resetsAt),
    windowMinutes: hasEnvVar(`${prefix}_WINDOW_MIN`)
      ? (envWindow.windowMinutes ?? rolloutWindow.windowMinutes)
      : (rolloutWindow.windowMinutes ?? envWindow.windowMinutes),
  };
}

/**
 * Merge two snapshots with env-backed values taking precedence only when the
 * corresponding env vars are actually present. This prevents empty env-mode
 * defaults (idle / [] / 0) from wiping out richer rollout data.
 */
export function mergeSnapshotsPreferEnv(envSnapshot: HudSnapshot, rolloutSnapshot: HudSnapshot): HudSnapshot {
  const merged: HudSnapshot = {
    ...rolloutSnapshot,
    ...envSnapshot,
    sessionPath: envSnapshot.sessionPath || rolloutSnapshot.sessionPath,
    sessionStart: envSnapshot.sessionStart ?? rolloutSnapshot.sessionStart,
    cwd: envSnapshot.cwd || rolloutSnapshot.cwd,
    compactCount: rolloutSnapshot.compactCount,
    recentTools: rolloutSnapshot.recentTools,
    activeTools: hasEnvVar('CODEX_RUNNING_TOOLS') ? envSnapshot.activeTools : rolloutSnapshot.activeTools,
    plan: hasEnvVar('CODEX_PLAN_TOTAL') ? envSnapshot.plan : rolloutSnapshot.plan,
    turnState: hasEnvVar('CODEX_TURN_STATE') ? envSnapshot.turnState : rolloutSnapshot.turnState,
    environment: envSnapshot.environment ?? rolloutSnapshot.environment,
    ratePrimary: mergeRateWindowPreferEnv('CODEX_RATE_PRIMARY', envSnapshot.ratePrimary, rolloutSnapshot.ratePrimary),
    rateSecondary: mergeRateWindowPreferEnv('CODEX_RATE_SECONDARY', envSnapshot.rateSecondary, rolloutSnapshot.rateSecondary),
  };

  if (!hasEnvVar('CODEX_CONTEXT_USED_PCT') && rolloutSnapshot.contextUsedPercent !== undefined) {
    merged.contextUsedPercent = rolloutSnapshot.contextUsedPercent;
  }
  if (!hasEnvVar('CODEX_CONTEXT_WINDOW') && rolloutSnapshot.contextWindow !== undefined) {
    merged.contextWindow = rolloutSnapshot.contextWindow;
  }
  if (!hasEnvVar('CODEX_CONTEXT_USED_TOKENS') && rolloutSnapshot.contextTokens !== undefined) {
    merged.contextTokens = rolloutSnapshot.contextTokens;
  }
  if (!hasEnvVar('CODEX_MODEL') && rolloutSnapshot.model) {
    merged.model = rolloutSnapshot.model;
  }
  if (!hasEnvVar('CODEX_REASONING_EFFORT') && rolloutSnapshot.reasoningEffort) {
    merged.reasoningEffort = rolloutSnapshot.reasoningEffort;
  }
  if (!hasEnvVar('CODEX_FAST') && rolloutSnapshot.fastMode !== undefined) {
    merged.fastMode = rolloutSnapshot.fastMode;
  }
  if (!hasEnvVar('CODEX_SESSION_ID') && rolloutSnapshot.sessionId) {
    merged.sessionId = rolloutSnapshot.sessionId;
  }
  if (!hasEnvVar('CODEX_CLI_VERSION') && rolloutSnapshot.cliVersion) {
    merged.cliVersion = rolloutSnapshot.cliVersion;
  }
  if (!hasEnvVar('CODEX_FEATURES') && rolloutSnapshot.experimentalFeatures) {
    merged.experimentalFeatures = rolloutSnapshot.experimentalFeatures;
  }
  if (!hasEnvVar('CODEX_STATUS_LINE_ITEMS') && rolloutSnapshot.statusLineItems) {
    merged.statusLineItems = rolloutSnapshot.statusLineItems;
  }

  return merged;
}
