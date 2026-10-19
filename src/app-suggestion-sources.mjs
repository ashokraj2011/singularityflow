/**
 * Reading IDE run configurations and platform markers for `app suggest` [RUN amendment §3].
 *
 * Every file read here is untrusted data. Reads are bounded (256 KiB per file, 200 files, a
 * bounded directory walk that never follows a symbolic link), XML goes through the in-repository
 * reader (no DOCTYPE, no entities), launch.json is read as JSON with comments and trailing commas,
 * and every path a configuration names must resolve inside the repository after its IDE macros
 * ($PROJECT_DIR$, $MODULE_DIR$, ${workspaceFolder}) are resolved. Anything else is refused with a
 * note. Nothing is executed and nothing is written.
 *
 * Each reader returns launches in one intermediate shape the translator turns into start entries:
 * `{ source: { kind, file, name }, launch: { platform, mode, … absolute paths … }, variables, notes }`.
 */
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseXml } from './code-delivery-tests.mjs';

export const SUGGEST_LIMITS = Object.freeze({ fileBytes: 256 * 1024, files: 200, directories: 2_000, depth: 6 });
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'target', 'build', 'dist', 'out', 'bin', 'obj', 'vendor', 'coverage',
  '__pycache__', 'venv', 'site-packages', 'bower_components', 'tmp', 'temp', 'logs']);
const IDE_DIRECTORIES = new Set(['.run', '.idea', '.vscode']);
const MARKER_FILES = new Set(['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'manage.py', 'go.mod', 'main.py', 'app.py',
  'asgi.py', 'main.go', 'launchSettings.json']);

/** The kind of IDE each JetBrains configuration type comes from. */
const JETBRAINS_TYPES = Object.freeze({
  Application: 'intellij', JetRunConfigurationType: 'intellij', SpringBootApplicationConfigurationType: 'intellij',
  MavenRunConfiguration: 'intellij', GradleRunConfiguration: 'intellij',
  PythonConfigurationType: 'pycharm', 'Python.DjangoServer': 'pycharm', 'Python.FastAPI': 'pycharm',
  NodeJSConfigurationType: 'webstorm', 'js.build_tools.npm': 'webstorm',
  GoApplicationRunConfiguration: 'goland',
  DotNetProject: 'rider', LaunchSettings: 'rider'
});

const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

/** XML character references in an attribute value; the reader returns values as written. */
export function decodeXmlText(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gu, (whole, name) => {
    if (name[0] !== '#') return NAMED_ENTITIES[name];
    const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

export function posixRelative(from, to) {
  return path.relative(from, to).split(path.sep).join('/') || '.';
}

/** Whether an absolute path lies inside the repository root (or is it). */
export function insideRoot(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A command line as an IDE stores it ("-Xmx1g -Dname=\"a b\""), split into arguments: whitespace
 * separates, double or single quotes group, a backslash escapes a quote. Never run through a shell.
 */
export function splitCommandLine(value) {
  const text = String(value ?? '');
  const result = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && (text[index + 1] === '"' || text[index + 1] === "'")) { current += text[index + 1]; index += 1; started = true; continue; }
    if (quote) {
      if (character === quote) quote = null; else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/u.test(character)) {
      if (started) { result.push(current); current = ''; started = false; }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) result.push(current);
  return result;
}

/** JSON with comments and trailing commas, as VS Code reads launch.json. */
export function parseJsonc(text) {
  let output = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const character = text[index];
    if (inString) {
      output += character;
      if (character === '\\') { output += text[index + 1] ?? ''; index += 2; continue; }
      if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') { inString = true; output += character; index += 1; continue; }
    if (character === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index += 1; continue; }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) throw new SyntaxError('unterminated comment');
      index = end + 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/gu, '$1').replace(/^﻿/u, ''));
}

class Reader {
  constructor(root) {
    this.root = root;
    this.filesRead = 0;
    this.skipped = [];
    this.truncated = false;
  }

  skip(absolute, reason) {
    this.skipped.push({ file: posixRelative(this.root, absolute), reason });
  }

