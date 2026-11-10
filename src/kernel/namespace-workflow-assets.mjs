/** Inventory the declared dependency closure of an accepted namespace configuration. */
import {SingularityFlowError} from '../foundation/failures.mjs';
export function namespaceWorkflowAssetBundle(compiled,selectors){
  const ids=[...new Set(selectors.map(selector=>{
    const id=selector.startsWith('story:')?selector.slice(6):selector;
    if(!Object.hasOwn(compiled.workflows,id))throw new SingularityFlowError('The selected workflow is absent from this immutable configuration.',{
      code:'WORKFLOW_NOT_FOUND',details:{workflowId:selector}});return id;
  }))].sort(),workflows=ids.map(id=>({governs:'story',id})),resolved=ids.map(id=>compiled.workflows[id]),
    phases=new Set(resolved.flatMap(workflow=>workflow.phases.map(phase=>phase.id))),agents=new Map(),skills=new Map(),instructions=new Map(),templates=new Map(),
    indexed=new Map(compiled.agents.map(agent=>[agent.id,agent]));
  const needInstruction=id=>{const value=compiled.instructions.find(item=>item.id===id);if(!value)throw new SingularityFlowError(
    'The approved dependency closure is missing an instruction.',{code:'ENGINE_STORAGE_CORRUPT',details:{instructionId:id}});instructions.set(id,value);};
  function needSkill(id){if(skills.has(id))return;const value=compiled.skills.find(item=>item.id===id);if(!value)throw new SingularityFlowError(
    'The approved dependency closure is missing a skill.',{code:'ENGINE_STORAGE_CORRUPT',details:{skillId:id}});
    skills.set(id,value);for(const dependency of value.skills)needSkill(dependency);for(const dependency of value.instructions)needInstruction(dependency);}
  const agentIds=new Set(compiled.agents.filter(agent=>agent.phases.some(id=>phases.has(id))).map(agent=>agent.id));
  for(const workflow of resolved){if(workflow.sourceReview?.reviewerAgent)agentIds.add(workflow.sourceReview.reviewerAgent);
    for(const phase of workflow.phases){if(phase.defaultAgent)agentIds.add(phase.defaultAgent);
      const key=phase.template.startsWith('agent:')?phase.template:compiled.definition.templatesRoot+'/'+phase.template,
        template=compiled.templates.find(item=>item.path===key);
      if(!template)throw new SingularityFlowError('The approved dependency closure is missing a phase template.',{code:'ENGINE_STORAGE_CORRUPT',details:{path:key}});
      templates.set(key,template);
    }
  }
  for(const id of agentIds){const agent=indexed.get(id);if(!agent)throw new SingularityFlowError('The approved dependency closure is missing an agent.',{
    code:'ENGINE_STORAGE_CORRUPT',details:{agentId:id}});agents.set(id,agent);for(const dependency of agent.skills)needSkill(dependency);for(const dependency of agent.instructions)needInstruction(dependency);}
  const constitutionPaths=new Set(resolved.filter(value=>value.constitution?.mode!=='off'&&value.constitution?.path).map(value=>value.constitution.path)),
    // These catalogs are shared declarations in this exact pinned package. Keep their full
    // names so omission/decision authorities and future phase references are not dropped.
    allPhases=resolved.flatMap(value=>value.phases),authorities=new Set(Object.keys(compiled.definition.approvalAuthorities??{})),
    mcpIds=new Set(Object.keys(compiled.definition.mcpServers??{})),
    artifactSetIds=new Set(allPhases.map(phase=>typeof phase.artifactSet==='string'?phase.artifactSet:phase.artifactSet?.id).filter(Boolean)),
    pick=(source,keys)=>Object.fromEntries([...keys].sort().filter(key=>Object.hasOwn(source??{},key)).map(key=>[key,source[key]])),
    assets=[...agents.values()].map(value=>({kind:'agent',id:value.id,...value}));
  assets.push(...[...skills.values()].map(value=>({kind:'skill',...value})),...[...instructions.values()].map(value=>({kind:'instruction',...value})),
    ...[...templates.values()].map(value=>({kind:'template',governs:'story',reference:value.path,...value})),
    ...compiled.files.map(value=>({kind:constitutionPaths.has(value.path)?'constitution':'user-defined',owner:{id:'config'},...value})));
  const story={phases:pick(compiled.definition.phases,phases),artifactSets:pick(compiled.definition.artifactSets,artifactSetIds),
    templates:compiled.definition.templates??{},approvalAuthorities:pick(compiled.definition.approvalAuthorities,authorities),
    mcpServers:pick(compiled.definition.mcpServers,mcpIds),integrations:compiled.definition.integrations??{}};
  return {workflows,objects:{story,initiative:{initiativePhases:{},approvalAuthorities:{},applicabilityPolicies:{}}},assets,
    agentLocks:{},imports:{},requirements:{worldModelViews:[...new Set(allPhases.flatMap(phase=>phase.worldModel?.views??[]))].sort()},skillPackages:[]};
}
