/**
 * The conversion review of a marketplace agent (docs/SPEC-MCR-MARKETPLACE-CONVERSION-REVIEW-v1.md §4, owner 2026-11-23:
 * "make sure the import is correct ... what sflow corrects and give the feedback to marketplace stakeholders"): what
 * `workflow from-agent` made of an agent, section by section, for Workflow Studio's screen, Copilot and the terminal.
 *
 * - where it came from: the marketplace, its commit, the agent's version, its owner, its lifecycle with who approved it and
 *   when, and whether code owners guard that record (OMK §5.3), and its maintainer;
 * - agent stage → SFlow step: every stage of agent.md once, as a step, part of one, the first step's questions or a
 *   step's approval, with what the step is for and why, its approval and its skills;
 * - what SFlow changed: its own findings (steps it added, stages it merged, names it changed);
 * - needs your answer: the stages SFlow cannot classify, each with its choices;
 * - checks: every stage accounted for, nothing left to answer, the walk of a Story of it (no loop, no stop);
 * - feedback for the marketplace: the findings the marketplace owns, each with its fix.
 *
 * Import is ready only when nothing needs an answer and every check passes. Pure: it reads only the conversion.
 */
import { itemLifecycle, lifecycleSummary } from './marketplace-lifecycle.mjs';

const STAGE_WORDS = Object.freeze({
  step: 'becomes the step', folded: 'runs inside the step', questions: 'becomes the questions asked at', approval: 'becomes the approval of', open: 'waits for your answer at'
});
const APPROVAL_WORDS = Object.freeze({ person: 'a person approves it', none: 'no approval', 'sflow-when-clean': 'SFlow approves it when clean' });

/** The agent's lifecycle in the one vocabulary's words [OMK:REQ-010]: its record's, else its apm.yml's lifecycle-state's. */
function lifecycleOf(source) {
  if (source.lifecycleRecord) return source.lifecycleRecord.history ? lifecycleSummary(source.lifecycleRecord) : source.lifecycleRecord;
  // Read without the marketplace's CODEOWNERS (an agent folder, or a conversion made from its files): its guard is not known.
  return source.lifecycleState ? lifecycleSummary(itemLifecycle({ state: source.lifecycleState, owner: source.owner ?? null, guard: null })) : null;
}

/** The review of `result`, a `workflow from-agent` conversion (with `derived` and `walk` once it compiled). */
export function conversionReview(result) {
  const steps = result.steps ?? [];
  const byStep = new Map(steps.map((step) => [step.id, step]));
  const derived = new Map((result.derived ?? []).map((entry) => [entry.step, entry]));
  const findings = result.findings ?? [];
  const source = result.source ?? {};
  const stages = result.stages ?? [];

  const rows = steps.map((step) => {
    const given = derived.get(step.id);
    const own = stages.filter((stage) => stage.step === step.id);
    return {
      step: step.id, label: step.label, intent: step.intent ?? null, why: step.why ?? null, addedBySflow: Boolean(step.addedBySflow),
      stages: own.map((stage) => ({ number: stage.number, title: stage.title, becomes: stage.becomes })),
      approval: step.personApproval ? `a person approves it: the agent's ${step.personApproval.gate} gate` : given ? APPROVAL_WORDS[given.approval] ?? given.approval : null,
      changesCode: given ? given.changesSource : null,
      questions: step === steps[0] && (result.questions ?? []).length ? result.questions.map((question) => question.topic) : [],
      skills: (step.skills ?? []).map((entry) => ({ skill: entry.skill, when: entry.use || null }))
    };
  });

  // Every stage once, the gate stages included: a stage no step names is a gap in the conversion itself.
  const named = new Set(stages.map((stage) => stage.number));
  const unaccounted = stages.filter((stage) => !stage.step || (!byStep.has(stage.step) && stage.becomes !== 'open'));
  const stops = result.walk?.stops ?? [];
  const checks = [
    { id: 'stages', ok: stages.length > 0 && unaccounted.length === 0,
      words: unaccounted.length ? `${unaccounted.length} stage${unaccounted.length === 1 ? '' : 's'} of agent.md became nothing: ${unaccounted.map((stage) => `${stage.number}. ${stage.title}`).join(', ')}.`
        : `Every stage of agent.md (${named.size}) is accounted for.` },
    { id: 'answers', ok: (result.open ?? []).length === 0,
      words: (result.open ?? []).length ? `${result.open.length} stage${result.open.length === 1 ? '' : 's'} need${result.open.length === 1 ? 's' : ''} your answer before the workflow is made.` : 'Nothing waits for your answer.' },
    ...(result.walk ? [{ id: 'walk', ok: stops.length === 0,
      words: stops.length ? `A Story of it would ${stops.some((stop) => stop.class === 'loop') ? 'loop' : 'stop'}: ${stops.map((stop) => stop.title).join('; ')}.`
        : `Walked with no Story: ${result.walk.paths} path${result.walk.paths === 1 ? '' : 's'} and ${result.walk.routes} route${result.walk.routes === 1 ? '' : 's'}, no loop and no stop.`,
      fixes: stops.map((stop) => ({ title: stop.title, detail: stop.detail ?? null, fix: stop.fix?.text ?? null })) }] : [])
  ];
  const ready = Boolean(result.ready) && checks.every((check) => check.ok);

  return {
    schemaVersion: 1, resultType: 'sflow-conversion-review',
    source: {
      marketplace: source.marketplace ?? null, repository: source.repository ?? null, commit: source.commit ?? null, folder: source.folder ?? null,
      agent: source.agent ?? null, version: source.version ?? null, lifecycle: lifecycleOf(source)?.words ?? null,
      maintainer: source.maintainer ?? null, sourceRepository: source.sourceRepository ?? null,
      // Who owns it, and its lifecycle record with who and when and its guard (MCR §4.1, OMK §5.3); null when unknown.
      owner: source.owner ?? null, lifecycleRecord: lifecycleOf(source)
    },
    workflow: { id: result.workflow?.id ?? null, label: result.workflow?.label ?? null },
    rows,
    stages: stages.map((stage) => ({ ...stage, words: `${STAGE_WORDS[stage.becomes] ?? stage.becomes} ${byStep.get(stage.step)?.label ?? stage.step ?? 'no step'}` })),
    changes: findings.filter((finding) => finding.owner === 'sflow'),
    open: (result.open ?? []).map((entry) => ({ step: entry.step, stage: entry.stage, question: entry.question, why: entry.why ?? null, choices: entry.choices ?? [] })),
    checks,
    feedback: findings.filter((finding) => finding.owner !== 'sflow'),
    ...(result.update ? { update: result.update } : {}),
    ready
  };
}