  /** The text of one regular file inside the repository, or null with a note. */
  async text(absolute, { quiet = false } = {}) {
    if (this.filesRead >= SUGGEST_LIMITS.files) {
      this.truncated = true;
      return null;
    }
    let entry;
    try { entry = await lstat(absolute); } catch { return null; }
    if (entry.isSymbolicLink() || !entry.isFile()) { if (!quiet) this.skip(absolute, 'not a regular file (symbolic links are not followed)'); return null; }
    if (entry.size > SUGGEST_LIMITS.fileBytes) { this.skip(absolute, `larger than ${SUGGEST_LIMITS.fileBytes / 1024} KiB`); return null; }
    this.filesRead += 1;
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(entry.size, SUGGEST_LIMITS.fileBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  }

  async exists(absolute) {
    try { await lstat(absolute); return true; } catch { return false; }
  }

  async isDirectory(absolute) {
    try { const entry = await lstat(absolute); return entry.isDirectory(); } catch { return false; }
  }
}

/** Bounded walk: the IDE folders and platform markers below the root, never through a link. */
async function discover(reader) {
  const found = { jetbrains: [], vscode: [], launchSettings: [], markers: [] };
  const queue = [{ directory: reader.root, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const { directory, depth } = queue.shift();
    if (++visited > SUGGEST_LIMITS.directories) { reader.truncated = true; break; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === '.run') {
          for (const file of await listFiles(absolute, (name) => name.endsWith('.run.xml'))) found.jetbrains.push(file);
        } else if (entry.name === '.idea') {
          for (const file of await listFiles(path.join(absolute, 'runConfigurations'), (name) => name.endsWith('.xml'))) found.jetbrains.push(file);
        } else if (entry.name === '.vscode') {
          if (await reader.exists(path.join(absolute, 'launch.json'))) found.vscode.push(path.join(absolute, 'launch.json'));
        } else if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name) && depth + 1 <= SUGGEST_LIMITS.depth) {
          queue.push({ directory: absolute, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'launchSettings.json' && path.basename(directory) === 'Properties') found.launchSettings.push(absolute);
      else if ((MARKER_FILES.has(entry.name) || entry.name.endsWith('.csproj')) && depth <= 4) found.markers.push(absolute);
    }
  }
  return found;

  async function listFiles(directory, accept) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
    // Links are listed so the reader can refuse them by name; it never follows one.
    return entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && accept(entry.name)).map((entry) => path.join(directory, entry.name)).sort();
  }
}

/**
 * Resolve an IDE path value against its macros. Returns `{ absolute }` inside the repository, or
 * `{ refused }` naming why: an unknown macro, or a path that leaves the repository.
 */
export function resolveIdePath(root, value, macros, base) {
  let text = String(value ?? '').trim();
  if (!text) return { absolute: base };
  for (const [macro, target] of Object.entries(macros)) text = text.split(macro).join(target);
  const unknown = text.match(/\$[A-Z_]+\$|\$\{[^}]*\}|\$\([^)]*\)/u);
  if (unknown) return { refused: `uses ${unknown[0]}, which has no meaning outside the IDE` };
  const absolute = path.resolve(base, text.replaceAll('\\', '/'));
  if (!insideRoot(root, absolute)) return { refused: 'points outside the repository' };
  return { absolute };
}

function xmlChild(node, name) { return node.children.find((child) => child.localName === name) ?? null; }
function xmlChildren(node, name) { return node.children.filter((child) => child.localName === name); }
function xmlAttribute(node, name) { return node?.attributes?.[name] == null ? null : decodeXmlText(node.attributes[name]); }

