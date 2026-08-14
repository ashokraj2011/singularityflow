import test from 'node:test';
import assert from 'node:assert/strict';

import { entropy, redact, scanEntries, scanText, secretRefusal, scannablePath, SECRET_RULES } from '../src/secrets.mjs';

/** Assembled at runtime so this test file is not itself a file full of credential-shaped strings. */
const fake = {
  aws: `AKIA${'Q7RJ2NXWMBK4TZVD'}`,
  github: `ghp_${'a'.repeat(36)}`,
  modelProvider: `sk-ant-${'A1b2C3d4E5f6G7h8J9k0'}`,
  npm: `npm_${'b'.repeat(36)}`,
  stripe: `sk_live_${'9XqZ4mT7wR2vN8kL5bH3jD6y'}`,
  google: `AIza${'SyD9xQ2mK7vR4tW8nL3bJ6hF5gY1cA0zEqW'.slice(0, 35)}`
};

test('every rule has a stable id, a label and a severity', () => {
  const ids = SECRET_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids must be unique: a waiver and a report name them');
  for (const rule of SECRET_RULES) {
    assert.match(rule.id, /^[a-z0-9-]+$/);
    assert.ok(rule.label, `${rule.id} has no reader-facing label`);
    assert.ok(['certain', 'likely'].includes(rule.severity));
  }
});

test('provider credential formats are caught', () => {
  for (const [name, value] of Object.entries(fake)) {
    const findings = scanText(`const key = "${value}";`, { path: 'src/app.js' });
    assert.equal(findings.length >= 1, true, `${name} was not detected`);
    assert.equal(findings[0].path, 'src/app.js');
    assert.equal(findings[0].line, 1);
  }
});

test('a private key header is caught wherever it appears', () => {
  for (const armour of ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----']) { // sflow-allow-secret: armour headers with no key body, the input this rule is tested against
    assert.equal(scanText(armour, { path: 'id_rsa' })[0]?.rule, 'private-key');
  }
});

test('credentials inside a remote URL are caught, which is how tokens usually arrive', () => {
  const findings = scanText('git remote add origin https://deploy:hunter2hunter2@code.acme.internal/x/y.git', { path: 'README.md' }); // sflow-allow-secret: invented URL asserting this rule fires
  assert.equal(findings[0].rule, 'url-credentials');
  // A URL with no password is a URL.
  assert.deepEqual(scanText('https://code.acme.internal/x/y.git', { path: 'README.md' }), []);
});

test('a finding never carries the secret, only enough to find the line', () => {
  const value = fake.github;
  const [finding] = scanText(`token = "${value}"`, { path: 'src/app.js' });
  assert.ok(!finding.preview.includes(value), 'the preview contains the credential');
  assert.ok(!JSON.stringify(finding).includes(value), 'the finding serialises the credential');
  // Enough to tell two findings apart in one file.
  assert.ok(finding.preview.startsWith(value.slice(0, 4)));
  assert.match(finding.preview, /\(\d+ chars\)/);
  // A short value is masked entirely rather than half-revealed.
  assert.equal(redact('abc'), '***');
});

test('placeholders and references are not credentials', () => {
  for (const value of ['${DB_PASSWORD}', '{{token}}', '<your-api-key>', 'changeme', 'your-token-here',
    'example-secret-value', 'REDACTED', '********', 'PLACEHOLDER_VALUE']) {
    assert.deepEqual(scanText(`password = "${value}"`, { path: 'docs/setup.md' }), [],
      `'${value}' was reported as a secret`);
  }
});

test('an identifier prefix does not exempt the assignment', () => {
  // `\bpassword` never matches `db_password`: `_` is a word character. The boundary looked correct
  // and quietly exempted the form people actually write.
  for (const name of ['db_password', 'API_KEY', 'client_secret', 'myApiKey', 'AWS_ACCESS_KEY']) {
    const findings = scanText(`${name} = "K7#mQ9xL2vB8nR4tZ6wY"`, { path: 'config.ini' });
    assert.equal(findings.length, 1, `${name} was not scanned`);
  }
});

