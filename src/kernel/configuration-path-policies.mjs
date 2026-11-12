import { portableFilesystemPathIdentity } from '../foundation/portable-paths.mjs';
/** Configuration path rules use explicit string primitives, never filesystem or repository access. */
import { SingularityFlowError } from '../foundation/failures.mjs';

export const CONFIGURATION_PATH_SYNTAX = 'sflow-configuration-path-syntax/v1';
export const CONFIGURATION_PATH_SYNTAX_V2 = 'sflow-configuration-path-syntax/v2';
// Private literal tables and binding caches do not need initialization in hosts using no path rules.
const METHODS = /* @__PURE__ */ Object.freeze(['isAbsolute','normalize','parse','posixIsAbsolute','posixNormalize','posixBasename','toPosix']);
const METHODS_V2 = /* @__PURE__ */ Object.freeze([...METHODS, 'posixDirname', 'posixRelative', 'win32IsAbsolute']);
const SYNTAX = /* @__PURE__ */ new WeakMap();
const invalidSyntax = () => { throw new SingularityFlowError('Configuration path rules need one frozen, explicit path-syntax port.', {
  code: 'ENGINE_CONFIGURATION_PATH_SYNTAX_INVALID'
}); };

/** Capture once, without calling a primitive or evaluating a caller's accessor. */
export function configurationPathSyntax(port) {
  if (!port || typeof port !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(port)) || !Object.isFrozen(port)) invalidSyntax();
  const profile = Object.getOwnPropertyDescriptor(port, 'profile');
  if (!profile || !Object.hasOwn(profile, 'value') || ![CONFIGURATION_PATH_SYNTAX, CONFIGURATION_PATH_SYNTAX_V2].includes(profile.value)) invalidSyntax();
  const extended = profile.value === CONFIGURATION_PATH_SYNTAX_V2;
  const methods = extended ? METHODS_V2 : METHODS;
  const keys = Reflect.ownKeys(port);
  if (keys.length !== methods.length + 2 || keys.some(key => typeof key !== 'string' || !['profile','grammar'].includes(key) && !methods.includes(key))) invalidSyntax();
  for (const key of ['profile','grammar',...methods]) {
    const descriptor = Object.getOwnPropertyDescriptor(port,key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')
      || (key === 'profile' ? descriptor.value !== profile.value
        : key === 'grammar' ? !['posix','win32'].includes(descriptor.value) : typeof descriptor.value !== 'function')) invalidSyntax();
  }
  if (SYNTAX.has(port)) return SYNTAX.get(port);
  const bound = Object.fromEntries(methods.map(key => {
    const method = Object.getOwnPropertyDescriptor(port, key).value;
    return [key, extended ? (...args) => Reflect.apply(method, port, args) : method.bind(port)];
  }));
  const value = Object.freeze({ grammar: port.grammar, path: Object.freeze({ isAbsolute: bound.isAbsolute, normalize: bound.normalize, parse: bound.parse,
    posix: Object.freeze({ isAbsolute: bound.posixIsAbsolute, normalize: bound.posixNormalize, basename: bound.posixBasename,
      ...(extended ? { dirname: bound.posixDirname, relative: bound.posixRelative } : {}) }),
    ...(extended ? { win32: Object.freeze({ isAbsolute: bound.win32IsAbsolute }) } : {}) }), posix: bound.toPosix });
  SYNTAX.set(port,value); return value;
}

/** v1 keeps its original methods; compiled skills and asset rules require the explicit v2 extension. */
export function configurationPathSyntaxV2(port) {
  const syntax = configurationPathSyntax(port);
  if (port.profile !== CONFIGURATION_PATH_SYNTAX_V2) throw new SingularityFlowError(
    'Compiled skill and configuration-asset rules require the path-syntax v2 capability.',
    { code: 'ENGINE_CONFIGURATION_PATH_SYNTAX_UNSUPPORTED' });
  return syntax;
}

const POLICIES = /* @__PURE__ */ new WeakMap();

function pathPolicy(port, name, create) {
  const syntax = configurationPathSyntax(port);
  let policies = POLICIES.get(port);
  if (!policies) { policies = Object.create(null); POLICIES.set(port,policies); }
  if (Object.hasOwn(policies,name)) return policies[name];
  const value = Object.freeze(create(syntax));
  Object.defineProperty(policies,name,{value}); return value;
}

// source-path-policy.mjs


function normalizePaths(value, label, { files = false } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new SingularityFlowError(`${label} must be a list of at most 64 repository-relative ${files ? 'files' : 'directories'}.`);
  }
  const paths = [];
  const caseFolded = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw || raw !== raw.trim() || raw.includes('\\')
      || /[\u0000-\u001f\u007f*?\[\]{}<>:"|]/u.test(raw) || raw.startsWith('/')
      || /^[A-Za-z]:/u.test(raw) || raw.endsWith('/') || raw.includes('//')
      || raw.split('/').some(segment => !segment || segment === '.' || segment === '..'
        || segment.endsWith('.') || segment.endsWith(' ')
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
      throw new SingularityFlowError(`${label} entries must be canonical repository-relative paths without globs or '..'.`);
    }
    if (raw === '.git' || raw.startsWith('.git/') || raw === 'singularity' || raw.startsWith('singularity/')) {
      throw new SingularityFlowError(`${label} cannot include Git or Singularity Flow paths.`);
    }
    const folded = raw.toLocaleLowerCase('en-US');
    if (caseFolded.has(folded) && !paths.includes(raw)) {
      throw new SingularityFlowError(`${label} contains paths that collide on a case-insensitive filesystem.`);
    }
    caseFolded.add(folded);
    if (!paths.includes(raw)) paths.push(raw);
  }
  return paths.sort();
}


/** Approved source exclusions are still hashed as separate test inputs. */
export function normalizeSourceHashExcludedRoots(value, label = 'sourceHashExcludedRoots') {
  return normalizePaths(value, label);
}


/** Exact test configuration files, never an extension-wide or glob-wide exception. */
export function normalizeTestConfigurationPaths(value, label = 'testConfigurationPaths') {
  return normalizePaths(value, label, { files: true });
}


export function sourcePathPolicy(scope = {}) {
  return {
    sourceHashExcludedRoots: normalizeSourceHashExcludedRoots(scope?.sourceHashExcludedRoots),
    testConfigurationPaths: normalizeTestConfigurationPaths(scope?.testConfigurationPaths)
  };
}


export function isSeparatelyHashedTestInput(relative, policy = {}) {
  return (policy.testConfigurationPaths ?? []).includes(relative)
    || (policy.sourceHashExcludedRoots ?? []).some(root => relative === root || relative.startsWith(`${root}/`));
}

// environment-declaration.mjs


export const ENVIRONMENT_DECLARATION_PATH = 'singularity/environments.yml';

export const ENVIRONMENT_IDENTIFIER = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/;

const RESERVED_VARIABLES = /* @__PURE__ */ new Set([
  'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'HOME', 'SHELL', 'COMSPEC', 'PATHEXT',
  'SYSTEMROOT', 'USERPROFILE', 'TMP', 'TEMP', 'SSH_AUTH_SOCK',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'
]);

const RESERVED_PREFIXES = ['GIT_', 'LD_', 'DYLD_', 'NODE_', 'NPM_CONFIG_', 'SINGULARITY_FLOW_'];


/** Whether a variable or option name reads like a secret's (secret-looking.mjs re-exports it). */
export function looksSecretName(name) {
  return /pass|secret|token|key|credential|private|auth/iu.test(String(name ?? ''));
}


/** Whether environments.yml may declare this variable name (UPPER_CASE, not reserved). */
export function declarableEnvironmentVariable(name) {
  return typeof name === 'string' && VARIABLE.test(name) && !RESERVED_VARIABLES.has(name)
    && !RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}
export { VARIABLE as environmentDeclarationVARIABLE, RESERVED_VARIABLES as environmentDeclarationRESERVEDVARIABLES, RESERVED_PREFIXES as environmentDeclarationRESERVEDPREFIXES };

// test-recovery-policy.mjs

