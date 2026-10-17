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

const CHECK_KEY = 'singularityFlow.capabilityProposalCheck.v1';

/**
 * The setup and capability queue's last full read on this machine. Reviews counts from it, because
 * reading the queue clones every capability map and is too costly to repeat just to draw a number.
 */
export interface CapabilityProposalCheck {
  checkedAt: string;
  capability: number;
  setup: number;
  /** False when a repository could not be read, so the counts are a lower bound. */
  complete: boolean;
}

export function capabilityProposalCheck(state: vscode.Memento): CapabilityProposalCheck | null {
  const stored = state.get<unknown>(CHECK_KEY);
  if (!stored || typeof stored !== 'object') return null;
  const { checkedAt, capability, setup, complete } = stored as Record<string, unknown>;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt)) || !count(capability) || !count(setup)
    || typeof complete !== 'boolean') return null;
  return { checkedAt, capability, setup, complete };
}

export async function rememberCapabilityProposalCheck(
  state: vscode.Memento, check: CapabilityProposalCheck
): Promise<void> {
  await state.update(CHECK_KEY, check);
}
