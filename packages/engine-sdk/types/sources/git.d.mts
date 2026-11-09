import type {SourceDescriptor} from '../source.mjs';
import type {SourceControlReader,SourceControlReaderDescriptor,SourceControlReaderDescriptorV1,SourceControlReaderDescriptorV2,SourceControlSubject} from '../source-control.mjs';
export declare const NODE_GIT_SOURCE_CONTROL_PROFILE:'git-selected-worktree-change-set/v1';
export declare const NODE_GIT_SOURCE_CONTROL_PROFILE_V2:'git-selected-worktree-line-origins/v2';
/** Explicit local-only Git observations; no lifecycle write or implicit Git discovery. */
export interface NodeGitSourceControlOptions<D extends SourceControlReaderDescriptor=SourceControlReaderDescriptor> {
  readonly id:string;readonly root:string;readonly source:SourceDescriptor;readonly baselineCommit:string;
  readonly git:{readonly executable:string;readonly executableSha256:string;readonly environment?:Readonly<Record<string,string>>};readonly timeoutMs?:number;
  readonly authorizeCapture:(descriptor:D,subject:SourceControlSubject)=>boolean|string|Promise<boolean|string>;
  readonly notice?:(event:{readonly stage:string;readonly gitCalls:number;readonly baselineCacheReused:boolean})=>void}
export declare function createNodeGitSourceControlReader(options:NodeGitSourceControlOptions<SourceControlReaderDescriptorV2>&{readonly originCommit:string}):Promise<SourceControlReader<SourceControlReaderDescriptorV2>>;
export declare function createNodeGitSourceControlReader(options:NodeGitSourceControlOptions<SourceControlReaderDescriptorV1>&{readonly originCommit?:undefined}):Promise<SourceControlReader<SourceControlReaderDescriptorV1>>;
export declare function createNodeGitSourceControlReader(options:NodeGitSourceControlOptions&{readonly originCommit?:string}):Promise<SourceControlReader>;
