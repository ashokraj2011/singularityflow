/** Confirmation-bound semantic project warm-up. */
import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { discoverProjectBindings, projectBindingSha256, validateProjectBinding } from './ast-project-binding.mjs';
import { gitCommonDir } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { runQualityCommand } from './quality-command-runner.mjs';
import { optionBoolean, optionString, SingularityFlowError, writeJson } from './util.mjs';

const PROVIDERS = Object.freeze({
  'sflow-java-jdt': { projectKinds: ['maven', 'gradle', 'java-standalone'], tool: ['java'], modelTool: { maven: ['mvn'], gradle: ['gradle'] }, kind: 'jdk+jdt' },
  'sflow-python-pyright': { projectKinds: ['python'], tool: ['python3', 'python'], kind: 'python+pyright' },
  'sflow-kotlin-analysis': { projectKinds: ['gradle', 'gradle-android'], tool: ['kotlinc'], modelTool: { gradle: ['gradle'], 'gradle-android': ['gradle'] }, kind: 'jdk+kotlin' },
  'sflow-swift-sourcekit': { projectKinds: ['swiftpm', 'xcode'], tool: ['sourcekit-lsp'], modelTool: { swiftpm: ['swift'], xcode: ['xcodebuild'] }, kind: 'swift+sourcekit' }
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function projectId(binding) {
  return `${binding.projectKind}:${binding.root}`;
}

function warmRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'ast', 'v2', 'projects');
}

function warmPath(root, binding) {
  return path.join(warmRoot(root), `${recordSha256({ projectKind: binding.projectKind, root: binding.root })}.json`);
}

function executableCandidates(name) {
  if (process.platform !== 'win32') return [name];
  const extensions = String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  return path.extname(name) ? [name] : extensions.map((extension) => `${name}${extension.toLowerCase()}`);
}

async function findExecutable(names, explicit = null) {
  const candidates = explicit ? [path.resolve(explicit)] : String(process.env.PATH ?? '').split(path.delimiter)
    .filter(Boolean).flatMap((directory) => names.flatMap((name) => executableCandidates(name).map((candidate) => path.join(directory, candidate))));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch { /* continue */ }
  }
  return null;
}

function versionArguments(provider, executable) {
  const name = path.basename(executable).toLowerCase();
  if (provider === 'sflow-java-jdt' || name.startsWith('java')) return ['--version'];
  if (provider === 'sflow-python-pyright' || name.startsWith('python')) return ['--version'];
  if (name.startsWith('xcodebuild')) return ['-version'];
  return ['-version'];
}

function projectArguments(binding, executable) {
  const projectDirectory = binding.root === '.' ? '.' : binding.root;
  if (binding.projectKind === 'maven') return { cwd: projectDirectory, argv: [executable, '-o', '-q', 'help:effective-pom'] };
  if (binding.projectKind === 'gradle' || binding.projectKind === 'gradle-android') {
    return { cwd: projectDirectory, argv: [executable, '--offline', '--no-daemon', '-q', 'projects'] };
  }
  if (binding.projectKind === 'python') return { cwd: projectDirectory, argv: [executable, '-m', 'pip', 'check'] };
  if (binding.projectKind === 'swiftpm') return { cwd: projectDirectory, argv: [executable, 'package', 'describe', '--type', 'json', '--skip-update'] };
  if (binding.projectKind === 'xcode') {
    const project = binding.buildFiles.find((file) => file.path.endsWith('project.pbxproj'))?.path;
    const bundle = project ? project.slice(0, project.indexOf('.xcodeproj/') + '.xcodeproj'.length) : null;
    return { cwd: projectDirectory, argv: [executable, '-list', '-json', ...(bundle ? ['-project', bundle] : [])] };
  }
  return { cwd: projectDirectory, argv: [] };
}

function redactedCommand(command) {
  return { kind: command.kind, executable: path.basename(command.argv[0] ?? ''), arguments: command.argv.slice(1), cwd: command.cwd };
}

