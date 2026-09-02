import { readFile } from 'node:fs/promises';
import { canonicalJson } from './records.mjs';
import {
  secureRepositoryPath, SingularityFlowError, snapshot, writeJson
} from './util.mjs';

export const MCP_WORKSPACE_PATH = '.vscode/mcp.json';
export const MCP_SCAFFOLD_VERSIONS = Object.freeze({ playwright: '0.0.79' });
export const PLAYWRIGHT_MCP_HOST_ARGUMENTS = Object.freeze([
  '--isolated',
  '--headless',
  '--output-dir', '.git/singularity-flow/mcp/playwright-output',
  '--output-max-size', '5242880',
  '--viewport-size', '1440x900',
  '--timeout-action', '10000',
  '--timeout-navigation', '30000'
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertHostDocument(document) {
  if (!plainObject(document)) {
    throw new SingularityFlowError(`${MCP_WORKSPACE_PATH} must contain a JSON object.`, {
      code: 'MCP_HOST_CONFIG_INVALID'
    });
  }
  if (document.servers == null) document.servers = {};
  if (!plainObject(document.servers)) {
    throw new SingularityFlowError(`${MCP_WORKSPACE_PATH}.servers must be an object.`, {
      code: 'MCP_HOST_CONFIG_INVALID'
    });
  }
  return document;
}

export function figmaHostEntry({ local = false } = {}) {
  return {
    type: 'http',
    url: local ? 'http://127.0.0.1:3845/mcp' : 'https://mcp.figma.com/mcp'
  };
}

export function playwrightHostEntry({ packageVersion = MCP_SCAFFOLD_VERSIONS.playwright } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion)) {
    throw new SingularityFlowError('The release-managed Playwright MCP package version must be exact.', {
      code: 'MCP_FLOATING_PACKAGE_FORBIDDEN'
    });
  }
  return {
    type: 'stdio',
    // The repository host never receives a machine-local storage-state path. This transparent
    // SFlow launcher resolves the exact warmed executable and optional private auth profile only
    // after the host starts it in the verified repository cwd.
    command: 'singularity-flow',
    args: [
      'mcp', 'serve', 'playwright', '--package', `@playwright/mcp@${packageVersion}`,
      ...PLAYWRIGHT_MCP_HOST_ARGUMENTS
    ]
  };
}

export async function scaffoldMcpServer(root, { serverId, entry, replaceServer = false } = {}) {
  const target = await secureRepositoryPath(root, MCP_WORKSPACE_PATH, {
    label: 'VS Code MCP configuration',
    type: 'file'
  });
  let document = { inputs: [], servers: {} };
  if (target.exists) {
    try {
      document = JSON.parse(await readFile(target.absolute, 'utf8'));
    } catch (error) {
      throw new SingularityFlowError(`${MCP_WORKSPACE_PATH} is invalid JSON: ${error.message}`, {
        code: 'MCP_HOST_CONFIG_INVALID', cause: error
      });
    }
  }
  assertHostDocument(document);
  const current = document.servers[serverId];
  if (current && canonicalJson(current) === canonicalJson(entry)) {
    return {
      path: MCP_WORKSPACE_PATH, changed: false, status: 'unchanged',
      sha256: (await snapshot(target.absolute)).sha256
    };
  }
  if (current && !replaceServer) {
    throw new SingularityFlowError(
      `MCP host entry '${serverId}' already exists and differs. Review it and use --replace-server to replace only that entry.`,
      { code: 'MCP_HOST_ENTRY_CONFLICT', details: { serverId } }
    );
  }
  document.servers[serverId] = entry;
  await writeJson(target.absolute, document);
  return {
    path: MCP_WORKSPACE_PATH,
    changed: true,
    status: current ? 'replaced' : 'created',
    sha256: (await snapshot(target.absolute)).sha256
  };
}

export async function scaffoldFigmaMcp(root, options = {}) {
  return scaffoldMcpServer(root, {
    serverId: 'figma',
    entry: figmaHostEntry({ local: options.local === true }),
    replaceServer: options.replaceServer === true
  });
}

export async function scaffoldPlaywrightMcp(root, options = {}) {
  return scaffoldMcpServer(root, {
    serverId: 'playwright',
    entry: playwrightHostEntry(),
    replaceServer: options.replaceServer === true || options.replace === true
  });
}
