export type ToolStatus = 'running' | 'completed' | 'failed';
export type ToolSource = 'exec' | 'mcp';
export type HudLayout = 'compact' | 'expanded';
export type ContextDisplay = 'percent' | 'tokens' | 'both' | 'remaining';
export type HudPresetName = 'minimal' | 'essential' | 'full';

export interface ToolActivity {
  id: string;
  label: string;
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

export interface HudSnapshot {
  sessionPath: string;
  sessionId?: string;
  cliVersion?: string;
  cwd?: string;
  model?: string;
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
  activeTools: ToolActivity[];
  recentTools: ToolActivity[];
  plan: PlanItem[];
  sessionStart?: Date;
}

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
  sevenDayThreshold: number;
  contextDisplay: ContextDisplay;
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
  sevenDayThreshold: 80,
  contextDisplay: 'both',
};
