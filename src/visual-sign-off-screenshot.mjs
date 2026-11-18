/**
 * SFlow's own screenshot for a visual sign-off whose plan names no file, taken when a person asks for it (`decision
 * screenshot`; visual-sign-off-capture.mjs says which build and where it goes). It builds the application's checked
 * source with application review's static adapter (application-review-preview.mjs), serves the output on a loopback
 * port and opens it in the pinned browser with SFlow's bar: the person brings up the screen the criterion is about and
 * clicks "Capture this screen" [owner review, 2026-11-18: the first page is often another screen]. SFlow writes that
 * screenshot in the Story's folder. Loaded only when a screenshot is taken.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { witnessContextBinding } from './verification/witness-records.mjs';
import { SingularityFlowError } from './util.mjs';
import { codePublicationRoute, storyNextCommand } from './action-command-map.mjs';
import { decisionListRoute } from './upstream-routes.mjs';
import { currentSignOffCapture, failureNote, noCaptureRoute, signOffBuild, signOffCapturePath, signOffViewports, sizeWords } from './visual-sign-off-capture.mjs';

function refused(message, code, details = {}) {
  return new SingularityFlowError(message, { code, details });
}

export const BUILD_SECONDS = 900;
export const WAIT_SECONDS = 600;

/**
 * Take the screenshot a person captures for `clauseId`'s visual slot `slot`, and return `{ file, reused, build,
 * viewport, screen }`. The build gets BUILD_SECONDS; the person `wait` seconds (WAIT_SECONDS) once the browser opens. A
 * screenshot of this candidate already here is reused unless `again`. Refuses, naming the route, when the step that
 * answers for the criterion has not published, when this checkout has application code nobody published, when no build
 * can be named, or when nobody captured a screen. A failure is kept as a note (lastCaptureFailure) and thrown.
 * `browser` ({ headless, drive }) is for tests only.
 */
export async function takeSignOffCapture(root, { workId, clauseId, slot, wait = WAIT_SECONDS, again = false, browser = {} }) {
  const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const binding = witnessContextBinding(workflow);
  const existing = currentSignOffCapture(root, config, workflow, clauseId, slot, binding);
  if (existing && !again) return { file: existing, reused: true };
  const note = await failureNote(root, workflow, clauseId, slot, binding);
  try {
    const result = await capture(root, config, workflow, { clauseId, slot, binding, wait, again, browser });
    await rm(note, { force: true }).catch(() => {});
    return result;
  } catch (error) {
    await mkdir(path.dirname(note), { recursive: true }).then(() => writeFile(note, `${JSON.stringify({ at: new Date().toISOString(), code: error.code ?? null,
      message: String(error.message ?? error).replace(/\s+/gu, ' ').slice(0, 600) })}\n`, { mode: 0o600 })).catch(() => {});
    throw error;
  }
}

/** PNG screenshots side by side, top-aligned, with a light gap between them: one image of every size. */
export async function sideBySide(images, { gap = 24 } = {}) {
  const { decodePngRgba8, encodePngRgba8 } = await import('./png-rgba8.mjs');
  const decoded = images.map((bytes) => decodePngRgba8(bytes));
  const width = decoded.reduce((sum, image) => sum + image.width, 0) + gap * (decoded.length - 1);
  const height = Math.max(...decoded.map((image) => image.height));
  const data = Buffer.alloc(width * height * 4).fill(Buffer.from([0xee, 0xee, 0xee, 0xff]));
  let left = 0;
  for (const image of decoded) {
    for (let y = 0; y < image.height; y += 1) image.data.copy(data, (y * width + left) * 4, y * image.width * 4, (y + 1) * image.width * 4);
    left += image.width + gap;
  }
  return encodePngRgba8({ width, height, data });
}