export const TRP_RISK_CATEGORIES = /* @__PURE__ */ Object.freeze([
  'known-test-failure', 'reduced-coverage', 'nonessential-document',
  'new-test-failure', 'validation-unavailable'
]);

// source-scope.mjs
export function sourceScopePolicies(port) {
  return pathPolicy(port, "sourceScopePolicies", ({ path, posix }) => {



/**
 * A source scope is deliberately a set of directory prefixes, not glob expressions.
 *
 * Prefixes give Git, sparse checkout, the world-model scanner, and the deterministic facts builder
 * one meaning to share. Supporting a different pattern language at each layer would make a file
 * visible to one of them and invisible to another, which is exactly the kind of partial world model
 * that is dangerous in a monorepo.
 */
function normalizeSourceRoots(value, label = 'Source roots') {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new SingularityFlowError(`${label} must be an array of repository-relative directories.`);
  const roots = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) throw new SingularityFlowError(`${label} must contain non-empty paths.`);
    if (raw.includes('\\')) throw new SingularityFlowError(`${label} entry '${raw}' must use forward slashes.`);
    const normalized = posix(raw.trim()).replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized)
      || normalized.split('/').includes('..') || /[*?\[\]{}]/.test(normalized)) {
      throw new SingularityFlowError(`${label} entry '${raw}' must be a repository-relative directory without '..' or glob characters.`);
    }
    if (!roots.includes(normalized)) roots.push(normalized);
  }
  return roots.sort();
}


/** The normalized scope declared by either a workflow definition or a worldModel object. */
function worldModelSourceScope(definition = {}) {
  const configured = definition.worldModel ?? definition;
  const sourceRoots = normalizeSourceRoots(configured?.sourceRoots, 'worldModel.sourceRoots');
  const sharedRoots = normalizeSourceRoots(configured?.sharedRoots, 'worldModel.sharedRoots');
  const { sourceHashExcludedRoots, testConfigurationPaths } = sourcePathPolicy(configured);
  const paths = [...new Set([...sourceRoots, ...sharedRoots])].sort();
  return Object.freeze({
    sourceRoots: Object.freeze(sourceRoots),
    sharedRoots: Object.freeze(sharedRoots),
    sourceHashExcludedRoots: Object.freeze(sourceHashExcludedRoots),
    testConfigurationPaths: Object.freeze(testConfigurationPaths),
    paths: Object.freeze(paths),
    all: paths.length === 0
  });
}
    return { normalizeSourceRoots, worldModelSourceScope };
  });
}

// work-item-location.mjs
export function workItemLocationPolicies(port) {
  return pathPolicy(port, "workItemLocationPolicies", ({ path, posix }) => {



const DEFAULT_WORK_ITEM_ROOT = 'singularity/work-items';


/** Normalize the configured durable Story root before it is used in a Git object expression. */
function normalizeWorkItemRoot(value = DEFAULT_WORK_ITEM_ROOT) {
  const candidate = String(value ?? DEFAULT_WORK_ITEM_ROOT).trim().replaceAll('\\', '/');
  if (!candidate || path.posix.isAbsolute(candidate) || /^[A-Za-z]:\//.test(candidate)
      || candidate.split('/').includes('..')) {
    throw new SingularityFlowError('workItemRoot must be a normalized repository-relative path.');
  }
  const root = path.posix.normalize(candidate).replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!root || root === '.') {
    throw new SingularityFlowError('workItemRoot must be a normalized repository-relative path.');
  }
  return root;
}
    return { DEFAULT_WORK_ITEM_ROOT, normalizeWorkItemRoot };
  });
}

