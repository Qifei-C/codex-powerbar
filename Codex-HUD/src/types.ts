export type ToolStatus = 'running' | 'completed' | 'failed';
export type ToolSource = 'exec' | 'mcp';
export type HudLayout = 'compact' | 'expanded';
export type ContextDisplay = 'percent' | 'tokens' | 'both' | 'remaining';
export type HudPresetName = 'minimal' | 'essential' | 'full';

/** Codex built-in status-line item ids (kebab-case, matches StatusLineItem enum). */
export type CodexStatusLineItem =
  | 'model-name'
  | 'model-with-reasoning'
  | 'current-dir'
  | 'project-root'
  | 'git-branch'
  | 'context-remaining'
  | 'context-used'
  | 'five-hour-limit'
  | 'weekly-limit'
  | 'codex-version'
  | 'context-window-size'
  | 'used-tokens'
  | 'total-input-tokens'
  | 'total-output-tokens'
  | 'session-id'
  | 'fast-mode';

export interface ToolActivity {
  id: string;
  label: string;
  target?: string;
  source: ToolSource;
  status: ToolStatus;
  startTime: Date;
  endTime?: Date;
}

export interface RateWindow {
  usedPercent: number;
  resetsAt?: Date;
  windowMinutes?: number;
}

export interface PlanItem {
  status: string;
  step: string;
}

export interface EnvironmentInfo {
  approvalPolicy?: string;
  sandboxMode?: string;
  collaborationMode?: string;
  activeShells: number;
  agentsCount: number;
  instructionsCount: number;
  rulesCount: number;
  mcpServers: number;
}

export interface HudSnapshot {
  sessionPath: string;
  sessionId?: string;
  cliVersion?: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  gitBranch?: string;
  gitDirty?: boolean;
  gitAhead?: number;
  gitBehind?: number;
  gitModified?: number;
  gitAdded?: number;
  gitDeleted?: number;
  gitUntracked?: number;
  turnState: 'idle' | 'running';
  contextUsedPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  ratePrimary?: RateWindow;
  rateSecondary?: RateWindow;
  compactCount: number;
  environment?: EnvironmentInfo;
  activeTools: ToolActivity[];
  recentTools: ToolActivity[];
  plan: PlanItem[];
  sessionStart?: Date;
  /** Codex /statusline items selection; undefined means show all (legacy/fallback). */
  statusLineItems?: ReadonlySet<CodexStatusLineItem>;
  /** Active experimental features (e.g. "guardian-approvals", "prevent-sleep"). */
  experimentalFeatures?: readonly string[];
}

/** Badge definition for a feature indicator shown in the header. */
export interface FeatureBadge {
  /** Short icon/prefix, e.g. "[>>]" */
  icon: string;
  /** Short label, e.g. "SPD" */
  label: string;
}

/** Map of feature keys to their badge display. */
export interface FeatureBadgeTheme {
  fast: FeatureBadge;
  'guardian-approvals': FeatureBadge;
  'prevent-sleep': FeatureBadge;
  [key: string]: FeatureBadge;
}

export const DEFAULT_BADGES: FeatureBadgeTheme = {
  fast: { icon: '[>>]', label: 'SPD' },
  'guardian-approvals': { icon: '[OK]', label: 'GRD' },
  'prevent-sleep': { icon: '(o_o)', label: 'AWK' },
};

export interface HudConfig {
  preset: HudPresetName;
  refreshMs: number;
  lineLayout: HudLayout;
  pathLevels: number;
  maxTools: number;
  showTools: boolean;
  showPlan: boolean;
  showRates: boolean;
  showSessionPath: boolean;
  showGitAheadBehind: boolean;
  showGitFileStats: boolean;
  showEnvironment: boolean;
  sevenDayThreshold: number;
  contextDisplay: ContextDisplay;
  badges: FeatureBadgeTheme;
}

export const DEFAULT_CONFIG: HudConfig = {
  preset: 'essential',
  refreshMs: 700,
  lineLayout: 'expanded',
  pathLevels: 2,
  maxTools: 3,
  showTools: true,
  showPlan: true,
  showRates: true,
  showSessionPath: false,
  showGitAheadBehind: true,
  showGitFileStats: false,
  showEnvironment: true,
  sevenDayThreshold: 60,
  contextDisplay: 'both',
  badges: { ...DEFAULT_BADGES },
};
