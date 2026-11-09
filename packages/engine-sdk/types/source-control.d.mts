import type {SourceDescriptor,SourceSnapshot} from './source.mjs';
import type {JsonValue} from './namespace.mjs';
export declare const SOURCE_CONTROL_READER_CONTRACT:'sflow-source-control-reader/v1';
export declare const SOURCE_CONTROL_OBSERVATION_FORMAT:'sflow-source-control-observation/v1';
export declare const SOURCE_CONTROL_READER_CONTRACT_V2:'sflow-source-control-reader/v2';
export declare const SOURCE_CONTROL_OBSERVATION_FORMAT_V2:'sflow-source-control-observation/v2';
export declare const SOURCE_CONTROL_LIMITS:Readonly<{maximumChanges:100000;maximumManifestBytes:33554432;maximumDurationMs:300000}>;
export interface SourceControlSubject {readonly workId:string;readonly phase:string;readonly generation:number;readonly generationIntentId:string|null}
export interface SourceControlReaderDescriptorV1 {readonly contract:typeof SOURCE_CONTROL_READER_CONTRACT;readonly id:string;
  readonly source:SourceDescriptor;readonly profile:string;readonly baselineRevision:string;readonly executableSha256:string;readonly environmentSha256:string;
  readonly limits:{readonly maximumChanges:number;readonly maximumManifestBytes:number;readonly maximumDurationMs:number}}
export interface SourceControlReaderDescriptorV2 extends Omit<SourceControlReaderDescriptorV1,'contract'> {
  readonly contract:typeof SOURCE_CONTROL_READER_CONTRACT_V2;readonly originRevision:string}
export type SourceControlReaderDescriptor=SourceControlReaderDescriptorV1|SourceControlReaderDescriptorV2;
export interface SourceControlObservationV1 {readonly schemaVersion:1;readonly format:typeof SOURCE_CONTROL_OBSERVATION_FORMAT;readonly readerId:string;readonly profile:string;
  readonly subject:SourceControlSubject;readonly current:{readonly snapshot:SourceSnapshot;readonly revision:string};
  readonly baseline:{readonly revision:string;readonly entries:SourceSnapshot['entries']};readonly control:JsonValue}
export interface SourceOriginPatch {readonly oldPath:string|null;readonly newPath:string|null;
  readonly hunks:readonly {readonly beforeStart:number;readonly beforeLines:number;readonly afterStart:number;readonly afterLines:number}[]}
export interface SourceControlObservationV2 extends Omit<SourceControlObservationV1,'schemaVersion'|'format'> {
  readonly schemaVersion:2;readonly format:typeof SOURCE_CONTROL_OBSERVATION_FORMAT_V2;
  readonly origin:{readonly revision:string;readonly entries:SourceSnapshot['entries'];readonly patch:readonly SourceOriginPatch[];readonly trackedPaths:readonly string[]}}
export type SourceControlObservation=SourceControlObservationV1|SourceControlObservationV2;
export interface SourceControlReader<D extends SourceControlReaderDescriptor=SourceControlReaderDescriptor> {readonly descriptor:D;
  capture(subject:SourceControlSubject,options?:{readonly signal?:AbortSignal|null}):Promise<{readonly observation:D extends SourceControlReaderDescriptorV2?SourceControlObservationV2:SourceControlObservationV1;readonly revision:string;
    readonly metrics?:{readonly gitCalls:number;readonly baselineCacheReused:boolean;readonly elapsedMs:number}}>}
export declare function sourceControlReaderDescriptor(value:SourceControlReaderDescriptorV1):SourceControlReaderDescriptorV1;
export declare function sourceControlReaderDescriptor(value:SourceControlReaderDescriptorV2):SourceControlReaderDescriptorV2;
export declare function sourceControlReaderDescriptor(value:unknown):SourceControlReaderDescriptor;
export declare function validateSourceControlReader<D extends SourceControlReaderDescriptor>(value:SourceControlReader<D>):D;
export declare function validateSourceControlReader(value:unknown):SourceControlReaderDescriptor;
export declare function sourceControlCaptureRequest(value:unknown):SourceControlSubject;
export declare function sourceControlObservation(value:unknown,descriptor:SourceControlReaderDescriptorV1,subject:SourceControlSubject):SourceControlObservationV1;
export declare function sourceControlObservation(value:unknown,descriptor:SourceControlReaderDescriptorV2,subject:SourceControlSubject):SourceControlObservationV2;
export declare function sourceControlObservation(value:unknown,descriptor:SourceControlReaderDescriptor,subject:SourceControlSubject):SourceControlObservation;
