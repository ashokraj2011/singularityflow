/**
 * SFlow's own screenshot for a visual sign-off whose plan names no file [owner, 2026-11-18: "It should be during
 * implementation .. SFlow should take a screenshot and ask for approval"].
 *
 * A primary visual criterion a code step answers for, whose plan names no screenshot (no evidence file), had nothing a
 * person could look at: its sign-off was never available (signOffReady needs a file), the step's approval waited for
 * it, and nothing led out ("Approve Implementation … waits for d1" on the owner's rehearsal Story). Now, once the step
 * has published, a person asks for the screenshot on the sign-off itself ("Take the screenshot" on the Decide card, or
 * `decision screenshot` in their own terminal; a person's own step, never a chat turn's): SFlow copies the application's
 * checked source into a private folder, builds it, serves the static output on a loopback port and opens it in the
 * pinned review browser with SFlow's bar naming the criterion and the screen the plan says it shows. The person brings
 * that screen up and clicks "Capture this screen", since an app's first page is often another screen [owner review,
 * 2026-11-18]; SFlow saves that screenshot in the Story's own folder, named for the criterion, its slot and the candidate
 * it shows. The sign-off then has that file, and the person looks at it and signs it off with the same witness review as
 * any other file: the Decide card on Copilot CLI, the Decide card or the Decisions page in VS Code, or `decision witness`
 * in their own terminal. Nothing here records or decides anything.
 *
 * The build, materialization, server and browser are application review's own static adapter
 * (application-review-preview.mjs); this adds no second screenshot system. Which build runs:
 *  - the static preview the Story pinned for application review (`applicationReview.preview`: a declared application
 *    entry's before-launch steps and its output directory), when it has one;
 *  - otherwise only the common case, inferred and said so wherever it is offered: a package.json at the repository
 *    root whose `build` script runs `vite build`, with a package-lock.json beside it, built with
 *    `npm ci --no-audit --no-fund` then `npm run build`, its output `dist` (Vite's default). Anything else is named
 *    with a route that works, never guessed.
 * It runs only when a person asks for the screenshot, never on a read or a card's check, and only on published code.
 *
 * The image is written untracked in the Story's folder (`evidence/visual-sign-offs/`). The lifecycle checks count it
 * as SFlow's own output, not a change to review (lifecycle-worktree.mjs), and the sign-off's own publication commits
 * it beside its record, so another laptop reads the same bytes when it evaluates the witness. A capture that failed is
 * kept as a note beside the checkout's Git data, so the card can say why.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { witnessContextBinding } from './verification/witness-records.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { storyLocation } from './story-paths.mjs';

/** Where in the Story's folder SFlow's sign-off screenshots go; lifecycle-worktree.mjs names the same folder. */
export const SIGN_OFF_CAPTURE_DIRECTORY = 'evidence/visual-sign-offs';
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
export const INFERRED_BUILD = Object.freeze({
  steps: Object.freeze([Object.freeze({ argv: Object.freeze(['npm', 'ci', '--no-audit', '--no-fund']) }), Object.freeze({ argv: Object.freeze(['npm', 'run', 'build']) })]),
  outputDirectory: 'dist'
});
const NON_WEB = new Set(['backend', 'job', 'cli', 'library', 'artifact']);
const USER_FACING = /\.(?:jsx|tsx|vue|svelte|html|css|scss)$/iu;
const VITE_BUILD = /(?:^|[\s;&|(])vite\s+build(?:\s|$|[;&|)])/u;

const slug = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[-.]+|-+$/gu, '').slice(0, 80) || 'slot';
const key = (binding) => createHash('sha256').update(String(binding)).digest('hex').slice(0, 16);
export const captureName = (clauseId, slot, binding) => `${slug(clauseId)}-${slug(slot)}-${key(binding)}`;

