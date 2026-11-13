import type {JsonValue} from './namespace.mjs';
import type {SpecificationDigests} from './specifications.mjs';
export declare const APPLICATION_REVIEW_VALUES_PROFILE:'sflow-application-review-values/v1';
export declare const ARA_VERSION:1,ARA_NAMESPACE:'ARA';
export declare const ARA_SURFACES:readonly ApplicationReviewSurface[],ARA_ACTIONS:readonly string[],ARA_READS:readonly string[];
export declare function reviewRelativePath(value:string,label?:string):string;
export type ApplicationReviewSurface='auto'|'web'|'backend'|'cli'|'library'|'artifact';
export type ReviewDigest=`sha256:${string}`;
export interface ApplicationReviewRecordBytes {readonly profile:'sflow-record-bytes/utf8-v1';isBytes(value:unknown):boolean;decodeUtf8(value:unknown):string}
export interface ApplicationReviewPolicy {readonly schemaVersion:1;readonly mode:'off'|'optional'|'required';readonly surface:ApplicationReviewSurface;
  readonly preview:{readonly entry:string|null;readonly outputDirectory:string}|null;readonly authorities?:readonly string[];
  readonly repairAttempts:number;readonly totalRepairAttempts:number;readonly quality:readonly string[];
  readonly capture:{readonly maximumPages:number;readonly casesPerPage:number;readonly maximumBytes:number;readonly timeoutMs:number;
    readonly viewport:{readonly width:number;readonly height:number}}}
export interface ApplicationReviewSubject {readonly kind:'story-phase';readonly workId:string;readonly phaseId:string;readonly generation:number}
export type ApplicationReviewEventType='target-preparing'|'target-blocked'|'target-ready'|'feedback-recorded'|'repair-prepared'
  |'finding-repair-requested'|'repair-observed'|'finding-rechecked'|'finding-dispositioned'|'review-confirmed'|'capture-started'
  |'capture-blocked'|'acceptance-blocked'|'capture-admitted'|'acceptance-finalized'|'review-stale'|'review-deferred'|'review-cancelled';
export interface ApplicationReviewEvent {readonly schemaVersion:1;readonly kind:'application-review-event';readonly sessionId:string;
  readonly subject:ApplicationReviewSubject;readonly revision:number;readonly previous:ReviewDigest|null;readonly actionId:string;
  readonly requestSha256:ReviewDigest;readonly type:ApplicationReviewEventType;readonly payload:Readonly<Record<string,JsonValue>>;
  readonly actor:Readonly<Record<string,JsonValue>>;readonly at:string;readonly digest:ReviewDigest}
/** Value mutation is explicit and local; appending an event does not persist or authenticate it. */
export interface ApplicationReviewSession {schemaVersion:1;kind:'application-review-session';id:string;subject:ApplicationReviewSubject;
  policy:ApplicationReviewPolicy;revision:number;events:ApplicationReviewEvent[]}
export interface ApplicationReviewFinding {readonly id:string;readonly duplicateOf?:string|null;readonly state?:string;readonly [key:string]:unknown}
export interface ApplicationReviewView {readonly id:string;readonly subject:ApplicationReviewSubject;readonly revision:number;readonly state:string;
  readonly target:Readonly<Record<string,unknown>>|null;readonly findings:readonly ApplicationReviewFinding[];
  readonly repairAttempts:readonly Readonly<{rootFindingId:string;[key:string]:unknown}>[];readonly [key:string]:unknown}
/** Already admitted observations. These booleans grant no execution, image, identity or approval authority. */
export interface ApplicationReviewObservationFacts {readonly targetCurrent:boolean;readonly evidenceAvailable:boolean;readonly decisionsCurrent?:boolean}
export interface ApplicationReviewCompletion {readonly applicabilityResolved:boolean;readonly targetCurrent:boolean;readonly coverageSatisfied:boolean;
  readonly findingsDisposed:boolean;readonly requiredDecisionsSatisfied:boolean;readonly evidenceAdmitted:boolean;readonly reviewSatisfied:boolean}
export interface ApplicationReviewReport {readonly pages:readonly Readonly<Record<string,unknown>>[];readonly complete:boolean;readonly requiredPages:number;
  readonly omittedPages:number;readonly missingCases:number;readonly cases:number}
export interface ApplicationReviewValues {
  readonly profile:typeof APPLICATION_REVIEW_VALUES_PROFILE;
  normalizeApplicationReview(value:unknown):ApplicationReviewPolicy|null;
  reviewDigest(value:unknown):ReviewDigest;
  applicationReviewPolicy(workflow:Readonly<Record<string,unknown>>):ApplicationReviewPolicy|null;
  reviewSubject(workflow:Readonly<Record<string,unknown>>,phaseId?:string|null):ApplicationReviewSubject;
  reviewApplicability(policy:ApplicationReviewPolicy|null,paths:readonly string[]):Readonly<{resolved:boolean;surface:ApplicationReviewSurface;reason:string;
    dimensions:Readonly<{visual:'pending'|'not-applicable';functional:'pending'}>}>;
  newReviewSession(input:{readonly id:string;readonly subject:ApplicationReviewSubject;readonly policy:ApplicationReviewPolicy}):ApplicationReviewSession;
  appendReviewEvent(session:ApplicationReviewSession,input:{readonly actionId:string;readonly expectedRevision:number;readonly type:ApplicationReviewEventType;
    readonly payload?:Readonly<Record<string,JsonValue>>;readonly actor:Readonly<Record<string,JsonValue>>;readonly at:string}):Readonly<{event:ApplicationReviewEvent;replay:boolean}>;
  validateReviewSession(session:unknown):ApplicationReviewSession;
  projectReview(session:ApplicationReviewSession):ApplicationReviewView;
  findingRoot(findings:readonly ApplicationReviewFinding[],id:string):ApplicationReviewFinding;
  findingRepairAttempts(view:Pick<ApplicationReviewView,'findings'|'repairAttempts'>,findingId:string):ApplicationReviewView['repairAttempts'];
  reviewCompletion(view:ApplicationReviewView,facts:ApplicationReviewObservationFacts):ApplicationReviewCompletion;
  assertCanConfirm(view:ApplicationReviewView,facts:{readonly targetCurrent:boolean;readonly dimensions:readonly string[];readonly coverage:readonly string[];readonly testsReady:boolean}):void;
  reviewReportPages(results:{readonly attempts:readonly Readonly<Record<string,unknown>>[]},limits:Pick<ApplicationReviewPolicy['capture'],'maximumPages'|'casesPerPage'>):ApplicationReviewReport;
  validateReviewCaptureSet<T extends Readonly<Record<string,unknown>>>(view:ApplicationReviewView,receipts:readonly T[],policy:ApplicationReviewPolicy):readonly T[];
}
export declare function applicationReviewPolicies(recordBytes:ApplicationReviewRecordBytes,digests:SpecificationDigests):Readonly<ApplicationReviewValues>;
