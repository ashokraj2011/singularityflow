/** Native shipped configuration supplies reference facts; registered operations do all new writes. */
import { mkdir,readFile,readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition,validateDefinition,resolveWorkType } from '../../src/config.mjs';
import { discoverAgents } from '../../src/agents.mjs';
import { readLibrarySkill } from '../../src/skill-library.mjs';
import { readInstruction } from '../../src/instruction-library.mjs';
import { configurationAssetPolicy,configurationAssetSearchRoots,isConfigurationAssetPath } from '../../src/engine-compatibility/node-configuration-path.mjs';

export async function seededNamespaceConfiguration(f) {
  const root=path.join(f.directory,'native-reference');await mkdir(path.join(root,'.git'),{recursive:true});
  await initializeDefinition(root);
  const definition=YAML.parse(await readFile(path.join(root,'singularity/workflow.yml'),'utf8'));
  const catalog=await discoverAgents(root),phaseIds=new Set(Object.keys(definition.phases));
  const native=structuredClone(definition);native.agentCatalog=catalog;validateDefinition(native);
  const expected=Object.fromEntries(Object.keys(native.workTypes).map(id=>[id,JSON.parse(JSON.stringify(resolveWorkType(native,id)))]));
  const source={schemaVersion:1,format:f.source.format,definition,agents:[],skills:[],instructions:[],templates:[],files:[]};
  const skillIds=new Set(),instructionIds=new Set();
  for(const agent of catalog) {
    if(agent.phases.length&&!agent.phases.some(id=>phaseIds.has(id)))continue;
    const skillBindings=[...(agent.librarySkills??[]),...(agent.attachedSkills??[])].filter(binding=>!binding.phases.length||binding.phases.some(id=>phaseIds.has(id)))
      .map(binding=>({id:binding.id,phases:binding.phases.filter(id=>phaseIds.has(id)),use:binding.use??''}));
    for(const binding of skillBindings)skillIds.add(binding.id);
    source.agents.push({id:agent.id,label:agent.displayName??agent.label,phases:agent.phases.filter(id=>phaseIds.has(id)),
      defaultFor:agent.defaultFor.filter(id=>phaseIds.has(id)),mode:agent.metadata?.['sflow-mode']??'read-write',body:await f.putText(agent.text),
      skills:[...new Set(skillBindings.map(binding=>binding.id))],skillBindings,tools:agent.tools,instructions:[]});
  }
  for(const id of skillIds) {
    const skill=await readLibrarySkill(root,id);if(!skill)throw Error(`Missing actual seeded skill ${id}.`);
    for(const instructionId of skill.instructionRefs)instructionIds.add(instructionId);
    source.skills.push({id,body:await f.putText(skill.text),skills:[],instructions:skill.instructionRefs,loading:skill.loading});
  }
  for(const id of instructionIds) {
    const instruction=await readInstruction(root,id);if(!instruction)throw Error(`Missing actual seeded instruction ${id}.`);
    source.instructions.push({id,body:await f.putText(instruction.text)});
  }
  const required=new Set();
  for(const workflow of Object.values(expected)) {
    for(const phase of workflow.phases) {
      if(phase.template.startsWith('agent:'))throw Error('Seeded remote templates need their actual retained bytes.');
      required.add(`${definition.templatesRoot}/${phase.template}`);
    }
  }
  for(const relative of required)source.templates.push({path:relative,body:await f.putText(await readFile(path.join(root,relative)))});
  const policy=configurationAssetPolicy(definition),seen=new Set(required);
  async function capture(selected) {
    if(!seen.has(selected)&&isConfigurationAssetPath(selected,policy)) {
      seen.add(selected);source.files.push({path:selected,body:await f.putText(await readFile(path.join(root,selected)))});
    }
  }
  async function walk(relative) {
    let entries;try{entries=await readdir(path.join(root,relative),{withFileTypes:true});}catch(error){
      if(error.code==='ENOENT')return;if(error.code==='ENOTDIR'){await capture(relative);return;}throw error;}
    for(const entry of entries) {
      const selected=path.posix.join(relative,entry.name);
      if(entry.isDirectory())await walk(selected);
      else if(entry.isFile())await capture(selected);
    }
  }
  for(const relative of configurationAssetSearchRoots(policy))await walk(relative);
  return {source,expected};
}
