import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DEFAULT_CONFIG,
  type ContextDisplay,
  type HudConfig,
  type HudLayout,
  type HudPresetName,
} from './types.js';

interface RawConfig {
  preset?: unknown;
  refreshMs?: unknown;
  lineLayout?: unknown;
  pathLevels?: unknown;
  maxTools?: unknown;
  showTools?: unknown;
  showPlan?: unknown;
  showRates?: unknown;
  showSessionPath?: unknown;
  showGitAheadBehind?: unknown;
  showGitFileStats?: unknown;
  sevenDayThreshold?: unknown;
  contextDisplay?: unknown;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return fallback;
  return Math.round(value);
}

function asBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function asPreset(value: unknown): HudPresetName | undefined {
  return value === 'minimal' || value === 'essential' || value === 'full' ? value : undefined;
}

function asLayout(value: unknown, fallback: HudLayout): HudLayout {
  return value === 'compact' || value === 'expanded' ? value : fallback;
}

function asContextDisplay(value: unknown, fallback: ContextDisplay): ContextDisplay {
  return value === 'percent' || value === 'tokens' || value === 'both' || value === 'remaining'
    ? value
    : fallback;
}

function presetConfig(preset: HudPresetName): HudConfig {
  if (preset === 'minimal') {
    return {
      ...DEFAULT_CONFIG,
      preset,
      lineLayout: 'compact',
      pathLevels: 1,
      maxTools: 0,
      showTools: false,
      showPlan: false,
      showGitAheadBehind: false,
      showGitFileStats: false,
      contextDisplay: 'percent',
    };
  }

  if (preset === 'full') {
    return {
      ...DEFAULT_CONFIG,
      preset,
      lineLayout: 'expanded',
      pathLevels: 2,
      maxTools: 5,
      showTools: true,
      showPlan: true,
      showSessionPath: true,
      showGitAheadBehind: true,
      showGitFileStats: true,
      sevenDayThreshold: 0,
      contextDisplay: 'both',
    };
  }

  return { ...DEFAULT_CONFIG, preset: 'essential' };
}

export function configPath(): string {
  return path.join(os.homedir(), '.codex-hud', 'config.json');
}

export function loadConfig(): HudConfig {
  const file = configPath();

  if (!fs.existsSync(file)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawConfig;
    const preset = asPreset(raw.preset) ?? DEFAULT_CONFIG.preset;
    const base = presetConfig(preset);

    return {
      preset,
      refreshMs: asPositiveInt(raw.refreshMs, base.refreshMs),
      lineLayout: asLayout(raw.lineLayout, base.lineLayout),
      pathLevels: asBoundedInt(raw.pathLevels, base.pathLevels, 1, 4),
      maxTools: asBoundedInt(raw.maxTools, base.maxTools, 0, 12),
      showTools: typeof raw.showTools === 'boolean' ? raw.showTools : base.showTools,
      showPlan: typeof raw.showPlan === 'boolean' ? raw.showPlan : base.showPlan,
      showRates: typeof raw.showRates === 'boolean' ? raw.showRates : base.showRates,
      showSessionPath: typeof raw.showSessionPath === 'boolean' ? raw.showSessionPath : base.showSessionPath,
      showGitAheadBehind: typeof raw.showGitAheadBehind === 'boolean'
        ? raw.showGitAheadBehind
        : base.showGitAheadBehind,
      showGitFileStats: typeof raw.showGitFileStats === 'boolean'
        ? raw.showGitFileStats
        : base.showGitFileStats,
      sevenDayThreshold: asBoundedInt(raw.sevenDayThreshold, base.sevenDayThreshold, 0, 100),
      contextDisplay: asContextDisplay(raw.contextDisplay, base.contextDisplay),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
