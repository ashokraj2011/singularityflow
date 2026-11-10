import type {JsonValue} from './namespace.mjs';
import type {SpecificationDigests,SpecificationClause} from './specifications.mjs';
export type ScopeDisposition='included'|'existing'|'excluded'|'deferred'|'informative'|'duplicate'|'superseded';
export declare const DECIDABLE_SCOPE_DISPOSITIONS:readonly ScopeDisposition[];
export declare const CLAUSE_LINKED_DISPOSITIONS:readonly ('included'|'existing')[];
export declare const SCOPE_INVENTORY_VERSION:'scope-inventory/v1';
export declare const SCOPE_DISPOSITIONS:readonly (ScopeDisposition|'unresolved')[];
export interface ScopeStatement {readonly sourceId:string;readonly line:number|null;readonly field?:string;
  readonly text:string;readonly statementSha256:string;readonly signal:'modal'|'structured'|'scenario'}
export interface ScopeStatementValues {
  normalizeStatement(value:unknown):string;statementSha256(value:unknown):string;scopeItemId(sourceId:string,text:unknown):string;
  clauseScopeItems(text:unknown):string[];extractNormativeStatements(text:string,options:{readonly sourceId:string}):ScopeStatement[];
  storySourceStatements(source:unknown,options?:{readonly sourceId?:string}):ScopeStatement[];
}
export declare function scopeStatementPolicies(digests:SpecificationDigests):Readonly<ScopeStatementValues>;
export interface ScopeDecision {readonly item:string;readonly disposition:ScopeDisposition;readonly clauseIds:readonly string[];
  readonly reason:string;readonly statementSha256:string|null;readonly actor:string;readonly authorityGroup:string;
  readonly identityAssurance:JsonValue;readonly at:string;readonly withdrawnAt?:string}
export interface ScopeSource {readonly id:string;readonly kind:string;readonly sha256:string|null;readonly readable:boolean;
  readonly statements:readonly ScopeStatement[];readonly name?:string;readonly path?:string|null;readonly reason?:string}
export interface ScopeItem {readonly id:string;readonly kind:'statement'|'source';readonly sourceId:string;readonly line:number|null;
  readonly text:string;readonly statementSha256:string|null;readonly disposition:ScopeDisposition|'unresolved';readonly clauseIds:readonly string[];
  readonly decision:ScopeDecision|null;readonly duplicateOf?:string;readonly staleDecision?:boolean;readonly coveredBy?:string}
export interface ScopeInventory {readonly schema:typeof SCOPE_INVENTORY_VERSION;readonly workId:string;readonly sourceSetSha256:string;
  readonly inventorySha256:string;readonly structurallyComplete:boolean;readonly items:readonly ScopeItem[];
  readonly sources:readonly (Omit<ScopeSource,'statements'>&{readonly statements:number})[];
  readonly summary:Readonly<Record<ScopeDisposition|'unresolved',number>>}
export declare function scopeInventoryPolicies(digests:SpecificationDigests):Readonly<{
  buildScopeInventoryValue(workflow:unknown,input:{readonly sources:readonly ScopeSource[];readonly clauses:readonly Pick<SpecificationClause,'id'|'body'>[];
    readonly decisions?:readonly ScopeDecision[];readonly scopeNotApplicable?:boolean}):ScopeInventory;
}>;
export interface ScopeChecklist {readonly id:string;readonly version:number;readonly articles:readonly {readonly id:string;readonly title?:string;readonly question?:string}[]}
export interface ScopeDecisionValues {
  recordScopeDecision(workflow:unknown,input:{readonly item:string;readonly disposition:ScopeDisposition;readonly clauseIds?:readonly string[];
    readonly reason:string;readonly actor:string;readonly authorityGroup:string;readonly identityAssurance?:JsonValue;readonly at:string;
    readonly inventory:ScopeInventory;readonly knownClauseIds:readonly string[]}):ScopeDecision;
  recordCompletenessReview(workflow:unknown,input:{readonly inventory:ScopeInventory;readonly confirm:string;readonly checklist?:readonly JsonValue[];
    readonly reason:string;readonly actor:string;readonly authorityGroup:string;readonly identityAssurance?:JsonValue;readonly at:string}):Readonly<Record<string,JsonValue>>;
}
/** Value functions preserve legacy mutation semantics; they do not authenticate the supplied human. */
export declare function scopeDecisionPolicies(options:{readonly checklist:ScopeChecklist;
  readonly validateChecklistDecisions:(decisions:readonly JsonValue[],options:{readonly checklist:ScopeChecklist;readonly mode:'enforce'})=>{readonly errors:readonly string[]}}):Readonly<ScopeDecisionValues>;
export declare function scopeAuthorities(workflow:unknown):string[];
export declare function endpointTaken(workflow:unknown):JsonValue;
export declare function omissionAuthorities(workflow:unknown,responsibility:string):string[];
export declare function recordApplicabilityDecision(workflow:unknown,input:{readonly responsibility:string;readonly reason:string;readonly actor:string;
  readonly authorityGroup:string;readonly identityAssurance?:JsonValue;readonly at:string}):Readonly<Record<string,JsonValue>>;
