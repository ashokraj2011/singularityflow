/**
 * The runtime check (step intents spec §12.3, owner decision D6): after a code step publishes and before its review,
 * SFlow runs the changed software the way a developer would try it, by the kind of each project the change touches
 * (software-kind-record.mjs), and hands what it saw to the reviewer:
 *   web      start the app with Run & Test's start entry, then type and click in SFlow's browser (runtime-check-web.mjs);
 *   backend  start the service, then call each changed endpoint (runtime-check-backend.mjs); the API contract against
 *            the base is compared even when it cannot start;
 *   cli      run each declared command with --help and a bad argument (runtime-check-cli.mjs);
 *   library  compare its public API with the base (runtime-check-library.mjs).
 * Job, mobile and artifact say what is missing to run them. The check is on while the Story's applicationReview is
 * optional or required; Stage 2's profiles set that by kind later.
 *
 * It is SFlow's own work: no model, the same on every host. It never blocks for its own environment: what cannot run
 * on this laptop (no start entry, a secret, no browser) is named in `missing`, with the command that provides it, and
 * the rest runs. Its capture is private to this checkout (under its Git directory), one per step version, and is
 * read by the review, by "Try it" at approval and by `app-review runtime-check`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SingularityFlowError } from './util.mjs';

export const RUNTIME_CHECK_FORMAT = 'sflow-runtime-check/v1';
export const RUNNABLE_KINDS = Object.freeze(['web', 'backend', 'job', 'cli', 'mobile']);
const MAXIMUM_PROJECTS = 3;
const MAXIMUM_FINDINGS = 60;
const safe = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 120) || 'step';

/** Whether the Story asks for the runtime check: its applicationReview is optional or required. */
export function runtimeCheckAdopted(workflow) {
  const mode = workflow?.resolution?.applicationReview?.mode;
  return mode === 'optional' || mode === 'required';
}

export async function runtimeCheckFile(root, workId, phaseId, generation) {
  const { gitDir } = await import('./git-execution.mjs');
  const directory = path.join(gitDir(root), 'singularity-flow', 'runtime-checks', safe(workId));
  return { directory, file: path.join(directory, `${safe(phaseId)}-v${generation}.json`), screenshots: path.join(directory, `${safe(phaseId)}-v${generation}`) };
}

async function headCommit(root) {
  try { return (await import('./git-access.mjs')).typedRevision(root, 'HEAD'); } catch { return null; }
}

/**
 * What the version delivered, as its publication recorded it: each delivered path with its digest. SFlow's own Story
 * commits (a retained review, a submission) move HEAD and change none of it, so they never make the check run again.
 */
export function deliveredSourceKey(phase) {
  const paths = (phase?.deliveryEvidence?.paths ?? []).map((entry) => [entry?.path ?? null, entry?.sha256 ?? null, entry?.exists ?? null]);
  const recorded = [...(phase?.deliveryEvidence?.sourcePaths ?? [])].sort();
  return `sha256:${createHash('sha256').update(JSON.stringify({ generation: phase?.generation ?? null, paths, recorded })).digest('hex')}`;
}

/** The capture of `phaseId`'s current version on this checkout, with `current` false once what it delivered changed; null when none. */
export async function readRuntimeCheck(root, workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId];
  if (!workflow?.workItem?.id || !phase || !(phase.generation >= 1)) return null;
  const { file } = await runtimeCheckFile(root, workflow.workItem.id, phaseId, phase.generation);
  let capture;
  try { capture = JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  if (capture?.format !== RUNTIME_CHECK_FORMAT || capture.workId !== workflow.workItem.id || capture.phase !== phaseId || capture.generation !== phase.generation) return null;
  return { ...capture, current: capture.sourceKey === deliveredSourceKey(phase) };
}

/** The paths a code step's version changed: its recorded delivery paths and Git's diff against its baseline. */
async function changedPaths(root, workflow, phase) {
  const recorded = [...(phase.deliveryEvidence?.sourcePaths ?? []), ...(phase.deliveryEvidence?.paths ?? []).filter((entry) => entry?.exists !== false).map((entry) => entry?.path)];
  const base = phase.generationIntent?.baseline?.commit ?? workflow.workItem?.baseCommit ?? null;
  let diffed = [];
  if (base) { try { diffed = (await import('./git.mjs')).workingTreeChangedPaths(root, base); } catch { diffed = []; } }
  return { base, paths: [...new Set([...recorded, ...diffed].filter((entry) => typeof entry === 'string' && entry && !entry.startsWith('singularity/')))].sort() };
}

