import type {ContentReference} from './content.mjs';
import type {VerificationPathSyntax,SpecificationTextValues} from './specifications.mjs';
export declare const CONVERGENCE_VALUES_PROFILE:'sflow-convergence-values/v1';
export declare const NAMESPACE_CONVERGENCE_VALUES_PROFILE:'sflow-namespace-convergence-values/v1';
export declare const NAMESPACE_CONVERGENCE_PROFILE:'sflow-namespace-convergence-projection/v1';
export declare const NAMESPACE_CONVERGENCE_SOURCE_PROFILE:'sflow-namespace-convergence-source/v1';
export type ConvergenceDisposition='rework'|'accepted-deviation'|'dismissed'|'deferred'|'update-intent';
export declare const DISPOSITIONS:readonly ConvergenceDisposition[];
export declare const FACT_KINDS:readonly string[];
export declare const FINDING_CLASSIFICATIONS:readonly ('missing'|'partial'|'contradicts'|'unplanned')[];
export interface ConvergenceFact {readonly id:string;readonly kind:string;readonly clauseIds:readonly string[];readonly paths:readonly string[];
  readonly evidence:readonly unknown[];readonly detail:string;readonly repositoryId?:string;readonly originalId?:string;readonly settledBy?:Readonly<Record<string,unknown>>}
export interface ConvergenceAdjudication {readonly itemId:string;readonly disposition:ConvergenceDisposition;readonly reason?:string;
  readonly clauseIds?:readonly string[];readonly actor:string;readonly at:string;readonly replaced?:readonly ConvergenceAdjudication[];readonly presence?:unknown}
export interface ConvergenceFinding {readonly id:string;readonly itemId:string;readonly disposition:ConvergenceDisposition;
  readonly decision:Readonly<Record<string,unknown>>;readonly [key:string]:unknown}
export interface ConvergenceProjection {readonly schemaVersion:number;readonly resultType:'convergence';readonly workId:string;readonly iteration:number;
  readonly bindings:Readonly<Record<string,unknown>>&{readonly iteration:number};readonly facts:readonly ConvergenceFact[];
  readonly settledByPlan?:readonly ConvergenceFact[];readonly findings:readonly ConvergenceFinding[];readonly convergenceSha256:string;
  readonly unresolvedBlockers:readonly string[];readonly allowedNext:readonly string[];readonly [key:string]:unknown}
export interface ConvergenceValues {
  itemId(prefix:string,payload:unknown):string;
  convergenceFacts(input:Readonly<Record<string,unknown>>):ConvergenceFact[];
  convergenceBindings(input:Readonly<Record<string,unknown>>):ConvergenceProjection['bindings'];
  validateAdjudication(value:ConvergenceAdjudication,options?:{readonly facts?:readonly ConvergenceFact[];readonly candidates?:readonly unknown[]}):ConvergenceAdjudication;
  replacedAnswers(value:ConvergenceAdjudication):ConvergenceAdjudication[];
  findingAdjudication(value:ConvergenceFinding):ConvergenceAdjudication;
  convergenceProjection(input:{readonly workId:string;readonly bindings:ConvergenceProjection['bindings'];readonly facts?:readonly ConvergenceFact[];
    readonly settledByPlan?:readonly ConvergenceFact[]|null;readonly adjudications?:readonly ConvergenceAdjudication[];
    readonly candidates?:readonly unknown[];readonly candidateRecords?:readonly string[];readonly candidateRecordBindings?:readonly unknown[];readonly legacyMigration?:unknown}):ConvergenceProjection;
  adjudicatedConvergenceProjection(value:ConvergenceProjection,adjudications:readonly ConvergenceAdjudication[]):ConvergenceProjection;
  assertConvergenceIntegrity(value:ConvergenceProjection,options?:Readonly<Record<string,unknown>>):ConvergenceProjection;
  assertConvergenceCandidateSource(source:unknown,value:ConvergenceProjection,options?:{readonly path?:string|null}):unknown;
  renderConvergenceArtifact(value:ConvergenceProjection):string;
  assertConvergencePublishable(value:ConvergenceProjection,body:string):unknown;
  serializeConvergence(value:ConvergenceProjection):string;
  planAccountsFromEntries(entries:readonly Readonly<Record<string,unknown>>[],options?:{readonly keptByPerson?:Set<string>|null}):(finding:Readonly<Record<string,unknown>>)=>Readonly<Record<string,unknown>>|null;
  settleChangedPaths(facts:readonly ConvergenceFact[],options:{readonly reconciliation:Readonly<Record<string,unknown>>;
    readonly planAccount:(finding:Readonly<Record<string,unknown>>)=>Readonly<Record<string,unknown>>|null}):{facts:ConvergenceFact[];settled:ConvergenceFact[]};
}
export declare function convergenceValuePolicies(paths:VerificationPathSyntax,text:SpecificationTextValues,options?:{
  readonly schemaVersion?:1|2|3|4|5|6;readonly profile?:typeof CONVERGENCE_VALUES_PROFILE|typeof NAMESPACE_CONVERGENCE_VALUES_PROFILE}):Readonly<ConvergenceValues>;
export interface NamespaceConvergenceProjection {readonly schemaVersion:1;readonly profile:typeof NAMESPACE_CONVERGENCE_PROFILE;
  readonly valueProfile:typeof NAMESPACE_CONVERGENCE_VALUES_PROFILE;readonly projectId:string;readonly workId:string;readonly phase:string;
  readonly generation:number;readonly iteration:number;readonly source:Readonly<Record<string,unknown>>;readonly sourceSha256:string;readonly projection:ConvergenceProjection}
export interface NamespaceConvergenceValues {
  readonly values:Readonly<ConvergenceValues>;
  project(input:{readonly projectId:string;readonly workId:string;readonly phase:string;readonly generation:number;readonly configuration:unknown;
    readonly inputs:readonly unknown[];readonly indexes:readonly unknown[];readonly repositories:readonly unknown[];readonly adjudications?:readonly ConvergenceAdjudication[];
    readonly limits?:Readonly<Record<string,number>>}):NamespaceConvergenceProjection;
  assert(value:NamespaceConvergenceProjection):NamespaceConvergenceProjection;
  render(value:NamespaceConvergenceProjection):string;
  publishable(value:NamespaceConvergenceProjection,body:string):NamespaceConvergenceProjection;
  advancement(value:NamespaceConvergenceProjection,publication:{readonly schemaVersion:1;readonly format:'sflow-phase-publication-binding/v1';readonly generation:number;readonly record:ContentReference}):Readonly<Record<string,unknown>>&{readonly confirmationDigest:string};
  hash(value:unknown):string;
}
export declare function namespaceConvergencePolicies(paths:VerificationPathSyntax,text:SpecificationTextValues):Readonly<NamespaceConvergenceValues>;