// What a build or a test run writes, never application code, even when Git tracks it.
const TOOL_OUTPUT = new Set(['test-results', 'playwright-report', 'blob-report', 'coverage', '.nyc_output', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vite', 'storybook-static', '.sflow', 'target', 'vendor']);

/**
 * The tracked application files this checkout changed and nobody published, oldest-first as Git lists them: never a
 * tool's output (TOOL_OUTPUT), never anything untracked or ignored, which the screenshot's build does not read.
 */
export async function unpublishedApplicationFiles(root, config, workflow) {
  const [{ workingTreeChangedPaths }, { applicationPathContext, isApplicationChangePath }] = await Promise.all([import('./git.mjs'), import('./application-paths.mjs')]);
  const context = applicationPathContext(config, workflow);
  return workingTreeChangedPaths(root, 'HEAD').filter((entry) => !entry.split('/').some((segment) => TOOL_OUTPUT.has(segment))
    && isApplicationChangePath(entry, context));
}

async function capture(root, config, workflow, { clauseId, slot, binding, wait, again, browser }) {
  const workId = workflow.workItem.id;
  const { owedDecisions } = await import('./owed-decisions.mjs');
  const owed = await owedDecisions(root, config, workflow, workflow.phaseOrder ?? Object.keys(workflow.phases ?? {}), { limit: 1000 });
  const witness = (owed?.witnesses ?? []).find((entry) => entry.clauseId === clauseId && entry.slot === slot && entry.method === 'visual');
  if (!witness) {
    const list = decisionListRoute(workId);
    throw refused(`${clauseId} has no visual sign-off of slot ${slot} owed now, so SFlow took no screenshot. The decision list says what is open: ${list.copilotCommand}.`,
      'VISUAL_SIGN_OFF_NOT_OWED', { nextAction: list });
  }
  if (witness.files.length && !(again && witness.capture?.status === 'taken')) return { file: witness.files[0], reused: true };
  const published = (witness.owners ?? []).filter((id) => Number(workflow.phases?.[id]?.generation ?? 0) >= 1);
  if (!published.length) {
    throw refused(`Nothing has published ${clauseId} yet: SFlow takes its screenshot once ${(witness.owners ?? []).join(' or ') || 'its step'} publishes. Nothing was taken.`,
      'VISUAL_SIGN_OFF_UNPUBLISHED', { nextAction: { command: storyNextCommand(workId) } });
  }
  const file = signOffCapturePath(config, workflow, clauseId, slot, binding);
  const build = signOffBuild(root, workflow);
  if (!build.source) {
    throw refused(`SFlow cannot take this screenshot: ${build.reason}. ${noCaptureRoute(workflow, { file, riskCommand: witness.capture?.riskCommand ?? null })}`,
      'VISUAL_SIGN_OFF_BUILD_UNAVAILABLE', { file });
  }
  // Only published code: a screenshot of edits nobody published would be signed off as the step's. SFlow builds Git's own
  // files only, so nothing untracked here is built (a test run's test-results/.last-run.json held a real approval: owner,
  // 2026-11-18); a tracked application file changed and not committed is what nobody published, named.
  const owner = workflow.phases[published.at(-1)];
  const changed = await unpublishedApplicationFiles(root, config, workflow);
  if (changed.length) {
    // The step's own publication, as the map names it [OSA:REQ-021].
    const publish = codePublicationRoute(workflow, owner);
    throw refused(`This checkout changed ${changed.length === 1 ? 'an application file' : 'application files'} nobody published (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? `, and ${changed.length - 3} more` : ''}), and SFlow screenshots only what was published. `
      + `Publish ${changed.length === 1 ? 'it' : 'them'} with ${owner.id} (${publish.command}), or set ${changed.length === 1 ? 'it' : 'them'} aside, then take the screenshot again. Nothing was taken.`,
    'VISUAL_SIGN_OFF_CODE_CHANGED', { paths: changed.slice(0, 20), nextAction: publish });
  }
  const preview = await import('./application-review-preview.mjs');
  const steps = build.source === 'declared' ? await preview.declaredStaticBuild(root, workflow, build.entry)
    : { steps: build.steps, workingDirectory: '.', env: {} };
  const built = await preview.buildStaticOutput(root, config, workflow, steps, { outputDirectory: build.outputDirectory, deadline: Date.now() + BUILD_SECONDS * 1000,
    label: build.source === 'inferred' ? 'The inferred build (npm ci, then npm run build)' : 'The declared preview build', trackedOnly: true });
  try {
    if (!built.files.has('index.html')) {
      throw refused(`The build wrote no ${build.outputDirectory}/index.html, so there is no page to screenshot. ${noCaptureRoute(workflow, { file, riskCommand: witness.capture?.riskCommand ?? null })}`,
        'VISUAL_SIGN_OFF_BUILD_UNAVAILABLE', { file });
    }
    // Every size the criterion names: the browser opens at the first, and the bar says which SFlow captures.
    const viewports = signOffViewports(workflow, witness.capture?.target);
    const [viewport] = viewports;
    const name = clauseId.slice(clauseId.lastIndexOf(':') + 1);
    // What the plan says the screen shows, on the bar the person reads while they bring it up.
    const shows = witness.capture?.target ? `: ${witness.capture.target}` : '';
    const sized = viewports.length > 1 ? ` SFlow captures it at ${sizeWords(viewports)}.` : '';
    const shot = await preview.personCapturedScreenshot(built.files, { viewport, sizes: viewports.slice(1), deadline: Date.now() + wait * 1000, ...browser,
      label: `SFlow · ${name}${shows}. Bring this screen up, then capture it.${sized}`, button: `Capture this screen for ${name}` });
    // One file the sign-off shows, every size side by side, so one witness record binds them all.
    const bytes = shot.shots?.length > 1 ? await sideBySide(shot.shots.map((entry) => entry.bytes)) : shot.bytes;
    // Written once SFlow has every byte: the sign-off binds this exact file.
    const { secureRepositoryPath, writeAtomic } = await import('./util.mjs');
    const target = await secureRepositoryPath(root, file, { label: 'Visual sign-off screenshot' });
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await writeAtomic(target.absolute, bytes);
    return { file, reused: false, build: { source: build.source, words: build.words }, viewport, ...(viewports.length > 1 ? { viewports } : {}), browser: shot.browser, screen: shot.screen };
  } finally {
    await rm(built.materialization, { recursive: true, force: true }).catch(() => {});
  }
}