// artifact-sets.mjs
export function artifactSetPolicies(port) {
  return pathPolicy(port, "artifactSetPolicies", ({ path, posix }) => {



/** How much a member's absence or change is allowed to mean. */
const MEMBER_AUTHORITIES = Object.freeze(['governed', 'advisory']);


/**
 * Normalize one declared set.
 *
 * Validated at configuration load rather than at first use. The set shipped in `workflow.yml` had no
 * reader at all until this module existed; a declaration nothing validates and nothing consumes is
 * indistinguishable from one that works.
 */
function normalizeArtifactSet(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Artifact set '${id}' must be an object.`);
  }
  const primary = String(value.primary ?? '').trim();
  if (!primary) throw new SingularityFlowError(`Artifact set '${id}' must name its primary member.`);
  const members = value.members ?? [];
  if (!Array.isArray(members) || !members.length) {
    throw new SingularityFlowError(`Artifact set '${id}' must list at least one member.`);
  }
  const seen = new Set();
  const normalized = members.map((member, index) => {
    if (!member || typeof member !== 'object') throw new SingularityFlowError(`Artifact set '${id}' member ${index + 1} must be an object.`);
    const memberPath = posix(String(member.path ?? '').trim());
    if (!memberPath) throw new SingularityFlowError(`Artifact set '${id}' member ${index + 1} needs a path.`);
    if (memberPath.startsWith('/') || memberPath.split('/').includes('..')) {
      throw new SingularityFlowError(`Artifact set '${id}' member '${memberPath}' must stay inside the phase artifact directory.`);
    }
    if (seen.has(memberPath)) throw new SingularityFlowError(`Artifact set '${id}' lists '${memberPath}' twice.`);
    seen.add(memberPath);
    const role = String(member.role ?? '').trim();
    if (!role) throw new SingularityFlowError(`Artifact set '${id}' member '${memberPath}' needs a role.`);
    const authority = member.authority ?? 'governed';
    if (!MEMBER_AUTHORITIES.includes(authority)) {
      throw new SingularityFlowError(`Artifact set '${id}' member '${memberPath}' authority must be one of ${MEMBER_AUTHORITIES.join(', ')}.`);
    }
    // An advisory member is a planning aid, never evidence `[SPK:CON-046]`. Requiring one would make
    // it evidence by the back door, so the two cannot be combined.
    if (authority === 'advisory' && member.required === true) {
      throw new SingularityFlowError(`Artifact set '${id}' member '${memberPath}' is advisory, so it cannot be required.`);
    }
    return { path: memberPath, role, required: member.required === true, authority };
  });
  if (!normalized.some((member) => member.path === posix(primary))) {
    throw new SingularityFlowError(`Artifact set '${id}' primary '${primary}' is not among its members.`);
  }
  return Object.freeze({ id, primary: posix(primary), members: Object.freeze(normalized) });
}


function normalizeArtifactSets(value = {}) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('artifactSets must be an object.');
  return Object.fromEntries(Object.entries(value).map(([id, set]) => [id, normalizeArtifactSet(set, id)]));
}
/** Compare admitted catalogues. Version admission and retained-byte reads belong to adapters. */
function artifactSetDiffValues(previous,current,{declared=[]}={}){
  if(!previous||!current)return {changed:[],preserved:[],incidental:[],declared:[...declared]};
  const before=new Map(previous.members.map(member=>[member.path,member])),intended=new Set(declared.map(entry=>posix(entry))),changed=[],preserved=[];
  for(const member of current.members){const earlier=before.get(member.path);
    if(!earlier){changed.push({...member,reason:'the member is new'});continue;}
    if(earlier.sha256===member.sha256)preserved.push(member);
    else changed.push({...member,reason:earlier.exists?'the member bytes changed':'the member was added'});
  }
  for(const [memberPath,earlier]of before)if(earlier.exists&&!current.members.some(member=>member.path===memberPath&&member.exists))
    changed.push({...earlier,sha256:null,exists:false,reason:'the member was removed'});
  return {changed,preserved,declared:[...intended],incidental:intended.size?changed.filter(member=>!intended.has(member.path)&&!intended.has(member.member)):[]};
}
    return { MEMBER_AUTHORITIES, normalizeArtifactSet, normalizeArtifactSets, artifactSetDiffValues };
  });
}

// ast-policy.mjs
export function astConfigurationPolicies(port) {
  return pathPolicy(port, "astConfigurationPolicies", ({ path, posix }) => {
    const { normalizeSourceRoots } = sourceScopePolicies(port);


const AST_MODES = Object.freeze(['auto', 'off']);

const AST_FALLBACKS = Object.freeze(['host-and-text', 'text-only']);

const AST_ASSURANCE = Object.freeze(['text', 'syntax', 'semantic']);

const AST_EVIDENCE_MODES = Object.freeze(['replayable', 'identified', 'off']);

const AST_STORY_START_WARM_MODES = Object.freeze(['background', 'before-first-phase', 'off']);

const AST_STORY_START_WARM_SCOPES = Object.freeze(['configured-roots', 'repository']);

const AST_PREDICATE_TYPES = Object.freeze([
  'path-exists', 'symbol-exists', 'import-boundary', 'annotation-present', 'inherits-from',
  'conforms-to', 'override-exists', 'public-signature-changed', 'module-dependency'
]);


const PREDICATE_FIELDS = Object.freeze({
  'path-exists': ['path'],
  'symbol-exists': ['symbol'],
  'import-boundary': ['path', 'target'],
  'annotation-present': ['symbol', 'annotation'],
  'inherits-from': ['symbol', 'target'],
  'conforms-to': ['symbol', 'target'],
  'override-exists': ['symbol', 'target'],
  'public-signature-changed': ['path', 'expectedSha256'],
  'module-dependency': ['module', 'target']
});


function positiveInteger(value, fallback, label) {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 1) throw new SingularityFlowError(`${label} must be a positive integer.`);
  return actual;
}


/**
 * Validate the repository-pinned AST policy without loading an AST implementation.
 *
 * Parsers remain optional packages. Keeping this normalizer in the configuration layer prevents
 * merely reading workflow.yml from pulling a compiler into the trusted kernel.
 */
function normalizeAstPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('ast must be an object.');
  const allowed = new Set([
    'mode', 'fallback', 'languages', 'generatedRoots', 'budgets', 'predicates', 'evidence',
    'warmOnStoryStart'
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`ast contains unknown field '${key}'.`);
  const mode = value.mode ?? 'auto';
  const fallback = value.fallback ?? 'host-and-text';
  if (!AST_MODES.includes(mode)) throw new SingularityFlowError(`ast.mode must be ${AST_MODES.join(' or ')}.`);
  if (!AST_FALLBACKS.includes(fallback)) throw new SingularityFlowError(`ast.fallback must be ${AST_FALLBACKS.join(' or ')}.`);

  const languages = {};
  for (const [language, policy] of Object.entries(value.languages ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(language)) throw new SingularityFlowError(`ast.languages key '${language}' must be lower-case kebab-case.`);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new SingularityFlowError(`ast.languages.${language} must be an object.`);
    for (const key of Object.keys(policy)) if (!['mode', 'minimumAssurance', 'syntaxProvider', 'semanticProvider', 'semanticProfile'].includes(key)) throw new SingularityFlowError(`ast.languages.${language} contains unknown field '${key}'.`);
    const languageMode = policy.mode ?? 'auto';
    const minimumAssurance = policy.minimumAssurance ?? 'text';
    if (!AST_MODES.includes(languageMode)) throw new SingularityFlowError(`ast.languages.${language}.mode must be auto or off.`);
    if (!AST_ASSURANCE.includes(minimumAssurance)) throw new SingularityFlowError(`ast.languages.${language}.minimumAssurance must be text, syntax, or semantic.`);
    for (const field of ['syntaxProvider', 'semanticProvider']) {
      if (policy[field] != null && !/^[a-z][a-z0-9-]*$/.test(policy[field])) {
        throw new SingularityFlowError(`ast.languages.${language}.${field} must be a lower-case pack id.`);
      }
    }
    if (policy.semanticProfile != null && (typeof policy.semanticProfile !== 'string' || !policy.semanticProfile.trim())) {
      throw new SingularityFlowError(`ast.languages.${language}.semanticProfile must be a non-empty string.`);
    }
    languages[language] = {
      mode: languageMode, minimumAssurance,
      syntaxProvider: policy.syntaxProvider ?? null,
      semanticProvider: policy.semanticProvider ?? null,
      semanticProfile: policy.semanticProfile ?? null
    };
  }

  const generatedRoots = normalizeSourceRoots(value.generatedRoots, 'ast.generatedRoots');
  if (value.budgets != null && (!value.budgets || typeof value.budgets !== 'object' || Array.isArray(value.budgets))) {
    throw new SingularityFlowError('ast.budgets must be an object.');
  }
  for (const key of Object.keys(value.budgets ?? {})) {
    if (!['maxFiles', 'maxBytes', 'maxFileBytes'].includes(key)) throw new SingularityFlowError(`ast.budgets contains unknown field '${key}'.`);
  }
  const predicates = value.predicates ?? [];
  if (!Array.isArray(predicates)) throw new SingularityFlowError('ast.predicates must be an array.');
  for (const predicate of predicates) {
    if (!predicate || typeof predicate !== 'object' || !predicate.id || !['required', 'advisory'].includes(predicate.mode ?? 'advisory')) {
      throw new SingularityFlowError('Each ast predicate requires an id and mode required or advisory.');
    }
    if (!AST_PREDICATE_TYPES.includes(predicate.type)) {
      throw new SingularityFlowError(`AST predicate '${predicate.id}' type must be one of ${AST_PREDICATE_TYPES.join(', ')}.`);
    }
    const requiredFields = PREDICATE_FIELDS[predicate.type];
    const allowedFields = new Set(['id', 'mode', 'type', 'minimumAssurance', 'languages', 'profiles', ...requiredFields]);
    for (const key of Object.keys(predicate)) {
      if (!allowedFields.has(key)) throw new SingularityFlowError(`AST predicate '${predicate.id}' contains unknown field '${key}'.`);
    }
    for (const field of requiredFields) {
      const value = predicate[field];
      if (typeof value !== 'string' || !value.trim()) throw new SingularityFlowError(`AST predicate '${predicate.id}' requires ${field}.`);
    }
    if (predicate.expectedSha256 != null && !/^[a-f0-9]{64}$/.test(predicate.expectedSha256)) {
      throw new SingularityFlowError(`AST predicate '${predicate.id}' expectedSha256 must be a SHA-256 digest.`);
    }
    const rich = !['path-exists', 'symbol-exists'].includes(predicate.type);
    for (const field of ['languages', 'profiles']) {
      const list = predicate[field];
      if (rich && (!Array.isArray(list) || !list.length)) {
        throw new SingularityFlowError(`AST predicate '${predicate.id}' must declare applicable ${field}. Use ['*'] for every ${field === 'languages' ? 'language' : 'profile'}.`);
      }
      if (list != null && (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item.trim()))) {
        throw new SingularityFlowError(`AST predicate '${predicate.id}' ${field} must be a non-empty string array.`);
      }
    }
    if (!AST_ASSURANCE.includes(predicate.minimumAssurance ?? 'text')) throw new SingularityFlowError(`AST predicate '${predicate.id}' minimumAssurance must be text, syntax, or semantic.`);
  }
  const evidenceSource = value.evidence ?? {};
  if (!evidenceSource || typeof evidenceSource !== 'object' || Array.isArray(evidenceSource)) {
    throw new SingularityFlowError('ast.evidence must be an object.');
  }
  for (const key of Object.keys(evidenceSource)) {
    if (!['mode', 'store'].includes(key)) throw new SingularityFlowError(`ast.evidence contains unknown field '${key}'.`);
  }
  const evidenceMode = evidenceSource.mode ?? 'identified';
  const evidenceStore = evidenceSource.store ?? 'local-directory';
  if (!AST_EVIDENCE_MODES.includes(evidenceMode)) {
    throw new SingularityFlowError(`ast.evidence.mode must be ${AST_EVIDENCE_MODES.join(', ')}.`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(evidenceStore)) {
    throw new SingularityFlowError('ast.evidence.store must be a lower-case logical store id.');
  }
  const storyStartSource = value.warmOnStoryStart ?? {};
  if (!storyStartSource || typeof storyStartSource !== 'object' || Array.isArray(storyStartSource)) {
    throw new SingularityFlowError('ast.warmOnStoryStart must be an object.');
  }
  for (const key of Object.keys(storyStartSource)) {
    if (!['mode', 'scope'].includes(key)) {
      throw new SingularityFlowError(`ast.warmOnStoryStart contains unknown field '${key}'.`);
    }
  }
  const storyStartMode = storyStartSource.mode ?? 'background';
  const storyStartScope = storyStartSource.scope ?? 'configured-roots';
  if (!AST_STORY_START_WARM_MODES.includes(storyStartMode)) {
    throw new SingularityFlowError(
      `ast.warmOnStoryStart.mode must be ${AST_STORY_START_WARM_MODES.join(', ')}.`
    );
  }
  if (!AST_STORY_START_WARM_SCOPES.includes(storyStartScope)) {
    throw new SingularityFlowError(
      `ast.warmOnStoryStart.scope must be ${AST_STORY_START_WARM_SCOPES.join(' or ')}.`
    );
  }
  return Object.freeze({
    mode,
    fallback,
    languages: Object.freeze(languages),
    generatedRoots: Object.freeze([...new Set(generatedRoots)].sort()),
    budgets: Object.freeze({
      maxFiles: positiveInteger(value.budgets?.maxFiles, 500, 'ast.budgets.maxFiles'),
      maxBytes: positiveInteger(value.budgets?.maxBytes, 20 * 1024 * 1024, 'ast.budgets.maxBytes'),
      maxFileBytes: positiveInteger(value.budgets?.maxFileBytes, 2 * 1024 * 1024, 'ast.budgets.maxFileBytes')
    }),
    predicates: Object.freeze(predicates.map((predicate) => Object.freeze({
      ...predicate,
      mode: predicate.mode ?? 'advisory',
      minimumAssurance: predicate.minimumAssurance ?? 'text',
      ...(predicate.languages ? { languages: Object.freeze([...new Set(predicate.languages)].sort()) } : {}),
      ...(predicate.profiles ? { profiles: Object.freeze([...new Set(predicate.profiles)].sort()) } : {})
    }))),
    evidence: Object.freeze({ mode: evidenceMode, store: evidenceStore }),
    warmOnStoryStart: Object.freeze({ mode: storyStartMode, scope: storyStartScope })
  });
}
    return { AST_MODES, AST_FALLBACKS, AST_ASSURANCE, AST_EVIDENCE_MODES, AST_STORY_START_WARM_MODES, AST_STORY_START_WARM_SCOPES, AST_PREDICATE_TYPES, normalizeAstPolicy };
  });
}

// fault-repair.mjs
export function faultRepairConfigurationPolicies(port) {
  return pathPolicy(port, "faultRepairConfigurationPolicies", ({ path, posix }) => {



const ENVIRONMENTS = new Set(['local', 'ide', 'copilot', 'ci', 'integration', 'staging', 'production']);

const ACTION_CEILINGS = Object.freeze(['record', 'diagnose', 'propose', 'guided', 'bounded-auto']);

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  maxAttempts: 3,
  maxMinutes: 20,
  maxTokens: 30_000,
  maximumInlineEvidenceBytes: 16 * 1024,
  maximumEvidenceBytes: 64 * 1024 * 1024,
  leaseMinutes: 60,
  boundedAuto: false,
  environmentCeilings: Object.freeze({
    local: 'guided', ide: 'guided', copilot: 'guided', ci: 'propose', integration: 'propose',
    staging: 'propose', production: 'diagnose'
  }),
  protectedPaths: Object.freeze(['.git', 'singularity', 'infra/production'])
});


function normalizeFaultRepairPolicy(value = {}) {
  if (value == null) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('faultRepair must be an object.');
  const allowed = new Set([
    'enabled', 'maxAttempts', 'maxMinutes', 'maxTokens', 'maximumInlineEvidenceBytes',
    'maximumEvidenceBytes', 'leaseMinutes', 'boundedAuto', 'environmentCeilings', 'protectedPaths'
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`faultRepair contains unknown field '${key}'.`);
  if (value.protectedPaths != null && !Array.isArray(value.protectedPaths)) {
    throw new SingularityFlowError('faultRepair.protectedPaths must be an array.');
  }
  if (value.environmentCeilings != null
    && (!value.environmentCeilings || typeof value.environmentCeilings !== 'object' || Array.isArray(value.environmentCeilings))) {
    throw new SingularityFlowError('faultRepair.environmentCeilings must be an object.');
  }
  const policy = {
    ...DEFAULT_POLICY,
    ...value,
    environmentCeilings: { ...DEFAULT_POLICY.environmentCeilings, ...(value.environmentCeilings ?? {}) },
    protectedPaths: [...new Set(value.protectedPaths ?? DEFAULT_POLICY.protectedPaths)]
  };
  if (typeof policy.enabled !== 'boolean' || typeof policy.boundedAuto !== 'boolean') {
    throw new SingularityFlowError('faultRepair.enabled and faultRepair.boundedAuto must be boolean.');
  }
  for (const [field, minimum, maximum] of [
    ['maxAttempts', 1, 20], ['maxMinutes', 1, 1440], ['maxTokens', 1, 10_000_000],
    ['maximumInlineEvidenceBytes', 1, 65_536], ['maximumEvidenceBytes', 1024, 1024 * 1024 * 1024],
    ['leaseMinutes', 1, 1440]
  ]) {
    if (!Number.isInteger(policy[field]) || policy[field] < minimum || policy[field] > maximum) {
      throw new SingularityFlowError(`faultRepair.${field} must be an integer from ${minimum} through ${maximum}.`);
    }
  }
  for (const [environment, ceiling] of Object.entries(policy.environmentCeilings)) {
    if (!ENVIRONMENTS.has(environment) || !ACTION_CEILINGS.includes(ceiling)) {
      throw new SingularityFlowError(`faultRepair.environmentCeilings.${environment} is invalid.`);
    }
  }
  for (const prefix of policy.protectedPaths) normalizePathPrefix(prefix, 'faultRepair.protectedPaths');
  return Object.freeze({ ...policy, protectedPaths: Object.freeze([...policy.protectedPaths]) });
}


function normalizePathPrefix(value, label = 'path') {
  const input = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!input || input === '.' || path.posix.isAbsolute(input) || input.split('/').includes('..') || input.includes('\0')) {
    throw new SingularityFlowError(`${label} must be a bounded repository-relative path, not the repository root, and may not contain '..'.`, { code: 'REPAIR_SCOPE_INVALID' });
  }
  return input;
}
    return { normalizeFaultRepairPolicy, ENVIRONMENTS, ACTION_CEILINGS, normalizePathPrefix };
  });
}

// constitution.mjs
export function constitutionConfigurationPolicies(port) {
  return pathPolicy(port, "constitutionConfigurationPolicies", ({ path, posix }) => {



const CONSTITUTION_MODES = Object.freeze(['off', 'warn', 'enforce']);

const DEFAULT_CONSTITUTION_PATH = 'singularity/constitution.md';


/**
 * Normalize the `constitution:` block a work type declares.
 *
 * Validated at configuration load. The block shipped in `workflow.yml` from P1 with no validator and
 * no reader — a `mode: enfroce` would have resolved cleanly and governed nothing, which is the
 * failure this product keeps producing and the reason every policy now gets a normalizer.
 */
function constitutionPolicy(value = {}) {
  if (value == null) return Object.freeze({ mode: 'off', path: DEFAULT_CONSTITUTION_PATH });
  if (typeof value === 'string') value = { mode: value };
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('constitution must be an object or mode string.');
  for (const key of Object.keys(value)) {
    if (!['mode', 'path'].includes(key)) throw new SingularityFlowError(`constitution contains unknown field '${key}'.`);
  }
  const mode = value.mode ?? 'off';
  if (!CONSTITUTION_MODES.includes(mode)) {
    throw new SingularityFlowError(`constitution.mode must be one of ${CONSTITUTION_MODES.join(', ')}; got '${mode}'.`);
  }
  const relative = posix(String(value.path ?? DEFAULT_CONSTITUTION_PATH));
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new SingularityFlowError('constitution.path must be a repository-relative path without "..".');
  }
  return Object.freeze({ mode, path: relative });
}
    return { CONSTITUTION_MODES, DEFAULT_CONSTITUTION_PATH, constitutionPolicy };
  });
}

// inject.mjs
export function injectionConfigurationPolicies(port) {
  return pathPolicy(port, "injectionConfigurationPolicies", ({ path, posix }) => {



const DEFAULT_INJECTION = { placeholder: '{{WORLD_MODEL}}', mode: 'append', maxBytes: 32768, rules: [] };

const MODES = new Set(['replace', 'append', 'off']);


function values(value) { return Array.isArray(value) ? value : [value]; }


function assertStringValues(value, label) {
  if (value == null) return;
  if (values(value).some((item) => typeof item !== 'string' || !item.trim())) throw new SingularityFlowError(`${label} must contain non-empty strings.`);
}


function injectionConfig(definition) {
  const configured = definition.worldModel?.injection ?? {};
  const merged = { ...DEFAULT_INJECTION, ...configured };
  if (!MODES.has(merged.mode)) throw new SingularityFlowError(`worldModel.injection.mode must be replace, append, or off; got '${merged.mode}'.`);
  if (typeof merged.placeholder !== 'string' || !merged.placeholder) throw new SingularityFlowError('worldModel.injection.placeholder must be a non-empty string.');
  if (!Number.isInteger(merged.maxBytes) || merged.maxBytes < 1) throw new SingularityFlowError('worldModel.injection.maxBytes must be a positive integer.');
  if (!Array.isArray(merged.rules)) throw new SingularityFlowError('worldModel.injection.rules must be an array.');
  return merged;
}


function validateInjectionDefinition(definition, { deferAgentReferences = false } = {}) {
  const injection = injectionConfig(definition);
  injection.rules.forEach((rule, index) => {
    const label = `worldModel.injection.rules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new SingularityFlowError(`${label} must be an object.`);
    if (!Array.isArray(rule.include) || !rule.include.length) throw new SingularityFlowError(`${label}.include must contain at least one world-model path or glob.`);
    assertStringValues(rule.include, `${label}.include`);
    for (const include of rule.include) {
      if (path.isAbsolute(include) || include.split(/[\\/]/).includes('..')) throw new SingularityFlowError(`${label}.include paths must stay inside the world-model directory.`);
    }
    const when = rule.when ?? {};
    if (typeof when !== 'object' || Array.isArray(when)) throw new SingularityFlowError(`${label}.when must be an object.`);
    for (const key of Object.keys(when)) if (!['agent', 'phase', 'workType', 'changedPaths', 'labels'].includes(key)) throw new SingularityFlowError(`${label}.when has unsupported signal '${key}'.`);
    for (const [key, source] of [['agent', definition.agents], ['phase', definition.phases], ['workType', definition.workTypes]]) {
      assertStringValues(when[key], `${label}.when.${key}`);
      for (const id of when[key] == null ? [] : values(when[key])) {
        if (!(deferAgentReferences && key === 'agent') && !source?.[id]) {
          throw new SingularityFlowError(`${label}.when.${key} references unknown ${key} '${id}'.`);
        }
      }
    }
    assertStringValues(when.changedPaths, `${label}.when.changedPaths`);
    assertStringValues(when.labels, `${label}.when.labels`);
    if (rule.depth != null && !['light', 'quick', 'standard', 'deep'].includes(rule.depth)) throw new SingularityFlowError(`${label}.depth must be light, quick, standard, or deep.`);
    if (rule.evidence != null && typeof rule.evidence !== 'boolean') throw new SingularityFlowError(`${label}.evidence must be boolean.`);
  });
  return injection;
}
    return { injectionConfig, validateInjectionDefinition };
  });
}

