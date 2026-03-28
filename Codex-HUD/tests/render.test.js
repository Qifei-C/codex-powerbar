import test from 'node:test';
import assert from 'node:assert/strict';
import { render, renderStatusLine } from '../dist/render.js';
import { DEFAULT_BADGES } from '../dist/types.js';

test('render emits claude-style HUD lines from supported Codex data', () => {
  const lines = render(
    {
      sessionPath: '/tmp/rollout.jsonl',
      sessionId: 'thread-1',
      cliVersion: '0.1.0',
      cwd: '/repo/project',
      model: 'gpt-5-codex',
      gitBranch: 'main',
      gitDirty: true,
      gitAhead: 2,
      gitModified: 3,
      turnState: 'running',
      contextUsedPercent: 82,
      contextTokens: 210000,
      contextWindow: 258000,
      ratePrimary: { usedPercent: 40 },
      rateSecondary: { usedPercent: 71 },
      activeTools: [{
        id: '1',
        label: 'npm test',
        source: 'exec',
        status: 'running',
        startTime: new Date('2026-01-01T00:00:00Z'),
      }],
      recentTools: [],
      plan: [
        { status: 'completed', step: 'A' },
        { status: 'in_progress', step: 'B' },
      ],
      sessionStart: new Date(Date.now() - 13 * 60 * 1000),
    },
    {
      preset: 'essential',
      refreshMs: 700,
      lineLayout: 'expanded',
      showDetails: true,
      pathLevels: 2,
      maxTools: 3,
      showTools: true,
      showPlan: true,
      showRates: true,
      showSessionPath: false,
      showGitAheadBehind: true,
      showGitFileStats: true,
      sevenDayThreshold: 80,
      contextDisplay: 'both',
      badges: { ...DEFAULT_BADGES },
    },
  );

  assert.ok(lines.length >= 3);
  assert.ok(lines[0].includes('git:(main'));
  assert.ok(lines[0].includes('⏱'));
  assert.ok(lines.some((line) => line.includes('Context')));
  assert.ok(lines.some((line) => line.includes('Bash ×1')));
  assert.ok(lines.some((line) => line.includes('1/2')));
});

