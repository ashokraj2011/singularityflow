/**
 * No tracked file holds a value in the shape of a credential. Push protection on the office mirrors
 * (GitHub secret scanning with company patterns) refuses a push that carries one, invented or not, so
 * tests build the values they need from parts when they run (test/helpers/invented-secrets.mjs) and docs
 * describe a value in words or with a placeholder such as <TOKEN>. The rules below are built so this
 * file holds no such value itself. They include, at least as wide, every rule of the office scanner that
 * refuses a push: its provider key rules (AWS, GitHub, Slack, JWT, private key block, sk-/pk-/rk- keys),
 * a password in a URL (four characters or more) and an SSH key fingerprint after --key.
 *
 * The office scanner also refuses plain code: a credential word followed by `=` or `:` and a value it
 * does not read as a placeholder, and a credential word quoted right after `?`. The last tests hold
 * every tracked file to its exact rules (test/helpers/office-secret-scan.mjs), with no line reported.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inventedValue } from './helpers/invented-secrets.mjs';
import { officeLineFindings, officeScannedFiles, officeTextFindings } from './helpers/office-secret-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WORDS = 'secret|password|passwd|pwd|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|credential';
/** A setting name that names a credential, read as one word: `API_SECRET`, `access_token`, `dbPassword`. */
const CREDENTIAL_NAME = /(?:secret|password|passwd|pwd|token|apikey|accesskey|privatekey|secretkey|credentials?)$/u;
/** Values that are plainly not a credential, such as placeholders, an environment variable's name, a dotted setting key or a version range. */
const PLACEHOLDER = /^(?:your[-_].*|changeme|change[-_]?me|\\?\[.*|redacted|hidden|placeholder|example|dummy|x+|password|pass|pw|secret|token|value)$/iu;
const notACredential = (value) => PLACEHOLDER.test(value) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]*)+$/u.test(value)
  || /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u.test(value) || /^[~^]\d+\.\d+\.\d+$/u.test(value);
function settingName(line, start, matched) {
  let left = start;
  while (left > 0 && /[A-Za-z0-9_.-]/u.test(line[left - 1])) left -= 1;
  return `${line.slice(left, start)}${matched.match(/^[A-Za-z_-]+/u)[0]}`.toLowerCase().replace(/[^a-z0-9]/gu, '').replace(/(?:value|text|literal)$/u, '');
}
const randomLooking = (value) => (value.match(/[A-Z]/gu) ?? []).length >= 3 && (value.match(/[a-z]/gu) ?? []).length >= 3
  && (value.match(/[0-9]/gu) ?? []).length >= 3 && !/[a-z]{4,}|[A-Z]{5,}|[0-9]{5,}/u.test(value);

const FAMILIES = [
  { name: 'provider key shape', pattern: new RegExp([
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', '(?:AKIA|ASIA)[0-9A-Z]{16}', '\\b(?:sk|pk|rk)-[A-Za-z0-9]{20,}', 'gh[pousr]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}', 'xox[abprs]-[A-Za-z0-9-]{10,}', 'sq[pua]_[a-f0-9]{20,}',
    'sk_(?:live|test)_[A-Za-z0-9]{10,}', 'AIza[0-9A-Za-z_-]{30,}', '-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}', `wJalr${'XUtnFEMI'}`
  ].join('|'), 'gi') },
  { name: 'named credential', pattern: new RegExp(`(?:${WORDS})[A-Za-z_]*['"]?\\s*[:=]\\s*['"]([^'"<>$*{}\\s]{6,})['"]`, 'gi'),
    keep: (match, line) => CREDENTIAL_NAME.test(settingName(line, match.index, match[0])) && !notACredential(match[1]) },
  { name: 'key=value', pattern: new RegExp('(?:password|passwd|secret|token|api[_-]?key)=([^\\s\'"&<>$]{6,})', 'gi'),
    keep: (match) => { const value = match[1].replace(/\\[nrt].*$/u, ''); return value.length >= 6 && !notACredential(value); } },
  // The office scanner's own rule, with an empty user too: any password of four characters or more, placeholder words included.
  { name: 'password in a URL', pattern: /:\/\/[^/\s:@'"`]*:[^/\s:@'"`${}<>]{4,}@/g },
  { name: 'key fingerprint', pattern: /--key\s+SHA256:\S+/g },
  { name: 'Bearer or Basic credential', pattern: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]{12,}=*)/g,
    keep: (match) => { const value = match[1].replace(/[.,]+$/u, ''); return value.length >= 16 || /[^A-Za-z]/u.test(value); } },
  { name: 'random-looking value', pattern: /(?<![A-Za-z0-9+/_-])([A-Za-z0-9]{16,64})(?![A-Za-z0-9+/=_-])/g, keep: (match) => randomLooking(match[1]) }
];