// external-command-policy.mjs
export function externalCommandConfigurationPolicies(port) {
  return pathPolicy(port, "externalCommandConfigurationPolicies", ({ path, posix }) => {



const EXTERNAL_MODEL_POLICIES = Object.freeze(['never', 'required', 'unknown']);

const QUALITY_COMMAND_KINDS = Object.freeze([
  'test', 'compile', 'lint', 'format', 'static-analysis', 'security', 'other'
]);

const QUALITY_COMMAND_REQUIREMENTS = Object.freeze(['required', 'advisory']);

const ENVIRONMENT_ID_PATTERN = ENVIRONMENT_IDENTIFIER;

const TEST_RESULT_ADAPTERS = Object.freeze([
  'junit-xml', 'jest-json', 'vitest-json', 'playwright-json', 'go-test-json', 'node-tap',
  'karma-text', 'dotnet-trx', 'cargo-json', 'sflow-test-result-v1', 'mocha-json'
]);

/**
 * The source languages a test command can be scoped to (code-delivery-tests.mjs reads them in this
 * order). A command's optional `ecosystem` makes it evidence only for that language's source and files
 * of no language below its roots, as an inferred command is; a test setup suggestion carries its own.
 * An older engine ignores it, like any key unknown here, and covers every file below the roots.
 */
const TEST_COMMAND_ECOSYSTEMS = Object.freeze(['node', 'python', 'jvm', 'dotnet', 'go', 'rust', 'swift', 'ruby', 'php', 'dart']);


/**
 * A command's literal `env` [TCE]: unreserved UPPER_CASE names, none secret-like (environments.yml holds
 * those), short values, in name order. An older engine ignores it, like any key unknown here.
 */
function normalizeCommandEnv(value, index) {
  const at = `qualityCommands[${index}].env`;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) {
    throw new SingularityFlowError(`${at} must map at most 64 names to literal values.`, { code: 'QUALITY_COMMAND_ENV_INVALID' });
  }
  const entries = Object.keys(value).sort().map((name) => {
    const raw = value[name];
    const secret = looksSecretName(name);
    // `_X` is checked as `X_X`: the reserved rule is environments.yml's, whose names start with a letter.
    if (secret || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) || !declarableEnvironmentVariable(name.replace(/^_/u, 'X_'))
        || !['string', 'number', 'boolean'].includes(typeof raw)
        || String(raw).length > 4_096 || /[\u0000-\u001f\u007f]/u.test(String(raw))) {
      throw new SingularityFlowError(secret ? `${at}.${name} names a secret: declare it in ${ENVIRONMENT_DECLARATION_PATH}, never in workflow.yml.`
        : `${at}.${name} must be an unreserved UPPER_CASE name (not PATH, HOME, NODE_*, GIT_*) with short literal text.`,
      { code: secret ? 'QUALITY_COMMAND_ENV_SECRET' : 'QUALITY_COMMAND_ENV_INVALID' });
    }
    return [name, String(raw)];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}


function relativePath(value, label, { allowDot = false } = {}) {
  const proposed = String(value ?? '').replaceAll('\\', '/');
  const normalized = proposed.replace(/^\.\//, '').replace(/\/$/, '');
  const collapsed = normalized ? path.posix.normalize(normalized) : normalized;
  if ((!collapsed && !allowDot) || normalized.split('/').includes('..')
      || collapsed === '..' || collapsed.startsWith('../')
      || collapsed.startsWith('/') || /^[A-Za-z]:\//.test(collapsed)) {
    throw new SingularityFlowError(`${label} must be repository-relative.`);
  }
  return collapsed || '.';
}


function normalizeExternalCommand(value, index = 0) {
  if (typeof value === 'string' && value.trim()) {
    // Legacy string commands are still readable, but they are gates, not optional hints. If their
    // model behavior is unknown while models are disabled, the resulting unavailability blocks
    // submission instead of being mislabeled as a passing validation.
    return {
      id: value.trim(), command: value.trim(), argv: null, modelPolicy: 'unknown',
      requirement: 'required', timeoutMs: null
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`qualityCommands[${index}] must be a command string or object.`);
  }
  const argv = Array.isArray(value.argv) ? value.argv.map(String) : null;
  const command = typeof value.command === 'string' && value.command.trim() ? value.command.trim() : null;
  if ((!argv?.length && !command) || (argv?.length && command)) {
    throw new SingularityFlowError(`qualityCommands[${index}] must define exactly one of command or argv.`);
  }
  const modelPolicy = value.modelPolicy ?? 'unknown';
  if (!EXTERNAL_MODEL_POLICIES.includes(modelPolicy)) {
    throw new SingularityFlowError(`qualityCommands[${index}].modelPolicy must be ${EXTERNAL_MODEL_POLICIES.join(', ')}.`);
  }
  const id = String(value.id ?? command ?? argv.join(' ')).trim();
  if (!id) throw new SingularityFlowError(`qualityCommands[${index}].id must be non-empty.`);
  const requirement = value.requirement ?? 'required';
  if (!QUALITY_COMMAND_REQUIREMENTS.includes(requirement)) {
    throw new SingularityFlowError(`qualityCommands[${index}].requirement must be ${QUALITY_COMMAND_REQUIREMENTS.join(' or ')}.`);
  }
  const timeoutMs = value.timeoutMs ?? null;
  if (timeoutMs != null && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 2 * 60 * 60 * 1_000)) {
    throw new SingularityFlowError(`qualityCommands[${index}].timeoutMs must be an integer from 1000 through 7200000.`);
  }
  const kind = value.kind ?? null;
  if (kind != null && !QUALITY_COMMAND_KINDS.includes(kind)) {
    throw new SingularityFlowError(`qualityCommands[${index}].kind must be ${QUALITY_COMMAND_KINDS.join(', ')}.`);
  }
  const environment = value.environment == null ? null : String(value.environment).trim();
  if (environment != null && !ENVIRONMENT_ID_PATTERN.test(environment)) {
    throw new SingularityFlowError(
      `qualityCommands[${index}].environment must be a lower-kebab environment identifier.`
    );
  }
  if (environment != null && command) {
    throw new SingularityFlowError(
      `qualityCommands[${index}] uses environment '${environment}' and must use argv instead of a shell command.`
    );
  }
  const env = value.env == null ? null : normalizeCommandEnv(value.env, index);
  if (value.ecosystem != null && !TEST_COMMAND_ECOSYSTEMS.includes(value.ecosystem)) {
    throw new SingularityFlowError(`qualityCommands[${index}].ecosystem must be ${TEST_COMMAND_ECOSYSTEMS.join(', ')}.`,
      { code: 'QUALITY_COMMAND_ECOSYSTEM_INVALID' });
  }
  const workingDirectory = value.workingDirectory == null
    ? null
    : relativePath(value.workingDirectory, `qualityCommands[${index}].workingDirectory`, { allowDot: true });
  const affectedRoots = value.affectedRoots == null ? [] : value.affectedRoots;
  if (!Array.isArray(affectedRoots) || affectedRoots.some((root) => typeof root !== 'string')) {
    throw new SingularityFlowError(`qualityCommands[${index}].affectedRoots must be an array of repository-relative paths.`);
  }
  const normalizedRoots = [...new Set(affectedRoots.map((root) => relativePath(root, `qualityCommands[${index}].affectedRoots`, { allowDot: true })))];
  let result = null;
  if (value.result != null) {
    if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
      throw new SingularityFlowError(`qualityCommands[${index}].result must be an object.`);
    }
    if (!TEST_RESULT_ADAPTERS.includes(value.result.adapter)) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.adapter must be ${TEST_RESULT_ADAPTERS.join(', ')}.`);
    }
    const minimumDiscovered = value.result.minimumDiscovered ?? 1;
    if (!Number.isInteger(minimumDiscovered) || minimumDiscovered < 1) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.minimumDiscovered must be a positive integer.`);
    }
    const minimumPassed = value.result.minimumPassed ?? 1;
    if (!Number.isInteger(minimumPassed) || minimumPassed < 1) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.minimumPassed must be a positive integer.`);
    }
    const sourceExtensions = value.result.sourceExtensions ?? [];
    if (!Array.isArray(sourceExtensions) || sourceExtensions.some((extension) =>
      typeof extension !== 'string' || !/^\.[a-z0-9][a-z0-9.+-]{0,15}$/i.test(extension))) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.sourceExtensions must contain file extensions such as '.exs'.`);
    }
    result = {
      adapter: value.result.adapter,
      path: relativePath(value.result.path, `qualityCommands[${index}].result.path`),
      minimumDiscovered,
      minimumPassed,
      sourceExtensions: [...new Set(sourceExtensions.map((extension) => extension.toLowerCase()))]
    };
  }
  return {
    id, command, argv, modelPolicy, requirement, timeoutMs,
    ...(value.kind != null ? { kind } : {}),
    ...(environment != null ? { environment } : {}),
    ...(env ? { env } : {}),
    ...(value.ecosystem != null ? { ecosystem: value.ecosystem } : {}),
    ...(value.workingDirectory != null ? { workingDirectory } : {}),
    ...(value.affectedRoots != null ? { affectedRoots: normalizedRoots } : {}),
    ...(value.result != null ? { result } : {})
  };
}
    return { EXTERNAL_MODEL_POLICIES, QUALITY_COMMAND_KINDS, QUALITY_COMMAND_REQUIREMENTS, ENVIRONMENT_ID_PATTERN, TEST_RESULT_ADAPTERS, TEST_COMMAND_ECOSYSTEMS, normalizeExternalCommand };
  });
}