/** Text of files at a revision (`HEAD` or a commit): `Map(path → text)`, absent when missing. */
async function filesAt(root, ref, paths) {
  if (!ref || !paths.length) return new Map();
  const { committedFilesAtRevisions } = await import('./git.mjs');
  const read = committedFilesAtRevisions(root, paths.map((file) => ({ key: file, ref, path: file })));
  return new Map([...read].map(([file, bytes]) => [file, Buffer.from(bytes).toString('utf8')]));
}

/** The start entry of `project`: one whose working directory is in its folder, else the review profile's, else the only one. */
function projectEntry(context, project, policy) {
  const entries = context?.application?.start ?? [];
  const inFolder = project.root ? entries.filter((entry) => entry.workingDirectory === project.root || String(entry.workingDirectory ?? '').startsWith(`${project.root}/`)) : [];
  return inFolder[0] ?? entries.find((entry) => entry.id === policy?.preview?.entry) ?? (entries.length === 1 || !project.root ? entries[0] : null) ?? null;
}

/**
 * Run `use({ url, logs })` against `project`'s application: a running instance of its start entry is used as it is,
 * otherwise SFlow starts it, waits for it to be ready, and stops it afterwards. Returns `{ result, entry, reused }`,
 * or `{ missing }` naming what this checkout lacks to start it.
 */
async function withRunningApplication(root, project, policy, use, { deadline }) {
  let context;
  try { context = await (await import('./capability-application-context.mjs')).resolveCapabilityApplication(root, { subjectPath: project.root || '' }); }
  catch (error) { return { missing: [{ what: 'this checkout\'s application', why: String(error?.message ?? error).split('\n')[0], command: 'singularity-flow app plan --json' }] }; }
  const entry = projectEntry(context, project, policy);
  if (!entry) return { missing: [{ what: 'a saved start entry', why: 'SFlow needs to know how to start the app to try it.',
    command: 'singularity-flow app suggest --json', copilotCommand: '/sf-run-app suggest' }] };
  const run = await import('./application-run.mjs');
  try {
    const running = (await run.applicationStatus(root, context)).find((item) => item.id === entry.id && item.started && item.ready);
    if (running) return { result: await use({ url: entry.url, logs: () => '' }), entry: entry.id, url: entry.url, reused: true };
  } catch { /* An unreadable run record: SFlow starts its own instance below. */ }
  let log = '';
  const sink = { write: (text) => { if (log.length < 200_000) log += String(text); return true; } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, deadline - Date.now()));
  let result = null;
  let ready = false;
  try {
    await run.startApplication(root, context, entry, { output: sink, errorOutput: sink, signals: [], signal: controller.signal,
      onReady: async () => {
        ready = true;
        const from = log.length;
        try { result = await use({ url: entry.url, logs: () => log.slice(from) }); } finally { controller.abort(); }
      } });
  } catch (error) {
    if (!ready) {
      const { redactDiagnosticText } = await import('./git-remote-diagnostics.mjs');
      return { entry: entry.id, missing: [{ what: `the app (start entry ${entry.id}) running here`, why: String(error?.message ?? error).split('\n')[0],
        ...(error?.details?.nextAction?.command ? { command: error.details.nextAction.command } : { command: `singularity-flow app start ${entry.id}` }),
        ...(log.trim() ? { log: redactDiagnosticText(log.trim().split('\n').slice(-12).join('\n'), { multiline: true }) } : {}) }] };
    }
    if (!result) throw error;
  } finally { clearTimeout(timer); }
  if (!ready) return { entry: entry.id, missing: [{ what: `the app (start entry ${entry.id}) ready in time`, why: 'It was not ready before the check\'s time ran out.', command: `singularity-flow app start ${entry.id}` }] };
  return { result, entry: entry.id, url: entry.url, reused: false };
}

