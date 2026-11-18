/**
 * The one check every way of making a workflow runs before anything is proposed or written [owner,
 * 2026-11-18]: "when a json is imported it should check and validate and fix the issues automatically
 * .. this holds true in every workflow creation paths". An import was proposed, and only approval found
 * that its first step's template had no clause anchors and no planned-claims table; its advice made no
 * sense for an import. Each issue is now repaired, or refused with its fix, where the workflow is made.
 *
 * The workflows a change makes or changes are judged exactly as approval judges them (src/configuration-
 * proposal.mjs): `workflow validate` on the configuration they land on, before and after the change,
 * keyed by src/workflow-validation.mjs problemKey, so only a problem the change adds counts. A problem
 * whose fix only adds per-Story placeholders to a step's template is repaired here, and the result is
 * judged again; every other problem the change adds comes back with its fix, for the creation step to
 * refuse. Repaired (REPAIRED_CODES), each by adding text and never by changing or removing the author's:
 *
 *   CHECK_TEMPLATE_MISSING          a template that does not exist: the packaged one of that name, else a starter
 *   CHECK_TEMPLATE_CLAUSE_ANCHORS   a clause step's template with no anchors: two TODO clauses, [{{work.id}}:REQ-001] and [{{work.id}}:AC-001]
 *   CHECK_TEMPLATE_PLANNED_TABLE    a planning step's template with no planned-claims table: the table, one TODO row per anchor
 *   CHECK_TEMPLATE_HEADING_MISSING  a section the step's publication checks for: the heading and a TODO line
 *
 * Refused with their fix: anchors or a table that are there but refused, an unfillable token, a fixed
 * clause namespace (each fix rewrites the author's text), and every problem with the workflow itself
 * (who drafts or signs off a step, its routes, which step plans the code: what the workflow means is its
 * author's decision). The text-only fixes are src/workflow-fix/templates.mjs, the ones /sf-fix-workflow drafts.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const WORKFLOW_FILE = 'singularity/workflow.yml';
const PORTFOLIO_FILE = 'singularity/portfolio.yml';
const ROUNDS = 3;

/** The problem codes repaired here, in the order a template's repairs are made. */
export const REPAIRED_CODES = Object.freeze(['CHECK_TEMPLATE_MISSING', 'CHECK_TEMPLATE_CLAUSE_ANCHORS', 'CHECK_TEMPLATE_PLANNED_TABLE', 'CHECK_TEMPLATE_HEADING_MISSING']);
const HEADING = 'CHECK_TEMPLATE_HEADING_MISSING';

const words = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const inNew = (sections) => (sections.length ? ` (in ${sections.length === 1 ? 'a new section' : 'new sections'} ${words(sections.map((section) => `"${section}"`))})` : '');
const safeRelative = (file) => typeof file === 'string' && Boolean(file) && !path.posix.isAbsolute(file)
  && !path.posix.normalize(file).split('/').includes('..');
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Each problem and finding of `ids` in `checkout`, as approval keys them. */
async function judged(checkout, ids) {
  const { workflowProblems } = await import('./workflow-validation.mjs');
  const findings = [];
  const problems = await workflowProblems(checkout, ids, { findings });
  return { problems, findings };
}

/** The problems approval would compare against: those `ids` already have in `checkout` (none for a new workflow). */
export async function problemsBefore(checkout, ids) {
  if (!ids.length) return new Map();
  let present = ids;
  try {
    const raw = YAML.parse(await readFile(path.join(checkout, WORKFLOW_FILE), 'utf8')) ?? {};
    present = ids.filter((id) => Object.hasOwn(raw.workTypes ?? {}, id));
  } catch { /* A configuration that does not read: validate says why, for every workflow named. */ }
  return present.length ? (await judged(checkout, present)).problems : new Map();
}

/** The roles and labels of each step that uses a template, from the configuration in `checkout`. */
async function stepsOf(checkout, workflowIds) {
  const { loadDefinition, resolveWorkType } = await import('./config.mjs');
  let definition = null;
  try { definition = await loadDefinition(checkout); }
  catch { definition = await loadDefinition(checkout, { storyBootstrap: true }).catch(() => null); }
  const steps = new Map();
  for (const id of workflowIds) {
    let resolved = null;
    try { resolved = definition ? resolveWorkType(definition, id) : null; } catch { resolved = null; }
    for (const phase of resolved?.phases ?? []) steps.set(`${id}\0${phase.id}`, phase);
  }
  return { steps, templatesRoot: definition?.templatesRoot ?? 'singularity/templates' };
}