/**
 * The update section's lines: what changed in the marketplace since the import, and what it changes for SFlow. For a
 * person (`forPerson`) it names versions, never a commit, as Workflow Studio does.
 */
function updateLines(update, { forPerson = false } = {}) {
  const short = (commit) => String(commit ?? '—').slice(0, 12);
  const version = update.version.from && update.version.to
    ? (update.version.from === update.version.to ? ` (version ${update.version.to})` : ` (version ${update.version.from}, now ${update.version.to})`) : '';
  const lines = ['## What changed in the marketplace', '',
    bullet(forPerson
      ? `${update.recorded ? 'Since this workflow was imported' : 'Its source was not recorded; compared with the commit this repository trusts'}${version}: ${update.words}.`
      : `${update.recorded ? 'Imported from' : 'Its source was not recorded; compared with the marketplace\'s pinned'} commit ${short(update.from)}${update.version.from ? ` (${update.version.from})` : ''}; now ${short(update.to)}${update.version.to ? ` (${update.version.to})` : ''}: ${update.words}.`)];
  if (update.trusts) {
    lines.push(bullet(forPerson
      ? `Updating it also makes this repository trust this commit of marketplace ${update.trusts.marketplace}, so Browse and Make a workflow read it too.`
      : `Updating it also makes this repository trust marketplace ${update.trusts.marketplace} at ${short(update.trusts.to)} (now ${short(update.trusts.from)}), so Browse and Make a workflow read that commit too.`));
  }
  if (update.nothingChanged) lines.push(bullet('Nothing changed for SFlow: the workflow stays as imported, and making it records the newer commit only.'));
  const steps = update.steps ?? {};
  if (steps.added?.length) lines.push(bullet(`New steps: ${steps.added.join(', ')}.`));
  if (steps.removed?.length) lines.push(bullet(`Steps no longer made: ${steps.removed.join(', ')}.`));
  for (const entry of steps.reclassified ?? []) lines.push(bullet(`${entry.step} is now ${entry.to}, not ${entry.from}.`));
  if (update.askedAgain?.length) lines.push(bullet(`Asked again, as their stages changed: ${update.askedAgain.join(', ')}.`));
  for (const words of update.findings?.added ?? []) lines.push(bullet(`New finding: ${words}`));
  for (const words of update.findings?.resolved ?? []) lines.push(bullet(`Resolved: ${words}`));
  const diff = (title, changes) => (changes?.length ? ['', `### ${title}`, '', '```diff', ...changes.map((change) => `${change.op === '…' ? '#' : change.op} ${change.text}`), '```'] : []);
  lines.push(...diff('agent.md', update.agent));
  for (const entry of update.skills ?? []) lines.push(...diff(`Skill ${entry.skill} (${entry.change})`, entry.lines));
  return [...lines, ''];
}