test('statusLineItems filters HUD sections', () => {
  const snapshot = {
    sessionPath: '/tmp/rollout.jsonl',
    cliVersion: '0.1.0',
    cwd: '/repo/project',
    model: 'gpt-5.4',
    reasoningEffort: 'low',
    fastMode: true,
    gitBranch: 'main',
    gitDirty: true,
    turnState: 'idle',
    contextUsedPercent: 14,
    contextTokens: 36000,
    contextWindow: 258000,
    ratePrimary: { usedPercent: 3 },
    activeTools: [],
    recentTools: [{
      id: 'recent-1',
      label: 'npm test',
      source: 'exec',
      status: 'completed',
      startTime: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-01-01T00:00:01Z'),
    }],
    plan: [{ status: 'in_progress', step: 'Run tests' }],
    compactCount: 0,
    environment: {
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      collaborationMode: 'default',
      activeShells: 1,
      agentsCount: 0,
      instructionsCount: 0,
      rulesCount: 0,
      mcpServers: 0,
    },
    sessionStart: new Date(Date.now() - 5 * 60 * 1000),
    // Only model + context selected via /statusline.
    statusLineItems: new Set(['model-with-reasoning', 'context-used']),
  };
  const config = {
    preset: 'essential',
    refreshMs: 700,
    lineLayout: 'expanded',
    showDetails: true,
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
  const lines = render(snapshot, config);
  // Model badge should be present
  assert.ok(lines[0].includes('g5.4'));
  // Git and project path should NOT be present (not in items)
  assert.ok(!lines[0].includes('git:('));
  assert.ok(!lines[0].includes('repo/project'));
  // Context should be present
  assert.ok(lines.some((l) => l.includes('Context')));
  // Usage (five-hour-limit) should NOT be present
  assert.ok(!lines.some((l) => l.includes('Usage')));
  // Fast mode should NOT be present (not in items)
  assert.ok(!lines[0].includes('SPD'));
  // HUD-only extras should remain visible; only Codex-mapped items are filtered.
  assert.ok(lines.some((l) => l.includes('Approvals:')));
  assert.ok(lines.some((l) => l.includes('Bash')));
  assert.ok(lines.some((l) => l.includes('todos')));
  assert.ok(lines[0].includes('⏱'));
});

test('statusLineItems can opt into codex-version and fast-mode in HUD header', () => {
  const lines = render(
    {
      sessionPath: '/tmp/rollout.jsonl',
      cliVersion: '0.1.0',
      cwd: '/repo/project',
      model: 'gpt-5.4',
      fastMode: true,
      turnState: 'idle',
      activeTools: [],
      recentTools: [],
      plan: [],
      compactCount: 0,
      statusLineItems: new Set(['model-name', 'codex-version', 'fast-mode']),
    },
    {
      preset: 'essential',
      refreshMs: 700,
      lineLayout: 'expanded',
      showDetails: true,
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
    },
  );

  assert.ok(lines[0].includes('g5.4'));
  assert.ok(lines[0].includes('v0.1.0'));
  assert.ok(lines[0].includes('SPD'));
});

test('renderStatusLine resolves compact preset into one line', () => {
  const line = renderStatusLine(
    {
      sessionPath: '/tmp/rollout.jsonl',
      cwd: '/repo/project',
      model: 'gpt-5.3-codex-spark',
      gitBranch: 'main',
      gitDirty: false,
      turnState: 'idle',
      contextUsedPercent: 25,
      contextTokens: 64500,
      contextWindow: 258000,
      ratePrimary: { usedPercent: 24.7, windowMinutes: 300 },
      rateSecondary: { usedPercent: 81, windowMinutes: 10080 },
      activeTools: [],
      recentTools: [],
      plan: [],
    },
    {
      preset: 'minimal',
      refreshMs: 700,
      lineLayout: 'compact',
      showDetails: false,
      pathLevels: 1,
      maxTools: 0,
      showTools: false,
      showPlan: false,
      showRates: true,
      showSessionPath: false,
      showGitAheadBehind: false,
      showGitFileStats: false,
      sevenDayThreshold: 80,
      contextDisplay: 'percent',
      badges: { ...DEFAULT_BADGES },
    },
  );

  assert.equal(line.includes('\n'), false);
  assert.ok(line.includes('Ctx'));
  assert.ok(line.includes('U5'));
});

test('showDetails hides HUD-only details while keeping core status content', () => {
  const lines = render(
    {
      sessionPath: '/tmp/rollout.jsonl',
      cwd: '/repo/project',
      model: 'gpt-5.4',
      fastMode: true,
      gitBranch: 'main',
      gitDirty: true,
      turnState: 'running',
      contextUsedPercent: 35,
      contextTokens: 90000,
      contextWindow: 258000,
      ratePrimary: { usedPercent: 10 },
      activeTools: [{
        id: '1',
        label: 'npm test',
        source: 'exec',
        status: 'running',
        startTime: new Date('2026-01-01T00:00:00Z'),
      }],
      recentTools: [],
      plan: [{ status: 'in_progress', step: 'Run tests' }],
      compactCount: 2,
      environment: {
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        collaborationMode: 'default',
        activeShells: 1,
        agentsCount: 0,
        instructionsCount: 0,
        rulesCount: 0,
        mcpServers: 0,
      },
      sessionStart: new Date(Date.now() - 5 * 60 * 1000),
      experimentalFeatures: ['guardian-approvals'],
    },
    {
      preset: 'essential',
      refreshMs: 700,
      lineLayout: 'expanded',
      showDetails: false,
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
    },
  );

  assert.ok(lines.some((line) => line.includes('Context')));
  assert.ok(!lines.some((line) => line.includes('Approvals:')));
  assert.ok(!lines.some((line) => line.includes('Bash')));
  assert.ok(!lines.some((line) => line.includes('todos')));
  assert.ok(!lines[0].includes('⏱'));
  assert.ok(!lines[0].includes('GRD'));
});