/** Product code whose matches are not values. Each names how many it allows, so a new one beside it still fails. */
const ALLOWED = [
  { file: 'src/presence/local-keys.mjs', family: 'provider key shape', count: 1, why: 'a pattern that finds an OpenSSH key armour header; it holds no key' },
  { file: 'src/jira.mjs', family: 'named credential', count: 2, why: "Jira's X-Atlassian-Token header, whose fixed value turns off its XSRF check" }
];

function credentialShapes(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const family of FAMILIES) {
      for (const match of line.matchAll(family.pattern)) {
        if (!family.keep || family.keep(match, line)) found.push({ line: index + 1, family: family.name });
      }
    }
  });
  return found;
}

function trackedTextFiles() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
  return files.flatMap((file) => {
    let bytes;
    try { bytes = readFileSync(path.join(ROOT, file)); } catch { return []; }
    return bytes.subarray(0, 8000).includes(0) ? [] : [{ file, text: bytes.toString('utf8') }];
  });
}

test('no tracked file holds a credential-shaped value, invented or real', () => {
  const groups = new Map();
  for (const { file, text } of trackedTextFiles()) {
    for (const finding of credentialShapes(text)) {
      const key = `${file}\0${finding.family}`;
      groups.set(key, [...(groups.get(key) ?? []), `${file}:${finding.line} (${finding.family})`]);
    }
  }
  const unexpected = [];
  for (const [key, sites] of groups) {
    const [file, family] = key.split('\0');
    const allowed = ALLOWED.find((entry) => entry.file === file && entry.family === family);
    if (!allowed || sites.length > allowed.count) unexpected.push(...sites);
  }
  assert.deepEqual(unexpected, [], `${unexpected.length} line(s) hold a value in the shape of a credential, which push protection on the office mirrors refuses. `
    + 'In a test, build it from parts when the test runs (test/helpers/invented-secrets.mjs: inventedValue(...parts), inventedJwt); in a doc, describe it in words or use a placeholder such as <TOKEN>.');
  const stale = ALLOWED.filter((entry) => (groups.get(`${entry.file}\0${entry.family}`)?.length ?? 0) !== entry.count)
    .map((entry) => `${entry.file} (${entry.family}): allows ${entry.count}, found ${groups.get(`${entry.file}\0${entry.family}`)?.length ?? 0}`);
  assert.deepEqual(stale, [], 'An allowance no longer matches what the file holds; lower or remove it so it cannot hide a new value.');
});

test('the rules find each shape and pass placeholders, references and patterns', () => {
  const caught = [
    `token = ${inventedValue('gh', 'p_', 'A1b2C3d4E5f6', 'G7h8I9j0K1l2')}`,
    `const API_SECRET = '${inventedValue('api-db-', 'pass-9142')}';`,
    `{"pass${'word'}":"${inventedValue('LEAK', 'MARK')}"}`,
    `provider says pass${'word'}=${inventedValue('office-', 'secret')}`,
    `https://user:${inventedValue('office-', 'secret')}@example.test/repo.git`,
    `Authorization: Bearer ${inventedValue('abcdefgh', 'ijklmnopqrst')}`,
    `value: ${inventedValue('Zk3q9Vb7', 'Lp2Xw8Rt5Ny1')}`,
    inventedValue('-----BEGIN', ' RSA PRIVATE KEY-----'),
    `the session ${inventedValue('AS', 'IA')}${'Q'.repeat(16)} expired`,
    `key ${inventedValue('sk', '-')}${'a1'.repeat(12)}`,
    `https://user:${inventedValue('pa', 'ss')}@host/repo`,
    `postgres://:${inventedValue('pass', 'word')}@db/app`,
    `singularity-flow guard rotate --key ${inventedValue('SHA256', ':abc')}`
  ];
  for (const line of caught) assert.notDeepEqual(credentialShapes(line), [], line);
  const passed = [
    `export NPM_TOKEN="your-artifactory-token"`, `tokenSecret: 'SFLOW_SECRET_GRAPH_TOKEN'`, `password: '\${DB_PASSWORD}'`,
    `const ${inventedValue('JIRA_', 'TOKEN')} = 'singularityFlow.jira.token';`, `token=[REDACTED]`, `https://user:pw@host/repo`,
    `https://x-access-token:\${GH_TOKEN}@git.example.test/acme/app.git`, `singularity-flow guard rotate --key <fingerprint>`,
    `${'token'}SavingComparison: 'not-evaluated'`, `"jsonwebtoken": "^9.0.0"`, `Basic authentication.`, `recommendationSha256`,
    `const pattern = /gh[pousr]_[A-Za-z0-9]{20,}/u;`
  ];
  for (const line of passed) assert.deepEqual(credentialShapes(line), [], line);
});

