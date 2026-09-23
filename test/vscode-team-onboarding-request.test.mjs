import assert from 'node:assert/strict';
import { access, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...parts) => path.join(packageRoot, 'apps', 'vscode', 'src', ...parts);

const { TEAM_ONBOARDING_REQUEST_MAX_BYTES, withTeamOnboardingRequestFile } = await import(
  source('views', 'team-onboarding-request.ts'));
const { formatCliArgsForDisplay } = await import(source('cli', 'runner.ts'));
const { CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES } = await import(
  path.join(packageRoot, 'src', 'commands', 'capability.mjs'));

const request = Object.freeze({
  teamId: 'payments-platform',
  lead: 'https://git.corp.invalid/platform.git',
  name: 'Payments Platform',
  jiraProject: 'PAY',
  members: [{
    capabilityId: 'checkout-api',
    repositoryUrl: 'https://git.corp.invalid/checkout-api.git',
    name: 'Checkout API'
  }],
  links: ['settlement-worker']
});

test('VS Code request ceiling matches the CLI transport ceiling', () => {
  assert.equal(TEAM_ONBOARDING_REQUEST_MAX_BYTES, CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES);
});

async function assertRemoved(file) {
  await assert.rejects(access(file), { code: 'ENOENT' });
  await assert.rejects(access(path.dirname(file)), { code: 'ENOENT' });
}

test('VS Code writes one private map-team request and removes it after success', async () => {
  let observedFile = '';
  const result = await withTeamOnboardingRequestFile(request, async (file) => {
    observedFile = file;
    const metadata = await stat(file);
    assert.equal(metadata.isFile(), true);
    if (process.platform !== 'win32') assert.equal(metadata.mode & 0o077, 0);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), request);
    return 'mapped';
  });

  assert.equal(result, 'mapped');
  await assertRemoved(observedFile);
});

test('VS Code removes the private map-team request when the CLI call fails', async () => {
  let observedFile = '';
  await assert.rejects(withTeamOnboardingRequestFile(request, async (file) => {
    observedFile = file;
    throw new Error('synthetic CLI refusal');
  }), /synthetic CLI refusal/u);
  await assertRemoved(observedFile);
});

test('a temp cleanup fault never masks the durable CLI result or original refusal', async () => {
  const retainedDirectories = [];
  const dependencies = {
    async remove(directory) {
      retainedDirectories.push(directory);
      throw new Error('synthetic cleanup fault');
    }
  };
  try {
    const result = await withTeamOnboardingRequestFile(
      request, async () => 'proposal-published', dependencies);
    assert.equal(result, 'proposal-published');

    await assert.rejects(withTeamOnboardingRequestFile(request, async () => {
      throw new Error('original CLI refusal');
    }, dependencies), /original CLI refusal/u);
  } finally {
    await Promise.all(retainedDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true })));
  }
});

test('VS Code diagnostics redact the private map-team request path', () => {
  const privatePath = path.join('/private', 'team-onboarding', 'request.json');
  assert.equal(formatCliArgsForDisplay([
    'capability', 'map-team', '--request', privatePath, '--json'
  ]), 'capability map-team --request [redacted-path] --json');
  assert.equal(formatCliArgsForDisplay([
    'capability', 'map-team', `--request=${privatePath}`, '--json'
  ]), 'capability map-team --request=[redacted-path] --json');
  assert.equal(formatCliArgsForDisplay([
    'auto', 'respond', 'AFL-EXAMPLE', '--request', 'AHR-EXAMPLE', '--choice', 'continue'
  ]), 'auto respond AFL-EXAMPLE --request AHR-EXAMPLE --choice continue',
  'non-path --request IDs used by other commands remain copyable');
});