/** `<option name="X" value="Y"/>` directly below a node. */
function optionValue(node, name) {
  const option = node ? xmlChildren(node, 'option').find((child) => xmlAttribute(child, 'name') === name) : null;
  return option ? xmlAttribute(option, 'value') : null;
}
function optionNode(node, name) {
  return node ? xmlChildren(node, 'option').find((child) => xmlAttribute(child, 'name') === name) ?? null : null;
}
/** `<option name="X"><list><option value="a"/></list></option>` as ['a']. */
function optionList(node, name) {
  const holder = optionNode(node, name);
  const list = holder ? xmlChild(holder, 'list') ?? xmlChild(holder, 'set') : null;
  return list ? xmlChildren(list, 'option').map((child) => xmlAttribute(child, 'value')).filter((value) => value != null) : [];
}
/** `<option name="X"><map><entry key="k" value="v"/></map></option>` as { k: v }. */
function optionMap(node, name) {
  const holder = optionNode(node, name);
  const map = holder ? xmlChild(holder, 'map') : null;
  return map ? Object.fromEntries(xmlChildren(map, 'entry').map((entry) => [xmlAttribute(entry, 'key'), xmlAttribute(entry, 'value') ?? ''])
    .filter(([key]) => key)) : {};
}
function envsElement(node) {
  const envs = xmlChild(node, 'envs');
  return envs ? xmlChildren(envs, 'env').map((env) => ({ name: xmlAttribute(env, 'name'), value: xmlAttribute(env, 'value') ?? '' }))
    .filter((entry) => entry.name) : [];
}
function childValue(node, name) { return xmlAttribute(xmlChild(node, name), 'value'); }

function variablesFrom(pairs) {
  return pairs.map(({ name, value }) => ({ name, value: value ?? '' }));
}

async function readJetBrains(reader, file) {
  const text = await reader.text(file);
  if (text == null) return [];
  let document;
  try {
    document = parseXml(text, (message) => { throw new SyntaxError(message); });
  } catch (error) {
    reader.skip(file, `not a readable run configuration (${error.message})`);
    return [];
  }
  const configurations = document.localName === 'configuration' ? [document] : xmlChildren(document, 'configuration');
  if (!configurations.length) { reader.skip(file, 'holds no run configuration'); return []; }
  // `.run` lives in the project or a module directory; `.idea/runConfigurations` in the project.
  const holder = path.dirname(file);
  const projectDirectory = path.basename(holder) === 'runConfigurations' ? path.dirname(path.dirname(holder)) : path.dirname(holder);
  const macros = { '$PROJECT_DIR$': projectDirectory, '$MODULE_DIR$': projectDirectory, '$MODULE_WORKING_DIR$': projectDirectory, '$ProjectFileDir$': projectDirectory };
  const launches = [];
  for (const configuration of configurations) {
    if (xmlAttribute(configuration, 'default') === 'true') continue;
    const type = xmlAttribute(configuration, 'type');
    const name = xmlAttribute(configuration, 'name') ?? path.basename(file);
    const kind = JETBRAINS_TYPES[type];
    const source = { kind: kind ?? 'intellij', file: posixRelative(reader.root, file), name };
    if (!kind) { reader.skip(file, `configuration '${name}' has type ${type ?? 'unknown'}, which app suggest does not translate`); continue; }
    try {
      const launch = jetBrainsLaunch(reader, type, configuration, { macros, projectDirectory });
      if (launch.refused) reader.skip(file, `configuration '${name}' ${launch.refused}`);
      else launches.push({ source, ...launch });
    } catch (error) {
      reader.skip(file, `configuration '${name}' could not be read (${error.message})`);
    }
  }
  return launches;
}