/**
 * What a template needs added for `codes`, as text and words; null when none of them applies to it
 * as it is now (anchors or a table already there are the author's, and are refused, never rewritten).
 */
async function repairedTemplate(text, codes, { sections = [], created = null } = {}) {
  const [{ templateAnchors, withClauseAnchors, withPlannedTable, withSections }, { plannedClaimSource }, { normalizeMarkdownHeading, parseMarkdownStructure }] = await Promise.all([
    import('./workflow-fix/templates.mjs'), import('./specifications.mjs'), import('./markdown-structure.mjs')]);
  let next = text;
  const added = [];
  const done = [];
  if (created) { added.push(created); done.push('CHECK_TEMPLATE_MISSING'); }
  if (codes.has('CHECK_TEMPLATE_CLAUSE_ANCHORS') && !templateAnchors(next).length) {
    const result = withClauseAnchors(next);
    next = result.text;
    added.push(`two TODO clauses with anchors [{{work.id}}:REQ-001] and [{{work.id}}:AC-001]${inNew(result.added)}`);
    done.push('CHECK_TEMPLATE_CLAUSE_ANCHORS');
  }
  if (codes.has('CHECK_TEMPLATE_PLANNED_TABLE') && !/^\|\s*clause\s*\|\s*expected paths\s*\|\s*planned tests\s*\|/imu.test(plannedClaimSource(next))) {
    const result = withPlannedTable(next);
    next = result.text;
    added.push(`the planned-claims table, one TODO row per clause${inNew(result.added)}`);
    done.push('CHECK_TEMPLATE_PLANNED_TABLE');
  }
  if (sections.length) {
    const headings = new Set(parseMarkdownStructure(next).headings.map((heading) => heading.normalized));
    const missing = sections.filter((section) => !headings.has(normalizeMarkdownHeading(section)));
    if (missing.length) {
      next = withSections(next, missing);
      added.push(`the ${missing.length === 1 ? 'section' : 'sections'} ${words(missing.map((section) => `"${section}"`))} with a TODO line`);
      done.push(HEADING);
    }
  }
  return added.length ? { text: next.endsWith('\n') ? next : `${next}\n`, added, codes: done } : null;
}

/**
 * Judge `ids` in `checkout` as approval would against `before`, repair what only needs placeholders in a
 * template `editable(file)` allows, in place, and judge again, up to three rounds. Returns the repairs
 * (one per template file), the problems still added with their fixes, and `restore()`, which puts every
 * repaired file back as it was.
 */