test('an assigned value that actually looks random is caught', () => {
  const findings = scanText(`db_password = "K7#mQ9xL2vB8nR4tZ6wY"`, { path: 'config.ini' }); // sflow-allow-secret: random string asserting the entropy gate
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'assigned-secret');
  assert.equal(findings[0].severity, 'likely');
  assert.ok(entropy('K7#mQ9xL2vB8nR4tZ6wY') >= 3.4);

  /**
   * Prose is NOT separated by entropy — `the quick brown fox` scores above the threshold too. What
   * separates them is whitespace, so a sentence assigned to a `password` key is not reported.
   */
  assert.ok(entropy('the quick brown fox') >= 3.4, 'entropy alone would not have excluded prose');
  assert.deepEqual(scanText('password: "see the docs for how to set this"', { path: 'README.md' }), []);
  assert.deepEqual(scanText('token = "ask the platform team first"', { path: 'README.md' }), []);
});

test('a waiver excuses the line, and requires a reason', () => {
  const line = `const key = "${fake.aws}"; // sflow-allow-secret: documented example key from AWS docs`;
  const [finding] = scanText(line, { path: 'docs/aws.md' });
  assert.equal(finding.waived, true);
  assert.equal(finding.reason, 'documented example key from AWS docs');

  // A bare marker with no reason does not waive: the reason is the point.
  const bare = scanText(`const key = "${fake.aws}"; // sflow-allow-secret:`, { path: 'docs/aws.md' });
  assert.equal(bare[0].waived, false);
});

test('a waiver on one line does not excuse the next', () => {
  const content = [
    `const a = "${fake.aws}"; // sflow-allow-secret: example`,
    `const b = "${fake.github}";`
  ].join('\n');
  const scan = scanEntries([{ path: 'src/app.js', content }]);
  assert.equal(scan.waived.length, 1);
  assert.equal(scan.blocking.length, 1);
  assert.equal(scan.blocking[0].line, 2);
  assert.equal(scan.clean, false);
});

test('a clean tree is clean, and a waived-only tree is too', () => {
  assert.equal(scanEntries([{ path: 'src/app.js', content: 'export const x = 1;\n' }]).clean, true);
  assert.equal(scanEntries([{
    path: 'docs/a.md', content: `key: "${fake.aws}" <!-- sflow-allow-secret: AWS documentation sample -->`
  }]).clean, true);
});

test('binary and lockfiles are skipped; test directories are not', () => {
  assert.equal(scannablePath('media/logo.png'), false);
  assert.equal(scannablePath('package-lock.json'), false);
  assert.equal(scannablePath('node_modules/x/index.js'), false);
  // Exempting test fixtures would put the blind spot exactly where someone pastes a real key
  // "just to check".
  assert.equal(scannablePath('test/fixtures/config.json'), true);
  assert.equal(scannablePath('src/app.js'), true);
});

test('an unreadable file refuses the commit rather than passing quietly', () => {
  // A scanner that treats "could not read" as "nothing found" is worse than no scanner, because
  // people stop looking.
  assert.throws(() => scanEntries([{ path: 'src/app.js', content: undefined }]),
    /Cannot scan .* an unscannable file is not a scanned file/);
  assert.throws(() => scanEntries([{ path: 'src/app.js' }]), { code: 'SECRET_SCAN_UNREADABLE' });
});

test('the refusal says what to do, and still does not print the secret', () => {
  const value = fake.stripe;
  const scan = scanEntries([{ path: 'src/pay.js', content: `const k = "${value}";` }]);
  const message = secretRefusal(scan);
  assert.match(message, /src\/pay\.js:1 — Stripe secret key \[stripe-key\]/);
  assert.match(message, /sflow-allow-secret: <why this is not a real credential>/);
  assert.match(message, /in the history on every clone/);
  assert.ok(!message.includes(value), 'the refusal echoes the credential');
  // Nothing to refuse means no message at all, rather than an empty banner.
  assert.equal(secretRefusal(scanEntries([{ path: 'a.js', content: 'ok' }])), null);
});

test('regex state does not leak between files', () => {
  // The rules are global regexes. Sharing one across files would leave `lastIndex` mid-string and
  // silently miss the second file's credential.
  const content = `key = "${fake.aws}"`;
  const scan = scanEntries([
    { path: 'a.js', content }, { path: 'b.js', content }, { path: 'c.js', content }
  ]);
  assert.deepEqual(scan.blocking.map((finding) => finding.path), ['a.js', 'b.js', 'c.js']);
});
