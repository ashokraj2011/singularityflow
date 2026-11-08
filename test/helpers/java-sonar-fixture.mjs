/**
 * A Java project scanned by SonarQube, for tests [CQF:REQ-048]: a Maven multi-module build and a Gradle
 * multi-project build of the same two modules, the change a Story makes to one of them (a method too
 * complex to read, a weak cipher and a weak hash), launchers for the scanner stand-in
 * (test/helpers/sonar-scanner-standin.mjs), and a SonarQube Web API answering with Java-shaped
 * responses for whichever project it is asked about. The responses follow SonarQube's documented
 * shapes for Java rules; they were not recorded from a live server.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STANDIN = fileURLToPath(new URL('./sonar-scanner-standin.mjs', import.meta.url));
export const PRICING = 'core/src/main/java/com/example/core/Pricing.java';
export const PRICING_TEST = 'core/src/test/java/com/example/core/PricingTest.java';
export const MAIN = 'app/src/main/java/com/example/app/Main.java';

const pricing = (body) => ['package com.example.core;', '', ...body].join('\n');
const PRICING_BASE = pricing(['public final class Pricing {', '  private Pricing() {', '  }', '',
  '  public static long total(long unitCents, int quantity) {', '    return unitCents * quantity;', '  }', '}', '']);
const TEST_BASE = ['package com.example.core;', '', 'import static org.junit.jupiter.api.Assertions.assertEquals;', '', 'import org.junit.jupiter.api.Test;', '',
  'class PricingTest {', '  @Test', '  void totalMultiplies() {', '    assertEquals(600, Pricing.total(200, 3));', '  }', '}', ''].join('\n');

/** The Story's version of the module: one clause, and three things SonarQube's Java rules report. */
export function storyChange(clause) {
  return {
    [PRICING]: ['package com.example.core;', '', 'import java.security.MessageDigest;', 'import javax.crypto.Cipher;', '',
      `// @clause:${clause} the total applies the customer's discount`, 'public final class Pricing {', '  private Pricing() {', '  }', '',
      '  public static long total(long unitCents, int quantity) {', '    return unitCents * quantity;', '  }', '',
      '  public static long discounted(long unitCents, int quantity, String tier, boolean member, boolean coupon) {',
      '    long total = total(unitCents, quantity);', '    if (member) {', '      if ("gold".equals(tier)) {', '        for (int i = 0; i < quantity; i++) {',
      '          if (coupon && i % 2 == 0) {', '            total -= unitCents / 10;', '          } else if (i > 10) {', '            total -= unitCents / 20;', '          }',
      '        }', '      } else if ("silver".equals(tier) || coupon) {', '        total -= total / 20;', '      }', '    }', '    return total;', '  }', '',
      '  public static byte[] receiptToken(byte[] receipt) throws Exception {', '    Cipher cipher = Cipher.getInstance("DES");',
      '    MessageDigest digest = MessageDigest.getInstance("MD5");', '    return digest.digest(cipher.getIV() == null ? receipt : cipher.getIV());', '  }', '}', ''].join('\n'),
    [PRICING_TEST]: TEST_BASE.replace(/\}\n$/u, ['', `  // @ac:${clause}`, '  @Test', '  void goldMembersGetTheDiscount() {',
      '    assertEquals(560, Pricing.discounted(200, 3, "gold", true, true));', '  }', '}', ''].join('\n'))
  };
}

/** The 1-based line holding `needle`. */
export const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;

const MODULE_POM = (artifact, extra = '') => ['<?xml version="1.0" encoding="UTF-8"?>', '<project xmlns="http://maven.apache.org/POM/4.0.0">',
  '  <modelVersion>4.0.0</modelVersion>', '  <parent>', '    <groupId>com.example</groupId>', '    <artifactId>shop</artifactId>', '    <version>1.0.0-SNAPSHOT</version>',
  '  </parent>', `  <artifactId>${artifact}</artifactId>`, extra, '</project>', ''].join('\n');
const JUNIT = '  <dependencies>\n    <dependency>\n      <groupId>org.junit.jupiter</groupId>\n      <artifactId>junit-jupiter</artifactId>\n      <version>5.11.4</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>';

/**
 * The project's files on main, keyed by repository path. The Maven root pom names the main project's
 * key, as a team's usually does; `gradlew` runs the stand-in, logging to `log`.
 */
