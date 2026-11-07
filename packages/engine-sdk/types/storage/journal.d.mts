import type { NamespaceScope, NamespaceRecord, NamespaceEvent, NamespaceReceipt, NamespaceBinding,
  NamespaceTransaction, NamespaceLimits, NamespaceOptions } from '../namespace.mjs';
export declare const NAMESPACE_JOURNAL_PORT: 'sflow-namespace-journal/v1';
export interface NamespaceState {
  readonly records: Map<string, NamespaceRecord>;
  readonly events: Map<string, NamespaceEvent & { readonly operationId: string; readonly revision: string }>;
  readonly operations: Map<string, { readonly identity: string; readonly receipt: NamespaceReceipt }>;
}
export interface NamespaceObservation { readonly scope: NamespaceScope; readonly sequence: number;
  readonly sha256: string | null; readonly state: NamespaceState }
/** A declaration is not qualification: append must provide an atomic durable CAS and original receipt. */
export interface NamespaceJournal {
  readonly contract: typeof NAMESPACE_JOURNAL_PORT;
  readonly manifest: { readonly storeId: string; readonly binding: NamespaceBinding; readonly cursorKey: string };
  read(scope: NamespaceScope, options?: { through?: number | null }): Promise<NamespaceObservation>;
  append(scope: NamespaceScope, observed: NamespaceObservation, transaction: NamespaceTransaction, options?: NamespaceOptions):
    Promise<{ accepted: false } | { accepted: true; replayed: boolean; receipt: NamespaceReceipt; state?: NamespaceState }>;
  confirm(scope: NamespaceScope): Promise<unknown>;
}
export declare function emptyNamespaceState(): NamespaceState;
export declare function applyNamespaceTransaction(state: NamespaceState, scope: NamespaceScope, input: NamespaceTransaction,
  options: { revision: string; requestDigest: string; limits?: Partial<NamespaceLimits> }):
  { state: NamespaceState; receipt: NamespaceReceipt; replayed: boolean };