export async function planAstSemanticWarm(root, options = {}) {
  const providerId = optionString(options, 'provider');
  const profile = optionString(options, 'profile');
  const requestedProject = optionString(options, 'project');
  if (!PROVIDERS[providerId]) {
    throw new SingularityFlowError(`AST semantic warm-up requires --provider ${Object.keys(PROVIDERS).join('|')}.`, { code: 'AST_WARM_PROVIDER_REQUIRED' });
  }
  if (!profile) throw new SingularityFlowError('AST semantic warm-up requires an explicit --profile.', { code: 'AST_WARM_PROFILE_REQUIRED' });
  const discovery = await discoverProjectBindings(root, { includeWarm: false });
  const compatible = discovery.bindings.filter((binding) => PROVIDERS[providerId].projectKinds.includes(binding.projectKind));
  const binding = requestedProject ? compatible.find((candidate) => projectId(candidate) === requestedProject) : compatible.length === 1 ? compatible[0] : null;
  if (!binding) {
    throw new SingularityFlowError(
      compatible.length
        ? `Select one project with --project <KIND:ROOT>. Available: ${compatible.map(projectId).join(', ')}.`
        : `No project compatible with '${providerId}' was discovered.`,
      { code: compatible.length ? 'AST_WARM_PROJECT_REQUIRED' : 'AST_WARM_PROJECT_UNAVAILABLE' }
    );
  }
  const provider = PROVIDERS[providerId];
  const toolchainExecutable = await findExecutable(provider.tool, optionString(options, 'toolchain'));
  const modelNames = provider.modelTool?.[binding.projectKind] ?? provider.tool;
  const modelExecutable = await findExecutable(modelNames, optionString(options, 'project-tool'));
  const commands = [];
  if (toolchainExecutable) commands.push({ kind: 'toolchain-version', cwd: '.', argv: [toolchainExecutable, ...versionArguments(providerId, toolchainExecutable)] });
  if (modelExecutable) {
    const project = projectArguments(binding, modelExecutable);
    if (project.argv.length) commands.push({ kind: 'project-model', ...project });
  }
  const unavailable = [
    ...(!toolchainExecutable ? [`toolchain:${provider.tool.join('|')}`] : []),
    ...(!modelExecutable ? [`project-tool:${modelNames.join('|')}`] : [])
  ];
  const semantic = {
    provider: providerId,
    project: projectId(binding),
    profile,
    sourceConfigurationSha256: binding.configurationSha256,
    sourceProjectModelSha256: binding.projectModelSha256,
    executableSha256: toolchainExecutable ? sha256(await readFile(toolchainExecutable)) : null,
    modelExecutableSha256: modelExecutable ? sha256(await readFile(modelExecutable)) : null,
    commands: commands.map(redactedCommand)
  };
  const planSha256 = recordSha256(semantic);
  return {
    schemaVersion: currentSchemaVersion('ast-semantic-warm-plan'),
    operation: 'ast-semantic-warm',
    project: projectId(binding),
    provider: providerId,
    profile,
    ready: unavailable.length === 0,
    unavailable,
    effects: {
      repositoryWrites: false,
      network: 'blocked-by-offline-command',
      executesRepositoryConfiguration: ['maven', 'gradle', 'gradle-android', 'swiftpm', 'xcode'].includes(binding.projectKind),
      writes: [path.relative(gitCommonDir(root), warmPath(root, binding)).replaceAll(path.sep, '/')]
    },
    commands: commands.map(redactedCommand),
    planSha256,
    confirmation: `WARM AST SEMANTICS ${providerId} ${planSha256.slice(0, 12)}`,
    binding: structuredClone(binding),
    executables: { toolchainExecutable, modelExecutable },
    semantic
  };
}

function closedEnvironment() {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
    .filter((key) => process.env[key] != null).map((key) => [key, process.env[key]]));
}