function jetBrainsLaunch(reader, type, configuration, { macros, projectDirectory }) {
  const root = reader.root;
  const directory = (value, fallback = projectDirectory) => resolveIdePath(root, value, macros, fallback);
  const notes = [];
  if (type === 'Application' || type === 'JetRunConfigurationType' || type === 'SpringBootApplicationConfigurationType') {
    const workingDirectory = directory(optionValue(configuration, 'WORKING_DIRECTORY'));
    if (workingDirectory.refused) return { refused: `working directory ${workingDirectory.refused}` };
    const profiles = splitList(optionValue(configuration, 'ACTIVE_PROFILES'));
    return {
      launch: {
        platform: 'java', mode: type === 'SpringBootApplicationConfigurationType' ? 'spring-boot' : 'application',
        mainClass: optionValue(configuration, 'SPRING_BOOT_MAIN_CLASS') ?? optionValue(configuration, 'MAIN_CLASS_NAME'),
        module: xmlAttribute(xmlChild(configuration, 'module'), 'name'),
        vmOptions: splitCommandLine(macroText(optionValue(configuration, 'VM_PARAMETERS'), macros, workingDirectory.absolute)),
        programArguments: splitCommandLine(macroText(optionValue(configuration, 'PROGRAM_PARAMETERS'), macros, workingDirectory.absolute)),
        profiles, workingDirectory: workingDirectory.absolute
      },
      variables: variablesFrom(envsElement(configuration)), notes
    };
  }
  if (type === 'MavenRunConfiguration') {
    const settings = xmlChild(configuration, 'MavenSettings') ?? configuration;
    const runnerParameters = xmlChild(optionNode(settings, 'myRunnerParameters') ?? settings, 'MavenRunnerParameters') ?? settings;
    const runnerSettings = xmlChild(optionNode(settings, 'myRunnerSettings') ?? settings, 'MavenRunnerSettings');
    const workingDirectory = directory(optionValue(runnerParameters, 'workingDirPath'));
    if (workingDirectory.refused) return { refused: `working directory ${workingDirectory.refused}` };
    const goals = optionList(runnerParameters, 'goals');
    const profiles = Object.entries(optionMap(runnerParameters, 'profilesMap')).filter(([, on]) => on === 'true').map(([profile]) => profile);
    const properties = runnerSettings ? optionMap(runnerSettings, 'mavenProperties') : {};
    const vmOptions = runnerSettings ? optionValue(runnerSettings, 'vmOptions') : null;
    if (vmOptions?.trim()) notes.push('The configuration\'s Maven VM options run Maven itself; set them in MAVEN_OPTS if you need them.');
    return {
      launch: {
        platform: 'java', mode: 'maven', goals, profiles, properties,
        options: splitCommandLine(macroText(optionValue(runnerParameters, 'cmdOptions'), macros, workingDirectory.absolute)), workingDirectory: workingDirectory.absolute
      },
      variables: variablesFrom(Object.entries(runnerSettings ? optionMap(runnerSettings, 'environmentProperties') : {})
        .map(([name, value]) => ({ name, value }))), notes
    };
  }
  if (type === 'GradleRunConfiguration') {
    const settings = xmlChild(configuration, 'ExternalSystemSettings') ?? configuration;
    const workingDirectory = directory(optionValue(settings, 'externalProjectPath'));
    if (workingDirectory.refused) return { refused: `project path ${workingDirectory.refused}` };
    if (optionValue(settings, 'vmOptions')?.trim()) notes.push('The configuration\'s Gradle VM options run Gradle itself; they are not carried over.');
    return {
      launch: {
        platform: 'java', mode: 'gradle', tasks: optionList(settings, 'taskNames'),
        arguments: splitCommandLine(macroText(optionValue(settings, 'scriptParameters'), macros, workingDirectory.absolute)), workingDirectory: workingDirectory.absolute
      },
      variables: variablesFrom(Object.entries(optionMap(settings, 'env')).map(([name, value]) => ({ name, value }))), notes
    };
  }
  if (type === 'PythonConfigurationType' || type === 'Python.DjangoServer' || type === 'Python.FastAPI') {
    const workingDirectory = directory(optionValue(configuration, 'WORKING_DIRECTORY'));
    if (workingDirectory.refused) return { refused: `working directory ${workingDirectory.refused}` };
    const interpreter = interpreterPath(root, optionValue(configuration, 'SDK_HOME'), macros, projectDirectory, notes);
    if ((optionValue(configuration, 'ENV_FILES') ?? '').trim()) notes.push('The configuration\'s .env files are not read; declare their names in environments.yml.');
    const variables = variablesFrom(envsElement(configuration)).filter((entry) => entry.name !== 'PYTHONUNBUFFERED');
    const interpreterOptions = splitCommandLine(optionValue(configuration, 'INTERPRETER_OPTIONS'));
    if (type === 'Python.DjangoServer') {
      return {
        launch: {
          platform: 'python', mode: 'django', interpreter, interpreterOptions, host: optionValue(configuration, 'host') ?? '',
          port: optionValue(configuration, 'port') ?? '', noReload: optionValue(configuration, 'runNoReload') === 'true',
          additional: splitCommandLine(optionValue(configuration, 'additionalOptions')), workingDirectory: workingDirectory.absolute,
          customCommand: optionValue(configuration, 'useCustomRunCommand') === 'true' ? optionValue(configuration, 'customRunCommand') : null
        },
        variables, notes
      };
    }
    if (type === 'Python.FastAPI') {
      // PyCharm's FastAPI configuration names the application file; uvicorn's own options ride along.
      const fileValue = optionValue(configuration, 'file') ?? optionValue(configuration, 'FILE') ?? '';
      const application = resolveIdePath(root, fileValue, macros, workingDirectory.absolute);
      if (application.refused || !fileValue.trim()) return { refused: `application file ${application.refused ?? 'is not named'}` };
      return {
        launch: {
          platform: 'python', mode: 'fastapi', interpreter, interpreterOptions, file: application.absolute, workingDirectory: workingDirectory.absolute,
          parameters: splitCommandLine(macroText(optionValue(configuration, 'uvicornParameters') ?? optionValue(configuration, 'additionalOptions')
            ?? optionValue(configuration, 'PARAMETERS'), macros, workingDirectory.absolute))
        },
        variables, notes
      };
    }
    const moduleMode = optionValue(configuration, 'MODULE_MODE') === 'true';
    const scriptName = optionValue(configuration, 'SCRIPT_NAME') ?? '';
    let script = null;
    if (!moduleMode) {
      const resolved = resolveIdePath(root, scriptName, macros, workingDirectory.absolute);
      if (resolved.refused || !scriptName.trim()) return { refused: `script ${resolved.refused ?? 'is not named'}` };
      script = resolved.absolute;
    } else if (!/^[A-Za-z_][\w.]*$/u.test(scriptName)) return { refused: `module '${scriptName}' is not a Python module name` };
    return {
      launch: {
        platform: 'python', mode: moduleMode ? 'module' : 'script', interpreter, interpreterOptions, module: moduleMode ? scriptName : null, script,
        parameters: splitCommandLine(macroText(optionValue(configuration, 'PARAMETERS'), macros, workingDirectory.absolute)), workingDirectory: workingDirectory.absolute
      },
      variables, notes
    };
  }
  if (type === 'NodeJSConfigurationType') {
    const workingDirectory = directory(xmlAttribute(configuration, 'working-dir'));
    if (workingDirectory.refused) return { refused: `working directory ${workingDirectory.refused}` };
    const scriptValue = xmlAttribute(configuration, 'path-to-js-file') ?? '';
    const script = resolveIdePath(root, scriptValue, macros, workingDirectory.absolute);
    if (script.refused || !scriptValue.trim()) return { refused: `JavaScript file ${script.refused ?? 'is not named'}` };
    return {
      launch: {
        platform: 'node', mode: 'node', script: script.absolute, workingDirectory: workingDirectory.absolute,
        nodeOptions: splitCommandLine(xmlAttribute(configuration, 'node-parameters')),
        arguments: splitCommandLine(macroText(xmlAttribute(configuration, 'application-parameters'), macros, workingDirectory.absolute))
      },
      variables: variablesFrom(envsElement(configuration)), notes
    };
  }
  if (type === 'js.build_tools.npm') {
    const packageJson = resolveIdePath(root, childValue(configuration, 'package-json') ?? '$PROJECT_DIR$/package.json', macros, projectDirectory);
    if (packageJson.refused) return { refused: `package.json ${packageJson.refused}` };
    const scripts = xmlChild(configuration, 'scripts');
    const scriptNames = scripts ? xmlChildren(scripts, 'script').map((script) => xmlAttribute(script, 'value')).filter(Boolean) : [];
    if (scriptNames.length > 1) notes.push(`The configuration runs ${scriptNames.length} scripts; the entry runs the first, ${scriptNames[0]}.`);
    return {
      launch: {
        platform: 'node', mode: 'package-script', packageManager: childValue(configuration, 'package-manager'),
        command: childValue(configuration, 'command') ?? 'run', script: scriptNames[0] ?? null,
        arguments: splitCommandLine(childValue(configuration, 'arguments')), workingDirectory: path.dirname(packageJson.absolute)
      },
      variables: variablesFrom(envsElement(configuration)), notes
    };
  }
  if (type === 'GoApplicationRunConfiguration') {
    const workingDirectory = directory(childValue(configuration, 'working_directory'));
    if (workingDirectory.refused) return { refused: `working directory ${workingDirectory.refused}` };
    const kind = (childValue(configuration, 'kind') ?? 'PACKAGE').toUpperCase();
    let target;
    if (kind === 'FILE' || kind === 'DIRECTORY') {
      const value = childValue(configuration, kind === 'FILE' ? 'filePath' : 'directory') ?? '';
      const resolved = resolveIdePath(root, value, macros, workingDirectory.absolute);
      if (resolved.refused || !value.trim()) return { refused: `${kind.toLowerCase()} ${resolved.refused ?? 'is not named'}` };
      target = { path: resolved.absolute };
    } else {
      const directoryValue = childValue(configuration, 'directory');
      const resolved = directoryValue ? resolveIdePath(root, directoryValue, macros, workingDirectory.absolute) : null;
      target = resolved?.absolute ? { path: resolved.absolute } : { package: childValue(configuration, 'package') ?? '.' };
    }
    return {
      launch: {
        platform: 'go', target, goFlags: splitCommandLine(childValue(configuration, 'go_parameters')),
        arguments: splitCommandLine(macroText(childValue(configuration, 'parameters'), macros, workingDirectory.absolute)), workingDirectory: workingDirectory.absolute
      },
      variables: variablesFrom(envsElement(configuration)), notes
    };
  }
  // Rider: a project, or a launchSettings profile of one.
  const projectValue = optionValue(configuration, type === 'LaunchSettings' ? 'LAUNCH_PROFILE_PROJECT_FILE_PATH' : 'PROJECT_PATH');
  const project = resolveIdePath(root, projectValue ?? '', macros, projectDirectory);
  if (project.refused || !projectValue) return { refused: `project ${project.refused ?? 'is not named'}` };
  const workingDirectory = type === 'DotNetProject' ? directory(optionValue(configuration, 'WORKING_DIRECTORY'), path.dirname(project.absolute)) : { absolute: path.dirname(project.absolute) };
  if (workingDirectory.refused) return { refused: `working directory ${workingDirectory.refused}` };
  return {
    launch: {
      platform: 'dotnet', project: project.absolute, launchProfile: type === 'LaunchSettings' ? optionValue(configuration, 'LAUNCH_PROFILE_NAME') : null,
      launchSettings: type === 'LaunchSettings' ? path.join(path.dirname(project.absolute), 'Properties', 'launchSettings.json') : null,
      arguments: splitCommandLine(optionValue(configuration, 'PROGRAM_PARAMETERS')), workingDirectory: workingDirectory.absolute
    },
    variables: variablesFrom(envsElement(configuration)), notes
  };
}

