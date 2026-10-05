import path from 'node:path';
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { isDotnetManifest, selectDotnetManifest } from '../dotnet-manifests.mjs';
import { gradleBuildKind, GRADLE_TEST_TARGET_REASON } from '../gradle-manifests.mjs';
import { isXcodeManifest, SWIFT_TEST_ARGUMENTS } from '../swift-manifests.mjs';

const VERSION = '1.2.0';
const IMPLEMENTATION = 'sflow-smart-init-detectors-v1.2';

export const BUILTIN_DETECTORS = Object.freeze([
  ['node', 100], ['go', 90], ['maven', 80], ['gradle', 70], ['python', 60],
  ['dotnet', 65], ['swift', 55], ['rust', 50], ['make', 40], ['docker', 30]
].map(([id, priority]) => Object.freeze({
  id, version: VERSION, priority,
  implementationSha256: `sha256:${recordSha256({ id, version: VERSION, implementation: IMPLEMENTATION })}`
})));

export const detectorRegistrySha256 = `sha256:${recordSha256(BUILTIN_DETECTORS)}`;

function sourceMap(snapshot) {
  return new Map(snapshot.entries.filter((entry) => ['manifest', 'binary-manifest'].includes(entry.kind))
    .map((entry) => [entry.path, entry]));
}

function digestFact(core) {
  const factSha256 = `sha256:${recordSha256(core)}`;
  return { id: `DET-${factSha256.slice(7, 19).toUpperCase()}`, ...core, factSha256 };
}

function detector(id) {
  return BUILTIN_DETECTORS.find((entry) => entry.id === id);
}

function fact(snapshot, detectorId, source, locator, claim, {
  status = 'available', confidence = 'declared'
} = {}) {
  const producer = detector(detectorId);
  return digestFact({
    detector: { id: producer.id, version: producer.version, implementationSha256: producer.implementationSha256 },
    source: { path: source.path, sha256: source.sha256, locator },
    claim, status, confidence
  });
}

function command(id, purpose, launcher, args, workingDirectory, evidence, {
  confidence = 'conventional', adapter = purpose === 'verify' ? 'exit-code' : null,
  required = purpose === 'verify', precedence = 1, timeoutMs = null,
  observationMs = null, shutdownGraceMs = null
} = {}) {
  const candidate = {
    id, purpose, launcher, args, workingDirectory: workingDirectory || '.', adapter,
    modelPolicy: 'never', confidence, evidence: [...new Set(evidence)].sort(), required, precedence
  };
  if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) candidate.timeoutMs = timeoutMs;
  if (Number.isSafeInteger(observationMs) && observationMs > 0) candidate.observationMs = observationMs;
  if (Number.isSafeInteger(shutdownGraceMs) && shutdownGraceMs > 0) candidate.shutdownGraceMs = shutdownGraceMs;
  return candidate;
}

function moduleDirectory(file) {
  const value = path.posix.dirname(file);
  return value === '.' ? '.' : value;
}

function atDirectory(files, directory, name) {
  const target = directory === '.' ? name : `${directory}/${name}`;
  return files.get(target) ?? null;
}

function parseJson(source) {
  try { return JSON.parse(source.content); }
  catch (error) {
    throw new SingularityFlowError(`Initialization manifest is invalid JSON: ${source.path}`, {
      code: 'INI_MANIFEST_UNREADABLE', cause: error, details: { path: source.path }
    });
  }
}