async function webCheck(root, project, { policy, deadline, screenshots, launchBrowser }) {
  const { driveWebApplication } = await import('./runtime-check-web.mjs');
  const running = await withRunningApplication(root, project, policy, ({ url }) => driveWebApplication(url, { launch: launchBrowser, deadline, screenshotDirectory: screenshots }), { deadline });
  if (running.missing) return { status: 'not-available', missing: running.missing, ran: [], findings: [] };
  const { status, missing, ran, findings, screenshots: shots, observed } = running.result;
  return { status, missing, ran, findings, screenshots: shots, observed,
    tryIt: { kind: 'web', url: running.url, words: `Open ${running.url} once the app runs.`, start: { command: `singularity-flow app start ${running.entry}`, copilotCommand: '/sf-run-app start' } } };
}

async function backendCheck(root, project, { policy, deadline, base, paths, tracked }) {
  const backend = await import('./runtime-check-backend.mjs');
  const inProject = (file) => !project.root || file.startsWith(`${project.root}/`);
  const specification = tracked.filter(inProject).filter(backend.isOpenApiFile).sort((left, right) => left.length - right.length)[0] ?? null;
  const sourceFiles = paths.filter(inProject).filter((file) => /\.(?:java|kt|ts|js|mjs|cjs|py|go|cs|rb)$/u.test(file) && !/(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\./u.test(file)).slice(0, 60);
  const head = await filesAt(root, 'HEAD', [...sourceFiles, ...(specification ? [specification] : [])]);
  const before = specification && base ? await filesAt(root, base, [specification]) : new Map();
  const document = specification ? backend.parseOpenApi(head.get(specification)) : null;
  const baseDocument = specification ? backend.parseOpenApi(before.get(specification)) : null;
  const findings = specification && paths.includes(specification) ? backend.openApiContractChanges(baseDocument, document) : [];
  const ran = specification && baseDocument && document ? [`compared ${specification} with the base`] : [];
  const endpoints = backend.changedEndpoints({ openapi: document, openapiBase: baseDocument, openapiChanged: Boolean(specification && paths.includes(specification)),
    sources: sourceFiles.filter((file) => head.has(file)).map((file) => ({ path: file, text: head.get(file) })) });
  if (!endpoints.length) {
    return { status: 'ran', missing: [], ran: [...ran, 'found no changed endpoint (no OpenAPI change and no route declared in the changed files)'], findings, observed: { endpoints: [] } };
  }
  const running = await withRunningApplication(root, project, policy, ({ url, logs }) => backend.probeEndpoints(url, endpoints, { document, logs, deadline }), { deadline });
  const named = endpoints.map((endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`);
  if (running.missing) return { status: findings.length || ran.length ? 'partial' : 'not-available', missing: running.missing, ran, findings, observed: { endpoints: named } };
  const origin = new URL(running.url).origin;
  return { status: 'ran', missing: [], ran: [...ran, `called ${named.length} endpoint${named.length === 1 ? '' : 's'} with valid input, invalid input and no credentials`],
    findings: [...findings, ...running.result.findings], observed: { endpoints: named, calls: running.result.calls.slice(0, 40) },
    tryIt: { kind: 'backend', baseUrl: origin, start: { command: `singularity-flow app start ${running.entry}`, copilotCommand: '/sf-run-app start' },
      requests: endpoints.slice(0, 8).flatMap((endpoint) => tryRequests(origin, endpoint, document, backend)) } };
}

/** Ready curl lines for one endpoint, valid and invalid, against the running service. */
function tryRequests(origin, endpoint, document, backend) {
  const method = endpoint.method.toUpperCase();
  const url = `${origin}${endpoint.path.replace(/\{[^}]+\}|:[A-Za-z_]\w*|<(?:\w+:)?\w+>/gu, '1')}`;
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return [`curl -i -X ${method} '${url}'`];
  const schema = endpoint.operation?.requestBody?.content?.['application/json']?.schema;
  const body = JSON.stringify(schema ? backend.sampleValue(document, schema) : {}).replace(/'/gu, "'\\''");
  return [`curl -i -X ${method} '${url}' -H 'content-type: application/json' -d '${body}'`, `curl -i -X ${method} '${url}' -H 'content-type: application/json' -d '{"broken": '`];
}

async function cliCheck(root, project, { deadline }) {
  const manifestPath = project.root ? `${project.root}/package.json` : 'package.json';
  const head = await filesAt(root, 'HEAD', [manifestPath]);
  let manifest = null;
  try { manifest = JSON.parse(head.get(manifestPath) ?? 'null'); } catch { manifest = null; }
  const { packageCommands, probeCommands } = await import('./runtime-check-cli.mjs');
  const commands = packageCommands(manifest, project.root ?? '').map((command) => ({ ...command, file: path.join(root, command.file) }));
  if (!commands.length) return { status: 'not-available', ran: [], findings: [], missing: [{ what: 'a command SFlow can run',
    why: 'SFlow runs a Node package\'s bin entries today; this project declares none it can run. Run the changed commands with typical and bad arguments, and with --help, yourself.' }] };
  const result = await probeCommands(commands, { deadline });
  return { status: 'ran', missing: [], ...result,
    tryIt: { kind: 'cli', commands: commands.slice(0, 5).flatMap((command) => [`node ${path.relative(root, command.file)} --help`]) } };
}

async function libraryCheck(root, project, { base, paths, tracked }) {
  if (!base) return { status: 'not-available', ran: [], findings: [], missing: [{ what: 'the base version to compare with', why: 'This Story names no baseline commit.' }] };
  const within = (file) => (project.root ? `${project.root}/${file}` : file);
  const library = await import('./runtime-check-library.mjs');
  const candidates = tracked.filter((file) => (!project.root || file.startsWith(`${project.root}/`)) && /\.(?:[cm]?[jt]sx?|d\.ts)$/u.test(file) && !/(?:^|\/)(?:test|tests|__tests__|node_modules|dist)\//u.test(file)).slice(0, 400);
  const wanted = [within('package.json'), ...candidates, ...paths.filter((file) => file.endsWith('.java'))];
  const [head, before] = await Promise.all([filesAt(root, 'HEAD', wanted), filesAt(root, base, wanted)]);
  const manifest = (files) => { try { return JSON.parse(files.get(within('package.json')) ?? 'null'); } catch { return null; } };
  const result = library.publicApiChanges({ base: { files: before, manifest: manifest(before) }, head: { files: head, manifest: manifest(head) }, folder: project.root ?? '', changedPaths: paths });
  if (!result.compared.length) return { status: 'not-available', ran: [], findings: [], missing: [{ what: 'a public API SFlow can read',
    why: 'SFlow compares a JavaScript or TypeScript package\'s exports and changed Java files\' public methods; neither is here. Compare the public API with the base yourself (japicmp for Java, api-extractor for TypeScript).' }] };
  const name = manifest(head)?.name ?? null;
  return { status: 'ran', missing: [], ran: result.ran, findings: result.findings,
    ...(name ? { tryIt: { kind: 'library', snippet: `import * as library from '${name}';\nconsole.log(Object.keys(library));` } } : {}) };
}

const NOT_BUILT = Object.freeze({
  job: 'Run it twice on the repository\'s sample input in a temporary folder and compare the output and exit status.',
  mobile: 'Launch it in a simulator or emulator and walk its main flow, in portrait and landscape.',
  artifact: 'Validate or dry-run it (terraform validate and plan, kubectl apply --dry-run=server, or the migration tool\'s dry run).'
});

/** Number every finding of the capture once: RT-001, RT-002, … */
function numbered(checks) {
  let next = 0;
  return checks.map((check) => ({ ...check, findings: (check.findings ?? []).slice(0, MAXIMUM_FINDINGS).map((finding) => {
    next += 1;
    return { id: `RT-${String(next).padStart(3, '0')}`, kind: check.kind, project: check.project, ...finding };
  }) }));
}

/**
 * Run the check for `phaseId`'s published version and keep its capture, or return the one already kept for what this
 * version delivered (`again` runs it anew). Returns `{ status: 'off' }` while the Story does not adopt it. Never throws for what
 * the laptop lacks: that is the capture's `missing`. `launchBrowser` and `deadlineMs` are for tests.
 */
export async function runRuntimeCheck(root, config, workflow, phaseId, { again = false, launchBrowser = null, deadlineMs = null } = {}) {
  const phase = workflow?.phases?.[phaseId];
  if (!runtimeCheckAdopted(workflow)) return { status: 'off', words: 'This Story does not run the runtime check: its applicationReview is off.' };
  const { phaseRequiresCodeDelivery } = await import('./code-delivery-policy.mjs');
  if (!phase || !phaseRequiresCodeDelivery(phase) || !(phase.generation >= 1)) {
    throw new SingularityFlowError(`The runtime check runs on a code step's published version; ${phaseId} has none yet.`, { code: 'RUNTIME_CHECK_NOT_PUBLISHED',
      details: { nextAction: { command: 'singularity-flow nextsteps --json', label: 'Go on with the Story; the check runs once its code step publishes.' } } });
  }
  const existing = await readRuntimeCheck(root, workflow, phaseId);
  if (existing?.current && !again) return existing;
  const policy = workflow.resolution.applicationReview;
  const deadline = Date.now() + (deadlineMs ?? policy.capture?.timeoutMs ?? 120_000);
  const startedAt = new Date().toISOString();
  const { base, paths } = await changedPaths(root, workflow, phase);
  const record = await import('./software-kind-record.mjs');
  let kinds = null;
  try { kinds = await record.softwareKindsView(root); } catch (error) { kinds = { projects: [], unavailable: String(error?.message ?? error).split('\n')[0] }; }
  const touched = record.kindsTouched(kinds, paths);
  const projects = (touched.length ? touched : kinds.projects).filter((project) => project.kind).slice(0, MAXIMUM_PROJECTS);
  const { trackedPathListing } = await import('./git.mjs');
  const tracked = trackedPathListing(root).paths ?? [];
  const files = await runtimeCheckFile(root, workflow.workItem.id, phaseId, phase.generation);
  const checks = [];
  for (const project of projects) {
    const common = { project: project.id, root: project.root ?? '', kind: project.kind, confirmed: project.confirmed };
    if (Date.now() > deadline) { checks.push({ ...common, status: 'not-available', ran: [], findings: [], missing: [{ what: 'time', why: 'The check\'s time ran out before this project.' }] }); continue; }
    try {
      const run = project.kind === 'web' ? await webCheck(root, project, { policy, deadline, screenshots: files.screenshots, launchBrowser })
        : project.kind === 'backend' ? await backendCheck(root, project, { policy, deadline, base, paths, tracked })
          : project.kind === 'cli' ? await cliCheck(root, project, { deadline })
            : project.kind === 'library' ? await libraryCheck(root, project, { base, paths, tracked })
              : { status: 'not-available', ran: [], findings: [], missing: [{ what: `SFlow's ${project.kind} check`, why: `SFlow does not run a ${project.kind} yet. ${NOT_BUILT[project.kind]}` }] };
      checks.push({ ...common, ...run });
    } catch (error) {
      // The check's own failure is reported, never the step's: it says what went wrong and blocks nothing.
      checks.push({ ...common, status: 'not-available', ran: [], findings: [], missing: [{ what: `SFlow's ${project.kind} check`, why: String(error?.message ?? error).split('\n')[0] }] });
    }
  }
  const capture = { format: RUNTIME_CHECK_FORMAT, id: null, workId: workflow.workItem.id, phase: phaseId, generation: phase.generation, head: await headCommit(root), sourceKey: deliveredSourceKey(phase),
    startedAt, finishedAt: new Date().toISOString(), changedPaths: paths.slice(0, 200),
    kinds: { capability: kinds.capability ?? null, question: kinds.question ?? null, confirm: kinds.confirm?.command ?? null, ...(kinds.unavailable ? { unavailable: kinds.unavailable } : {}),
      projects: (kinds.projects ?? []).map(({ id, root: folder, kind, confirmed }) => ({ id, root: folder, kind, confirmed })) },
    checks: numbered(checks.length ? checks : [{ project: null, root: '', kind: null, status: 'not-available', ran: [], findings: [],
      missing: [{ what: 'the kind of software this change touches', why: kinds.unavailable ?? 'SFlow cannot tell it from the repository\'s files.', command: 'singularity-flow capability kind --json' }] }]) };
  capture.id = `RTC-${createHash('sha256').update(JSON.stringify({ ...capture, startedAt: null, finishedAt: null })).digest('hex').slice(0, 16)}`;
  await mkdir(files.directory, { recursive: true, mode: 0o700 });
  await writeFile(files.file, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  return { ...capture, current: true };
}