/** The repository path of SFlow's screenshot for a criterion's slot, for the candidate `binding` names. */
export function signOffCapturePath(config, workflow, clauseId, slot, binding = witnessContextBinding(workflow)) {
  return storyLocation(null, config, workflow.workItem.id).record(`${SIGN_OFF_CAPTURE_DIRECTORY}/${captureName(clauseId, slot, binding)}.png`);
}

/** SFlow's screenshot of this candidate for the slot, when one was taken here (a regular file), else null. */
export function currentSignOffCapture(root, config, workflow, clauseId, slot, binding = witnessContextBinding(workflow)) {
  const file = signOffCapturePath(config, workflow, clauseId, slot, binding);
  try { return lstatSync(path.join(root, file)).isFile() ? file : null; } catch { return null; }
}

export function failureNote(root, workflow, clauseId, slot, binding) {
  return import('./git.mjs').then(({ gitCommonDir }) => path.join(gitCommonDir(root), 'singularity-flow', 'visual-sign-offs',
    slug(workflow.workItem.id), `${captureName(clauseId, slot, binding)}.json`));
}

/** Why the last screenshot of this candidate failed here, in its own words, or null. */
export async function lastCaptureFailure(root, workflow, clauseId, slot, binding = witnessContextBinding(workflow)) {
  try { return JSON.parse(readFileSync(await failureNote(root, workflow, clauseId, slot, binding), 'utf8')).message ?? null; } catch { return null; }
}

/**
 * The file a visual sign-off whose plan names none is given (owed-decisions.mjs), and how it gets one: SFlow's own
 * screenshot of this candidate once taken, else what taking it needs, as `capture` (status needed, unavailable with
 * its reason, unpublished, or taken), with its terminal lines and a dated risk's command. Before, such a sign-off had no
 * file, so it was never available and the step's approval waited for it with no way out.
 */
export function signOffFile({ root, config }, workflow, { clauseId, slot, target = null, owners, row }) {
  const binding = witnessContextBinding(workflow);
  const workId = workflow.workItem.id;
  // The person's own step that takes it: on the Decide card's button, or in their own terminal.
  const command = screenshotCommand(workId, clauseId, slot);
  const taken = currentSignOffCapture(root, config, workflow, clauseId, slot, binding);
  if (taken) return { files: [taken], capture: { status: 'taken', workId, file: taken, again: `${command} --replace` } };
  const file = signOffCapturePath(config, workflow, clauseId, slot, binding);
  if (!owners.some((owner) => Number(workflow.phases?.[owner]?.generation ?? 0) >= 1)) return { files: [], capture: { status: 'unpublished', workId, file } };
  const riskCommand = (row?.actions ?? []).find((entry) => entry.kind === 'accept-risk')?.command ?? null;
  const build = signOffBuild(root, workflow);
  const head = `  ${clauseId} ${slot} (visual: the plan names no file) — `;
  const review = applicationReviewRoute(workflow);
  const risk = { ...(riskCommand ? { riskCommand } : {}), ...(review ? { appReview: review } : {}) };
  const capture = build.source
    ? { status: 'needed', workId, file, command, ...(target ? { target } : {}), ...risk, build: { source: build.source, words: build.words }, viewport: signOffViewports(workflow, target)[0],
      ...(signOffViewports(workflow, target).length > 1 ? { viewports: signOffViewports(workflow, target) } : {}),
      lines: [`${head}a person takes its screenshot on the Decide card (/sf-decide ${workId}, Take the screenshot) or in their own terminal, bringing up the screen it is about, then looks at it and signs it off:`, `    ${command}`, ...reviewLine(review)] }
    : { status: 'unavailable', workId, file, reason: build.reason, ...risk,
      lines: [`${head}SFlow cannot take its screenshot: ${build.reason}. Save one as ${file}, then sign it off: /sf-decide ${workId}`,
        ...(riskCommand ? [`    Or accept it as a dated risk: ${riskCommand}`] : []), ...reviewLine(review)] };
  return { files: [], capture };
}

