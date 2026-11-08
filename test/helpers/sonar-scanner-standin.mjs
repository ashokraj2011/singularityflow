/**
 * A stand-in for SonarQube's scanners, for tests: no scanner, JVM or server analysis runs. It ranks the
 * analysis properties the way the scanners' source does and writes report-task.txt where their
 * engine would, so a test sees where a real scan puts its work and its report:
 *
 * - Maven (sonar-maven-plugin 3.9 to 5.8, MavenProjectConverter): every module's properties are its
 *   `target/sonar` work folder, the pom's `sonar.*` properties, the environment's JSON properties, then
 *   the `-D` options. The root's key is the pom's `sonar.projectKey`, else `groupId:artifactId`.
 * - Gradle (org.sonarqube 3.5 to 7.5, SonarPropertyComputer): the root project's are its name as key and
 *   `build/sonar`, then the environment's and the `-D` options; other projects get neither.
 * - sonar-scanner (8.3, Conf): sonar-project.properties, the environment's, then the `-D` options.
 * - The engine (SonarQube 25.1: ProjectReactorBuilder, WorkDirectoriesInitializer, ScanProperties,
 *   ReportPublisher): a relative work folder is resolved against its module's own folder, a module
 *   without one works below the root's, and each is emptied first. report-task.txt goes to
 *   `sonar.scanner.metadataFilePath`, which must be absolute, else into the root's work folder. Java
 *   sources without compiled classes fail the analysis, as SonarQube's Java analysis does. With
 *   `sonar.qualitygate.wait` it reads the gate from the server and fails when it failed.
 *
 * argv: <log file> <maven|gradle|cli> <the command's own arguments...>. Maven and Gradle "build" with
 * test, verify, package, install, build or check: compiled-class folders and one passing JUnit report
 * per test class. Each run appends a JSON line to the log: what it was given (never the token) and
 * where it worked and wrote.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [log, tool, ...args] = process.argv.slice(2);
const cwd = process.cwd();
const read = (file) => (existsSync(path.join(cwd, file)) ? readFileSync(path.join(cwd, file), 'utf8') : null);
const files = (directory, pattern) => (existsSync(directory) ? readdirSync(directory, { recursive: true }).map(String)
  .filter((name) => pattern.test(name)).map((name) => path.join(directory, name)) : []);

const pom = tool === 'maven' ? read('pom.xml') ?? '' : '';
const settings = tool === 'gradle' ? read('settings.gradle') ?? read('settings.gradle.kts') ?? '' : '';
const modules = tool === 'maven' ? [...pom.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/gu)].map((match) => match[1])
  : tool === 'gradle' ? [...settings.matchAll(/^\s*include\s*\(?(.+?)\)?\s*$/gmu)].flatMap((match) => [...match[1].matchAll(/['"]:?([\w./-]+)['"]/gu)].map((name) => name[1]))
    : [];
const output = tool === 'maven' ? { classes: 'target/classes', tests: 'target/surefire-reports' } : { classes: 'build/classes/java/main', tests: 'build/test-results/test' };

const record = { tool, args, cwd, modules };
const finish = (status, message = null) => {
  if (message) console.error(message);
  appendFileSync(log, `${JSON.stringify({ ...record, status, ...(message ? { message } : {}) })}\n`);
  process.exit(status);
};

// The build: compiled classes, and a JUnit report for each test class.
if (tool !== 'cli' && args.some((arg) => ['test', 'verify', 'package', 'install', 'build', 'check'].includes(arg))) {
  for (const module of modules) {
    const root = path.join(cwd, module);
    if (files(path.join(root, 'src/main/java'), /\.java$/u).length) {
      mkdirSync(path.join(root, output.classes), { recursive: true });
      writeFileSync(path.join(root, output.classes, '.compiled'), 'stand-in\n');
    }
    for (const test of files(path.join(root, 'src/test/java'), /Test\.java$/u)) {
      const source = readFileSync(test, 'utf8');
      const name = `${source.match(/^package\s+([\w.]+);/mu)?.[1] ?? ''}.${path.basename(test, '.java')}`.replace(/^\./u, '');
      const cases = [...source.matchAll(/@Test\s+(?:public\s+)?void\s+(\w+)\s*\(/gu)].map((match) =>
        `<testcase name="${match[1]}" classname="${name}" time="0.001"/>`);
      mkdirSync(path.join(root, output.tests), { recursive: true });
      writeFileSync(path.join(root, output.tests, `TEST-${name}.xml`),
        `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${name}" tests="${cases.length}" failures="0" errors="0" skipped="0" time="0.01">\n${cases.join('\n')}\n</testsuite>\n`);
    }
  }
}
const scans = tool === 'cli' || args.some((arg) => (tool === 'maven' ? arg === 'sonar:sonar' || /:sonar(?::sonar)?$/u.test(arg) : ['sonar', 'sonarqube'].includes(arg)));
if (!scans) finish(0);

// The properties, ranked as each scanner ranks them.
const fromEnvironment = { ...(process.env.SONAR_HOST_URL ? { 'sonar.host.url': process.env.SONAR_HOST_URL } : {}),
  ...JSON.parse(process.env.SONAR_SCANNER_JSON_PARAMS ?? process.env.SONARQUBE_SCANNER_PARAMS ?? '{}') };
const options = Object.fromEntries(args.filter((arg) => arg.startsWith('-D')).map((arg) => {
  const at = arg.indexOf('=');
  return at < 0 ? [arg.slice(2), 'true'] : [arg.slice(2, at), arg.slice(at + 1)];
}));
let rootProperties;
let moduleProperties = () => ({});
if (tool === 'maven') {
  const pomProperties = Object.fromEntries([...(pom.match(/<properties>([\s\S]*?)<\/properties>/u)?.[1] ?? '').matchAll(/<(sonar\.[\w.]+)>([^<]*)<\/\1>/gu)]
    .map((match) => [match[1], match[2].trim()]));
  const key = `${pom.match(/<groupId>([^<]+)<\/groupId>/u)?.[1]}:${pom.match(/<artifactId>([^<]+)<\/artifactId>/u)?.[1]}`;
  const own = (folder) => ({ 'sonar.working.directory': path.join(folder, 'target/sonar') });
  rootProperties = { 'sonar.projectKey': key, ...own(cwd), ...pomProperties, ...fromEnvironment, ...options };
  // A module inherits the pom's properties, but not its sonar.projectKey (MSONAR-205).
  const inherited = Object.fromEntries(Object.entries(pomProperties).filter(([name]) => name !== 'sonar.projectKey'));
  moduleProperties = (folder) => ({ ...own(folder), ...inherited, ...fromEnvironment, ...options });
} else if (tool === 'gradle') {
  const name = settings.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/u)?.[1] ?? path.basename(cwd);
  rootProperties = { 'sonar.projectKey': name, 'sonar.working.directory': path.join(cwd, 'build/sonar'), ...fromEnvironment, ...options };
} else {
  const file = Object.fromEntries((read('sonar-project.properties') ?? '').split(/\r?\n/u).filter((line) => /^\s*[\w.]+\s*=/u.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
  rootProperties = { ...file, ...fromEnvironment, ...options };
}
record.properties = rootProperties;

// The engine.
const folder = (base, value) => (path.isAbsolute(value) ? value : path.join(base, value));
const rootWork = folder(cwd, rootProperties['sonar.working.directory'] ?? '.scannerwork');
const workFolders = [rootWork, ...modules.map((module) => {
  const own = moduleProperties(path.join(cwd, module))['sonar.working.directory'];
  return own ? folder(path.join(cwd, module), own) : path.join(rootWork, module);
})];
record.workFolders = workFolders.map((work) => path.relative(cwd, work));
for (const module of modules) {
  if (files(path.join(cwd, module, 'src/main/java'), /\.java$/u).length && !existsSync(path.join(cwd, module, output.classes))) {
    finish(1, 'Your project contains .java files, please provide compiled classes with sonar.java.binaries property, or exclude them from the analysis with sonar.exclusions property.');
  }
}
const metadata = rootProperties['sonar.scanner.metadataFilePath'] ?? null;
if (metadata && !path.isAbsolute(metadata)) finish(1, `Property 'sonar.scanner.metadataFilePath' must point to an absolute path: ${metadata}`);
for (const work of new Set(workFolders)) {
  if (existsSync(work)) for (const entry of readdirSync(work)) if (entry !== '.sonar_lock') rmSync(path.join(work, entry), { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
}
const project = rootProperties['sonar.projectKey'];
const branch = rootProperties['sonar.branch.name'] ?? null;
const host = String(rootProperties['sonar.host.url'] ?? 'http://localhost:9000').replace(/\/$/u, '');
const report = metadata ?? path.join(rootWork, 'report-task.txt');
record.report = path.relative(cwd, report);
mkdirSync(path.dirname(report), { recursive: true });
writeFileSync(report, [`projectKey=${project}`, `serverUrl=${host}`, 'serverVersion=26.11.0.134175', ...(branch ? [`branch=${branch}`] : []),
  `dashboardUrl=${host}/dashboard?id=${encodeURIComponent(project)}`, 'ceTaskId=AZstandin', `ceTaskUrl=${host}/api/ce/task?id=AZstandin`, ''].join('\n'));
if (rootProperties['sonar.qualitygate.wait'] === 'true') {
  const url = new URL(`${host}/api/qualitygates/project_status`);
  url.searchParams.set('projectKey', project);
  if (branch) url.searchParams.set('branch', branch);
  const answer = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SONAR_TOKEN ?? ''}` }, signal: AbortSignal.timeout(10_000) })
    .then((response) => response.json()).catch(() => null);
  record.gate = answer?.projectStatus?.status ?? null;
  if (record.gate === 'ERROR') finish(1, 'QUALITY GATE STATUS: FAILED - View details on the dashboard');
}
finish(0);
