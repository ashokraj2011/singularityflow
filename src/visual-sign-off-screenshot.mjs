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
import { currentSignOffCapture, failureNote, noCaptureRoute, signOffBuild, signOffCapturePath, signOffViewport } from './visual-sign-off-capture.mjs';

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
  // Only published code: a screenshot of edits nobody published would be signed off as the step's. What a step
  // publishes is committed, so this checkout's uncommitted or new application files are what nobody published.
  const owner = workflow.phases[published.at(-1)];
  const [{ workingTreeChangedPaths, untrackedFiles }, { applicationPathContext, isApplicationChangePath }] = await Promise.all([import('./git.mjs'), import('./application-paths.mjs')]);
  const context = applicationPathContext(config, workflow);
  const changed = [...new Set([...workingTreeChangedPaths(root, 'HEAD'), ...untrackedFiles(root)])].filter((entry) => isApplicationChangePath(entry, context));
  if (changed.length) {
    // The step's own publication, as the map names it [OSA:REQ-021].
    const publish = codePublicationRoute(workflow, owner);
    throw refused(`This checkout has code nobody published (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? `, and ${changed.length - 3} more` : ''}), and SFlow screenshots only what was published. `
      + `Publish it with ${owner.id} (${publish.command}), or set it aside, then take the screenshot again. Nothing was taken.`,
    'VISUAL_SIGN_OFF_CODE_CHANGED', { paths: changed.slice(0, 20), nextAction: publish });
  }
  const preview = await import('./application-review-preview.mjs');
  const steps = build.source === 'declared' ? await preview.declaredStaticBuild(root, workflow, build.entry)
    : { steps: build.steps, workingDirectory: '.', env: {} };
  const built = await preview.buildStaticOutput(root, config, workflow, steps, { outputDirectory: build.outputDirectory, deadline: Date.now() + BUILD_SECONDS * 1000,
    label: build.source === 'inferred' ? 'The inferred build (npm ci, then npm run build)' : 'The declared preview build' });
  try {
    if (!built.files.has('index.html')) {
      throw refused(`The build wrote no ${build.outputDirectory}/index.html, so there is no page to screenshot. ${noCaptureRoute(workflow, { file, riskCommand: witness.capture?.riskCommand ?? null })}`,
        'VISUAL_SIGN_OFF_BUILD_UNAVAILABLE', { file });
    }
    const viewport = signOffViewport(workflow);
    const name = clauseId.slice(clauseId.lastIndexOf(':') + 1);
    // What the plan says the screen shows, on the bar the person reads while they bring it up.
    const shows = witness.capture?.target ? `: ${witness.capture.target}` : '';
    const shot = await preview.personCapturedScreenshot(built.files, { viewport, deadline: Date.now() + wait * 1000, ...browser,
      label: `SFlow · ${name}${shows}. Bring this screen up, then capture it.`, button: `Capture this screen for ${name}` });
    // Written once SFlow has every byte: the sign-off binds this exact file.
    const { secureRepositoryPath, writeAtomic } = await import('./util.mjs');
    const target = await secureRepositoryPath(root, file, { label: 'Visual sign-off screenshot' });
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await writeAtomic(target.absolute, shot.bytes);
    return { file, reused: false, build: { source: build.source, words: build.words }, viewport, browser: shot.browser, screen: shot.screen };
  } finally {
    await rm(built.materialization, { recursive: true, force: true }).catch(() => {});
  }
}
