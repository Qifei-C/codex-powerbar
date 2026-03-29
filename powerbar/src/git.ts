import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface GitInfo {
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  modified?: number;
  added?: number;
  deleted?: number;
  untracked?: number;
}

function parseAheadBehind(text: string): { ahead?: number; behind?: number } {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return {};
  const ahead = Number.parseInt(parts[0] ?? '', 10);
  const behind = Number.parseInt(parts[1] ?? '', 10);

  return {
    ahead: Number.isNaN(ahead) ? undefined : ahead,
    behind: Number.isNaN(behind) ? undefined : behind,
  };
}

function parsePorcelain(text: string): Pick<GitInfo, 'dirty' | 'modified' | 'added' | 'deleted' | 'untracked'> {
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;

  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('??')) {
      untracked += 1;
      continue;
    }

    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    if (x === 'D' || y === 'D') {
      deleted += 1;
    } else if (x === 'A' || x === 'C') {
      added += 1;
    } else {
      modified += 1;
    }
  }

  return {
    dirty: text.trim().length > 0,
    modified,
    added,
    deleted,
    untracked,
  };
}

export async function getGitInfo(cwd?: string): Promise<GitInfo> {
  if (!cwd) {
    return {};
  }

  try {
    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 800,
    });

    const branch = branchOut.trim();
    if (!branch) {
      return {};
    }

    let status: ReturnType<typeof parsePorcelain> = { dirty: false, modified: 0, added: 0, deleted: 0, untracked: 0 };
    try {
      const { stdout: statusOut } = await execFileAsync('git', ['--no-optional-locks', 'status', '--porcelain'], {
        cwd,
        encoding: 'utf8',
        timeout: 800,
      });
      status = parsePorcelain(statusOut);
    } catch {
      // noop
    }

    let aheadBehind: ReturnType<typeof parseAheadBehind> = {};
    try {
      const { stdout: countsOut } = await execFileAsync(
        'git',
        ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
        {
          cwd,
          encoding: 'utf8',
          timeout: 800,
        },
      );
      aheadBehind = parseAheadBehind(countsOut);
    } catch {
      // noop
    }

    return {
      branch,
      dirty: status.dirty,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      modified: status.modified,
      added: status.added,
      deleted: status.deleted,
      untracked: status.untracked,
    };
  } catch {
    return {};
  }
}
