/** A fake machine for the distribution installers: npm, Copilot and VS Code as recorded calls. */
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function harness(version, {
  badInstalledVersion = false,
  badInstalledBuild = false,
  beforeVersion = null,
  initialInstalled = false,
  pluginIdentity = null,
  fullSurfaces = false,
  badRestoredBuild = false,
  badRestoredPlugin = false,
  tamperRestoredPackagedSkill = false,
  tamperRestoredSkill = false
} = {}) {
  const calls = [];
  const build = `${version} (distribution-fixture-build-01234567)`;
  let installed = initialInstalled;
  let plugin = pluginIdentity;
  let installedPluginRoot = null;
  let vscodeVersion = null;
  let globalInstallCount = 0;
  let pluginInstallCount = 0;
  const exists = (command) => ['node', 'npm', ...(fullSurfaces ? ['copilot', 'code'] : [])]
    .includes(command);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const execute = (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'npm' && args.join(' ') === 'config get registry') return ok('https://registry.npmjs.org/\n');
    if (command === 'npm' && args[0] === 'list') {
      return ok(installed ? JSON.stringify({ dependencies: { 'singularity-flow': { version } } }) : '{}');
    }
    if (command === 'npm' && args[0] === 'install' && args[1] === '--prefix') {
      const packageRoot = path.join(args[2], 'node_modules', 'singularity-flow');
      mkdirSync(path.join(packageRoot, 'plugin'), { recursive: true });
      mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
        name: 'singularity-flow', version
      })}\n`);
      writeFileSync(path.join(packageRoot, 'plugin', 'plugin.json'), `${JSON.stringify({
        name: 'singularity-flow', version
      })}\n`);
      writeFileSync(path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
        `if (process.argv[2] === '--build') console.log(${JSON.stringify(build)});\n`);
      const skill = path.join(packageRoot, 'plugin', 'skills', 'sflow-help');
      mkdirSync(skill, { recursive: true });
      writeFileSync(path.join(skill, 'SKILL.md'), [
        '---', 'name: sflow-help', 'description: Help', '---', '# Help', ''
      ].join('\n'));
      return ok();
    }
    if (command === 'npm' && args[0] === 'install') {
      if (args[1] === '--global') globalInstallCount += 1;
      installed = true;
      return ok();
    }
    if (command === 'npm' && args[0] === 'uninstall') { installed = false; return ok(); }
    if (command === 'copilot' && args.join(' ') === 'plugin list') {
      return ok(plugin ? `${plugin}\n` : '');
    }
    if (command === 'copilot' && args.join(' ') === 'plugin list --json') {
      if (!plugin) return ok('[]');
      const [name, marketplace = ''] = plugin.split('@');
      return ok(JSON.stringify([{
        name, marketplace, version,
        enabled: !(badRestoredPlugin && pluginInstallCount >= 2), source: 'installed'
      }]));
    }
    if (command === 'copilot' && args.join(' ') === 'skill list --json') {
      const skillsRoot = options.env?.SINGULARITY_FLOW_COPILOT_SKILLS_DIR
        ?? path.join(options.env?.HOME ?? os.homedir(), '.copilot', 'skills');
      return ok(JSON.stringify([
        {
          name: 'sf-help', description: 'Help', source: 'personal-copilot',
          path: path.join(skillsRoot, 'sf-help'), enabled: true
        },
        {
          name: 'sflow-help', description: 'Help', source: 'plugin',
          path: path.join(installedPluginRoot, 'skills', 'sflow-help'), enabled: true
        }
      ]));
    }
    if (command === 'copilot' && args[0] === 'plugins' && args[1] === 'list'
        && args[2] === '--kind' && args[4] === '--scope' && args[6] === '--json') {
      const kind = args[3];
      const scope = args[5];
      let plugins = [];
      if (kind === 'plugin' && scope === 'user' && plugin) {
        plugins = [{ kind, scope, name: 'singularity-flow', enabled: true }];
      } else if (kind === 'skill' && scope === 'user' && plugin) {
        plugins = [{ kind, scope, name: 'sf-help', enabled: true }];
      } else if (kind === 'skill' && scope === 'plugin' && plugin) {
        plugins = [{ kind, scope, name: 'sflow-help', enabled: true }];
      }
      return ok(`${JSON.stringify({ plugins, errors: [] })}\n`);
    }
    if (command === 'copilot' && args[0] === 'plugin' && args[1] === 'uninstall') {
      if (plugin === args[2]) plugin = null;
      return ok();
    }
    if (command === 'copilot' && args[0] === 'plugin' && args[1] === 'install') {
      pluginInstallCount += 1;
      plugin = 'singularity-flow';
      installedPluginRoot = path.join(
        options.env?.HOME ?? os.homedir(), '.copilot', 'plugin-cache', 'singularity-flow'
      );
      rmSync(installedPluginRoot, { recursive: true, force: true });
      cpSync(args[2], installedPluginRoot, { recursive: true });
      if (tamperRestoredPackagedSkill && pluginInstallCount >= 2) {
        appendFileSync(
          path.join(installedPluginRoot, 'skills', 'sflow-help', 'SKILL.md'),
          '\ntampered after plugin restore\n'
        );
      }
      return ok();
    }
    if (command === 'code' && args.join(' ') === '--list-extensions --show-versions') {
      return ok(vscodeVersion ? `singularityflow.singularity-flow-vscode@${vscodeVersion}\n` : '');
    }
    if (command === 'code' && args[0] === '--install-extension') {
      vscodeVersion = version;
      return ok();
    }
    if (command === 'code' && args[0] === '--uninstall-extension') {
      vscodeVersion = null;
      if (tamperRestoredSkill) {
        const skillsRoot = options.env?.SINGULARITY_FLOW_COPILOT_SKILLS_DIR
          ?? path.join(options.env?.HOME ?? os.homedir(), '.copilot', 'skills');
        appendFileSync(path.join(skillsRoot, 'sf-help', 'SKILL.md'), '\ntampered after restore\n');
      }
      return ok();
    }
    if (command === 'singularity-flow' && args.join(' ') === '--version') {
      beforeVersion?.();
      return ok(`${badInstalledVersion ? '0.0.0-bad' : version}\n`);
    }
    if (command === process.execPath && args.at(-1) === '--build') return ok(`${build}\n`);
    if (command === 'singularity-flow' && args.join(' ') === '--build') {
      const restoredMismatch = badRestoredBuild && globalInstallCount >= 2;
      return ok(`${badInstalledBuild || restoredMismatch
        ? `${version} (stale-distribution-build-89abcdef)` : build}\n`);
    }
    if (command === 'singularity-flow' && args.join(' ') === 'plugin verify --json') {
      return ok('{"status":"verified"}\n');
    }
    return ok();
  };
  return { calls, execute, exists };
}