/** Every finding of a capture, in order. */
export const runtimeFindings = (capture) => (capture?.checks ?? []).flatMap((check) => check.findings ?? []);

/** What the reviewer reads of a capture: each check's status, what ran, what is missing, and each finding, bounded. */
export function runtimeCheckForReview(capture) {
  if (!capture?.checks) return null;
  return {
    id: capture.id, current: capture.current !== false,
    checks: capture.checks.map((check) => ({ project: check.project, kind: check.kind, status: check.status, ran: check.ran ?? [],
      ...(check.missing?.length ? { missing: check.missing.map(({ what, why, command }) => ({ what, why, ...(command ? { command } : {}) })) } : {}),
      ...(check.screenshots?.length ? { screenshots: check.screenshots.map((shot) => ({ width: shot.width, path: shot.path })) } : {}),
      findings: (check.findings ?? []).map(({ id, class: use, type, title, detail, where }) => ({ id, use, type, title, detail: String(detail ?? '').slice(0, 600),
        ...(where?.file ? { where: `${where.file}${where.line ? `:${where.line}` : ''}` } : {}) })) })),
    guidance: 'SFlow ran the changed software (no model). For each finding with use breaks-use: if the changed code causes it, raise a blocking finding with check "use", use "breaks-use", the code line that causes it and runtimeFinding set to its id; if it is not this change\'s doing, raise an advisory "use" finding with runtimeFinding and say why. A check that could not run names what is missing; it never holds the step.'
  };
}

