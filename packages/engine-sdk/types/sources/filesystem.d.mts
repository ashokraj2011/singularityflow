import type { SourceUnit,SourceLimits } from '../source.mjs';
export declare function createFilesystemSourceUnit(options: { readonly root: string; readonly id: string;
  readonly projectId: string; readonly repositoryId: string; readonly excludePaths?: readonly string[];
  readonly limits?: Partial<SourceLimits> }): Promise<SourceUnit>;
