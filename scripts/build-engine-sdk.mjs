/** Build only: no install scripts, repository discovery, source control or runtime provider. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENGINE_CONTRACT, ENGINE_HELPERS, ENGINE_OPERATIONS } from '../src/engine-sdk/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(root, 'packages/engine-sdk');
const entryNames = Object.freeze(['index', 'errors', 'namespace', 'content', 'artifacts', 'source', 'sources/filesystem', 'hosts/namespace-source', 'hosts/namespace-reader', 'hosts/namespace-project', 'hosts/namespace-configuration', 'hosts/namespace-story',
  'storage/filesystem', 'storage/sqlite', 'storage/sqlite-content', 'storage/application', 'storage/journal']);
const builtins = new Set(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:sqlite', 'node:net']);
const adapterNames = new Set(['filesystem-namespace-adapter', 'filesystem-namespace-journal', 'namespace-journal-adapter',
  'application-namespace-adapter', 'sqlite-namespace-adapter', 'sqlite-namespace-journal', 'sqlite-native', 'sqlite-content-adapter']);

function allowedSource(relative) {
  return relative.startsWith('packages/engine-sdk/src/') || /^src\/(foundation|kernel|engine-sdk|engine-storage|sda\/(namespace|content))\//u.test(relative)
    || ['src/records.mjs', 'src/document-identity.mjs', 'src/authoring-skills.mjs', 'src/sgos/filesystem-source-unit.mjs',
      'src/engine-compatibility/node-configuration-path.mjs', 'src/engine-compatibility/node-network-syntax.mjs',
      'src/engine-compatibility/node-namespace-configuration.mjs'].includes(relative)
    || /^src\/sda\/([^/]+)\.mjs$/u.test(relative) && adapterNames.has(path.posix.basename(relative, '.mjs'));
}

function inputType(operation, field) {
  if (operation.id === 'source.bind') return field === 'repositories' ? 'readonly string[]' : 'string';
  if (operation.id === 'story.create') return field === 'source' ? 'ContentReference' : 'string';
  if (operation.id === 'configuration.approve') {
    if (field === 'source') return 'ContentReference';
    if (['confirm','reason'].includes(field)) return 'string';
  }
  if (field === 'operationId') return 'string';
  if (['workId', 'phaseId'].includes(field)) return 'string | null';
  if (['fetch', 'compose', 'adoptExisting', 'runChecks', 'confirmEvidence', 'notApplicable', 'open', 'fromArtifact', 'repair', 'dryRun'].includes(field)) return 'boolean | null';
  if (field === 'maximumBytes') return 'number | null';
  if (field === 'includeDetached') return 'boolean | null';
  if (field === 'confirmation' && operation.id === 'phase.approve') return 'ApprovalConfirmation | null';
  if (['usage', 'answers', 'decisions', 'decisionValues', 'command', 'reference'].includes(field)) return 'JsonValue';
  if (['changeOrigins', 'clauseIds', 'transitions', 'sourceRoots', 'members'].includes(field)) return 'readonly string[] | null';
  if (field === 'workflowIds') return 'readonly string[]';
  if (['checklist', 'witnessMappings', 'bindingDecisions', 'changes', 'operations'].includes(field)) return 'readonly JsonValue[] | null';
  return 'string | null';
}

/** Names/fields/helpers come from the executable registry. Runtime remains the admission authority. */
export function engineDeclarations() {
  return `// Generated from the executable engine registry. Context-dependent constraints are checked at runtime.
import type { JsonValue } from './namespace.mjs';
import type { ContentReference } from './content.mjs';
export * from './errors.mjs';
export type { JsonValue } from './namespace.mjs';
export declare const ENGINE_CONTRACT: ${JSON.stringify(ENGINE_CONTRACT)};
export interface ApprovalConfirmation { readonly workId: string; readonly phase: string; readonly generation: number; readonly reviewPacketSha256: string }
export interface EngineInputs {
${ENGINE_OPERATIONS.map(operation => `  readonly ${JSON.stringify(operation.id)}: {\n${operation.inputFields.map(field =>
    `    readonly ${JSON.stringify(field)}${operation.requiredFields?.includes(field) ? '' : '?'}: ${inputType(operation, field)};`).join('\n')}\n  };`).join('\n')}
}
export type EngineOperation = keyof EngineInputs;
export interface EngineResult<O extends EngineOperation = EngineOperation> {
  readonly schemaVersion: 1; readonly contract: typeof ENGINE_CONTRACT; readonly operation: O;
  readonly [name: string]: JsonValue;
}
export interface EngineOptions { readonly signal?: AbortSignal | null }
export interface EngineOperationDescriptor { readonly id: EngineOperation; readonly version: 1; readonly effect: string;
  readonly inputFields: readonly string[]; readonly stages: readonly string[]; readonly port: string;
  readonly humanDecision?: boolean; readonly authority?: string; readonly confirmation?: string | null;
  readonly [name: string]: JsonValue | undefined;
}
export declare const ENGINE_OPERATIONS: readonly EngineOperationDescriptor[];
export declare const ENGINE_HELPERS: Readonly<{
${Object.entries(ENGINE_HELPERS).map(([helper, operation]) => `  ${helper}: ${JSON.stringify(operation)};`).join('\n')}
}>;
/** Trusted construction-time ports, not operation inputs. Implementations must enforce their declared binding and authority. */
export type EngineStage = (...parameters: unknown[]) => unknown;
export type EnginePort = Readonly<Record<string, EngineStage>>;
export interface Engine {
  readonly contract: typeof ENGINE_CONTRACT; readonly operations: typeof ENGINE_OPERATIONS;
  run<O extends EngineOperation>(operation: O, ...args: {} extends EngineInputs[O]
    ? [inputs?: EngineInputs[O], options?: EngineOptions]
    : [inputs: EngineInputs[O], options?: EngineOptions]): Promise<EngineResult<O>>;
${Object.entries(ENGINE_HELPERS).map(([helper, operation]) =>
    `  ${helper}(inputs?: EngineInputs[${JSON.stringify(operation)}], options?: EngineOptions): Promise<EngineResult<${JSON.stringify(operation)}>>;`).join('\n')}
}
export declare function createEngine(options: { ports: Readonly<Record<string, EnginePort>> }): Engine;
`;
}