/** The ready ways to try a version at its approval, by kind: a URL, requests, commands or a snippet. Optional. */
export function runtimeTryIt(capture) {
  const tries = (capture?.checks ?? []).map((check) => check.tryIt).filter(Boolean);
  return tries.length ? tries : null;
}

/** One line on what the check found, for a person. */
export function runtimeCheckWords(capture) {
  if (!capture?.checks) return null;
  const findings = runtimeFindings(capture);
  const breaking = findings.filter((finding) => finding.class === 'breaks-use').length;
  const missing = capture.checks.filter((check) => check.missing?.length).flatMap((check) => check.missing.map((entry) => entry.what));
  const ran = capture.checks.filter((check) => check.status !== 'not-available').map((check) => `${check.kind}${check.project && check.project !== 'repository-root' ? ` (${check.project})` : ''}`);
  return `Runtime check: ${ran.length ? `ran ${ran.join(', ')}` : 'could not run here'}; ${breaking} finding${breaking === 1 ? '' : 's'} that break${breaking === 1 ? 's' : ''} use, ${findings.length - breaking} advice${missing.length ? `; missing here: ${[...new Set(missing)].join(', ')}` : ''}.`;
}

/**
 * "Try it" at a code step's approval (step intents spec §12.5), from its version's runtime check: the ready ways to
 * try the change by kind (the app's URL and its start, requests valid and invalid, commands, a snippet), what the
 * check found, and the kind line while a person has not confirmed it. Optional: it records nothing and holds nothing.
 * Null when the version has no capture here.
 */
export async function runtimeTryItView(root, workflow, phaseId) {
  const capture = await readRuntimeCheck(root, workflow, phaseId);
  if (!capture) return null;
  const ways = runtimeTryIt(capture) ?? [];
  const first = ways[0];
  const line = first?.kind === 'web' ? `Optional: try it at ${first.url} (start it with ${first.start.copilotCommand}).`
    : first?.kind === 'backend' ? `Optional: try it with ${first.requests.length} ready request${first.requests.length === 1 ? '' : 's'} against ${first.baseUrl} (start it with ${first.start.copilotCommand}).`
      : first?.kind === 'cli' ? `Optional: try it with ${first.commands[0]}.` : first?.kind === 'library' ? 'Optional: try it with the usage snippet in tryIt.' : null;
  return { optional: true, recordsAcceptance: false, phase: phaseId, generation: capture.generation, current: capture.current,
    words: runtimeCheckWords(capture), ways, ...(line ? { line } : {}),
    ...(capture.kinds?.question ? { kindQuestion: capture.kinds.question, kindRoute: { command: 'singularity-flow capability kind --json' } } : {}) };
}