const bullet = (text) => `- ${text}`;

/**
 * The lines removed (`-`) and added (`+`) from `before` to `after`, blank lines ignored, at most `limit` of them: what an
 * update shows of a prompt that changed. Longest common subsequence; a text too long for it lists both sides.
 */
export function lineChanges(before, after, { limit = 200 } = {}) {
  const left = String(before ?? '').split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim());
  const right = String(after ?? '').split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim());
  let changes;
  if (left.length * right.length > 250_000) changes = [...left.map((text) => ({ op: '-', text })), ...right.map((text) => ({ op: '+', text }))];
  else {
    const table = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
    for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    changes = [];
    let i = 0; let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { i += 1; j += 1; }
      else if (j < right.length && (i >= left.length || table[i][j + 1] >= table[i + 1][j])) { changes.push({ op: '+', text: right[j] }); j += 1; }
      else { changes.push({ op: '-', text: left[i] }); i += 1; }
    }
  }
  return changes.length > limit ? [...changes.slice(0, limit), { op: '…', text: `${changes.length - limit} more changed lines` }] : changes;
}

/**
 * The review as Markdown: the same sections, for Copilot and the terminal. The terminal's names each commit; for a
 * person (`forPerson`, what a Copilot turn shows) it names versions and never a commit, as Workflow Studio does.
 */