/**
 * The other way a Story that adopted application review satisfies a visual sign-off: its live review, whose accepted
 * visual dimension witnesses the criterion's visual slots (applicationReviewSlotResults) [owner, 2026-11-18]. Null for a
 * Story without it, with it off, with a declared surface that has no screens, or under signed person presence, which the
 * local review adapter cannot sign (ARA_AUTHORITY_ADAPTER_UNAVAILABLE).
 */
export function applicationReviewRoute(workflow) {
  const policy = workflow?.resolution?.applicationReview;
  if (!policy || policy.mode === 'off' || NON_WEB.has(policy.surface)) return null;
  if (workflow.resolution.presence && workflow.resolution.presence.status !== 'off') return null;
  return { copilot: '/sf-app-review', command: `singularity-flow app-review start --work-id ${workflow.workItem.id} --json`, vscode: 'Singularity Flow: Review Application' };
}

const reviewLine = (review) => (review ? [`    Or accept it in the application review: ${review.copilot}, or ${review.command}`] : []);

/** The person's own command that opens the app for them to bring up and capture the screen a visual sign-off is about. */
export const screenshotCommand = (workId, clauseId, slot) => `singularity-flow decision screenshot --work-id ${workId} --criterion ${clauseId} --slot ${slot}`;

/** A visual sign-off's planned files, or SFlow's own screenshot of this candidate once taken when the plan names none (approve --confirm-evidence). */
export function plannedOrTaken(root, config, workflow, row, slot, planned) {
  const taken = planned.length ? null : currentSignOffCapture(root, config, workflow, row.id, slot);
  return taken ? [taken] : planned;
}

/** Each owed sign-off still needing SFlow's screenshot, with why the last one here failed, so the card says it and offers it again. */
export async function withCaptureFailures(root, workflow, witnesses) {
  for (const witness of witnesses.filter((entry) => entry.capture?.status === 'needed')) {
    const failed = await lastCaptureFailure(root, workflow, witness.clauseId, witness.slot);
    if (failed) witness.capture = { ...witness.capture, failed };
  }
  return witnesses;
}

/**
 * Which build SFlow runs for the screenshot, read without running anything: `{ source: 'declared' | 'inferred', steps,
 * outputDirectory, words }`, or `{ source: null, reason }` naming why none can be, with what makes one.
 */
