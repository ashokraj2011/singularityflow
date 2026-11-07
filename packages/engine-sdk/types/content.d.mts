import type { Namespace, NamespaceBinding, NamespaceScope } from './namespace.mjs';
export type ContentReference = Readonly<{ namespace: Namespace; sha256: string; bytes: number }>;
export interface ContentDescriptor { readonly id: string; readonly contract: typeof CONTENT_STORE_CONTRACT;
  readonly binding: NamespaceBinding; readonly maximumBytes: number }
export interface ContentStore {
  readonly descriptor: ContentDescriptor;
  put(scope: NamespaceScope, namespace: Namespace, bytes: Uint8Array, options?: { signal?: AbortSignal | null }):
    Promise<{ reference: ContentReference; reused: boolean }>;
  read(scope: NamespaceScope, reference: ContentReference, options?: { signal?: AbortSignal | null; maximumBytes?: number }):
    Promise<{ status: 'missing'; reference: ContentReference; data: null }
      | { status: 'present'; reference: ContentReference; data: Uint8Array; truncated: boolean }>;
}
export declare const CONTENT_STORE_CONTRACT: 'sda-content-store/draft-1';
export declare const CONTENT_LIMITS: Readonly<{ maximumBytes: 134217728 }>;
export declare const CONTENT_STORE_METHODS: readonly ['put', 'read'];
export declare function contentReference(value: ContentReference, maximumBytes?: number): ContentReference;
export declare function contentStoreDescriptor(value: { id: string; binding: NamespaceBinding; maximumBytes: number }): ContentDescriptor;
export declare function validateContentStore<T extends ContentStore>(store: T): T;
