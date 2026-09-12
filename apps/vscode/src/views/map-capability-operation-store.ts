import type { MapCapabilityOperation } from './map-capability-form.ts';

/** The pre-concurrency receipt slot, retained only as a read-once migration source. */
export const LEGACY_MAP_CAPABILITY_OPERATION_KEY = 'singularityFlow.mapCapability.operation.v1';

/** One key per operation prevents independent VS Code windows from sharing a mutable slot. */
export const MAP_CAPABILITY_OPERATION_PREFIX = 'singularityFlow.mapCapability.operation.v2.';

export interface MapCapabilityOperationState {
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  keys?(): readonly string[];
}

type Restore = (value: unknown) => MapCapabilityOperation | null;

export function mapCapabilityOperationKey(id: string): string {
  return `${MAP_CAPABILITY_OPERATION_PREFIX}${id}`;
}

/** Read all independently stored receipts; malformed values never become operation candidates. */
export function readMapCapabilityOperations(
  state: MapCapabilityOperationState,
  restore: Restore
): Array<{ key: string; operation: MapCapabilityOperation }> {
  const keys = typeof state.keys === 'function'
    ? state.keys().filter((key) => key.startsWith(MAP_CAPABILITY_OPERATION_PREFIX)) : [];
  const seen = new Set<string>();
  const operations: Array<{ key: string; operation: MapCapabilityOperation }> = [];
  for (const key of keys) {
    const operation = restore(state.get<unknown>(key));
    if (!operation || key !== mapCapabilityOperationKey(operation.id) || seen.has(operation.id)) continue;
    seen.add(operation.id);
    operations.push({ key, operation });
  }
  const legacy = restore(state.get<unknown>(LEGACY_MAP_CAPABILITY_OPERATION_KEY));
  if (legacy && !seen.has(legacy.id)) {
    operations.push({ key: LEGACY_MAP_CAPABILITY_OPERATION_KEY, operation: legacy });
  }
  return operations.sort((left, right) => {
    const time = Date.parse(right.operation.updatedAt) - Date.parse(left.operation.updatedAt);
    return time || right.operation.id.localeCompare(left.operation.id);
  });
}

/** A write can affect only this operation's key, even when another window writes concurrently. */
export async function writeMapCapabilityOperation(
  state: MapCapabilityOperationState,
  operation: MapCapabilityOperation,
  restore: Restore
): Promise<void> {
  const key = mapCapabilityOperationKey(operation.id);
  const currentRaw = state.get<unknown>(key);
  if (currentRaw != null) {
    const current = restore(currentRaw);
    if (!current || current.id !== operation.id) {
      throw new Error('The durable capability-map receipt changed identity and was not overwritten.');
    }
  }
  await state.update(key, operation);
}

/** Delete only the exact receipt requested; never clear a slot now owned by another operation. */
export async function clearMapCapabilityOperation(
  state: MapCapabilityOperationState,
  operationId: string,
  restore: Restore
): Promise<boolean> {
  const key = mapCapabilityOperationKey(operationId);
  const current = restore(state.get<unknown>(key));
  if (!current || current.id !== operationId) return false;
  await state.update(key, undefined);
  return true;
}

/** Move one valid legacy receipt without deleting any per-operation receipt. */
export async function migrateLegacyMapCapabilityOperation(
  state: MapCapabilityOperationState,
  operation: MapCapabilityOperation,
  restore: Restore
): Promise<void> {
  await writeMapCapabilityOperation(state, operation, restore);
  const legacy = restore(state.get<unknown>(LEGACY_MAP_CAPABILITY_OPERATION_KEY));
  if (legacy?.id === operation.id) await state.update(LEGACY_MAP_CAPABILITY_OPERATION_KEY, undefined);
}