export async function repairCheckout(checkout, ids, { before = new Map(), editable = () => true, written = () => false } = {}) {
  const { addedProblemKeys } = await import('./workflow-validation.mjs');
  const repairs = new Map();
  const originals = new Map();
  // A packaged workflow's templates change only with SFlow (src/seeded-workflow-protection.mjs), never here.
  const packaged = await packagedTemplates(checkout);
  const allowed = (file) => !packaged.has(file) && editable(file);
  let state = await judged(checkout, ids);
  for (let round = 0; round < ROUNDS; round += 1) {
    const added = addedProblemKeys(before, state.problems);
    // Problems this change adds; a missing section only where SFlow writes the template anyway.
    const targets = new Map();
    const target = (workflow, finding) => {
      const file = finding.subject?.file ?? finding.location?.file ?? null;
      if (!safeRelative(file) || !allowed(file)) return null;
      if (!targets.has(file)) targets.set(file, { file, template: finding.subject?.template ?? path.posix.basename(file), codes: new Set(), steps: [] });
      const entry = targets.get(file);
      if (!entry.steps.some((step) => step.workflow === workflow && step.step === finding.subject?.step)) entry.steps.push({ workflow, step: finding.subject?.step ?? null });
      return entry;
    };
    // The problems this change adds that only need placeholders.
    for (const { workflow, key, finding } of state.findings) {
      if (!REPAIRED_CODES.includes(finding.code) || finding.code === HEADING || finding.severity !== 'problem' || !added.has(key)) continue;
      target(workflow, finding)?.codes.add(finding.code);
    }
    // A missing section (a warning) only in a template this change writes or SFlow repairs anyway.
    for (const { workflow, finding } of state.findings.filter((entry) => entry.finding.code === HEADING)) {
      const file = finding.subject?.file ?? finding.location?.file ?? null;
      if (targets.has(file) || repairs.has(file) || written(file)) target(workflow, finding)?.codes.add(HEADING);
    }
    if (!targets.size) break;
    const { steps } = await stepsOf(checkout, ids);
    let changed = false;
    for (const target of targets.values()) {
      const absolute = path.join(checkout, ...target.file.split('/'));
      const info = await lstat(absolute).catch(() => null);
      const phases = target.steps.map((entry) => steps.get(`${entry.workflow}\0${entry.step}`)).filter(Boolean);
      const { requiredArtifactSections } = await import('./artifact-required-sections.mjs');
      const sections = target.codes.has(HEADING) || target.codes.has('CHECK_TEMPLATE_MISSING')
        ? [...new Set(phases.flatMap((phase) => requiredArtifactSections(phase)))] : [];
      let text = null;
      let created = null;
      if (!info) {
        if (!target.codes.has('CHECK_TEMPLATE_MISSING')) continue;
        const { PACKAGE_ROOT } = await import('./package-root.mjs');
        const shipped = path.join(PACKAGE_ROOT, 'templates', 'artifacts', ...target.template.split('/'));
        const shippedInfo = safeRelative(target.template) ? await lstat(shipped).catch(() => null) : null;
        if (shippedInfo?.isFile()) { text = await readFile(shipped, 'utf8'); created = 'the template itself, copied from the packaged one of that name'; }
        else {
          const { newStepTemplate } = await import('./step-outputs.mjs');
          const phase = phases[0];
          text = newStepTemplate(phase?.id ?? target.steps[0]?.step ?? 'step', phase?.label ?? phase?.id ?? 'Step');
          created = 'the template itself, from a starter with a TODO under each heading';
        }
      } else if (info.isFile() && !info.isSymbolicLink()) {
        text = await readFile(absolute, 'utf8');
      } else continue;
      const repaired = await repairedTemplate(text, target.codes, { sections, created });
      if (!repaired) continue;
      if (!originals.has(target.file)) originals.set(target.file, info ? await readFile(absolute) : null);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, repaired.text);
      changed = true;
      const earlier = repairs.get(target.file);
      const labels = phases.map((phase) => phase.label ?? phase.id);
      repairs.set(target.file, {
        path: target.file, template: target.template,
        steps: [...(earlier?.steps ?? []), ...target.steps.filter((step) => !(earlier?.steps ?? []).some((other) => other.workflow === step.workflow && other.step === step.step))],
        labels: [...new Set([...(earlier?.labels ?? []), ...labels])],
        codes: [...new Set([...(earlier?.codes ?? []), ...repaired.codes])],
        added: [...(earlier?.added ?? []), ...repaired.added],
        content: repaired.text
      });
    }
    if (!changed) break;
    state = await judged(checkout, ids);
  }
  const remaining = addedProblemKeys(before, state.problems);
  const where = new Map(state.findings.map((entry) => [entry.key, entry.finding]));
  const problems = [...state.problems].filter(([key]) => remaining.has(key)).map(([key, problem]) => {
    const finding = where.get(key);
    const file = finding?.subject?.file ?? null;
    return { ...problem, ...(finding?.subject?.step ? { step: finding.subject.step } : {}),
      ...(finding?.subject?.template ? { template: finding.subject.template } : {}),
      // The fix there is the author's: a template of the workflow's own, or another step for the role.
      ...(file && packaged.has(file) && REPAIRED_CODES.includes(problem.code) ? { fix: `${problem.fix ?? ''} ${PACKAGED_TEMPLATE}`.trim() } : {}) };
  });
  const shown = [];
  for (const repair of repairs.values()) {
    const { content, ...rest } = repair;
    shown.push({ ...rest, before: originals.get(repair.path) == null ? null : sha256(originals.get(repair.path)),
      after: sha256(content), text: repairText(repair) });
  }
  return {
    repairs: shown, problems,
    contents: new Map([...repairs.values()].map((repair) => [repair.path, repair.content])),
    originals,
    async restore() {
      for (const [file, bytes] of originals) {
        const absolute = path.join(checkout, ...file.split('/'));
        if (bytes == null) await rm(absolute, { force: true });
        else await writeFile(absolute, bytes);
      }
    }
  };
}