async function exists(file) { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function promote(staging, destination) {
  const previous = await exists(destination);
  if (!previous) { await rename(staging, destination); return; }
  if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('SDK build output must be an ordinary generated directory.');
  const receipt = JSON.parse(await readFile(path.join(destination, 'build.json'), 'utf8'));
  if (receipt.package !== '@singularity-flow/engine-sdk' || receipt.schemaVersion !== 1) throw new Error('SDK build refuses to replace an unrecognized directory.');
  const backup = await mkdtemp(path.join(path.dirname(destination), '.engine-sdk-previous-'));
  await rename(destination, path.join(backup, 'dist'));
  try { await rename(staging, destination); }
  catch (error) { await rename(path.join(backup, 'dist'), destination); await rm(backup, { recursive: true, force: true }); throw error; }
  await rm(backup, { recursive: true, force: true });
}

export async function buildEngineSdk({ outdir = path.join(workspace, 'dist') } = {}) {
  if (!path.isAbsolute(outdir) || path.basename(outdir) !== 'dist') throw new Error('SDK output must be an absolute dist directory.');
  const destination = path.resolve(outdir);
  if (destination === path.join(root, 'dist') || destination.startsWith(path.join(root, 'src') + path.sep)
    || destination.startsWith(path.join(workspace, 'src') + path.sep)) throw new Error('SDK build cannot replace source or the product distribution.');
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), '.engine-sdk-building-'));
  try {
    const result = await build({ absWorkingDir: root,
      entryPoints: Object.fromEntries(entryNames.map(name => [name, path.join(workspace, 'src', name + '.mjs')])),
      outdir: staging, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22',
      outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]', metafile: true, write: false,
      sourcemap: false, legalComments: 'none', logLevel: 'silent' });
    for (const [source, facts] of Object.entries(result.metafile.inputs)) {
      if (!allowedSource(source.replaceAll('\\', '/'))) throw new Error(`SDK build has an unowned source dependency: ${source}`);
      for (const imported of facts.imports) if (imported.external && !builtins.has(imported.path)) throw new Error(`SDK build has an unsupported external dependency: ${imported.path}`);
    }
    for (const output of result.outputFiles) {
      const relative = path.relative(staging, output.path);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SDK build emitted outside its staging directory.');
      await mkdir(path.dirname(output.path), { recursive: true }); await writeFile(output.path, output.contents);
    }
    await cp(path.join(workspace, 'types'), staging, { recursive: true });
    await writeFile(path.join(staging, 'index.d.mts'), engineDeclarations());
    const outputs = Object.fromEntries(result.outputFiles.map(output => [path.relative(staging, output.path).replaceAll('\\', '/'), {
      bytes: output.contents.length, sha256: createHash('sha256').update(output.contents).digest('hex') }]));
    const report = { schemaVersion: 1, package: '@singularity-flow/engine-sdk', contract: ENGINE_CONTRACT,
      operations: ENGINE_OPERATIONS.map(({ id, version, inputFields, requiredFields, port, stages }) => ({ id, version, inputFields,
        ...(requiredFields ? { requiredFields } : {}), port, stages })),
      sources: Object.keys(result.metafile.inputs).sort(), outputs };
    await writeFile(path.join(staging, 'build.json'), JSON.stringify(report, null, 2) + '\n');
    await promote(staging, destination);
    return report;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--outdir')) throw new Error('Usage: node scripts/build-engine-sdk.mjs [--outdir /absolute/package/dist]');
  const result = await buildEngineSdk(args.length ? { outdir: path.resolve(args[1]) } : {});
  process.stdout.write(JSON.stringify({ package: result.package, operations: result.operations.length,
    modules: result.sources.length, bytes: Object.values(result.outputs).reduce((sum, output) => sum + output.bytes, 0) }) + '\n');
}