function splitList(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** IDE macros inside argument text become paths relative to the working directory. */
function macroText(value, macros, workingDirectory = null) {
  let text = String(value ?? '');
  for (const [macro, target] of Object.entries(macros)) {
    const replacement = workingDirectory ? posixRelative(workingDirectory, target) : target;
    text = text.split(macro).join(replacement);
  }
  return text;
}

/** The interpreter inside the repository, or null; one outside it is never copied (it is machine-specific). */
function interpreterPath(root, value, macros, base, notes) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const resolved = resolveIdePath(root, text, macros, base);
  if (resolved.refused) {
    notes.push('The IDE\'s interpreter lies outside the repository and is not copied.');
    return null;
  }
  return resolved.absolute;
}

async function readVsCode(reader, file) {
  const text = await reader.text(file);
  if (text == null) return [];
  let document;
  try { document = parseJsonc(text); } catch (error) { reader.skip(file, `not valid JSON with comments (${error.message})`); return []; }
  const configurations = Array.isArray(document?.configurations) ? document.configurations : null;
  if (!configurations) { reader.skip(file, 'has no configurations list'); return []; }
  const folder = path.dirname(path.dirname(file));
  const macros = { '${workspaceFolder}': folder, '${workspaceRoot}': folder };
  const launches = [];
  for (const configuration of configurations.slice(0, 100)) {
    if (!configuration || typeof configuration !== 'object') continue;
    const name = typeof configuration.name === 'string' ? configuration.name : `${configuration.type ?? 'configuration'}`;
    const source = { kind: 'vscode', file: posixRelative(reader.root, file), name };
    if (configuration.request !== 'launch') { reader.skip(file, `configuration '${name}' attaches to a running process; nothing to start`); continue; }
    try {
      const launch = vsCodeLaunch(reader, configuration, { macros, folder });
      if (launch.refused) reader.skip(file, `configuration '${name}' ${launch.refused}`);
      else launches.push({ source, ...launch });
    } catch (error) { reader.skip(file, `configuration '${name}' could not be read (${error.message})`); }
  }
  return launches;
}