export function conversionReviewMarkdown(review, { forPerson = false } = {}) {
  const { source } = review;
  const at = forPerson ? (review.update ? ', at its newest commit' : ', at the commit this repository trusts')
    : source.commit ? ` at commit ${String(source.commit).slice(0, 12)}` : '';
  const from = source.marketplace ? `marketplace ${source.marketplace}${at}` : `folder ${source.folder}`;
  const lines = [
    `# Conversion review: ${review.workflow.label ?? source.agent}`, '',
    '## Where it came from', '',
    bullet(`${source.agent}${source.version ? ` ${source.version}` : ''}, from ${from}${source.repository && !forPerson ? ` (${source.repository})` : ''}.`),
    ...(source.owner?.words ? [bullet(`${source.owner.words}.${source.owner.confirmWords ? ` ${source.owner.confirmWords}.` : ''}`)] : []),
    ...(source.lifecycle ? [bullet(`Lifecycle: ${source.lifecycle}.${source.lifecycleRecord?.guardWords ? ` ${source.lifecycleRecord.guardWords}` : ''}`)] : []),
    ...(source.lifecycleRecord?.change && !forPerson ? [bullet(`Its lifecycle change: ${source.lifecycleRecord.change}`)] : []),
    ...(source.maintainer ? [bullet(`Maintainer: ${source.maintainer}.`)] : []),
    '', '## Agent stage → SFlow step', '',
    '| Stage | Becomes | Step | What it is for | Approval | Skills |', '|---|---|---|---|---|---|',
    ...review.stages.map((stage) => {
      const row = review.rows.find((entry) => entry.step === stage.step);
      return `| ${stage.number}. ${stage.title} | ${stage.becomes} | ${row?.label ?? stage.step ?? '—'} | ${row?.intent ?? 'not known yet'}${row?.why ? `: ${row.why}` : ''} | ${row?.approval ?? '—'} | ${(row?.skills ?? []).map((entry) => `${entry.skill}${entry.when ? ` (${entry.when})` : ''}`).join(', ') || '—'} |`;
    }),
    ...review.rows.filter((row) => row.addedBySflow).map((row) => `| — | added by SFlow | ${row.label} | ${row.intent}: ${row.why} | ${row.approval ?? '—'} | — |`),
    ...(review.rows[0]?.questions?.length ? ['', `Asked at ${review.rows[0].label}, before any work: ${review.rows[0].questions.join(' ')}`] : []),
    '', '## What SFlow changed', '',
    ...(review.changes.length ? review.changes.map((entry) => bullet(entry.words)) : ['Nothing: every stage became its own step as written.']),
    '', '## Needs your answer', '',
    ...(review.open.length ? review.open.flatMap((entry) => [bullet(`${entry.question} (stage ${entry.stage})`), ...entry.choices.map((choice) => `  - ${choice.label}`)]) : ['Nothing.']),
    '', '## Checks', '',
    ...review.checks.flatMap((check) => [bullet(`${check.ok ? 'Passed' : 'Not yet'}: ${check.words}`), ...(check.fixes ?? []).map((fix) => `  - ${fix.title}.${fix.detail ? ` ${fix.detail}` : ''} Fix: ${fix.fix ?? '—'}`)]),
    '', ...(review.update ? updateLines(review.update, { forPerson }) : []),
    '## Feedback for the marketplace', '',
    ...(review.feedback.length ? review.feedback.map((entry) => bullet(`${entry.words}${entry.fix ? ` Fix: ${entry.fix}` : ''}`)) : ['Nothing to report.']),
    '', review.ready ? 'Ready to make: nothing waits for your answer and every check passed.' : 'Not ready to make yet: see Needs your answer and Checks.'
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The feedback for the marketplace as Markdown (MCR §6): only the findings the marketplace owns, each with its fix,
 * and where it came from. It holds nothing of the importer's repository, Story or person.
 */
/** Today on this computer's calendar: a person reads the feedback's date, so it is not UTC's day. */
const localDay = (at = new Date()) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

export function conversionFeedbackMarkdown(review, { date = localDay() } = {}) {
  const { source } = review;
  const lines = [
    `# Feedback on ${source.agent}${source.version ? ` ${source.version}` : ''}`, '',
    `Found while converting it into an SFlow workflow, ${date}.`, '',
    bullet(`Marketplace: ${source.marketplace ?? source.folder ?? '—'}${source.commit ? `, commit ${source.commit}` : ''}.`),
    ...(source.maintainer ? [bullet(`Maintainer: ${source.maintainer}.`)] : []),
    '', '## What to fix in the marketplace', '',
    ...(review.feedback.length
      ? review.feedback.flatMap((entry, index) => [`${index + 1}. ${entry.words}`, ...(entry.fix ? [`   Fix: ${entry.fix}`] : [])])
      : ['Nothing: the agent converted as written.']),
    ''
  ];
  return lines.join('\n');
}

/** The web address of a repository's own pages, from its clone URL, or null for a local path or a host SFlow cannot address. */
export function repositoryPageUrl(value) {
  const text = String(value ?? '').trim();
  const ssh = /^(?:ssh:\/\/)?git@([A-Za-z0-9.-]+)[:/](.+?)(?:\.git)?\/?$/u.exec(text);
  const https = /^https:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/(.+?)(?:\.git)?\/?$/u.exec(text);
  const [host, repository] = ssh ? [ssh[1], ssh[2]] : https ? [https[1], https[2]] : [null, null];
  if (!host || !/^[\w.-]+(?:\/[\w.-]+)+$/u.test(repository) || /@/u.test(host)) return null;
  return `https://${host}/${repository}`;
}

/**
 * The repository's new-issue page with the feedback filled in, for the person to submit: the agent's own source
 * repository, else the marketplace's. Null where there is no web page to open. A body too long for an address leaves
 * the title only; the person pastes the feedback, which the host copies for them.
 */
export function feedbackIssue(review, markdown, { maximumUrl = 7000 } = {}) {
  const page = repositoryPageUrl(review.source.sourceRepository) ?? repositoryPageUrl(review.source.repository);
  if (!page) return null;
  // GitLab's new-issue form reads issue[title] and issue[description]; GitHub's reads title and body (OMK probe P4).
  const gitlab = /gitlab/iu.test(page);
  const [titleKey, bodyKey] = gitlab ? ['issue[title]', 'issue[description]'] : ['title', 'body'];
  const title = `SFlow conversion feedback: ${review.source.agent}${review.source.version ? ` ${review.source.version}` : ''}`;
  const titled = `${page}${gitlab ? '/-/issues/new' : '/issues/new'}?${encodeURIComponent(titleKey)}=${encodeURIComponent(title)}`;
  const full = `${titled}&${encodeURIComponent(bodyKey)}=${encodeURIComponent(markdown)}`;
  return full.length <= maximumUrl ? { url: full, title, bodyInUrl: true } : { url: titled, title, bodyInUrl: false };
}

/** What the host saves, copies or opens: the feedback document of `review`, or null when the marketplace owns nothing here. */
export function feedbackDocument(review, { date } = {}) {
  if (!review.feedback.length) return null;
  const markdown = conversionFeedbackMarkdown(review, { date });
  const safe = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'agent';
  return { name: `conversion-feedback-${safe(review.source.agent)}${review.source.version ? `-${safe(review.source.version)}` : ''}.md`, markdown, issue: feedbackIssue(review, markdown) };
}
