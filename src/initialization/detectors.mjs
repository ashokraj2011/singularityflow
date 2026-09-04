import path from 'node:path';
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

const VERSION = '1.0.0';
const IMPLEMENTATION = 'sflow-smart-init-detectors-v1';

export const BUILTIN_DETECTORS = Object.freeze([
  ['node', 100], ['go', 90], ['maven', 80], ['gradle', 70], ['python', 60],
  ['rust', 50], ['make', 40], ['docker', 30]
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
  required = purpose === 'verify', precedence = 1
} = {}) {
  return {
    id, purpose, launcher, args, workingDirectory: workingDirectory || '.', adapter,
    modelPolicy: 'never', confidence, evidence: [...new Set(evidence)].sort(), required, precedence
  };
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

function detectNode(snapshot, files) {
  const facts = []; const commands = []; const ambiguities = [];
  const packages = [...files.values()].filter((entry) => path.posix.basename(entry.path) === 'package.json');
  for (const source of packages) {
    const manifest = parseJson(source);
    const directory = moduleDirectory(source.path);
    const stack = fact(snapshot, 'node', source, '#', { kind: 'stack', value: 'node', module: directory });
    facts.push(stack);
    const managerField = String(manifest.packageManager ?? '').split('@')[0].toLowerCase();
    const lockManagers = [
      ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
      ['pnpm', ['pnpm-lock.yaml']], ['yarn', ['yarn.lock']], ['bun', ['bun.lock', 'bun.lockb']]
    ].filter(([, names]) => names.some((name) => atDirectory(files, directory, name)));
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
        id: `node-package-manager:${directory}`, purpose: 'verify', scope: directory,
        candidates: lockManagers.map(([id]) => id).sort(),
        reason: 'Multiple package-manager lockfile families are present and packageManager is not declared.'
      });
    } else manager = 'npm';

    const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
    const declared = (name, purpose) => {
      if (typeof scripts[name] !== 'string' || !scripts[name].trim()) return;
      const scriptFact = fact(snapshot, 'node', source, `#/scripts/${name}`, {
        kind: 'script', value: name, purpose, module: directory
      });
      facts.push(scriptFact);
      if (purpose === 'verify' && placeholderNodeTest(scripts[name])) return;
      if (!manager) return;
      const args = manager === 'npm' && name === 'test' ? ['test'] : ['run', name];
      commands.push(command(`${purpose}-node-${safeId(directory)}-${name}`, purpose, manager, args,
        directory, [...managerEvidence, scriptFact.id], { confidence: 'declared', precedence: 30 }));
    };
    for (const name of ['test', 'test:ci', 'ci:test']) declared(name, 'verify');
    for (const name of ['lint', 'typecheck', 'check:types', 'format:check']) declared(name, 'quality');
    declared('build', 'build');
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
  return conventionalStack(files, 'pom.xml', 'maven', 'java-maven', (directory) => {
    const wrapper = atDirectory(files, directory, 'mvnw') || atDirectory(files, directory, 'mvnw.cmd');
    const launcher = wrapper ? 'maven-wrapper' : 'mvn';
    const precedence = wrapper ? 20 : 10;
    return [
      { purpose: 'verify', launcher, args: ['-q', 'verify'], precedence },
      { purpose: 'build', launcher, args: ['-q', 'package'], precedence }
    ];
  });
}

function detectGradle(snapshot, files) {
  const buildNames = new Set(['build.gradle', 'build.gradle.kts']);
  const roots = [...files.values()].filter((entry) => buildNames.has(path.posix.basename(entry.path).toLowerCase()));
  const facts = []; const commands = [];
  for (const source of roots) {
    const directory = moduleDirectory(source.path);
    const stackFact = fact(snapshot, 'gradle', source, '#', { kind: 'stack', value: 'java-gradle', module: directory });
    facts.push(stackFact);
    const wrapper = atDirectory(files, directory, 'gradlew') || atDirectory(files, directory, 'gradlew.bat');
    const launcher = wrapper ? 'gradle-wrapper' : 'gradle';
    const precedence = wrapper ? 20 : 10;
    commands.push(command(`verify-gradle-${safeId(directory)}`, 'verify', launcher, ['test'], directory, [stackFact.id], { precedence }));
    commands.push(command(`build-gradle-${safeId(directory)}`, 'build', launcher, ['build'], directory, [stackFact.id], { precedence }));
  }
  return { facts, commands, ambiguities: [] };
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
    detectGradle(snapshot, files), detectPython(snapshot, files), detectRust(snapshot, files),
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
      verification: chosen.selected.filter((entry) => entry.purpose === 'verify'),
      quality: chosen.selected.filter((entry) => entry.purpose === 'quality'),
      build: chosen.selected.filter((entry) => entry.purpose === 'build')
    },
    discardedCommands: chosen.discarded,
    ambiguities,
    stacks: [...new Set(facts.filter((entry) => entry.claim.kind === 'stack').map((entry) => entry.claim.value))].sort()
  };
}
