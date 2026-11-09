import type {SourceDescriptor} from '../source.mjs';
import type {SourceControlReader,SourceControlReaderDescriptor,SourceControlSubject} from '../source-control.mjs';
export declare const NODE_GIT_SOURCE_CONTROL_PROFILE:'git-selected-worktree-change-set/v1';
/** Explicit local-only Git observations; no lifecycle write or implicit Git discovery. */
export declare function createNodeGitSourceControlReader(options:{readonly id:string;readonly root:string;readonly source:SourceDescriptor;readonly baselineCommit:string;
  readonly git:{readonly executable:string;readonly executableSha256:string;readonly environment?:Readonly<Record<string,string>>};readonly timeoutMs?:number;
  readonly authorizeCapture:(descriptor:SourceControlReaderDescriptor,subject:SourceControlSubject)=>boolean|string|Promise<boolean|string>;
  readonly notice?:(event:{readonly stage:string;readonly gitCalls:number;readonly baselineCacheReused:boolean})=>void}):Promise<SourceControlReader>;
