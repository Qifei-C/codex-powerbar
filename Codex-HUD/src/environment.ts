import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { EnvironmentInfo } from './types.js';

function countFiles(dir: string, pattern: RegExp): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((f) => pattern.test(f)).length;
  } catch {
    return 0;
  }
}

function countMarkdownFiles(dir: string): number {
  return countFiles(dir, /\.md$/i);
}

interface CodexToml {
  approval_policy?: string;
  sandbox?: string;
  mcp_servers?: Record<string, unknown>;
}

function parseToml(text: string): CodexToml {
  const result: CodexToml = {};

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"/);
    if (match) {
      const [, key, value] = match;
      if (key === 'approval_policy') result.approval_policy = value;
      if (key === 'sandbox') result.sandbox = value;
    }

    if (trimmed.startsWith('[mcp_servers')) {
      result.mcp_servers = result.mcp_servers ?? {};
    }
  }

  // Count MCP server sections: [mcp_servers.NAME]
  const serverSections = text.match(/\[mcp_servers\.\w+\]/g);
  if (serverSections) {
    result.mcp_servers = {};
    for (const section of serverSections) {
      const name = section.match(/\[mcp_servers\.(\w+)\]/)?.[1];
      if (name) result.mcp_servers[name] = true;
    }
  }

  return result;
}

export function collectEnvironment(cwd?: string): EnvironmentInfo {
  const codexHome = path.join(os.homedir(), '.codex');
  const configFile = path.join(codexHome, 'config.toml');

  // Prefer live env vars from patched codex over static TOML.
  let approvalPolicy = process.env.CODEX_APPROVAL_POLICY || undefined;
  let sandboxMode = process.env.CODEX_SANDBOX_MODE || undefined;
  const reviewer = process.env.CODEX_APPROVALS_REVIEWER || undefined;
  const collaborationMode = process.env.CODEX_COLLABORATION_MODE || undefined;
  const activeShells = Number.parseInt(process.env.CODEX_RUNNING_TOOLS ?? '', 10) || 0;
  let mcpServers = 0;

  // Fall back to TOML for values not available via env.
  if (fs.existsSync(configFile)) {
    try {
      const content = fs.readFileSync(configFile, 'utf8');
      const parsed = parseToml(content);
      if (!approvalPolicy) approvalPolicy = parsed.approval_policy;
      if (!sandboxMode) sandboxMode = parsed.sandbox;
      mcpServers = parsed.mcp_servers ? Object.keys(parsed.mcp_servers).length : 0;
    } catch {
      // noop
    }
  }

  // Append reviewer to policy label when guardian is active.
  if (reviewer === 'guardian_subagent' && approvalPolicy) {
    approvalPolicy = `${approvalPolicy}+guardian`;
  }

  const projectDir = cwd ?? process.cwd();

  // Count AGENTS.md files in project root and .codex/ subdirectories
  const agentsCount =
    (fs.existsSync(path.join(projectDir, 'AGENTS.md')) ? 1 : 0) +
    countMarkdownFiles(path.join(projectDir, '.codex', 'agents'));

  // Count INSTRUCTIONS.md
  const instructionsCount = fs.existsSync(path.join(projectDir, 'INSTRUCTIONS.md')) ? 1 : 0;

  // Count rules files in .codex/rules/ and ~/.codex/rules/
  const localRules = countMarkdownFiles(path.join(projectDir, '.codex', 'rules'));
  const globalRules = countMarkdownFiles(path.join(codexHome, 'rules'));
  const rulesCount = localRules + globalRules;

  return {
    approvalPolicy,
    sandboxMode,
    collaborationMode,
    activeShells,
    agentsCount,
    instructionsCount,
    rulesCount,
    mcpServers,
  };
}
