import type {JsonValue} from './namespace.mjs';
import type {SpecificationDigests} from './specifications.mjs';
export declare const CONSTITUTION_SYNTAX_PROFILE:'sflow-constitution-yaml-syntax/v1';
export declare const CONSTITUTION_RECORD_SCHEMA:Readonly<{id:'constitution-record';currentVersion:1;minimumReadableVersion:1;maximumReadableVersion:1;immutable:true;unversionedAs:null}>;
export interface ConstitutionSyntax {readonly profile:typeof CONSTITUTION_SYNTAX_PROFILE;parse(source:string):unknown}
export type ConstitutionArticle=Readonly<{id:string;type:'enforced'|'judged';status:'active'|'withdrawn';policy?:string;policyValueSha256?:string|null;
  rendererVersion?:number;articleSha256?:string|null;level?:'must'|'should';evidenceRequired?:boolean;withdrawnBy?:string;title?:string|null;prose?:string;valid?:boolean}>;
export interface ConstitutionFinding {readonly id:string;readonly kind:string;readonly message:string}
export interface ConstitutionPin {readonly path:string;readonly fileSha256:string;readonly indexSha256:string;readonly configurationCommit:string|null;
  readonly policyResolutionSha256:string|null;readonly rendererVersion:number;readonly articles:readonly ConstitutionArticle[]}
export interface ConstitutionValues {
  readonly RENDERER_VERSION:1;readonly ARTICLE_TYPES:readonly ('enforced'|'judged')[];readonly ARTICLE_LEVELS:readonly ('must'|'should')[];
  normalizeArticle(value:unknown,index:number):ConstitutionArticle;
  policyValue(resolution:unknown,policyPath:string):unknown;
  renderEnforcedArticle(value:{policy:string;value:unknown;rendererVersion?:number}):string;
  articleHash(article:ConstitutionArticle,prose:string):string;
  articleSections(body:string):Map<string,{id:string;title:string;prose:string}>;
  generatedProse(prose:string,id:string):string|null;
  parseConstitution(markdown:string,options?:{resolution?:unknown;allowExample?:boolean}):{articles:ConstitutionArticle[];findings:ConstitutionFinding[]};
  constitutionIndex(input:{articles:readonly ConstitutionArticle[];path:string;fileSha256:string;configurationCommit?:string|null;resolution?:unknown}):Readonly<Record<string,JsonValue>>&{readonly indexSha256:string;readonly articles:readonly ConstitutionArticle[]};
  generationPlan(markdown:string,resolution:unknown):{frontMatter:string;declaration:Readonly<Record<string,JsonValue>>;body:string;regenerated:string[];articles:ConstitutionArticle[]};
  constitutionPin(input:{constitution:({path:string;fileSha256:string;articles?:readonly ConstitutionArticle[]})|null;index:{indexSha256:string;articles:readonly ConstitutionArticle[]};configurationCommit?:string|null;resolution?:unknown}):ConstitutionPin|null;
  citedArticleIds(markdown:string):string[];
  validateCitations(pin:ConstitutionPin|null,citedIds:readonly string[],options?:{label?:string}):{cited:string[];errors:string[];warnings:string[]};
  requiredArticles(pin:ConstitutionPin|null,citedIds?:readonly string[]):string[];
  buildConstitutionException(input:{articleId:string;reason:string;scope:string;actor:JsonValue;authority:string;at:string;expiresAt?:string|null;workId:string;sourceCommit:string}):Readonly<Record<string,JsonValue>>;
  expiredExceptions<T extends {readonly expiresAt?:string|null}>(exceptions:readonly T[]|undefined,now:string):T[];
}
export declare function constitutionValuePolicies(digests:SpecificationDigests,syntax:Readonly<ConstitutionSyntax>,options?:{pathSeparator?:'/'|'\\'}):Readonly<ConstitutionValues>;
