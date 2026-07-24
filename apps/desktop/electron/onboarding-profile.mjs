import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ONBOARDING_ROLES = new Set([
  'product-owner',
  'business-analyst',
  'product-designer',
  'architect',
  'developer',
  'qa',
  'security',
  'delivery-manager',
  'operations',
  'other'
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizedRepositories(values = []) {
  if (!Array.isArray(values)) throw new Error('Onboarding repositories must be a list.');
  const unique = new Map();
  for (const value of values) {
    const rawPath = String(value?.path ?? value ?? '').trim();
    if (!rawPath) throw new Error('Repository paths must identify a specific local directory.');
    const repositoryPath = path.resolve(rawPath);
    if (repositoryPath === path.parse(repositoryPath).root) throw new Error('Repository paths must identify a specific local directory.');
    unique.set(repositoryPath, {
      path: repositoryPath,
      name: String(value?.name ?? path.basename(repositoryPath)).trim() || path.basename(repositoryPath)
    });
  }
  return [...unique.values()].slice(0, 20);
}

export function normalizeOnboardingProfile(input = {}, { complete = false, jiraConnected = false, touch = false } = {}) {
  const name = String(input.name ?? '').trim().slice(0, 160);
  const role = String(input.role ?? '').trim();
  const workspacePath = input.workspacePath ? path.resolve(String(input.workspacePath).trim()) : null;
  const repositories = normalizedRepositories(input.repositories ?? []);
  const step = Number.isInteger(input.step) ? Math.max(0, Math.min(4, input.step)) : 0;
  const jiraChoice = input.jiraChoice === 'connected'
    ? (jiraConnected ? 'connected' : 'disconnected')
    : input.jiraChoice === 'disconnected'
      ? (jiraConnected ? 'connected' : 'disconnected')
      : input.jiraChoice === 'not-used' ? 'not-used' : 'later';
  if (role && !ONBOARDING_ROLES.has(role)) throw new Error(`Unsupported onboarding role '${role}'.`);
  if (workspacePath === path.parse(workspacePath ?? '').root) throw new Error('Choose a specific local workspace directory.');
  if (complete) {
    if (!name) throw new Error('Enter your name before finishing onboarding.');
    if (!role) throw new Error('Choose your role before finishing onboarding.');
    if (!workspacePath) throw new Error('Choose a local workspace before finishing onboarding.');
    if (jiraChoice === 'later') throw new Error('Connect Jira or confirm that Jira is not used before finishing onboarding.');
  }
  const completed = complete === true;
  return {
    schemaVersion: 1,
    completed,
    name,
    role: role || null,
    step: completed ? 4 : step,
    workspacePath,
    repositories,
    jiraChoice,
    completedAt: completed ? (input.completedAt ?? nowIso()) : null,
    updatedAt: !touch && Number.isFinite(Date.parse(input.updatedAt)) ? new Date(input.updatedAt).toISOString() : nowIso()
  };
}

export async function readOnboardingProfile(file, { jiraConnected = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeOnboardingProfile({}, { jiraConnected });
    if (!(error instanceof SyntaxError)) throw error;
    return {
      ...normalizeOnboardingProfile({}, { jiraConnected }),
      recovery: {
        reason: 'invalid-json',
        message: 'The previous local setup file was not valid JSON. Review and save the recovered setup to replace it.'
      }
    };
  }
  try {
    return normalizeOnboardingProfile(parsed, { complete: parsed?.completed === true, jiraConnected });
  } catch (error) {
    return {
      ...normalizeOnboardingProfile({}, { jiraConnected }),
      recovery: {
        reason: 'invalid-profile',
        message: `The previous local setup was incompatible: ${error.message}`
      }
    };
  }
}

export async function saveOnboardingProfile(file, input, options = {}) {
  const profile = normalizeOnboardingProfile(input, { ...options, touch: true });
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
  return profile;
}