export function javaProject(tool, { log }) {
  const modules = { [PRICING]: PRICING_BASE, [PRICING_TEST]: TEST_BASE,
    [MAIN]: ['package com.example.app;', '', 'public final class Main {', '  public static void main(String[] args) {',
      '    System.out.println(com.example.core.Pricing.total(200, 3));', '  }', '}', ''].join('\n'),
    '.gitignore': 'target/\nbuild/\n.gradle/\n' };
  if (tool === 'maven') {
    return { ...modules,
      'pom.xml': ['<?xml version="1.0" encoding="UTF-8"?>', '<project xmlns="http://maven.apache.org/POM/4.0.0">', '  <modelVersion>4.0.0</modelVersion>',
        '  <groupId>com.example</groupId>', '  <artifactId>shop</artifactId>', '  <version>1.0.0-SNAPSHOT</version>', '  <packaging>pom</packaging>',
        '  <modules>', '    <module>core</module>', '    <module>app</module>', '  </modules>', '  <properties>',
        '    <maven.compiler.release>17</maven.compiler.release>', '    <sonar.projectKey>com.example:shop</sonar.projectKey>', '  </properties>', '</project>', ''].join('\n'),
      'core/pom.xml': MODULE_POM('shop-core', JUNIT),
      'app/pom.xml': MODULE_POM('shop-app', '  <dependencies>\n    <dependency>\n      <groupId>com.example</groupId>\n      <artifactId>shop-core</artifactId>\n      <version>1.0.0-SNAPSHOT</version>\n    </dependency>\n  </dependencies>') };
  }
  return { ...modules,
    'settings.gradle': "rootProject.name = 'shop'\ninclude 'core', 'app'\n",
    'build.gradle': "plugins {\n  id 'org.sonarqube' version '7.5.0.8588'\n}\n",
    'core/build.gradle': "plugins {\n  id 'java-library'\n}\n\ndependencies {\n  testImplementation 'org.junit.jupiter:junit-jupiter:5.11.4'\n}\n\ntest {\n  useJUnitPlatform()\n}\n",
    'app/build.gradle': "plugins {\n  id 'application'\n}\n\ndependencies {\n  implementation project(':core')\n}\n",
    gradlew: launcher('gradle', { log }) };
}

