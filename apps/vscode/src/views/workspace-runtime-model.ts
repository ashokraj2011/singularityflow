/** Run & Test navigation and target headers. No process or repository operation lives here. */
import path from 'node:path';
import type { CapabilityNode } from '../cli/snapshot.ts';
import { unwrapResult } from './run-and-test-model.ts';
export interface RuntimeTarget {
  id: string; repositoryId: string; checkoutPath: string; workId: string | null; title: string;
  branch: string | null; phase: string | null; storyStatus: string | null; role: string; available: boolean;
  changes?: Array<{ path: string | null; display: string; status: string }>; changesTruncated?: boolean;
  lifecycleCheckoutPath?: string; capabilities?: CapabilityNode[];
  context?: { worktree?: { branch?: string | null; head?: string | null } };
}
export interface RuntimeInventory { workspace: { id: string; name: string; path: string }; targets: RuntimeTarget[] }
export function runtimeInventory(raw: unknown): RuntimeInventory | null {
  const value = unwrapResult(raw) as Partial<RuntimeInventory> | null;
  if (!value?.workspace || typeof value.workspace.id !== 'string' || typeof value.workspace.name !== 'string' || typeof value.workspace.path !== 'string' || !path.isAbsolute(value.workspace.path) || !Array.isArray(value.targets)) return null;
  if (value.targets.some(target => !validRuntimeTarget(target))) return null;
  return value as RuntimeInventory;
}
export function validRuntimeTarget(value: unknown): value is RuntimeTarget {
  const target = value as RuntimeTarget | null;
  return Boolean(target && /^[a-f0-9]{64}$/u.test(target.id) && typeof target.repositoryId === 'string'
    && typeof target.title === 'string' && (target.workId === null || typeof target.workId === 'string')
    && (target.phase === null || typeof target.phase === 'string') && typeof target.role === 'string'
    && typeof target.checkoutPath === 'string' && path.isAbsolute(target.checkoutPath) && typeof target.available === 'boolean');
}
export function runtimeTargetArgs(workspace: string, target?: string): string[] {
  if (!path.isAbsolute(workspace) || target && !/^[a-f0-9]{64}$/u.test(target)) throw new Error('Choose an exact workspace and target.');
  return ['workspace', 'runtime', '--workspace', workspace, ...(target ? ['--target', target] : []), '--json'];
}
export function safeRuntimeRelative(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)
      || value.includes('\\') || path.isAbsolute(value) || value.split('/').some(part => part === '..' || part === '.git')) return null;
  return value;
}
