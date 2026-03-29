import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';

test('loadConfig applies preset defaults and explicit overrides', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'powerbar-config-'));
  const configDir = path.join(home, '.powerbar');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      preset: 'minimal',
      showDetails: true,
      showTools: true,
      pathLevels: 3,
      contextDisplay: 'both',
    }),
    'utf8',
  );

  const prevHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const config = loadConfig();
    assert.equal(config.preset, 'minimal');
    assert.equal(config.lineLayout, 'compact');
    assert.equal(config.showDetails, true);
    assert.equal(config.showTools, true);
    assert.equal(config.pathLevels, 3);
    assert.equal(config.contextDisplay, 'both');
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  }
});