export function signOffBuild(root, workflow) {
  const policy = workflow?.resolution?.applicationReview ?? null;
  const delivered = Object.values(workflow?.phases ?? {}).flatMap((step) => step?.deliveryEvidence?.sourcePaths ?? []);
  if (NON_WEB.has(policy?.surface) && !delivered.some((file) => USER_FACING.test(file) && !/\.(?:test|spec)\./iu.test(file))) {
    return { source: null, reason: `this Story's workflow declares a ${policy.surface} surface, which has no screens to capture` };
  }
  if (policy?.preview?.entry) {
    return { source: 'declared', entry: policy.preview.entry, outputDirectory: policy.preview.outputDirectory,
      words: `the static preview this Story's application review declares (entry ${policy.preview.entry}, output ${policy.preview.outputDirectory})` };
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {
    return { source: null, reason: 'this repository has no package.json at its root, so SFlow cannot tell how to build its web app' };
  }
  const script = typeof manifest?.scripts?.build === 'string' ? manifest.scripts.build : null;
  if (!script || !VITE_BUILD.test(script)) {
    return { source: null, reason: `its package.json build script ${script ? `("${script.slice(0, 80)}") does not run vite build` : 'is missing'}, and SFlow infers only a Vite build` };
  }
  if (!existsSync(path.join(root, 'package-lock.json'))) {
    return { source: null, reason: 'it has no package-lock.json, and SFlow installs dependencies only with npm ci from a lock file' };
  }
  return { source: 'inferred', ...INFERRED_BUILD, steps: INFERRED_BUILD.steps.map((step) => ({ argv: [...step.argv] })),
    words: 'npm ci --no-audit --no-fund, then npm run build (inferred: package.json builds with vite build; output dist)' };
}

/** A phone-sized screen, for a criterion that names a narrow or mobile view. */
export const NARROW_VIEWPORT = Object.freeze({ width: 390, height: 844 });
const TABLET_VIEWPORT = Object.freeze({ width: 768, height: 1024 });

/**
 * Every screen size a sign-off's screenshot shows, the first the one the browser opens at [owner, 2026-11-18: the target
 * "Grapher mode at desktop and narrow viewports" got one 1280×800 screenshot, and one screenshot cannot show both]: the
 * Story's pinned visual profiles when it pins more than one, else the sizes the plan's target names (desktop, tablet,
 * narrow or mobile), else the one capture viewport. SFlow captures the screen the person brought up at each, side by side.
 */
export function signOffViewports(workflow, target = null) {
  const profiles = (workflow?.resolution?.verification?.profiles ?? []).filter((profile) => Number.isInteger(profile?.width) && Number.isInteger(profile?.height));
  if (profiles.length > 1) return profiles.slice(0, 4).map((profile) => ({ name: profile.label ?? profile.id, width: profile.width, height: profile.height }));
  const text = String(target ?? '');
  const narrow = /\b(?:narrow|mobile|phone|small[- ]screen)\b/iu.test(text);
  const tablet = /\btablet\b/iu.test(text);
  const wide = /\b(?:desktop|wide|large[- ]screen|laptop)\b/iu.test(text);
  const base = { name: 'desktop', ...signOffViewport(workflow) };
  if (!narrow && !tablet) return [base];
  return [...(wide ? [base] : []), ...(tablet ? [{ name: 'tablet', ...TABLET_VIEWPORT }] : []), ...(narrow ? [{ name: 'narrow', ...NARROW_VIEWPORT }] : [])];
}

/** "1280×800 and 390×844": the sizes a screenshot shows, as people read them. */
export const sizeWords = (viewports) => {
  const sizes = viewports.map(({ width, height }) => `${width}×${height}`);
  return sizes.length > 1 ? `${sizes.slice(0, -1).join(', ')} and ${sizes.at(-1)}` : sizes[0] ?? '';
};

/** The viewport the screenshot is taken at: the Story's application-review capture viewport, else 1280×800. */
export function signOffViewport(workflow) {
  const viewport = workflow?.resolution?.applicationReview?.capture?.viewport;
  return Number.isInteger(viewport?.width) && Number.isInteger(viewport?.height) ? { width: viewport.width, height: viewport.height } : { ...DEFAULT_VIEWPORT };
}

/**
 * What a person who cannot get SFlow's screenshot does instead, in words with working routes: their own screenshot,
 * saved where SFlow would have saved it, is then the file the sign-off shows them; or a dated risk.
 */
export function noCaptureRoute(workflow, { file, riskCommand = null }) {
  return [
    `Take the screenshot yourself and save it as ${file}: the sign-off then shows it to you to look at and sign off (/sf-decide ${workflow.workItem.id}).`,
    ...(riskCommand ? [`Or accept it as a dated risk: ${riskCommand}.`] : []),
    'For later Stories, declare the static build on the work type: applicationReview.preview { entry, outputDirectory } (singularity-flow explain app-review).'
  ].join(' ');
}

/**
 * Take SFlow's screenshot for `clauseId`'s visual slot `slot` within `seconds` (visual-sign-off-screenshot.mjs). Loaded
 * by its path, so no bundle that reads a sign-off carries the build runner or the browser.
 */
export async function takeSignOffCapture(root, request) {
  const runtime = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'visual-sign-off-screenshot.mjs')).href;
  return (await import(runtime)).takeSignOffCapture(root, request);
}
