export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [name: string]: JsonValue };
export type Namespace = 'config' | 'state' | 'evidence' | 'runtime' | 'local';
export interface NamespaceScope { readonly projectId: string }
export type NamespaceBinding = { readonly kind: 'shared' } | { readonly kind: 'machine-local'; readonly deviceId: string };
export interface NamespaceLimits {
  readonly maxPage: number; readonly maxChanges: number; readonly maxPreconditions: number; readonly maxEvents: number;
  readonly maxValueBytes: number; readonly maxTransactionBytes: number; readonly maxDepth: number; readonly maxNodes: number;
}
export interface NamespaceRecord {
  readonly namespace: Namespace; readonly key: string; readonly version: string; readonly immutable: boolean; readonly value: JsonValue;
}
export interface NamespaceCondition { readonly namespace: Namespace; readonly key: string; readonly version: string | null }
export type NamespaceChange = { readonly op: 'put'; readonly namespace: Namespace; readonly key: string;
  readonly value: JsonValue; readonly immutable: boolean } | { readonly op: 'delete'; readonly namespace: Namespace; readonly key: string };
export interface NamespaceEvent { readonly eventId: string; readonly eventType: string; readonly namespace: Namespace; readonly payload: JsonValue }
export interface NamespaceTransaction { readonly operationId: string; readonly preconditions: readonly NamespaceCondition[];
  readonly changes: readonly NamespaceChange[]; readonly events: readonly NamespaceEvent[] }
export interface NamespaceReceipt { readonly operationId: string; readonly scope: NamespaceScope; readonly revision: string;
  readonly requestDigest: string; readonly records: readonly NamespaceCondition[]; readonly eventIds: readonly string[] }
export interface NamespaceDescriptor { readonly id: string; readonly contract: typeof NAMESPACE_STORE_CONTRACT;
  readonly qualification: 'production' | 'test-only'; readonly binding: NamespaceBinding;
  readonly limits: NamespaceLimits; readonly capabilities: readonly string[] }
export interface NamespaceOptions { readonly signal?: AbortSignal | null }
export interface NamespaceStore {
  readonly descriptor: NamespaceDescriptor;
  read(scope: NamespaceScope, namespace: Namespace, key: string, options?: NamespaceOptions):
    Promise<{ status: 'present'; record: NamespaceRecord } | { status: 'missing'; record: null }>;
  list(scope: NamespaceScope, namespace: Namespace, query: { limit: number; prefix?: string; continuation?: string | null }, options?: NamespaceOptions):
    Promise<{ snapshot: string; entries: readonly NamespaceRecord[]; complete: boolean; continuation: string | null }>;
  transact(scope: NamespaceScope, transaction: NamespaceTransaction, options?: NamespaceOptions):
    Promise<{ status: 'committed'; replayed: boolean; receipt: NamespaceReceipt }>;
  inspectOperation(scope: NamespaceScope, operationId: string, options?: NamespaceOptions):
    Promise<{ status: 'committed'; receipt: NamespaceReceipt } | { status: 'missing'; receipt: null }>;
  verify(scope: NamespaceScope, options?: NamespaceOptions): Promise<{ valid: boolean; errors: readonly string[] }>;
}
export interface NamespaceStoreOptions { readonly binding: NamespaceBinding; readonly limits?: Partial<NamespaceLimits>;
  readonly snapshotTtlMs?: number; readonly maxConcurrencyRetries?: number }
export interface NamespaceHostPorts { readonly now?: () => number }
export declare const NAMESPACE_STORE_CONTRACT: 'sda-namespace-store/draft-1';
export declare const NAMESPACES: readonly Namespace[];
export declare const NAMESPACE_LIMITS: Readonly<NamespaceLimits>;
export declare const NAMESPACE_STORE_METHODS: readonly ['read', 'list', 'transact', 'inspectOperation', 'verify'];
export declare const NAMESPACE_STORE_CAPABILITIES: readonly string[];
export declare function namespaceScope(input: NamespaceScope): NamespaceScope;
export declare function namespaceStoreDescriptor(options: { id: string; qualification: 'production' | 'test-only';
  binding: NamespaceBinding; limits?: Partial<NamespaceLimits>; capabilities?: readonly string[] }): NamespaceDescriptor;
export declare function validateNamespaceStore<T extends NamespaceStore>(store: T): T;
export declare function namespaceTransaction(input: NamespaceTransaction, limits?: Partial<NamespaceLimits>): NamespaceTransaction;
export declare function namespaceTransactionIdentity(scope: NamespaceScope, input: NamespaceTransaction, limits?: Partial<NamespaceLimits>): string;
export declare function namespaceStoreOutcome(error: unknown): string;