function argumentArray(value, macros, workingDirectory) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' || typeof entry === 'number').map((entry) => macroText(String(entry), macros, workingDirectory));
  return splitCommandLine(macroText(value, macros, workingDirectory));
}

function vsCodeVariables(configuration, notes) {
  if (configuration.envFile) notes.push('The configuration\'s envFile is not read; declare its names in environments.yml.');
  const env = configuration.env && typeof configuration.env === 'object' && !Array.isArray(configuration.env) ? configuration.env : {};
  return Object.entries(env).map(([name, value]) => ({ name, value: value == null ? '' : String(value), reference: /\$\{env:[^}]+\}/u.test(String(value ?? '')) }));
}

function vsCodeLaunch(reader, configuration, { macros, folder }) {
  const root = reader.root;
  const notes = [];
  const type = String(configuration.type ?? '');
  const workingDirectory = resolveIdePath(root, configuration.cwd ?? '', macros, folder);
  if (workingDirectory.refused) return { refused: `cwd ${workingDirectory.refused}` };
  const variables = vsCodeVariables(configuration, notes);
  if (type === 'java') {
    return {
      launch: {
        platform: 'java', mode: 'application', mainClass: typeof configuration.mainClass === 'string' ? configuration.mainClass : null,
        module: configuration.projectName ?? null, vmOptions: argumentArray(configuration.vmArgs, macros, workingDirectory.absolute),
        programArguments: argumentArray(configuration.args, macros, workingDirectory.absolute), profiles: [], workingDirectory: workingDirectory.absolute
      },
      variables, notes
    };
  }
  if (type === 'python' || type === 'debugpy') {
    const interpreter = configuration.python ? interpreterPath(root, configuration.python, macros, folder, notes) : null;
    const programValue = configuration.program;
    let script = null;
    if (!configuration.module) {
      const resolved = resolveIdePath(root, programValue ?? '', macros, workingDirectory.absolute);
      if (resolved.refused || !programValue) return { refused: `program ${resolved.refused ?? 'is not named'}` };
      script = resolved.absolute;
    } else if (!/^[A-Za-z_][\w.]*$/u.test(String(configuration.module))) return { refused: 'names a module that is not a Python module name' };
    return {
      launch: {
        platform: 'python', mode: configuration.module ? 'module' : 'script', interpreter, interpreterOptions: [],
        module: configuration.module ?? null, script, parameters: argumentArray(configuration.args, macros, workingDirectory.absolute), workingDirectory: workingDirectory.absolute
      },
      variables, notes
    };
  }
  if (type === 'node' || type === 'pwa-node') {
    const runtimeExecutable = typeof configuration.runtimeExecutable === 'string' ? configuration.runtimeExecutable : null;
    const runtimeArgs = argumentArray(configuration.runtimeArgs, macros, workingDirectory.absolute);
    if (runtimeExecutable && !/^(?:node|nodejs)$/u.test(runtimeExecutable)) {
      const executable = /[\\/]/u.test(runtimeExecutable) ? resolveIdePath(root, runtimeExecutable, macros, workingDirectory.absolute) : { command: runtimeExecutable };
      if (executable.refused) return { refused: `runtimeExecutable ${executable.refused}` };
      return {
        launch: {
          platform: 'node', mode: 'executable', executable: executable.absolute ?? executable.command, executableIsPath: Boolean(executable.absolute),
          arguments: [...runtimeArgs, ...argumentArray(configuration.args, macros, workingDirectory.absolute)], workingDirectory: workingDirectory.absolute
        },
        variables, notes
      };
    }
    const program = resolveIdePath(root, configuration.program ?? '', macros, workingDirectory.absolute);
    if (program.refused || !configuration.program) return { refused: `program ${program.refused ?? 'is not named'}` };
    return {
      launch: { platform: 'node', mode: 'node', script: program.absolute, nodeOptions: runtimeArgs, arguments: argumentArray(configuration.args, macros, workingDirectory.absolute), workingDirectory: workingDirectory.absolute },
      variables, notes
    };
  }
  if (type === 'go') {
    if (configuration.mode === 'test' || configuration.mode === 'exec' || configuration.mode === 'remote') {
      return { refused: `has mode ${configuration.mode}; only a program go run builds is started` };
    }
    const program = resolveIdePath(root, configuration.program ?? '', macros, workingDirectory.absolute);
    if (program.refused || !configuration.program) return { refused: `program ${program.refused ?? 'is not named'}` };
    return {
      launch: {
        platform: 'go', target: { path: program.absolute }, goFlags: splitCommandLine(configuration.buildFlags),
        arguments: argumentArray(configuration.args, macros, workingDirectory.absolute), workingDirectory: workingDirectory.absolute
      },
      variables, notes
    };
  }
  if (type === 'coreclr' || type === 'dotnet') {
    const program = resolveIdePath(root, configuration.program ?? '', macros, workingDirectory.absolute);
    if (program.refused || !configuration.program) return { refused: `program ${program.refused ?? 'is not named'}` };
    return {
      launch: { platform: 'dotnet', projectFrom: program.absolute, launchProfile: null, arguments: argumentArray(configuration.args, macros, workingDirectory.absolute), workingDirectory: workingDirectory.absolute },
      variables, notes
    };
  }
  return { refused: `has type ${type || 'unknown'}, which app suggest does not translate` };
}

