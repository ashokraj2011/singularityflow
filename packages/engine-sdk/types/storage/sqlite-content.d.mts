import type { NamespaceBinding } from '../namespace.mjs';
import type { ContentStore } from '../content.mjs';
/** A trusted application-owned connection. The application closes it and sets bounded busy policy. */
export interface ContentDatabase { exec(sql: string): unknown; prepare(sql: string): unknown }
export declare function createSqliteContentStore(options: { database: ContentDatabase; binding: NamespaceBinding;
  create?: boolean; maximumBytes?: number }): ContentStore;
