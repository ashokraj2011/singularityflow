import type {SourceDescriptor,SourceSnapshot} from './source.mjs';
import type {JsonValue} from './namespace.mjs';
export declare const SOURCE_CONTROL_READER_CONTRACT:'sflow-source-control-reader/v1';
export declare const SOURCE_CONTROL_OBSERVATION_FORMAT:'sflow-source-control-observation/v1';
export declare const SOURCE_CONTROL_LIMITS:Readonly<{maximumChanges:100000;maximumManifestBytes:33554432;maximumDurationMs:300000}>;
export interface SourceControlSubject {readonly workId:string;readonly phase:string;readonly generation:number;readonly generationIntentId:string|null}
export interface SourceControlReaderDescriptor {readonly contract:typeof SOURCE_CONTROL_READER_CONTRACT;readonly id:string;
  readonly source:SourceDescriptor;readonly profile:string;readonly baselineRevision:string;readonly executableSha256:string;readonly environmentSha256:string;
  readonly limits:{readonly maximumChanges:number;readonly maximumManifestBytes:number;readonly maximumDurationMs:number}}
export interface SourceControlObservation {readonly schemaVersion:1;readonly format:typeof SOURCE_CONTROL_OBSERVATION_FORMAT;readonly readerId:string;readonly profile:string;
  readonly subject:SourceControlSubject;readonly current:{readonly snapshot:SourceSnapshot;readonly revision:string};
  readonly baseline:{readonly revision:string;readonly entries:SourceSnapshot['entries']};readonly control:JsonValue}
export interface SourceControlReader {readonly descriptor:SourceControlReaderDescriptor;
  capture(subject:SourceControlSubject,options?:{readonly signal?:AbortSignal|null}):Promise<{readonly observation:SourceControlObservation;readonly revision:string;
    readonly metrics?:{readonly gitCalls:number;readonly baselineCacheReused:boolean;readonly elapsedMs:number}}>}
export declare function sourceControlReaderDescriptor(value:unknown):SourceControlReaderDescriptor;
export declare function validateSourceControlReader(value:unknown):SourceControlReaderDescriptor;
export declare function sourceControlCaptureRequest(value:unknown):SourceControlSubject;
export declare function sourceControlObservation(value:unknown,descriptor:SourceControlReaderDescriptor,subject:SourceControlSubject):SourceControlObservation;