function placeholderNodeTest(value) {
  return /(?:no test specified|echo\s+["']?error|exit\s+1)/i.test(String(value ?? ''));
}

const NODE_LOCKFILES = Object.freeze({
  npm: Object.freeze(['package-lock.json', 'npm-shrinkwrap.json']),
  pnpm: Object.freeze(['pnpm-lock.yaml']),
  yarn: Object.freeze(['yarn.lock']),
  bun: Object.freeze(['bun.lock', 'bun.lockb'])
});

const NODE_DEPENDENCY_ARGS = Object.freeze({
  npm: Object.freeze(['ci']),
  pnpm: Object.freeze(['install', '--frozen-lockfile']),
  yarn: Object.freeze(['install', '--frozen-lockfile']),
  bun: Object.freeze(['install', '--frozen-lockfile'])
});

const NODE_START_ALIASES = Object.freeze(['dev', 'serve', 'preview']);

function nodeLock(files, directory, manager) {
  return NODE_LOCKFILES[manager]
    ?.map((name) => atDirectory(files, directory, name))
    .find(Boolean) ?? null;
}

function nodeRunArgs(manager, name) {
  return manager === 'npm' && name === 'test'
    ? ['test']
    : manager === 'npm' && name === 'start'
      ? ['start']
      : ['run', name];
}

function detectNode(snapshot, files) {
  const facts = []; const commands = []; const ambiguities = [];
  const packages = [...files.values()].filter((entry) => path.posix.basename(entry.path) === 'package.json');
  for (const source of packages) {
    const manifest = parseJson(source);
    const directory = moduleDirectory(source.path);
    const stack = fact(snapshot, 'node', source, '#', { kind: 'stack', value: 'node', module: directory });
    facts.push(stack);
    const managerField = String(manifest.packageManager ?? '').split('@')[0].toLowerCase();
    const lockManagers = Object.entries(NODE_LOCKFILES)
      .filter(([, names]) => names.some((name) => atDirectory(files, directory, name)));
    let manager = ['npm', 'pnpm', 'yarn', 'bun'].includes(managerField) ? managerField : null;
    let managerEvidence = [stack.id];
    if (manager) {
      const managerFact = fact(snapshot, 'node', source, '#/packageManager', {
        kind: 'package-manager', value: manager, module: directory
      });
      facts.push(managerFact); managerEvidence.push(managerFact.id);
    } else if (lockManagers.length === 1) {
      manager = lockManagers[0][0];
      const lock = lockManagers[0][1].map((name) => atDirectory(files, directory, name)).find(Boolean);
      const managerFact = fact(snapshot, 'node', lock, '#', {
        kind: 'package-manager', value: manager, module: directory
      });
      facts.push(managerFact); managerEvidence.push(managerFact.id);
    } else if (lockManagers.length > 1) {
      ambiguities.push({
        id: `node-package-manager:${directory}`, purpose: 'dependency', scope: directory,
        candidates: lockManagers.map(([id]) => id).sort(),
        reason: 'Multiple package-manager lockfile families are present and packageManager is not declared.'
      });
    } else manager = 'npm';

    // A dependency restore is proposed only when the chosen package manager has its own lockfile.
    // The command is expressed as launcher + argv; lockfile or script contents never enter it.
    const lock = manager ? nodeLock(files, directory, manager) : null;
    if (lock) {
      const lockFact = fact(snapshot, 'node', lock, '#', {
        kind: 'dependency-lock', value: manager, module: directory
      });
      facts.push(lockFact);
      commands.push(command(
        `dependency-node-${safeId(directory)}-${manager}`,
        'dependency', manager, [...NODE_DEPENDENCY_ARGS[manager]], directory,
        [...managerEvidence, lockFact.id], {
          confidence: 'declared', required: true, precedence: 40, timeoutMs: 600_000
        }
      ));
    }

    const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
    const declared = (name, purpose) => {
      if (typeof scripts[name] !== 'string' || !scripts[name].trim()) return;
      const scriptFact = fact(snapshot, 'node', source, `#/scripts/${name}`, {
        kind: 'script', value: name, purpose, module: directory
      });
      facts.push(scriptFact);
      if (purpose === 'verify' && placeholderNodeTest(scripts[name])) return;
      if (!manager) return;
      const args = nodeRunArgs(manager, name);
      commands.push(command(`${purpose}-node-${safeId(directory)}-${name}`, purpose, manager, args,
        directory, [...managerEvidence, scriptFact.id], { confidence: 'declared', precedence: 30 }));
    };
    for (const name of ['test', 'test:ci', 'ci:test']) declared(name, 'verify');
    for (const name of ['lint', 'typecheck', 'check:types', 'format:check']) declared(name, 'quality');
    declared('build', 'build');

    const startNames = ['start', ...NODE_START_ALIASES]
      .filter((name) => typeof scripts[name] === 'string' && scripts[name].trim());
    const selectedStart = startNames.includes('start')
      ? 'start'
      : startNames.length === 1 ? startNames[0] : null;
    if (!selectedStart && startNames.length > 1) {
      ambiguities.push({
        id: `node-start-script:${directory}`, purpose: 'start', scope: directory,
        candidates: startNames.sort(),
        reason: 'Multiple application-start aliases are declared and no canonical start script exists.'
      });
    } else if (selectedStart) {
      const startFact = fact(snapshot, 'node', source, `#/scripts/${selectedStart}`, {
        kind: 'script', value: selectedStart, purpose: 'start', module: directory
      });
      facts.push(startFact);
      if (manager) commands.push(command(
        `start-node-${safeId(directory)}-${selectedStart}`,
        'start', manager, nodeRunArgs(manager, selectedStart), directory,
        [...managerEvidence, startFact.id], {
          confidence: 'declared', required: false, precedence: 30,
          timeoutMs: 15_000, observationMs: 5_000, shutdownGraceMs: 2_000
        }
      ));
    }
  }
  return { facts, commands, ambiguities };
}

function safeId(value) {
  return value === '.' ? 'root' : value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function conventionalStack(files, fileName, detectorId, stack, proposals) {
  const facts = []; const commands = [];
  for (const source of [...files.values()].filter((entry) => path.posix.basename(entry.path).toLowerCase() === fileName)) {
    const directory = moduleDirectory(source.path);
    const stackFact = fact(null, detectorId, source, '#', { kind: 'stack', value: stack, module: directory });
    facts.push(stackFact);
    for (const proposal of proposals(directory, files)) commands.push(command(
      `${proposal.purpose}-${detectorId}-${safeId(directory)}`, proposal.purpose,
      proposal.launcher, proposal.args, directory, [stackFact.id], {
        confidence: proposal.confidence ?? 'conventional', precedence: proposal.precedence ?? 10,
        adapter: proposal.adapter ?? (proposal.purpose === 'verify' ? 'exit-code' : null)
      }
    ));
  }
  return { facts, commands, ambiguities: [] };
}

function detectGo(snapshot, files) {
  const workspaces = [...files.values()].filter((entry) => path.posix.basename(entry.path) === 'go.work');
  if (!workspaces.length) return conventionalStack(files, 'go.mod', 'go', 'go', () => [
    { purpose: 'verify', launcher: 'go', args: ['test', './...'] },
    { purpose: 'quality', launcher: 'go', args: ['vet', './...'] },
    { purpose: 'build', launcher: 'go', args: ['build', './...'] }
  ]);
  const facts = []; const commands = [];
  for (const source of workspaces) {
    const directory = moduleDirectory(source.path);
    const modules = [];
    let inUseBlock = false;
    for (const raw of source.content.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/u, '').trim();
      if (!line) continue;
      if (/^use\s*\($/u.test(line)) { inUseBlock = true; continue; }
      if (inUseBlock && line === ')') { inUseBlock = false; continue; }
      const value = inUseBlock ? line : /^use\s+(.+)$/u.exec(line)?.[1];
      if (!value || /["'`]/u.test(value)) continue;
      const normalized = path.posix.normalize(path.posix.join(directory, value.trim()));
      if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) continue;
      modules.push(normalized);
    }
    const stackFact = fact(snapshot, 'go', source, '#', {
      kind: 'stack', value: 'go', module: directory, workspaceModules: [...new Set(modules)].sort()
    });
    facts.push(stackFact);
    for (const [purpose, args] of [['verify', ['test', './...']], ['quality', ['vet', './...']], ['build', ['build', './...']]]) {
      commands.push(command(`${purpose}-go-${safeId(directory)}`, purpose, 'go', args, directory, [stackFact.id]));
    }
  }
  return { facts, commands, ambiguities: [] };
}

function detectMaven(snapshot, files) {
  const result = conventionalStack(files, 'pom.xml', 'maven', 'java-maven', (directory) => {
    const wrapper = atDirectory(files, directory, 'mvnw') || atDirectory(files, directory, 'mvnw.cmd');
    const launcher = wrapper ? 'maven-wrapper' : 'mvn';
    const precedence = wrapper ? 20 : 10;
    return [
      { purpose: 'verify', launcher, args: ['-q', 'verify'], precedence },
      { purpose: 'build', launcher, args: ['-q', 'package'], precedence }
    ];
  });
  result.facts = result.facts.map((entry) => {
    const source = files.get(entry.source.path);
    return /<artifactId>\s*kotlin-maven-plugin\s*<\/artifactId>/u.test(source.content)
      ? fact(snapshot, 'maven', source, '#', { ...entry.claim, value: 'kotlin-maven' }) : entry;
  });
  // Keep command evidence joined to the new language-specific stack fact.
  result.commands.forEach((entry) => {
    entry.evidence = result.facts.filter((item) => item.claim.module === entry.workingDirectory).map((item) => item.id);
  });
  return result;
}

function detectGradle(snapshot, files) {
  const buildNames = new Set(['build.gradle', 'build.gradle.kts']);
  const roots = [...files.values()].filter((entry) => buildNames.has(path.posix.basename(entry.path).toLowerCase()));
  const facts = []; const commands = []; const ambiguities = [];
  for (const source of roots) {
    const directory = moduleDirectory(source.path);
    const { stack, requiresTestTarget } = gradleBuildKind(source.content);
    const stackFact = fact(snapshot, 'gradle', source, '#', { kind: 'stack',
      value: stack, module: directory });
    facts.push(stackFact);
    const wrapper = atDirectory(files, directory, 'gradlew') || atDirectory(files, directory, 'gradlew.bat');
    const launcher = wrapper ? 'gradle-wrapper' : 'gradle';
    const precedence = wrapper ? 20 : 10;
    if (requiresTestTarget) ambiguities.push({
      id: `gradle-test-target:${directory}`, purpose: 'verify', scope: directory,
      candidates: [], reason: GRADLE_TEST_TARGET_REASON
    });
    else commands.push(command(`verify-gradle-${safeId(directory)}`, 'verify', launcher, ['test'], directory, [stackFact.id], { precedence }));
    commands.push(command(`build-gradle-${safeId(directory)}`, 'build', launcher, ['build'], directory, [stackFact.id], { precedence }));
  }
  return { facts, commands, ambiguities };
}

function detectDotnet(snapshot, files) {
  const directories = new Map();
  for (const source of files.values()) {
    if (!isDotnetManifest(source.path)) continue;
    const directory = moduleDirectory(source.path);
    if (!directories.has(directory)) directories.set(directory, []);
    directories.get(directory).push(path.posix.basename(source.path));
  }
  const facts = []; const commands = []; const ambiguities = [];
  for (const [directory, names] of directories) {
    let selected;
    try { selected = selectDotnetManifest(names); }
    catch (error) {
      ambiguities.push({ id: `dotnet-entry-point:${directory}`, purpose: 'verify', scope: directory,
        candidates: error.details.manifests, reason: error.message });
      // Still disclose the stack; an ambiguous code repository cannot get an empty receipt.
      facts.push(fact(snapshot, 'dotnet', atDirectory(files, directory, names.sort()[0]), '#',
        { kind: 'stack', value: 'dotnet', module: directory }));
      continue;
    }
    const source = atDirectory(files, directory, selected);
    const stackFact = fact(snapshot, 'dotnet', source, '#', { kind: 'stack', value: 'dotnet', module: directory });
    facts.push(stackFact);
    const locked = Boolean(atDirectory(files, directory, 'packages.lock.json'));
    commands.push(command(`dependency-dotnet-${safeId(directory)}`, 'dependency', 'dotnet',
      ['restore', selected, ...(locked ? ['--locked-mode'] : [])], directory, [stackFact.id], { confidence: 'declared' }));
    commands.push(command(`build-dotnet-${safeId(directory)}`, 'build', 'dotnet', ['build', selected], directory, [stackFact.id]));
    commands.push(command(`verify-dotnet-${safeId(directory)}`, 'verify', 'dotnet',
      ['test', selected, '--logger', 'trx', '--results-directory', 'TestResults'], directory, [stackFact.id]));
  }
  return { facts, commands, ambiguities };
}

function detectPython(snapshot, files) {
  const configurationNames = new Set(['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']);
  const directories = [...new Set([...files.values()]
    .filter((entry) => configurationNames.has(path.posix.basename(entry.path).toLowerCase()))
    .map((entry) => moduleDirectory(entry.path)))].sort();
  const facts = []; const commands = [];
  for (const directory of directories) {
    const source = atDirectory(files, directory, 'pyproject.toml')
      ?? atDirectory(files, directory, 'pytest.ini')
      ?? atDirectory(files, directory, 'setup.cfg')
      ?? atDirectory(files, directory, 'tox.ini');
    const stackFact = fact(snapshot, 'python', source, '#', { kind: 'stack', value: 'python', module: directory });
    facts.push(stackFact);
    const pyproject = atDirectory(files, directory, 'pyproject.toml');
    const setup = atDirectory(files, directory, 'setup.cfg');
    const tox = atDirectory(files, directory, 'tox.ini');
    const pytestIni = atDirectory(files, directory, 'pytest.ini');
    const combined = [pyproject, setup, tox, pytestIni].filter(Boolean).map((entry) => entry.content).join('\n');
    const pytest = Boolean(pytestIni || tox || /\[tool\.pytest\.ini_options\]/u.test(combined)
      || /(?:^|[\s"'])pytest(?:[\s"'<>=,]|$)/imu.test(combined));
    if (pytest) commands.push(command(`verify-python-${safeId(directory)}`, 'verify', 'python', ['-m', 'pytest'], directory, [stackFact.id], { confidence: 'declared', precedence: 30 }));
    if (/\[tool\.ruff(?:\]|\.)/u.test(combined) || /^\[ruff\]/mu.test(combined)) commands.push(command(`quality-python-ruff-${safeId(directory)}`, 'quality', 'ruff', ['check', '.'], directory, [stackFact.id], { confidence: 'declared', precedence: 30 }));
    if (/\[tool\.mypy\]/u.test(combined) || /^\[mypy\]/mu.test(combined)) commands.push(command(`quality-python-mypy-${safeId(directory)}`, 'quality', 'mypy', ['.'], directory, [stackFact.id], { confidence: 'declared', precedence: 30 }));
    if (pyproject && /\[build-system\]/u.test(pyproject.content)) commands.push(command(`build-python-${safeId(directory)}`, 'build', 'python', ['-m', 'build'], directory, [stackFact.id], { confidence: 'declared', precedence: 30 }));
  }
  return { facts, commands, ambiguities: [] };
}

function detectRust(snapshot, files) {
  return conventionalStack(files, 'cargo.toml', 'rust', 'rust', () => [
    { purpose: 'verify', launcher: 'cargo', args: ['test'] },
    { purpose: 'quality', launcher: 'cargo', args: ['clippy', '--all-targets', '--all-features', '--', '-D', 'warnings'] },
    { purpose: 'build', launcher: 'cargo', args: ['build'] }
  ]);
}

function detectSwift(snapshot, files) {
  // Package.swift is executable source. Detection binds its bytes but never loads the package,
  // invokes a compiler, or guesses test frameworks from comments or arbitrary Swift expressions.
  const result = conventionalStack(files, 'package.swift', 'swift', 'swift', () => [
    { purpose: 'verify', launcher: 'swift', args: [...SWIFT_TEST_ARGUMENTS] },
    { purpose: 'build', launcher: 'swift', args: ['build'] }
  ]);
  for (const source of files.values()) {
    if (!isXcodeManifest(source.path)) continue;
    const directory = path.posix.dirname(path.posix.dirname(source.path));
    result.facts.push(fact(snapshot, 'swift', source, '#', {
      kind: 'stack', value: 'swift-xcode', module: directory
    }));
    result.ambiguities.push({
      id: `xcode-test-target:${source.path}`, purpose: 'verify', scope: directory,
      candidates: [],
      reason: 'Xcode tests require an approved explicit scheme, destination and structured result command; SwiftPM test inference does not qualify an Xcode project.'
    });
  }
  return result;
}

function detectMake(snapshot, files) {
  const names = new Set(['makefile', 'gnumakefile']);
  const facts = []; const commands = [];
  for (const source of [...files.values()].filter((entry) => names.has(path.posix.basename(entry.path).toLowerCase()))) {
    const directory = moduleDirectory(source.path);
    const targets = new Set();
    for (const line of source.content.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/u.exec(line);
      if (match) targets.add(match[1]);
    }
    for (const name of ['test', 'verify', 'lint', 'check', 'typecheck', 'build']) {
      if (!targets.has(name)) continue;
      const purpose = ['test', 'verify'].includes(name) ? 'verify' : name === 'build' ? 'build' : 'quality';
      const targetFact = fact(snapshot, 'make', source, `target:${name}`, { kind: 'make-target', value: name, purpose, module: directory });
      facts.push(targetFact);
      commands.push(command(`${purpose}-make-${safeId(directory)}-${name}`, purpose, 'make', [name], directory, [targetFact.id], { confidence: 'declared', precedence: 30 }));
    }
  }
  return { facts, commands, ambiguities: [] };
}

function detectDocker(snapshot, files) {
  const facts = [...files.values()].filter((entry) => /^dockerfile(?:[._-].+)?$/iu.test(path.posix.basename(entry.path)))
    .map((source) => fact(snapshot, 'docker', source, '#', { kind: 'stack', value: 'container', module: moduleDirectory(source.path) }));
  return { facts, commands: [], ambiguities: [] };
}

function chooseCommands(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.purpose}\0${candidate.workingDirectory}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const selected = []; const discarded = []; const ambiguities = [];
  for (const [key, values] of groups) {
    const unique = [...new Map(values.map((item) => [JSON.stringify([
      item.launcher, item.args, item.workingDirectory, item.purpose
    ]), item])).values()];
    const highest = Math.max(...unique.map((item) => item.precedence));
    const top = unique.filter((item) => item.precedence === highest)
      .sort((a, b) => a.id.localeCompare(b.id, 'en'));
    discarded.push(...unique.filter((item) => item.precedence < highest).map((item) => ({ ...item, reason: 'lower-precedence-candidate' })));
    // Distinct commands at the same winning precedence are cumulative checks (for example lint and
    // typecheck, or required verifiers for independent stacks). Detectors emit an ambiguity before
    // this point only when the candidates are alternatives, such as incompatible package managers.
    selected.push(...top);
  }
  return { selected, discarded, ambiguities };
}

export function runSmartInitDetectors(snapshot, { maxModules = 200, maxCommands = 100 } = {}) {
  const files = sourceMap(snapshot);
  const results = [
    detectNode(snapshot, files), detectGo(snapshot, files), detectMaven(snapshot, files),
    detectGradle(snapshot, files), detectDotnet(snapshot, files), detectPython(snapshot, files), detectSwift(snapshot, files), detectRust(snapshot, files),
    detectMake(snapshot, files), detectDocker(snapshot, files)
  ];
  const facts = results.flatMap((entry) => entry.facts).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const modules = new Set(facts.map((entry) => entry.claim.module).filter(Boolean));
  if (modules.size > maxModules) throw new SingularityFlowError(
    `Smart initialization detected ${modules.size} modules; the bound is ${maxModules}.`,
    { code: 'INI_DETECTION_BOUND_EXCEEDED', details: { bound: 'maxModules', observed: modules.size } }
  );
  const chosen = chooseCommands(results.flatMap((entry) => entry.commands));
  if (chosen.selected.length > maxCommands) throw new SingularityFlowError(
    `Smart initialization selected ${chosen.selected.length} commands; the bound is ${maxCommands}.`,
    { code: 'INI_DETECTION_BOUND_EXCEEDED', details: { bound: 'maxCommands', observed: chosen.selected.length } }
  );
  const ambiguities = [...results.flatMap((entry) => entry.ambiguities), ...chosen.ambiguities]
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return {
    facts,
    commands: {
      dependency: chosen.selected.filter((entry) => entry.purpose === 'dependency'),
      verification: chosen.selected.filter((entry) => entry.purpose === 'verify'),
      quality: chosen.selected.filter((entry) => entry.purpose === 'quality'),
      build: chosen.selected.filter((entry) => entry.purpose === 'build'),
      start: chosen.selected.filter((entry) => entry.purpose === 'start')
    },
    discardedCommands: chosen.discarded,
    ambiguities,
    stacks: [...new Set(facts.filter((entry) => entry.claim.kind === 'stack').map((entry) => entry.claim.value))].sort()
  };
}