const PACKAGED_TEMPLATE = 'That template belongs to a packaged workflow, so SFlow does not change it: give the step a template of '
  + 'this workflow\'s own (templateOverrides in workflow.yml, or a new step in Workflow Studio), or give the role to a step whose template has it.';

/** The template files a packaged workflow in `checkout` uses: read-only to every authoring route. */
async function packagedTemplates(checkout) {
  const { seededWorkflowProtection } = await import('./seeded-workflow-protection.mjs');
  const parsed = async (relative) => { try { return YAML.parse(await readFile(path.join(checkout, relative), 'utf8')) ?? {}; } catch { return {}; } };
  try { return new Set((await seededWorkflowProtection(await parsed(WORKFLOW_FILE), await parsed(PORTFOLIO_FILE), [])).templateFiles); }
  catch { return new Set(); }
}

/** What SFlow added to one template, in one sentence a person reads in a preview. */
export function repairText(repair) {
  const steps = repair.labels?.length ? ` (${words(repair.labels)})` : '';
  return `SFlow added to ${repair.template}${steps}: ${repair.added.join('; ')}. Each Story's author fills them in; nothing written there was changed.`;
}

/** A problem as a refusal lists it: what, in which workflow, and its fix. */
export function problemLines(problems) {
  return problems.map((problem) => `- ${problem.workflow}: ${problem.title}${problem.fix ? `\n  Fix: ${String(problem.fix).split('\n').join('\n  ')}` : ''}`).join('\n');
}

/**
 * A copy of the configuration at `readRoot` in a private temporary folder: every file sflow/config would
 * hold (src/configuration-assets.mjs), and the agents and skills folders the loader reads besides.
 */
async function configurationCopy(readRoot) {
  const [{ configurationAssetPolicy, configurationAssetSearchRoots, LEGACY_AGENTS_ROOT }] = await Promise.all([import('./configuration-assets.mjs')]);
  const parsed = async (relative) => { try { return YAML.parse(await readFile(path.join(readRoot, relative), 'utf8')) ?? {}; } catch { return {}; } };
  const policy = configurationAssetPolicy(await parsed(WORKFLOW_FILE), await parsed(PORTFOLIO_FILE));
  const runtime = (relative) => policy.runtimeRoots.some((root) => relative === root || relative.startsWith(`${root}/`));
  const copy = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-check-'));
  try {
    for (const root of [...new Set([...configurationAssetSearchRoots(policy), LEGACY_AGENTS_ROOT, '.github/skills'])]) {
      const source = path.join(readRoot, ...root.split('/'));
      if (!safeRelative(root) || !existsSync(source)) continue;
      await mkdir(path.dirname(path.join(copy, ...root.split('/'))), { recursive: true });
      await cp(source, path.join(copy, ...root.split('/')), { recursive: true, force: true, verbatimSymlinks: true,
        filter: (from) => {
          const relative = path.relative(readRoot, from).split(path.sep).join('/');
          return !relative.split('/').includes('.git') && !runtime(relative);
        } });
    }
    return copy;
  } catch (error) { await rm(copy, { recursive: true, force: true }); throw error; }
}

/** Run `fn` on a private copy of the configuration at `readRoot` (see configurationCopy), removed afterwards. */
export async function withConfigurationCopy(readRoot, fn) {
  const copy = await configurationCopy(readRoot);
  try { return await fn(copy); }
  finally { await rm(copy, { recursive: true, force: true }); }
}

/**
 * The check for a change not written yet: `files` (`{ path, content }`, content null for a removal) laid
 * over a copy of the configuration at `readRoot`, `workflows` judged before and after as approval would,
 * and what only needs placeholders repaired in the templates `editable(path)` allows (default: any).
 * Returns `{ repairs, problems, files }`: `files` are the change's files with each repaired template's
 * new content, and any template SFlow repaired that the change did not write (with `before`, its bytes
 * as they are). Nothing at `readRoot` is written.
 */