// test-selection-policy.mjs
export function testSelectionPolicies(port) {
  return pathPolicy(port, "testSelectionPolicies", ({ path, posix }) => {



function refuse(message, code = 'TEST_SELECTION_INVALID') {
  throw new SingularityFlowError(message, { code });
}


/** Normalize repository-relative paths independently of the machine running the preview. */
function normalizeTestSelectionPath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/u.test(value)) {
    refuse('Test-selection paths must be nonempty repository-relative paths.');
  }
  const candidate = value.replaceAll('\\', '/');
  if (/^(?:\/|[a-z]:)/iu.test(candidate) || candidate.split('/').includes('..')) {
    refuse(`Test-selection path '${value}' is outside the repository.`);
  }
  const normalized = path.posix.normalize(candidate).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized || (normalized === '.' && !allowRoot)) refuse(`Invalid test-selection path '${value}'.`);
  return normalized || '.';
}
    return { normalizeTestSelectionPath, refuse };
  });
}

// trp-document-policy.mjs
export function trpDocumentPolicies(port) {
  return pathPolicy(port, "trpDocumentPolicies", ({ path, posix }) => {
    const { normalizeTestSelectionPath } = testSelectionPolicies(port);


const fail = message => { throw new SingularityFlowError(message, { code: 'TRP_DOCUMENT_POLICY_INVALID' }); };

function normalizeDocumentObligations(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) fail('documentObligations needs 1–64 explicitly named supplemental Markdown documents.');
  const seen = new Set(); const paths = new Set();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['id', 'phaseId', 'path', 'requiredSections'].includes(key))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.id ?? '')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.phaseId ?? '')
      || entry.id.includes('..') || entry.phaseId.includes('..')) fail('Every supplemental document needs a safe ID and phase.');
    let relative;
    try { relative = normalizeTestSelectionPath(entry.path); } catch { fail('A supplemental document needs a safe repository-relative path.'); }
    if (relative !== entry.path || !/\.md$/iu.test(relative)
      || /(^|\/)(?:\.[^/]+|singularity|AGENTS\.md|SKILL\.md|USER-STORY\.md)(?:\/|$)/iu.test(relative)) {
      fail('Only ordinary supplemental Markdown paths outside authority, Story and agent instructions may be declared nonessential.');
    }
    const pair = `${entry.phaseId}:${entry.id}`; const target = `${entry.phaseId}:${relative.toLowerCase()}`;
    if (seen.has(pair) || paths.has(target)) fail('Supplemental document IDs and paths must be unique per phase.');
    seen.add(pair); paths.add(target);
    const sections = entry.requiredSections ?? [];
    if (!Array.isArray(sections) || sections.length > 32 || new Set(sections).size !== sections.length
      || sections.some(item => typeof item !== 'string' || item !== item.trim() || !item.length
        || item.length > 256 || /[\x00-\x1f\x7f]/u.test(item))) fail('Document sections must be bounded, unique heading names.');
    return { id: entry.id, phaseId: entry.phaseId, path: relative, requiredSections: sections };
  });
}
    return { normalizeDocumentObligations };
  });
}

