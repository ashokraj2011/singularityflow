/** Canonical namespace configuration is data; no Markdown discovery, files, Git or model calls. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NAMESPACE_CONFIGURATION_SCHEMAS, admitRecordSchemaVersion, jsonValueContract } from '../foundation/record-schema.mjs';
import { portableFilesystemPathIdentity } from '../foundation/portable-paths.mjs';
import { createWorkflowConfigurationCompiler } from './workflow-configuration.mjs';
import { configurationAssetPolicies } from './configuration-path-policies.mjs';
import { agentMappingProblems, parseAgentTemplateReference } from './configuration-declarations.mjs';
import { projectConfigurationReference, CONFIGURATION_PACKAGE_MAXIMUM_BYTES, CONFIGURATION_RESOURCE_MAXIMUM_BYTES } from './project-enrollment.mjs';

export const NAMESPACE_CONFIGURATION_SOURCE_FORMAT = 'sflow-namespace-configuration-source/v1';
export const NAMESPACE_CONFIGURATION_COMPILED_FORMAT = 'sflow-namespace-configuration-compiled/v1';
export function namespaceConfigurationJsonValues() {
  return jsonValueContract({ maximumBytes: CONFIGURATION_PACKAGE_MAXIMUM_BYTES, maximumDepth: 64, maximumNodes: 250_000,
    inputCode: 'ENGINE_CONFIGURATION_INVALID', limitCode: 'ENGINE_CONFIGURATION_LIMIT' });
}
const id = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 128;
const fail = (message, details = null) => { throw new SingularityFlowError(message, { code: 'ENGINE_CONFIGURATION_INVALID', details }); };
const list = (value, label) => {
  if (!Array.isArray(value) || value.length > 2048 || value.some(item => !id(item)) || new Set(value).size !== value.length) fail(`Invalid ${label}.`);
  return value;
};
const sourceFields = ['schemaVersion','format','definition','agents','skills','instructions','templates','files'];

/** Uses the actual shared compiler over value primitives, never a supplied admission function. */
export function createNamespaceConfigurationCompiler(dependencies) {
  const compiler = createWorkflowConfigurationCompiler(dependencies);
  const paths = configurationAssetPolicies(dependencies.pathSyntax);
  const {exactObject,namespaceJson}=namespaceConfigurationJsonValues();
  return Object.freeze({ compile(source, reference) {
    source = namespaceJson(source); reference = projectConfigurationReference(reference);
    exactObject(source, sourceFields); admitRecordSchemaVersion(NAMESPACE_CONFIGURATION_SCHEMAS.source, source);
    if (source.format !== NAMESPACE_CONFIGURATION_SOURCE_FORMAT || !source.definition || typeof source.definition!=='object' || Array.isArray(source.definition)
      || Object.hasOwn(source.definition, 'agentCatalog')) fail('A configuration package needs a definition and its own explicit agent catalog.');
    for (const field of ['agents','skills','instructions','templates','files']) {
      if (!Array.isArray(source[field]) || source[field].length > 2048) fail(`Configuration ${field} must be a bounded list.`);
    }
    if (['agents','skills','instructions','templates','files'].reduce((n,key) => n + source[key].length, 0) > 2048) fail('The configuration resource inventory exceeds its bound.');
    const resources = [], agents = new Map(), skills = new Map(), instructions = new Map(), files = new Map(), pathIdentities = new Set();
    let resourceBytes = 0;
    const body = (item, kind, key) => {
      const reference = projectConfigurationReference(item.body, CONFIGURATION_RESOURCE_MAXIMUM_BYTES, kind === 'file' ? 0 : 1);
      resourceBytes += reference.bytes;
      if (resourceBytes > 67_108_864) fail('Configuration resources exceed their aggregate byte bound.');
      resources.push({ kind, key, reference });
    };
    for (const kind of ['instructions','skills','agents']) for (const item of source[kind]) {
      const fields = kind === 'agents' ? ['id','label','phases','defaultFor','mode','body','skills','instructions']
        : kind === 'skills' ? ['id','body','skills','instructions'] : ['id','body'];
      exactObject(item, fields, kind === 'agents' ? ['skillBindings','tools'] : kind === 'skills' ? ['loading'] : []);
      const map = kind === 'agents' ? agents : kind === 'skills' ? skills : instructions;
      if (!id(item.id) || map.has(item.id)) fail(`Invalid or duplicate ${kind} identity.`, { id: item.id });
      if (kind !== 'instructions') { list(item.skills, `${kind} skill dependencies`); list(item.instructions, `${kind} instruction dependencies`); }
      if (kind === 'agents') {
        list(item.phases, 'agent phases'); list(item.defaultFor, 'agent defaults');
        if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 512
          || !['read-write','read-only','read-only-review'].includes(item.mode)
          || item.mode !== 'read-write' && item.defaultFor.length) fail('Invalid agent label or author/reviewer mode.', { agentId: item.id });
        if(item.tools!==undefined && (!Array.isArray(item.tools)||item.tools.length>2048
          ||item.tools.some(tool=>typeof tool!=='string'||!tool.trim()||tool.length>512||/[\u0000-\u001f\u007f]/u.test(tool))
          ||new Set(item.tools).size!==item.tools.length))fail('Agent tools must be bounded distinct declarations.',{agentId:item.id});
        if (item.skillBindings !== undefined) {
          if (!Array.isArray(item.skillBindings) || item.skillBindings.length > 2048) fail('Agent skill bindings must be a bounded list.');
          const bound=new Set();
          for(const binding of item.skillBindings) {
            exactObject(binding,['id','phases','use']);list(binding.phases,'skill binding phases');
            if(!item.skills.includes(binding.id) || typeof binding.use!=='string' || binding.use.length>4096
              || /[\u0000\u007f]/u.test(binding.use))fail('An agent skill binding has another dependency or invalid use note.',{agentId:item.id});
            bound.add(binding.id);
          }
          if(item.skills.some(skillId=>!bound.has(skillId)))fail('Every scoped agent skill needs its explicit binding.',{agentId:item.id});
        }
      } else if(kind === 'skills' && item.loading !== undefined && !['eager','on-demand'].includes(item.loading)) {
        fail('Unknown skill loading mode.',{skillId:item.id});
      }
      map.set(item.id, item); body(item, kind.slice(0,-1), item.id);
    }
    const displayNames = new Set();
    for (const agent of agents.values()) {
      const name = agent.label.trim().toLowerCase();
      if (displayNames.has(name)) fail('Agent display names must be distinct.'); displayNames.add(name);
    }
    for (const owner of [...agents.values(), ...skills.values()]) {
      for (const dependency of owner.skills) if (!skills.has(dependency)) fail('A declared skill dependency is missing.', { owner: owner.id, skillId: dependency });
      for (const dependency of owner.instructions) if (!instructions.has(dependency)) fail('A declared instruction dependency is missing.', { owner: owner.id, instructionId: dependency });
    }
    const visited = new Set(), active = new Set();
    function visit(skillId, depth = 0) {
      if (depth > 64 || active.has(skillId)) fail('Skill dependencies contain a cycle or exceed their depth bound.', { skillId });
      if (visited.has(skillId)) return;
      active.add(skillId); for (const dependency of skills.get(skillId).skills) visit(dependency, depth + 1);
      active.delete(skillId); visited.add(skillId);
    }
    for (const skillId of skills.keys()) visit(skillId);
    const definition = structuredClone(source.definition);
    definition.agentCatalog = [...agents.values()].map(agent => ({ id: agent.id, label: agent.label, displayName: agent.label,
      scope: 'namespace', source: `agent:${agent.id}`, phases: agent.phases, defaultFor: agent.defaultFor,
      metadata: { 'sflow-mode': agent.mode }, tools: agent.tools??[],
      librarySkills: agent.skillBindings ?? agent.skills.map(id=>({id,phases:[],use:''})) }));
    compiler.validateDefinition(definition);
    definition.planning=compiler.normalizePlanning(definition.planning??{});
    const phaseIds = new Set(Object.keys(definition.phases));
    for (const agent of agents.values()) if ([...agent.phases,...agent.defaultFor].some(phase => !phaseIds.has(phase))) fail('An agent names an undeclared phase.', { agentId: agent.id });
    for(const agent of agents.values()) for(const binding of agent.skillBindings??[]) if(binding.phases.some(phase=>!phaseIds.has(phase)))fail('An agent skill binding names an undeclared phase.',{agentId:agent.id,skillId:binding.id});
    const mapping = agentMappingProblems(definition.agentCatalog, phaseIds);
    if (mapping.length) throw new SingularityFlowError(mapping[0].message, { code: mapping[0].code, details: { problems: mapping } });
    const policy = paths.configurationAssetPolicy(definition);
    for (const kind of ['templates','files']) for (const item of source[kind]) {
      exactObject(item, ['path','body']);
      const agentTemplate = kind === 'templates' && typeof item.path === 'string' && item.path.startsWith('agent:');
      if (agentTemplate) {
        const {agentId}=parseAgentTemplateReference(item.path);
        if(!agents.has(agentId))fail('An agent template names a missing agent.',{agentId});
      } else if (typeof item.path !== 'string' || item.path.length > 512 || paths.portableConfigurationPath(item.path) !== item.path
        || !paths.isConfigurationAssetPath(item.path, policy)) fail('A resource path is outside portable configuration scope.', { path: item.path });
      const identity = agentTemplate ? item.path : portableFilesystemPathIdentity(item.path);
      if (pathIdentities.has(identity)) fail('Configuration resource paths collide across platforms.', { path: item.path });
      pathIdentities.add(identity); files.set(item.path, item); body(item, kind === 'templates' ? 'template' : 'file', item.path);
    }
    const workflows = {}, warnings=[];
    for (const workTypeId of Object.keys(definition.workTypes)) {
      const workflow = compiler.resolveWorkType(definition, workTypeId);
      for (const phase of workflow.phases) {
        if (String(phase.template).startsWith('agent:')) {
          const {agentId}=parseAgentTemplateReference(phase.template);
          if (!agents.has(agentId) || !files.has(phase.template)) fail('An agent-backed template is missing.', { agentId, template: phase.template });
        } else {
          const required = `${definition.templatesRoot}/${phase.template}`;
          if (!files.has(required)) fail('A workflow template is missing from this package.', { workTypeId, phase: phase.id, path: required });
        }
      }
      const constitution = workflow.constitution?.mode !== 'off' ? workflow.constitution?.path : null;
      if (constitution && !files.has(constitution)) {
        if(workflow.constitution.mode==='enforce')fail('A required workflow constitution is missing from this package.', { workTypeId, path: constitution });
        warnings.push({code:'CONFIGURATION_RESOURCE_UNAVAILABLE',kind:'constitution',workTypeId,path:constitution,mode:'warn'});
      }
      workflows[workTypeId] = workflow;
    }
    const prompt = definition.worldModel?.promptSource;
    if (prompt && prompt !== 'builtin' && !files.has(prompt)) fail('The configured knowledge prompt is missing.', { path: prompt });
    if(definition.planning.enabled&&!files.has(definition.planning.promptSource))fail('The configured planning prompt is missing.',{path:definition.planning.promptSource});
    // Resolution uses the existing JSON persistence meaning, including omitted optional fields.
    if(warnings.length>2048)fail('The configuration advisory inventory exceeds its bound.');
    const compiled = namespaceJson(JSON.parse(JSON.stringify({ schemaVersion: NAMESPACE_CONFIGURATION_SCHEMAS.compiled.currentVersion,
      format: NAMESPACE_CONFIGURATION_COMPILED_FORMAT, source: reference, definition, workTypeIds: Object.keys(workflows), workflows,
      agents: source.agents, skills: source.skills, instructions: source.instructions, templates: source.templates, files: source.files, warnings })));
    return { compiled, resources };
  } });
}