export async function checkCandidate(readRoot, files, { workflows, editable = () => true } = {}) {
  const ids = [...new Set(workflows ?? [])];
  if (!ids.length) return { repairs: [], problems: [], files: files.map((file) => ({ ...file })) };
  const copy = await configurationCopy(readRoot);
  try {
    const before = await problemsBefore(copy, ids);
    const written = new Set();
    for (const file of files) {
      if (!safeRelative(file.path)) continue;
      const absolute = path.join(copy, ...file.path.split('/'));
      if (file.content == null) { await rm(absolute, { force: true }); continue; }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content);
      written.add(file.path);
    }
    const outcome = await repairCheckout(copy, ids, { before, editable, written: (file) => written.has(file) });
    const next = files.map((file) => (outcome.contents.has(file.path) ? { ...file, content: outcome.contents.get(file.path) } : { ...file }));
    for (const [file, content] of outcome.contents) {
      if (!written.has(file)) next.push({ path: file, content, before: outcome.originals.get(file) ?? null, repaired: true });
    }
    return { repairs: outcome.repairs, problems: outcome.problems, files: next };
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

/** The Story workflows `after` (workflow.yml as parsed) adds or changes against `before`: the ones approval judges. */
export function changedWorkflows(before, after) {
  const stable = (value) => JSON.stringify(value ?? null, (key, entry) => (entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((name) => [name, entry[name]])) : entry));
  return Object.keys(after?.workTypes ?? {}).filter((id) => stable(before?.workTypes?.[id]) !== stable(after.workTypes[id]));
}

const parsedYaml = (text) => { try { return YAML.parse(String(text ?? '')) ?? {}; } catch { return {}; } };

/**
 * A whole-file save of workflow.yml (`configuration save`, Configuration Center) with the one check: the
 * workflows it adds or changes are judged as approval will, a template that lacks only placeholders gets
 * them in `checkout`, and any other problem it adds puts every file back and is refused with its fix.
 */
export async function checkedConfigurationSave(checkout, requestedPath, content, save) {
  const relative = String(requestedPath ?? '').replace(/\\/gu, '/');
  if (!(relative === WORKFLOW_FILE || relative.endsWith(`/${WORKFLOW_FILE}`))) return save();
  const file = path.join(checkout, ...WORKFLOW_FILE.split('/'));
  const previous = await readFile(file).catch(() => null);
  const ids = changedWorkflows(parsedYaml(previous), parsedYaml(content));
  if (!ids.length) return save();
  const before = await problemsBefore(checkout, ids);
  const result = await save();
  const outcome = await repairCheckout(checkout, ids, { before });
  if (!outcome.problems.length) return outcome.repairs.length ? { ...result, repairs: outcome.repairs } : result;
  await outcome.restore();
  if (previous == null) await rm(file, { force: true }); else await writeFile(file, previous);
  const { SingularityFlowError } = await import('./util.mjs');
  throw new SingularityFlowError(`${WORKFLOW_FILE} was not saved: approval would refuse ${outcome.problems.length === 1 ? 'a problem' : `${outcome.problems.length} problems`} it adds. `
    + `Nothing was saved or proposed.\n${problemLines(outcome.problems)}`, {
    code: 'CONFIGURATION_SAVE_WORKFLOW_PROBLEMS', details: { problems: outcome.problems,
      nextAction: { label: 'Change what each problem names, then save again', command: `singularity-flow workflow validate ${ids[0]}` } } });
}

/**
 * The check alone, for a change whose exact files a person already confirmed (`workflow author submit`): no
 * file can be added to them, so a problem approval would refuse is refused here, before anything is proposed.
 */
export async function refuseAddedProblems(readRoot, files, { label }) {
  const workflowFile = files.find((entry) => entry.path === WORKFLOW_FILE && entry.content != null);
  if (!workflowFile) return;
  const ids = changedWorkflows(parsedYaml(await readFile(path.join(readRoot, ...WORKFLOW_FILE.split('/'))).catch(() => '')), parsedYaml(workflowFile.content));
  if (!ids.length) return;
  const checked = await checkCandidate(readRoot, files, { workflows: ids, editable: () => false });
  if (!checked.problems.length) return;
  const { SingularityFlowError } = await import('./util.mjs');
  throw new SingularityFlowError(`${label} was not proposed: approval would refuse ${checked.problems.length === 1 ? 'a problem' : `${checked.problems.length} problems`} it adds. `
    + `Nothing was proposed.\n${problemLines(checked.problems)}`, {
    code: 'WORKFLOW_PACKAGE_PROBLEMS', details: { problems: checked.problems,
      nextAction: { label: 'Change the draft as each fix says, then preview it again', command: 'singularity-flow workflow author list' } } });
}