// test-recovery-intake.mjs
export function testRecoveryConfigurationPolicies(port) {
  return pathPolicy(port, "testRecoveryConfigurationPolicies", ({ path, posix }) => {
    const { normalizeDocumentObligations } = trpDocumentPolicies(port);
    const { normalizeTestSelectionPath } = testSelectionPolicies(port);

const fail = (message, code = 'TRP_POLICY_INVALID') => { throw new SingularityFlowError(message, { code }); };


/** Independent approved identities, never an inventory inferred from a test report. */
function normalizeCaseInventory(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) fail('testRecovery.caseInventory needs 1–64 phase/command entries.');
  const entries = new Set();
  let total = 0;
  const ordinary = (text, max) => typeof text === 'string' && text.trim().length > 0
    && text === text.trim() && text.length <= max && !/[\x00-\x1f\x7f]/u.test(text);
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => !['phaseId', 'commandId', 'adapter', 'runtime', 'baselineMutableRoots', 'dependencyScope', 'tests'].includes(key))
        || !ordinary(entry.phaseId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.phaseId)
        || entry.phaseId.includes('..') || !ordinary(entry.commandId, 256)
        || !Array.isArray(entry.tests) || !entry.tests.length || (total += entry.tests.length) > 10_000) {
      fail('Invalid or oversized testRecovery.caseInventory entry.');
    }
    const adapter = entry.adapter ?? 'node-test-junit-v1';
    if (!['node-test-junit-v1', 'pytest-junit-v1', 'maven-surefire-junit-v1'].includes(adapter)) fail('Unsupported approved testcase adapter.');
    const node = adapter === 'node-test-junit-v1';
    if (entry.dependencyScope !== (node ? 'repository-and-node-builtins-only' : 'repository-and-declared-runtime-only')) fail('Approved testcase dependency scope does not match its runner.');
    let runtime;
    if (node) {
      if (entry.runtime !== undefined) fail('Native Node inventory uses the current qualified Node runtime, not a declared external runtime.');
    } else {
      runtime = entry.runtime;
      if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
          || Object.keys(runtime).some(key => !['executableSha256', 'dependencyRoots'].includes(key))
          || !/^sha256:[a-f0-9]{64}$/u.test(runtime.executableSha256 ?? '')
          || !Array.isArray(runtime.dependencyRoots) || !runtime.dependencyRoots.length || runtime.dependencyRoots.length > 8
          || new Set(runtime.dependencyRoots).size !== runtime.dependencyRoots.length
          || runtime.dependencyRoots.some(root => !ordinary(root, 4096) || !path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root)) {
        fail('Declared runtimes need an exact executable SHA-256 and 1–8 canonical, non-root absolute dependency roots.');
      }
      runtime = { executableSha256: runtime.executableSha256, dependencyRoots: [...runtime.dependencyRoots] };
    }
    const pair = JSON.stringify([entry.phaseId, entry.commandId]);
    if (entries.has(pair)) fail('Duplicate testRecovery.caseInventory phase/command.');
    entries.add(pair);
    const ids = new Set(); const identities = new Set(); const files = new Set();
    const tests = entry.tests.map(test => {
      if (!test || typeof test !== 'object' || Array.isArray(test)
          || Object.keys(test).some(key => !['id', 'path', 'name', 'className'].includes(key))
          || !ordinary(test.id, 256) || !ordinary(test.name, 4096) || !ordinary(test.path, 1024)
          || (!node && !ordinary(test.className, 4096)) || (node && test.className !== undefined)) {
        fail('Each approved test needs an exact ID, repository-relative path and native report name.');
      }
      let normalized;
      try { normalized = normalizeTestSelectionPath(test.path); } catch { fail('Approved test paths must be safe repository-relative paths.'); }
      if (normalized !== test.path || test.path.includes('\\')) fail('Approved test paths must use canonical forward slashes.');
      const identity = JSON.stringify([node ? test.path : test.className, test.name]);
      if (ids.has(test.id) || identities.has(identity)) fail('Approved test IDs and file/name pairs must be unique per command.');
      ids.add(test.id); identities.add(identity); files.add(test.path);
      return { id: test.id, path: test.path, name: test.name, ...(!node ? { className: test.className } : {}) };
    });
    if (files.size > 256) fail('Approved test inventory exceeds 256 files per command.');
    let baselineMutableRoots;
    if (entry.baselineMutableRoots !== undefined) {
      const roots = entry.baselineMutableRoots;
      if (!Array.isArray(roots) || !roots.length || roots.length > 16 || new Set(roots).size !== roots.length) fail('Baseline mutable source roots need 1–16 distinct repository directories.');
      baselineMutableRoots = roots.map(root => {
        let normalized;
        try { normalized = normalizeTestSelectionPath(root); } catch { fail('Baseline mutable roots must be canonical repository directories.'); }
        if (!ordinary(root, 1024) || root !== normalized || root.includes('\\') || root === '.'
          || /(?:^|\/)(?:\.git|singularity|node_modules|vendor|target|build|dist|tests?|fixtures?|config|configuration|\.venv|venv)(?:\/|$)/iu.test(root)
          || /\.[a-z0-9]+$/iu.test(root)
          || tests.some(test => test.path === root || test.path.startsWith(`${root}/`))) fail('Baseline mutable roots must exclude approved tests, fixtures, dependency, configuration and framework paths.');
        return root;
      });
      if (baselineMutableRoots.some((root, index) => baselineMutableRoots.some((other, otherIndex) => index !== otherIndex && root.startsWith(`${other}/`)))) fail('Baseline mutable source roots must not overlap.');
    }
    return { phaseId: entry.phaseId, commandId: entry.commandId, ...(entry.adapter ? { adapter } : {}),
      ...(runtime ? { runtime } : {}), ...(baselineMutableRoots ? { baselineMutableRoots } : {}), dependencyScope: entry.dependencyScope, tests };
  });
}