/**
 * Lines the office scanner passes only because they hold its allow marker. Each names how many it
 * allows and why the words have to stay, so a new marker that hides a finding still fails.
 */
const OFFICE_ALLOWED = [];

test('no tracked file holds a line the office secret scanner refuses', () => {
  const findings = officeScannedFiles(ROOT).flatMap(({ file, text }) => officeTextFindings(text).map((finding) => ({ file, ...finding })));
  const refused = findings.filter((finding) => !finding.allowed).map((finding) => `${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`);
  assert.deepEqual(refused, [], `${refused.length} line(s) match the office scanner, whose push protection refuses them even when nothing is a credential. `
    + 'Reword the line: give a local a name without the credential word; keep a stored or printed field and take its value from a camelCase name, '
    + 'shorthand or the next line; take a status word such as the passing one from a constant instead of quoting it after `?`. '
    + 'Only a line that must keep the words takes the allow marker with its reason, listed in OFFICE_ALLOWED.');
  const marked = new Map();
  for (const finding of findings.filter((entry) => entry.allowed)) marked.set(finding.file, [...(marked.get(finding.file) ?? []), finding.line]);
  const unlisted = [...marked].filter(([file, lines]) => (OFFICE_ALLOWED.find((entry) => entry.file === file)?.count ?? 0) < lines.length)
    .map(([file, lines]) => `${file}:${lines.join(',')}`);
  assert.deepEqual(unlisted, [], 'An allow marker hides a finding that OFFICE_ALLOWED does not list; reword the line, or list it with why the words must stay.');
  const stale = OFFICE_ALLOWED.filter((entry) => (marked.get(entry.file)?.length ?? 0) !== entry.count)
    .map((entry) => `${entry.file}: allows ${entry.count}, found ${marked.get(entry.file)?.length ?? 0}`);
  assert.deepEqual(stale, [], 'An office allowance no longer matches what the file holds; lower or remove it.');
});

test('the office rules find credential-shaped code and pass placeholders, kept fields and constants', () => {
  const caught = [
    `const ${'tok'}en = randomUUID();`,
    `status: ok ? '${'pa'}ss' : 'fail',`,
    `first${'Pass'}Verified: receipts.filter((entry) => entry.ok).length,`,
    `${'cred'}ential-helper: 'Install the helper'`,
    `const ${'SEC'}RET_RULES = Object.freeze([`,
    `${'pass'}word = os.environ["DB"]`,
    // What the office report of 2026-11-23 named beyond the photographed rules.
    `singularity-flow guard register --key <${'SHA'}256-FINGERPRINT>`, `--key <${'SHA'}256:…>`,
    `const holds = found ? ${'sec'}ret : prior;`, `  '${'sec'}ret: bound privately on each computer',`, 'values.get(`' + `${'sec'}ret:` + '${key}`)'
  ];
  for (const line of caught) assert.notDeepEqual(officeLineFindings(line), [], line);
  const passed = [
    'token: nonce,', 'processToken: processNonce,', 'tokenEconomyMode:', "const OK = 'pass';", 'INTEGRATION_SECRET_NAME =',
    `${'sec'}ret: SFLOW_SECRET_EVENTS_KEY`, 'password: ${DB_PASSWORD}', 'const access = String(raw);', "'not-evaluated',"
  ];
  for (const line of passed) assert.deepEqual(officeLineFindings(line), [], line);
  const [marked] = officeTextFindings(`const ${'tok'}en = randomUUID(); // ${'sflow-allow'}-secret: a fixture's own value`);
  assert.equal(marked.allowed, true);
});
