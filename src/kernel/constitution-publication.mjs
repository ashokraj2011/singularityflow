/** Namespace constitution proof values. Immutable configuration references replace Git commit fields. */
import {canonicalJson,textDigestCapability,NAMESPACE_PHASE_POLICY_SCHEMAS} from '../foundation/record-schema.mjs';
export const CONSTITUTION_POLICY_EVIDENCE='constitution-policy/v1';
export function constitutionPublicationPolicies(values,digestPort){
  const digests=textDigestCapability(digestPort),hash=value=>digests.sha256Utf8(canonicalJson(value));
  function observation({resolution,configuration,document=null,artifact=null}){
    const policy=resolution.constitution??{mode:'off'},mode=policy.mode,findings=[],warnings=[],errors=[];
    let parsed=null,pin=null,citations={cited:[],errors:[],warnings:[]};
    if(mode!=='off'){
      if(!document){(mode==='enforce'?errors:warnings).push(`The pinned constitution is unavailable at ${policy.path}.`);}
      else{
        parsed=values.parseConstitution(document.markdown,{resolution,allowExample:false});findings.push(...parsed.findings);
        const integrity=parsed.findings.filter(row=>['hand-edited','stale-policy','judged-prose-changed','unresolved-policy'].includes(row.kind));
        if(mode==='enforce')errors.push(...integrity.map(row=>row.message));
        warnings.push(...parsed.findings.map(row=>row.message));
        const articles=parsed.articles.map(row=>({...row,articleSha256:row.articleSha256??values.articleHash(row,row.prose)}));
        pin={profile:'sflow-namespace-constitution-pin/v1',source:{path:policy.path,content:document.content},configuration,
          policyResolutionSha256:hash(resolution),rendererVersion:values.RENDERER_VERSION,articles};
      }
      if(artifact){citations=values.validateCitations(pin,values.citedArticleIds(artifact.text??''),{label:artifact.key});
        (mode==='enforce'?errors:warnings).push(...citations.errors);warnings.push(...citations.warnings);}
    }
    return {schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.constitutionReport.currentVersion,format:'sflow-namespace-constitution-policy-report/v1',
      mode,path:policy.path??null,pin,artifact:artifact?{key:artifact.key,content:artifact.content}:null,
      citations,requiredArticles:values.requiredArticles(pin,citations.cited),findings,errors,warnings,
      judgment:{performed:false,owner:'phase-approval'}};
  }
  return Object.freeze({observation});
}