function normalizeTestRecoveryPolicy(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('testRecovery must be an object.');
  const allowed = new Set(['enabled', 'riskAuthorities', 'enabledRiskCategories', 'maxRiskDays',
    'maxDistinctAutomaticAttempts', 'allowEvidenceReuse', 'maxEvidenceAgeSeconds', 'caseInventory', 'documentObligations']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Unknown testRecovery field '${key}'.`);
  if (typeof value.enabled !== 'boolean') fail('testRecovery.enabled must be explicitly true or false.');
  const list = (key, fallback) => {
    const result = value[key] ?? fallback;
    if (!Array.isArray(result) || result.length > 32 || new Set(result).size !== result.length
      || result.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(item))) fail(`Invalid testRecovery.${key}.`);
    return [...result];
  };
  const integer = (key, fallback, minimum, maximum) => {
    const n = value[key] ?? fallback;
    if (!Number.isSafeInteger(n) || n < minimum || n > maximum) fail(`Invalid testRecovery.${key}.`);
    return n;
  };
  const categories = list('enabledRiskCategories', []);
  if (categories.some(category => !TRP_RISK_CATEGORIES.includes(category))) fail('Unsupported testRecovery risk category.');
  const authorities = list('riskAuthorities', []);
  if (categories.length && !authorities.length) fail('Enabled risks require explicit testRecovery.riskAuthorities.');
  if (value.allowEvidenceReuse != null && typeof value.allowEvidenceReuse !== 'boolean') fail('testRecovery.allowEvidenceReuse must be boolean.');
  const caseInventory = value.caseInventory === undefined ? undefined : normalizeCaseInventory(value.caseInventory);
  const documentObligations = value.documentObligations === undefined ? undefined : normalizeDocumentObligations(value.documentObligations);
  if (categories.includes('nonessential-document') && !documentObligations?.length) fail('Nonessential-document review requires explicitly declared supplemental document obligations.');
  if (categories.some(category => ['new-test-failure', 'known-test-failure', 'reduced-coverage'].includes(category)) && (!caseInventory || value.allowEvidenceReuse !== true)) {
    fail('Failed-test review requires an independently approved caseInventory and explicit allowEvidenceReuse: true. Observations remain failed; each transition needs its own review.', 'TRP_RISK_ADAPTER_UNAVAILABLE');
  }
  if (value.allowEvidenceReuse === true && !categories.some(category => ['new-test-failure', 'known-test-failure', 'reduced-coverage'].includes(category))) fail('Evidence reuse is supported only for explicitly enabled, independently inventoried failed-test or reduced-coverage review.', 'TRP_EVIDENCE_REUSE_UNAVAILABLE');
  return {
    enabled: value.enabled, riskAuthorities: authorities, enabledRiskCategories: categories,
    maxRiskDays: integer('maxRiskDays', 30, 1, 30),
    maxDistinctAutomaticAttempts: integer('maxDistinctAutomaticAttempts', 3, 0, 3),
    allowEvidenceReuse: value.allowEvidenceReuse ?? false,
    maxEvidenceAgeSeconds: integer('maxEvidenceAgeSeconds', 86400, 1, 2592000),
    ...(caseInventory ? { caseInventory } : {}), ...(documentObligations ? { documentObligations } : {})
  };
}
    return { normalizeTestRecoveryPolicy, fail };
  });
}

/** Bounded configuration-asset transport rules; string capabilities do not grant file access. */
export function configurationAssetPolicies(port) {
  configurationPathSyntaxV2(port);
  return pathPolicy(port, 'configurationAssetPolicies', ({ path }) => {


const DEFAULT_RUNTIME_ROOTS = Object.freeze([
  '.sdlc',
  '.sflow',
  '.singularity',
  'singularity/initiatives',
  'singularity/work-items',
  'singularity/seeds',
  'singularity/world-model',
  'singularity/knowledge',
  'singularity/pins',
  'singularity/identity-reservations',
  'singularity/sgos-drafts',
  'singularity/telemetry',
  'singularity/.product'
]);

const WINDOWS_RESERVED_COMPONENT = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i;


function hasUnsafePortableComponent(candidate) {
  return candidate.split('/').some((component) => {
    const folded = component.toLowerCase();
    return folded === '.git'
      || component.endsWith('.') || component.endsWith(' ')
      || component.includes(':')
      || /[*?"<>|]/u.test(component)
      || /~[0-9]/u.test(component)
      || /[\u0000-\u001f]/u.test(component)
      || WINDOWS_RESERVED_COMPONENT.test(component);
  });
}


function invalidRoot(label, value) {
  const error = new Error(`${label} must be a canonical repository-relative portable path: ${value}`);
  error.name = 'SingularityFlowError';
  error.code = 'CONFIGURATION_ASSET_ROOT_INVALID';
  return error;
}


function portablePath(value, label) {
  const candidate = String(value ?? '').trim();
  if (!candidate || candidate.includes('\0') || candidate.includes('\\')
      || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
      || path.posix.normalize(candidate) !== candidate
      || candidate.normalize('NFC') !== candidate
      || /[^\x20-\x7e]/u.test(candidate)
      || candidate === '.' || candidate.endsWith('/')
      || candidate.split('/').includes('..')
      || hasUnsafePortableComponent(candidate)) {
    throw invalidRoot(label, value);
  }
  return candidate;
}


function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}


/**
 * Build the one bounded path policy used to transport and mount approved configuration.
 *
 * `singularity/` remains the conventional policy root, but its runtime children are excluded.
 * Generated world-model output remains runtime state even when the repository chooses a custom
 * destination. It is published and reconciled independently on the state branch; treating that
 * destination as configuration would copy generated bytes into Story branches and let a
 * configuration refresh overwrite the independently published model.
 */
function configurationAssetPolicy(workflow = {}, portfolio = {}) {
  const configuredWorldModelRoot = portablePath(
    workflow.worldModel?.outputDir ?? 'singularity/world-model', 'worldModel.outputDir'
  );
  const roots = unique([
    portablePath(workflow.templatesRoot ?? 'singularity/templates', 'templatesRoot'),
    // Governed Agent Markdown is discovered from this canonical repository location by every
    // runtime. `agentPromptsRoot` may add an organisation/editor transport root, but it cannot
    // remove the framework-agent authority that refresh/reinitialize must mirror and validate.
    '.github/agents',
    portablePath(workflow.agentPromptsRoot ?? '.github/agents', 'agentPromptsRoot'),
    portablePath(portfolio.templatesRoot ?? workflow.templatesRoot ?? 'singularity/templates',
      'portfolio.templatesRoot')
  ]);
  const files = unique([
    // Which agents in .github/agents APM deployed, with each file's hash: read with them wherever
    // configuration is read (a Story's base, the approved configuration) [APM].
    'apm.lock.yaml',
    workflow.worldModel?.promptSource && workflow.worldModel.promptSource !== 'builtin'
      ? portablePath(workflow.worldModel.promptSource, 'worldModel.promptSource')
      : null
  ]);
  const runtimeRoots = unique([
    ...DEFAULT_RUNTIME_ROOTS,
    configuredWorldModelRoot,
    workflow.workItemRoot
      ? portablePath(workflow.workItemRoot, 'workItemRoot')
      : 'singularity/work-items',
    portfolio.initiativeRoot
      ? portablePath(portfolio.initiativeRoot, 'portfolio.initiativeRoot')
      : 'singularity/initiatives'
  ]);
  return Object.freeze({
    roots: Object.freeze(roots),
    files: Object.freeze(files),
    runtimeRoots: Object.freeze(runtimeRoots)
  });
}


function mergeConfigurationAssetPolicies(...policies) {
  return Object.freeze({
    roots: Object.freeze(unique(policies.flatMap((policy) => policy?.roots ?? []))),
    files: Object.freeze(unique(policies.flatMap((policy) => policy?.files ?? []))),
    runtimeRoots: Object.freeze(unique(policies.flatMap((policy) => policy?.runtimeRoots ?? [])))
  });
}


const DEFAULT_CONFIGURATION_ASSET_POLICY = configurationAssetPolicy();


function within(relative, root) {
  return relative === root || relative.startsWith(`${root}/`);
}


function withinFilesystemIdentity(relative, root) {
  // Configuration paths are portable Git spellings, but the checkout may live on a
  // case-insensitive Windows or macOS filesystem. Runtime exclusion is a safety boundary, so use
  // the most restrictive portable identity here without collapsing legitimate configured search
  // roots on a case-sensitive filesystem.
  const candidate = portableFilesystemPathIdentity(relative);
  const boundary = portableFilesystemPathIdentity(root);
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}


function portableConfigurationPath(value) {
  const relative = String(value ?? '').replace(/^\.\//, '');
  if (!relative || relative.includes('\0') || relative.includes('\\')
      || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)
      || path.posix.normalize(relative) !== relative || relative.normalize('NFC') !== relative
      || relative.split('/').includes('..')
      || hasUnsafePortableComponent(relative)) return null;
  return relative;
}


function isConfigurationAssetPath(value, policy = DEFAULT_CONFIGURATION_ASSET_POLICY) {
  const relative = portableConfigurationPath(value);
  if (!relative || relative === 'singularity/configuration-source.json') return false;
  // Runtime ownership is the stronger boundary. In particular, a custom world-model output must
  // never become configuration merely because it is nested under a configured template/agent root.
  if (policy.runtimeRoots.some((root) => withinFilesystemIdentity(relative, root))) return false;
  if (policy.files.includes(relative) || policy.roots.some((root) => within(relative, root))) return true;
  if (!within(relative, 'singularity')) return false;
  return true;
}


/** Bounded Git/path-walk roots; never collapse custom roots into the repository root. */
function configurationAssetSearchRoots(policy = DEFAULT_CONFIGURATION_ASSET_POLICY) {
  return unique([
    'singularity',
    ...policy.roots.filter((root) => !within(root, 'singularity')),
    ...policy.files.filter((file) => !within(file, 'singularity'))
  ]);
}
    return { configurationAssetPolicy, mergeConfigurationAssetPolicies, DEFAULT_CONFIGURATION_ASSET_POLICY,
      portableConfigurationPath, isConfigurationAssetPath, configurationAssetSearchRoots };
  });
}
