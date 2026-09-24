/** Repositories with onboarding reviews are not yet in the approved lead registry. */
import type * as vscode from 'vscode';
import { gitRemoteProblem } from './map-capability-form.ts';

const KEY = 'singularityFlow.setupReviewRepositories.v1';
const MAX_REPOSITORIES = 100;

export function setupReviewRepositories(state: vscode.Memento): string[] {
  const stored = state.get<unknown>(KEY);
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.slice(0, MAX_REPOSITORIES).filter((value): value is string =>
    typeof value === 'string' && Boolean(value.trim())
      && !gitRemoteProblem(value, 'Repository setup review')))];
}

export async function rememberSetupReviewRepository(
  state: vscode.Memento, repository: string
): Promise<void> {
  if (gitRemoteProblem(repository, 'Repository setup review')) return;
  const known = setupReviewRepositories(state).filter((value) => value !== repository);
  await state.update(KEY, [repository, ...known].slice(0, MAX_REPOSITORIES));
}

export async function forgetSetupReviewRepository(
  state: vscode.Memento, repository: string
): Promise<void> {
  await state.update(KEY, setupReviewRepositories(state).filter((value) => value !== repository));
}
