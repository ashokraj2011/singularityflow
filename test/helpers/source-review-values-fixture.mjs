/** Inputs for the independent, pre-extraction source-review value capture. */
export function sourceReviewValueCases(){return [
  ...['specification','planning'].flatMap(kind=>['ready','missing','stale','schema-missing','schema-future','schema-string','wrong-kind','self-disposition','wrong-reviewer','author-collision','mutable-reviewer','unreviewed-source','missing-rows','bad-citation','missing-clarification','blocking-finding','invalid-finding'].map(test=>({name:kind+':'+test,kind,test}))),
  {name:'specification:exclusion',kind:'specification',test:'exclusion'},
  {name:'planning:unsupported',kind:'planning',test:'unsupported'},
  {name:'specification:invalid-source',kind:'specification',test:'invalid-source'}
];}
export function sourceReviewValueInput(api,entry){
  const specification='# Specification\n## Scenarios\n### S1 — Save a draft\nGiven a draft, when saved, then it persists.\n## Requirements\nSave the draft. [VALUE:REQ-001]\nShow saved status. [VALUE:AC-001]\n',
    plan='# Plan\n| Clause | Expected paths | Planned tests |\n|---|---|---|\n| `VALUE:REQ-001` | `src/draft.mjs` | `test/draft.test.mjs` |\n| `VALUE:AC-001` | `src/draft.mjs` | `test/draft.test.mjs` |\n',
    context={kind:entry.kind,workId:'VALUE',phase:entry.kind,generation:1,sources:[{id:'story',path:'story.md',text:'# Story\nSave a draft and show saved status.\n'}],
      artifact:{path:entry.kind+'.md',text:entry.kind==='planning'?plan:specification},...(entry.kind==='planning'?{upstreamSpec:{path:'spec.md',text:specification}}:{}),
      authorAgentId:'author',reviewerAgentId:'source-reviewer',reviewerReadOnly:true},
    report={schemaVersion:1,resultType:'source-grounded-review',kind:entry.kind,binding:api.sourceReviewBinding(context),reviewer:{agentId:'source-reviewer',readOnly:true},sourcesReviewed:['story'],findings:[],
      rows:entry.kind==='planning'?['VALUE:REQ-001','VALUE:AC-001'].map(clauseId=>({clauseId,expectedPaths:['src/draft.mjs'],plannedTests:['test/draft.test.mjs'],testDisposition:'applicable',assessment:'supported'}))
        :[{id:'save-draft',sourceId:'story',line:2,quote:'Save a draft and show saved status.',outcome:'covered',scenarioId:'S1',clauseIds:['VALUE:REQ-001','VALUE:AC-001']}]};
  if(entry.test==='missing')return {report:null,context};
  if(entry.test==='stale')context.artifact.text+='Changed.';
  if(entry.test==='schema-missing')delete report.schemaVersion;
  if(entry.test==='schema-future')report.schemaVersion=2;
  if(entry.test==='schema-string')report.schemaVersion='1';
  if(entry.test==='wrong-kind')report.kind='other';
  if(entry.test==='self-disposition')report.humanDispositions=[];
  if(entry.test==='wrong-reviewer')report.reviewer.agentId='someone-else';
  if(entry.test==='author-collision')context.reviewerAgentId=context.authorAgentId;
  if(entry.test==='mutable-reviewer')context.reviewerReadOnly=false;
  if(entry.test==='unreviewed-source')report.sourcesReviewed=[];
  if(entry.test==='missing-rows')report.rows=[];
  if(entry.test==='bad-citation'){if(entry.kind==='planning')report.rows[0].expectedPaths=['src/other.mjs'];else report.rows[0].quote='Not on this line.';}
  if(entry.test==='missing-clarification'){context.clarifications=[{id:'clarification:current-phase',phase:entry.kind,generation:1,path:'answers.json',sha256:'a'.repeat(64)}];report.binding=api.sourceReviewBinding(context);}
  if(entry.test==='blocking-finding')report.findings=[{id:'gap-1',severity:'blocking',message:'The described interaction is missing.',sourceId:'story',line:2,quote:'Save a draft'}];
  if(entry.test==='invalid-finding')report.findings=[{id:'gap-1',severity:'unknown'}];
  if(entry.test==='exclusion')report.rows=[{id:'excluded',sourceId:'story',line:2,quote:'Save a draft',outcome:'excluded',reason:'Ask the scope authority.'}];
  if(entry.test==='unsupported')report.rows[0].assessment='gap';
  if(entry.test==='invalid-source')context.sources[0].sha256='f'.repeat(64);
  return {report,context};
}
export function sourceReviewValueOutcome(api,entry){try{const {report,context}=sourceReviewValueInput(api,entry);return {status:'returned',value:api.evaluateSourceGroundedReview(report,context)};}
  catch(error){return {status:'threw',name:error.name,message:error.message,code:error.code??null,details:error.details??null};}}