export async function applyAstSemanticWarm(root, plan, options = {}) {
  if (!plan.ready) throw new SingularityFlowError(`AST semantic warm-up is unavailable: ${plan.unavailable.join(', ')}.`, { code: 'AST_WARM_UNAVAILABLE' });
  if (optionString(options, 'confirm') !== plan.confirmation) {
    throw new SingularityFlowError(`AST semantic warm-up requires --confirm "${plan.confirmation}".`, { code: 'AST_WARM_CONFIRMATION_REQUIRED' });
  }
  const evidence = [];
  for (const command of plan.commands) {
    const absolute = command.kind === 'toolchain-version' ? plan.executables.toolchainExecutable : plan.executables.modelExecutable;
    const args = command.arguments;
    const cwd = path.resolve(root, command.cwd);
    const result = await runQualityCommand(absolute, args, {
      cwd, env: closedEnvironment(), shell: false, timeoutMs: 60_000, captureBytes: 1024 * 1024
    });
    if (result.timedOut || result.status !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      throw new SingularityFlowError(
        `AST semantic warm-up command '${command.kind}' failed safely; no binding was written.`,
        { code: result.timedOut ? 'AST_WARM_TIMEOUT' : 'AST_WARM_COMMAND_FAILED' }
      );
    }
    evidence.push({
      kind: command.kind,
      status: result.status,
      outputSha256: recordSha256({ stdout: result.stdout, stderr: result.stderr }),
      outputBytes: result.stdoutBytes + result.stderrBytes
    });
  }
  const toolEvidence = evidence.find((entry) => entry.kind === 'toolchain-version');
  const projectEvidence = evidence.find((entry) => entry.kind === 'project-model') ?? toolEvidence;
  const executableBytes = await readFile(plan.executables.toolchainExecutable);
  const binding = {
    ...structuredClone(plan.binding),
    profile: plan.profile,
    toolchain: {
      kind: PROVIDERS[plan.provider].kind,
      version: `${path.basename(plan.executables.toolchainExecutable)}:${toolEvidence.outputSha256.slice(0, 12)}`,
      identitySha256: recordSha256({ executableSha256: sha256(executableBytes), versionOutputSha256: toolEvidence.outputSha256 })
    },
    dependencyGraphSha256: recordSha256({ previous: plan.binding.dependencyGraphSha256, projectOutputSha256: projectEvidence.outputSha256 }),
    configurationSha256: recordSha256({ previous: plan.binding.configurationSha256, provider: plan.provider, profile: plan.profile }),
    semanticProvider: plan.provider,
    complete: true,
    unavailable: [],
    projectModelSha256: ''
  };
  binding.projectModelSha256 = projectBindingSha256(binding);
  const validated = validateProjectBinding(binding);
  const record = {
    schemaVersion: currentSchemaVersion('ast-semantic-binding'),
    provider: plan.provider,
    profile: plan.profile,
    sourceConfigurationSha256: plan.binding.configurationSha256,
    sourceProjectModelSha256: plan.binding.projectModelSha256,
    planSha256: plan.planSha256,
    binding: validated,
    evidence,
    warmedAt: new Date().toISOString(),
    integritySha256: ''
  };
  const { integritySha256: _integrity, ...integrityContent } = record;
  record.integritySha256 = recordSha256(integrityContent);
  await writeJson(warmPath(root, validated), record);
  return {
    schemaVersion: currentSchemaVersion('ast-semantic-binding'),
    operation: 'ast-semantic-warm',
    warmed: true,
    project: projectId(validated),
    provider: plan.provider,
    profile: plan.profile,
    binding: validated,
    evidence
  };
}

export async function readAstSemanticBinding(root, baseBinding) {
  try {
    const stored = readRecord('ast-semantic-binding', await readFile(warmPath(root, baseBinding))).record;
    const { integritySha256, ...content } = stored;
    if (recordSha256(content) !== integritySha256
      || stored.sourceConfigurationSha256 !== baseBinding.configurationSha256
      || stored.sourceProjectModelSha256 !== baseBinding.projectModelSha256) return null;
    return validateProjectBinding(stored.binding);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function astSemanticWarmCommand(root, options = {}) {
  const plan = await planAstSemanticWarm(root, options);
  if (optionBoolean(options, 'dry-run')) {
    const { binding: _binding, executables: _executables, semantic: _semantic, ...safe } = plan;
    return { ...safe, dryRun: true };
  }
  return applyAstSemanticWarm(root, plan, options);
}