/** A shell launcher for the stand-in: what `mvn` on PATH, or a project's `gradlew`, runs. */
export function launcher(tool, { log }) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STANDIN)} ${quote(log)} ${tool} "$@"\n`;
}

/** Writes `files` below `root`, `gradlew` executable. */
export async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
    if (path.basename(relative) === 'gradlew') await chmod(path.join(root, relative), 0o755);
  }
}

/** `mvn` on a PATH folder of its own, running the stand-in. Returns that folder. */
export async function mavenOnPath(base, { log }) {
  const bin = path.join(base, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'mvn'), launcher('maven', { log }));
  await chmod(path.join(bin, 'mvn'), 0o755);
  return bin;
}

/**
 * A SonarQube Web API answering for any project key with the Story's findings in `PRICING` at
 * `lines` ({ complexity, cipher, digest }) and an existing one in `MAIN`: a cognitive-complexity code
 * smell (java:S3776), a weak-cipher vulnerability (java:S5547), a weak-hash hotspot (java:S4790) and
 * `System.out` (java:S106). The gate fails on new security rating. It runs in a process of its own, so
 * a test may wait on the CLI with spawnSync while the CLI and the scanner read it; `requests()` reads
 * what it was asked.
 */
export async function javaSonarServer(t, { lines }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-sonar-api-'));
  const log = path.join(folder, 'requests.jsonl');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', JSON.stringify(lines), log], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    child.kill();
    await rm(folder, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    child.once('exit', (code) => reject(new Error(`the SonarQube stand-in exited with ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}`,
    requests: async () => (existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []) };
}

function serve(lines, log) {
  const file = (project, relative) => ({ key: `${project}:${relative}`, enabled: true, qualifier: 'FIL', name: path.posix.basename(relative), longName: relative, path: relative });
  const issue = (project, { key, rule, relative, line, type, severity, quality, impact, attribute, message }) => ({ key, rule, severity, component: `${project}:${relative}`,
    project, line, hash: `${key}-hash`, textRange: { startLine: line, endLine: line, startOffset: 4, endOffset: 20 }, flows: [], status: 'OPEN', message,
    effort: '10min', debt: '10min', author: '', tags: [], creationDate: '2026-11-08T10:00:00+0000', updateDate: '2026-11-08T10:00:00+0000', type, scope: 'MAIN',
    quickFixAvailable: false, messageFormattings: [], codeVariants: [], cleanCodeAttribute: attribute, cleanCodeAttributeCategory: attribute === 'TRUSTWORTHY' ? 'RESPONSIBLE' : 'ADAPTABLE',
    impacts: [{ softwareQuality: quality, severity: impact }], issueStatus: 'OPEN', prioritizedRule: false });
  const answer = (pathname, query) => {
    const project = query.componentKeys ?? query.components ?? query.project ?? query.projectKey ?? query.component;
    if (pathname === '/api/issues/search') {
      const issues = [
        issue(project, { key: 'AZjava-complexity', rule: 'java:S3776', relative: PRICING, line: lines.complexity, type: 'CODE_SMELL', severity: 'CRITICAL', quality: 'MAINTAINABILITY',
          impact: 'HIGH', attribute: 'FOCUSED', message: 'Refactor this method to reduce its Cognitive Complexity from 18 to the 15 allowed.' }),
        issue(project, { key: 'AZjava-cipher', rule: 'java:S5547', relative: PRICING, line: lines.cipher, type: 'VULNERABILITY', severity: 'CRITICAL', quality: 'SECURITY',
          impact: 'HIGH', attribute: 'TRUSTWORTHY', message: 'Use a strong cipher algorithm.' }),
        issue(project, { key: 'AZjava-stdout', rule: 'java:S106', relative: MAIN, line: 5, type: 'CODE_SMELL', severity: 'MAJOR', quality: 'MAINTAINABILITY',
          impact: 'MEDIUM', attribute: 'MODULAR', message: 'Replace this use of System.out by a logger.' })];
      return { total: issues.length, p: 1, ps: 500, paging: { pageIndex: 1, pageSize: 500, total: issues.length }, effortTotal: 30, issues,
        components: [file(project, PRICING), file(project, MAIN), { key: project, enabled: true, qualifier: 'TRK', name: 'shop', longName: 'shop' }], facets: [] };
    }
    if (pathname === '/api/hotspots/search') {
      return { paging: { pageIndex: 1, pageSize: 500, total: 1 }, hotspots: [{ key: 'AZjava-digest', component: `${project}:${PRICING}`, project,
        securityCategory: 'weak-cryptography', vulnerabilityProbability: 'LOW', status: 'TO_REVIEW', line: lines.digest,
        message: 'Make sure this weak hash algorithm is not used in a sensitive context here.', author: '', creationDate: '2026-11-08T10:00:00+0000',
        updateDate: '2026-11-08T10:00:00+0000', textRange: { startLine: lines.digest, endLine: lines.digest, startOffset: 28, endOffset: 39 }, flows: [], ruleKey: 'java:S4790', messageFormattings: [] }],
      components: [file(project, PRICING), { key: project, qualifier: 'TRK', name: 'shop', longName: 'shop' }] };
    }
    if (pathname === '/api/qualitygates/project_status') {
      return { projectStatus: { status: 'ERROR', conditions: [
        { status: 'ERROR', metricKey: 'new_security_rating', comparator: 'GT', errorThreshold: '1', actualValue: '4' },
        { status: 'OK', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '100.0' }], ignoredConditions: false, caycStatus: 'compliant' } };
    }
    if (pathname === '/api/measures/component') {
      return { component: { key: project, name: 'shop', qualifier: 'TRK', measures: [{ metric: 'complexity', value: '14' }, { metric: 'cognitive_complexity', value: '18' },
        { metric: 'duplicated_lines_density', value: '0.0' }, { metric: 'new_coverage', period: { index: 1, value: '100.0', bestValue: true } }] } };
    }
    return null;
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const query = Object.fromEntries(url.searchParams);
    appendFileSync(log, `${JSON.stringify({ path: url.pathname, query, authorization: request.headers.authorization ?? null })}\n`);
    const body = answer(url.pathname, query);
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? { errors: [{ msg: 'Unknown url' }] }));
  });
  server.listen(0, '127.0.0.1', () => console.log(server.address().port));
}

if (process.argv[2] === 'serve' && process.argv[1] === fileURLToPath(import.meta.url)) serve(JSON.parse(process.argv[3]), process.argv[4]);
