/**
 * No tracked file holds a value in the shape of a credential. Push protection on the office mirrors
 * (GitHub secret scanning with company patterns) refuses a push that carries one, invented or not, so
 * tests build the values they need from parts when they run (test/helpers/invented-secrets.mjs) and docs
 * describe a value in words or with a placeholder such as <TOKEN>. The rules below are built so this
 * file holds no such value itself.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { invented } from './helpers/invented-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WORDS = 'secret|password|passwd|pwd|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|credential';
/** A setting name that names a credential, read as one word: `API_SECRET`, `access_token`, `dbPassword`. */
const CREDENTIAL_NAME = /(?:secret|password|passwd|pwd|token|apikey|accesskey|privatekey|secretkey|credentials?)$/u;
/** Values that are plainly not a credential: placeholders, an environment variable's name, a dotted setting key, a version range. */
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
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', 'AKIA[0-9A-Z]{16}', 'gh[pousr]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}', 'xox[abprs]-[A-Za-z0-9-]{10,}', 'sq[pua]_[a-f0-9]{20,}',
    'sk_(?:live|test)_[A-Za-z0-9]{10,}', 'AIza[0-9A-Za-z_-]{30,}', '-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}', `wJalr${'XUtnFEMI'}`
  ].join('|'), 'gi') },
  { name: 'named credential', pattern: new RegExp(`(?:${WORDS})[A-Za-z_]*['"]?\\s*[:=]\\s*['"]([^'"<>$*{}\\s]{6,})['"]`, 'gi'),
    keep: (match, line) => CREDENTIAL_NAME.test(settingName(line, match.index, match[0])) && !notACredential(match[1]) },
  { name: 'key=value', pattern: new RegExp('(?:password|passwd|secret|token|api[_-]?key)=([^\\s\'"&<>$]{6,})', 'gi'),
    keep: (match) => { const value = match[1].replace(/\\[nrt].*$/u, ''); return value.length >= 6 && !notACredential(value); } },
  { name: 'password in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~%!-]*:([A-Za-z0-9._~%!-]+)@/gi,
    keep: (match) => !notACredential(match[1]) },
  { name: 'Bearer or Basic credential', pattern: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]{12,}=*)/g,
    keep: (match) => { const value = match[1].replace(/[.,]+$/u, ''); return value.length >= 16 || /[^A-Za-z]/u.test(value); } },
  { name: 'random-looking value', pattern: /(?<![A-Za-z0-9+/_-])([A-Za-z0-9]{16,64})(?![A-Za-z0-9+/=_-])/g, keep: (match) => randomLooking(match[1]) }
];

/** Product code whose matches are not values. Each names how many it allows, so a new one beside it still fails. */
const ALLOWED = [
  { file: 'src/presence/local-keys.mjs', family: 'provider key shape', count: 1, why: 'a pattern that finds an OpenSSH key armour header; it holds no key' },
  { file: 'src/jira.mjs', family: 'named credential', count: 2, why: "Jira's X-Atlassian-Token header, whose fixed value turns off its XSRF check" },
  { file: 'src/instruction-test-commands.mjs', family: 'named credential', count: 1, why: "the words 'a secret' and 'secrets' in a sentence" },
  { file: 'src/copilot-environment-files-guard.mjs', family: 'password in a URL', count: 1, why: "a comment quoting a compose file's local database service address" },
  { file: 'apps/vscode/src/views/visual-fixture.ts', family: 'named credential', count: 1, why: 'the style nonce of an offline visual fixture page' }
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
    + 'In a test, build it from parts when the test runs (test/helpers/invented-secrets.mjs: invented(...parts), inventedJwt); in a doc, describe it in words or use a placeholder such as <TOKEN>.');
  const stale = ALLOWED.filter((entry) => (groups.get(`${entry.file}\0${entry.family}`)?.length ?? 0) !== entry.count)
    .map((entry) => `${entry.file} (${entry.family}): allows ${entry.count}, found ${groups.get(`${entry.file}\0${entry.family}`)?.length ?? 0}`);
  assert.deepEqual(stale, [], 'An allowance no longer matches what the file holds; lower or remove it so it cannot hide a new value.');
});

test('the rules find each shape and pass placeholders, references and patterns', () => {
  const caught = [
    `token = ${invented('gh', 'p_', 'A1b2C3d4E5f6', 'G7h8I9j0K1l2')}`,
    `const API_SECRET = '${invented('api-db-', 'pass-9142')}';`,
    `{"pass${'word'}":"${invented('LEAK', 'MARK')}"}`,
    `provider says pass${'word'}=${invented('office-', 'secret')}`,
    `https://user:${invented('office-', 'secret')}@example.test/repo.git`,
    `Authorization: Bearer ${invented('abcdefgh', 'ijklmnopqrst')}`,
    `value: ${invented('Zk3q9Vb7', 'Lp2Xw8Rt5Ny1')}`,
    invented('-----BEGIN', ' RSA PRIVATE KEY-----')
  ];
  for (const line of caught) assert.notDeepEqual(credentialShapes(line), [], line);
  const passed = [
    `export NPM_TOKEN="your-artifactory-token"`, `tokenSecret: 'SFLOW_SECRET_GRAPH_TOKEN'`, `password: '\${DB_PASSWORD}'`,
    `const JIRA_TOKEN = 'singularityFlow.jira.token';`, `token=[REDACTED]`, `https://user:password@host/repo`,
    `tokenSavingComparison: 'not-evaluated'`, `"jsonwebtoken": "^9.0.0"`, `Basic authentication.`, `recommendationSha256`,
    `const pattern = /gh[pousr]_[A-Za-z0-9]{20,}/u;`
  ];
  for (const line of passed) assert.deepEqual(credentialShapes(line), [], line);
});
