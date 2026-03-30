import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions,
  getUpdateHint,
  resetUpdateCheckStateForTest,
  shouldCheck,
} from '../dist/update-check.js';

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'powerbar-update-check-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, '.powerbar'), { recursive: true });
  resetUpdateCheckStateForTest();

  try {
    fn(home);
  } finally {
    resetUpdateCheckStateForTest();
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  }
}

function writeCache(home, cache) {
  fs.writeFileSync(
    path.join(home, '.powerbar', 'update-check.json'),
    JSON.stringify(cache, null, 2),
    'utf8',
  );
}

test('compareVersions handles equal, newer, missing, and non-numeric segments', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.1', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0-beta', '0.1.0'), 0);
});

test('shouldCheck enforces a 24 hour cache interval', () => {
  const now = Date.parse('2026-03-30T14:00:00Z');

  assert.equal(shouldCheck(null, now), true);
  assert.equal(shouldCheck({
    lastCheck: '2026-03-29T12:59:59Z',
    latestVersion: '0.1.2',
    currentVersion: '0.1.1',
  }, now), true);
  assert.equal(shouldCheck({
    lastCheck: '2026-03-30T13:00:00Z',
    latestVersion: '0.1.2',
    currentVersion: '0.1.1',
  }, now), false);
});

test('getUpdateHint only returns newer versions and dedupes per session', () => {
  withTempHome((home) => {
    writeCache(home, {
      lastCheck: '2026-03-30T13:00:00Z',
      latestVersion: '0.1.2',
      currentVersion: '0.1.1',
    });

    assert.deepEqual(getUpdateHint('0.1.1', 'session-a'), { version: '0.1.2' });
    assert.equal(getUpdateHint('0.1.1', 'session-a'), null);
    assert.deepEqual(getUpdateHint('0.1.1', 'session-b'), { version: '0.1.2' });
    assert.equal(getUpdateHint('0.1.2', 'session-c'), null);
    assert.equal(getUpdateHint('0.1.3', 'session-d'), null);
  });
});
