import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicPrivateJson, withLocalStoreMutation } from './local-store.mjs';

export const ONBOARDING_SCHEMA_VERSION = 1;
export const MAX_ONBOARDING_REPOSITORIES = 20;
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
      name: String(value?.name ?? path.basename(repositoryPath)).trim().slice(0, 160) || path.basename(repositoryPath)
    });
  }
  if (unique.size > MAX_ONBOARDING_REPOSITORIES) {
    throw new Error(`Onboarding supports at most ${MAX_ONBOARDING_REPOSITORIES} repository locations.`);
  }
  return [...unique.values()];
}

export async function validateOnboardingWorkspace(value) {
  const requested = path.resolve(String(value ?? '').trim());
  if (!String(value ?? '').trim() || requested === path.parse(requested).root) {
    throw new Error('Choose a specific local workspace directory.');
  }
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('The selected local workspace directory is no longer available.');
    throw error;
  }
  if (canonical === path.parse(canonical).root) throw new Error('Choose a specific local workspace directory.');
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory()) throw new Error('The selected local workspace must be a directory.');
  try {
    await access(canonical, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error('The selected local workspace must be writable and searchable by this user.');
  }
  return canonical;
}

export function normalizeOnboardingProfile(input = {}, {
  complete = false,
  jiraConnected = false,
  touch = false,
  allowDisconnectedCompletion = false
} = {}) {
  const schemaVersion = input.schemaVersion ?? ONBOARDING_SCHEMA_VERSION;
  if (schemaVersion !== ONBOARDING_SCHEMA_VERSION) {
    throw new Error(`Unsupported onboarding profile version ${schemaVersion}; expected version ${ONBOARDING_SCHEMA_VERSION}.`);
  }
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
    if (jiraChoice === 'disconnected' && !allowDisconnectedCompletion) {
      throw new Error('Reconnect Jira or explicitly confirm that Jira is not used before finishing onboarding.');
    }
  }
  const completed = complete === true;
  const completedAt = completed
    ? (!touch && Number.isFinite(Date.parse(input.completedAt))
        ? new Date(input.completedAt).toISOString()
        : nowIso())
    : null;
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    completed,
    name,
    role: role || null,
    step: completed ? 4 : step,
    workspacePath,
    repositories,
    jiraChoice,
    completedAt,
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
    return normalizeOnboardingProfile(parsed, {
      complete: parsed?.completed === true,
      jiraConnected,
      allowDisconnectedCompletion: parsed?.completed === true
    });
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

export async function prepareOnboardingProfile(input = {}, {
  complete = false,
  jiraConnected = false,
  validateWorkspace = async (workspacePath) => workspacePath,
  validateRepository = async (repositoryPath) => repositoryPath
} = {}) {
  const draft = normalizeOnboardingProfile(input, { jiraConnected });
  const notices = [];
  if (draft.workspacePath) {
    try {
      draft.workspacePath = await validateWorkspace(draft.workspacePath);
    } catch (error) {
      if (complete) throw error;
      notices.push({
        kind: 'workspace',
        path: draft.workspacePath,
        message: `The previous workspace is unavailable (${error.message}). Select it again to continue.`
      });
      draft.workspacePath = null;
      draft.step = Math.min(draft.step, 2);
    }
  }
  const repositories = [];
  for (const repository of draft.repositories) {
    try {
      repositories.push({
        ...repository,
        path: await validateRepository(repository.path)
      });
    } catch (error) {
      notices.push({
        kind: 'repository',
        path: repository.path,
        message: `${repository.name} was removed from setup because it is unavailable (${error.message}).`
      });
    }
  }
  return {
    profile: normalizeOnboardingProfile({
      ...draft,
      repositories
    }, { complete, jiraConnected }),
    notices
  };
}

export async function saveOnboardingProfile(file, input, options = {}) {
  const profile = normalizeOnboardingProfile(input, { ...options, touch: true });
  return withLocalStoreMutation(file, async () => {
    await atomicPrivateJson(file, profile);
    return profile;
  });
}