async function readLaunchSettings(reader, file) {
  const text = await reader.text(file);
  if (text == null) return [];
  let document;
  try { document = parseJsonc(text); } catch (error) { reader.skip(file, `not valid JSON (${error.message})`); return []; }
  const profiles = document?.profiles && typeof document.profiles === 'object' ? document.profiles : null;
  if (!profiles) { reader.skip(file, 'has no profiles'); return []; }
  const projectDirectory = path.dirname(path.dirname(file));
  const launches = [];
  for (const [name, profile] of Object.entries(profiles).slice(0, 50)) {
    if (!profile || typeof profile !== 'object') continue;
    if (profile.commandName !== 'Project') { reader.skip(file, `profile '${name}' runs ${profile.commandName ?? 'something'}, not the project`); continue; }
    launches.push({
      source: { kind: 'launch-settings', file: posixRelative(reader.root, file), name },
      launch: {
        platform: 'dotnet', project: null, projectDirectory, launchProfile: name, applicationUrl: profile.applicationUrl ?? null,
        arguments: splitCommandLine(profile.commandLineArgs), workingDirectory: projectDirectory
      },
      variables: Object.entries(profile.environmentVariables ?? {}).map(([variable, value]) => ({ name: variable, value: String(value ?? '') })),
      notes: ['dotnet run --launch-profile applies this profile\'s own URLs and variables too.']
    });
  }
  return launches;
}

/** Everything the readers found, plus the marker files the translator and detectors consult. */
export async function readRunConfigurationSources(root) {
  const canonicalRoot = await realpath(root);
  const reader = new Reader(canonicalRoot);
  const found = await discover(reader);
  const launches = [];
  for (const file of found.jetbrains) launches.push(...await readJetBrains(reader, file));
  for (const file of found.vscode) launches.push(...await readVsCode(reader, file));
  for (const file of found.launchSettings) launches.push(...await readLaunchSettings(reader, file));
  return { root: canonicalRoot, reader, launches, markers: found.markers, launchSettingsFiles: found.launchSettings };
}
