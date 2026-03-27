import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, findRolloutForSession } from '../dist/rollout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('buildSnapshot parses context, rates, tools, and plan', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'rollout-sample.jsonl');
  const snapshot = await buildSnapshot(fixture);

  assert.equal(snapshot.sessionId, 'thread-1');
  assert.equal(snapshot.cliVersion, '0.1.0');
  assert.equal(snapshot.model, 'gpt-5-codex');
  assert.equal(snapshot.turnState, 'running');
  assert.equal(snapshot.contextTokens, 64500);
  assert.equal(snapshot.contextWindow, 258000);
  assert.equal(snapshot.contextUsedPercent, 25);
  assert.equal(snapshot.ratePrimary?.usedPercent, 24.7);
  assert.equal(snapshot.rateSecondary?.usedPercent, 78.2);

  assert.equal(snapshot.activeTools.length, 1);
  assert.equal(snapshot.activeTools[0].label, 'filesystem/read_file');
  assert.equal(snapshot.activeTools[0].source, 'mcp');

  assert.equal(snapshot.recentTools.length, 1);
  assert.equal(snapshot.recentTools[0].status, 'completed');
  assert.equal(snapshot.recentTools[0].source, 'exec');

  assert.equal(snapshot.plan.length, 3);
  assert.equal(snapshot.plan[1].step, 'Implement parser');
});

test('buildSnapshot prefers spark limits for spark models and default for non-spark', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-rollout-'));
  const fixture = path.join(tmpDir, 'rollout.jsonl');

  const lines = [
    JSON.stringify({
      timestamp: '2026-02-13T09:27:33.215Z',
      type: 'turn_context',
      payload: {
        cwd: '/tmp/project',
        model: 'gpt-5.3-codex-spark',
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-13T09:27:33.658Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 11, window_minutes: 300, resets_at: 1770991779 },
          secondary: { used_percent: 22, window_minutes: 10080, resets_at: 1771560373 },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-13T09:27:33.659Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex_bengalfox',
          limit_name: 'GPT-5.3-Codex-Spark',
          primary: { used_percent: 33, window_minutes: 300, resets_at: 1770992853 },
          secondary: { used_percent: 44, window_minutes: 10080, resets_at: 1771579653 },
        },
      },
    }),
  ];
  fs.writeFileSync(fixture, `${lines.join('\n')}\n`, 'utf8');

  const sparkSnapshot = await buildSnapshot(fixture);
  assert.equal(Math.round(sparkSnapshot.ratePrimary?.usedPercent ?? -1), 33);
  assert.equal(Math.round(sparkSnapshot.rateSecondary?.usedPercent ?? -1), 44);

  const nonSparkFixture = path.join(tmpDir, 'rollout-non-spark.jsonl');
  const nonSpark = lines.map((line, i) => {
    if (i !== 0) return line;
    return JSON.stringify({
      timestamp: '2026-02-13T09:27:33.215Z',
      type: 'turn_context',
      payload: {
        cwd: '/tmp/project',
        model: 'gpt-5.3-codex',
      },
    });
  });
  fs.writeFileSync(nonSparkFixture, `${nonSpark.join('\n')}\n`, 'utf8');

  const defaultSnapshot = await buildSnapshot(nonSparkFixture);
  assert.equal(Math.round(defaultSnapshot.ratePrimary?.usedPercent ?? -1), 11);
  assert.equal(Math.round(defaultSnapshot.rateSecondary?.usedPercent ?? -1), 22);
});

test('findRolloutForSession resolves explicit session ids and prefers cwd matches', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-session-'));
  const sessionsDir = path.join(tmpDir, 'sessions', '2026', '03', '27');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const first = path.join(sessionsDir, 'rollout-a.jsonl');
  const second = path.join(sessionsDir, 'rollout-b.jsonl');

  fs.writeFileSync(
    first,
    `${JSON.stringify({
      timestamp: '2026-03-27T10:00:00Z',
      type: 'session_meta',
      payload: { id: 'thread-42', cwd: '/tmp/alpha' },
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    second,
    `${JSON.stringify({
      timestamp: '2026-03-27T10:05:00Z',
      type: 'session_meta',
      payload: { id: 'thread-42', cwd: '/tmp/beta' },
    })}\n`,
    'utf8',
  );

  const resolved = await findRolloutForSession('thread-42', tmpDir, '/tmp/beta');
  assert.equal(resolved, second);
});
