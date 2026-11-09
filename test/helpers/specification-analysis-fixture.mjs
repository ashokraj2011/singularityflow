/** Input data for the independent native analysis capture; no copied analyzer implementation. */
export function specificationAnalysisCases() {
  const spec='# Specification\n\n## Actors\n\nAn operator.\n\n## User scenarios\n\n### S1 — Convert\n\nGiven 255 When conversion is requested Then FF is displayed.\n\n## Requirements\n\n[APP:REQ-001] Convert the supplied integer.\n\n[APP:AC-001] The hexadecimal output is observable.\n';
  const witnessed='# Specification\n\n## Actors\n\nAn operator.\n\n## User scenarios\n\nConversion.\n\n## Requirements\n\n### [APP:AC-001]\n\n- Behavior: Convert the supplied value.\n- Observable: The returned value equals FF.\n- Witness: test\n';
  const marker={question:'Who may retry?',questionHash:'Who may retry?',line:4};
  const texts=[['ordinary',spec],['empty',''],['bom','\ufeff'+spec],['crlf',spec.replaceAll('\n','\r\n')],
    ['missing-headings','[APP:REQ-001] Convert the supplied integer.'],['duplicate',spec+'\n[APP:REQ-001] Another declaration.'],
    ['duplicate-text',spec.replace('The hexadecimal output is observable.','Convert the supplied integer.')],
    ['wrong-namespace',spec.replaceAll('APP:','OTHER:')],['dependency',spec+'\n[APP:REQ-003] Requires APP:REQ-999.'],
    ['marker',spec+'\n[NEEDS CLARIFICATION: Who may retry?]'],['malformed-marker',spec+'\n[NEEDS CLARIFICATION: ]\n[NEEDS CLARIFICATION: unclosed'],
    ['examples',spec+'\n```md\n[NEEDS CLARIFICATION: Ignore this?]\n[APP:REQ-999] Example.\n```\n'],
    ['loose-heading',spec.replace('## Actors','## 1. **Actors:**')],['failure-hint',spec.replace('Convert the supplied integer.','Reject negative values and show an error.')],
    ['scenario-matrix',spec+'\n## Scenario coverage\n\n| Clause | Scenario | Outcome |\n| --- | --- | --- |\n| APP:REQ-001 | S1 | success |\n| APP:AC-001 | S1 | success |\n'],
    ['bad-scenario',spec.replace('Then FF is displayed.','Then')+'\n## Scenario coverage\n\n| Clause | Scenario | Outcome |\n| --- | --- | --- |\n| APP:REQ-001 | S1 | success |\n'],
    ['witnessed',witnessed],['bad-witness',witnessed.replace('Witness: test','Witness: security-scan')],
    ['unicode-fields',witnessed.replace('Convert the supplied value.','Convert é and 漢字 without losing bytes.')]];
  const cases=[];
  for(const [name,text]of texts)for(const mode of ['off','warn','enforce'])cases.push({id:name+'-'+mode,method:'analyzeSpecification',args:[text,
    {artifactPath:'artifacts/requirements/spec.md',phase:'requirements',generation:2,namespace:'APP',policy:{mode,...(name.includes('witness')||name==='unicode-fields'?{witnessedClauses:{profile:'witnessed-v1'}}:{})}}]});
  for(const [name,options]of [
    ['required-scenarios',{policy:{mode:'enforce',scenarioCoverage:'required'}}],
    ['removed-marker',{previousMarkers:[marker]}],['answered-marker',{previousMarkers:[marker],answers:[{questionHash:marker.questionHash}]}],
    ['bounded-findings',{limits:{maxFacts:1}}],['oversized-input',{limits:{maxArtifactBytes:8}}],
    ['bad-policy',{policy:{mode:'unknown'}}],['small-witness-report',{policy:{mode:'enforce',witnessedClauses:{profile:'witnessed-v1',limits:{maxReportBytes:512}}}}]
  ])cases.push({id:name,method:'analyzeSpecification',args:[name.includes('witness')?witnessed:spec,{phase:'requirements',generation:2,namespace:'APP',policy:{mode:'enforce'},...options}]});
  for(const [name,text,options]of [['markers','[NEEDS CLARIFICATION:   Who may\tretry? ]'],['empty','[NEEDS CLARIFICATION: ]'],
    ['masked','<!-- [NEEDS CLARIFICATION: hidden] -->\n`[NEEDS CLARIFICATION: inline]`'],['long','[NEEDS CLARIFICATION: '+('x'.repeat(301))+']'],
    ['bad-type',42],['tiny-limit','[NEEDS CLARIFICATION: Who may retry?]',{limits:{maxQuestionChars:5,maxMarkersPerArtifact:1}}]]) {
    cases.push({id:'extract-'+name,method:'extractMarkers',args:[text,...(options?[options]:[])]});
  }
  for(const [name,value]of [['vanished',{previous:[marker]}],['answered',{previous:[marker],answers:[marker]}],
    ['still-open',{current:[marker],previous:[marker],answers:[marker]}],['reflow',{current:[{...marker,line:90}],previous:[marker]}]]) {
    cases.push({id:'reconcile-'+name,method:'reconcileMarkers',args:[value]});
  }
  for(const mode of ['off','warn','block'])cases.push({id:'marker-policy-'+mode,method:'evaluateMarkerPolicy',args:[{mode},{open:[marker],malformed:[{line:5,reason:'not closed'}],vanished:[marker]}]});
  for(const decisions of [[],[{article:'completeness',decision:'satisfied'}],[{article:'completeness',decision:'exception',reason:'Known bounded omission.'}],
    [{article:'completeness',decision:'not-applicable'}],[{article:'completeness',decision:'invalid'}]])for(const mode of ['off','warn','enforce'])cases.push({
      id:'checklist-'+cases.length,method:'validateChecklistDecisions',args:[decisions,{mode}]});
  cases.push({id:'policy-hash',method:'policyHash',args:[{mode:'enforce'}]},
    {id:'review-fields',method:'witnessedClauseReviewFields',args:['Behavior: Return é.\nObservable: HTTP 200.\nWitness: test']});
  return cases;
}
