import type { SourceUnit,SourceLimits,SourceContentReader,SourceDescriptor } from '../source.mjs';
export declare function createFilesystemSourceUnit(options: { readonly root: string; readonly id: string;
  readonly projectId: string; readonly repositoryId: string; readonly excludePaths?: readonly string[];
  readonly limits?: Partial<SourceLimits> }): Promise<SourceUnit>;
export declare function createFilesystemSourceContentReader(options:{readonly root:string;readonly id:string;
  readonly source:SourceDescriptor;readonly maximumChunkBytes?:number}):Promise<SourceContentReader>;
