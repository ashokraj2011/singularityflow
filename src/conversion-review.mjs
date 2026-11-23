/**
 * The conversion review of a marketplace agent (docs/SPEC-MCR-MARKETPLACE-CONVERSION-REVIEW-v1.md §4, owner 2026-11-23:
 * "make sure the import is correct ... what sflow corrects and give the feedback to marketplace stakeholders"): what
 * `workflow from-agent` made of an agent, section by section, for Workflow Studio's screen, Copilot and the terminal.
 *
 * - where it came from: the marketplace, its commit, the agent's version, lifecycle state and maintainer;
 * - agent stage → SFlow step: every stage of agent.md once, as a step, part of one, the first step's questions or a
 *   step's approval, with what the step is for and why, its approval and its skills;
 * - what SFlow changed: its own findings (steps it added, stages it merged, names it changed);
 * - needs your answer: the stages SFlow cannot classify, each with its choices;
 * - checks: every stage accounted for, nothing left to answer, the walk of a Story of it (no loop, no stop);
 * - feedback for the marketplace: the findings the marketplace owns, each with its fix.
 *
 * Import is ready only when nothing needs an answer and every check passes. Pure: it reads only the conversion.
 */

const STAGE_WORDS = Object.freeze({
  step: 'becomes the step', folded: 'runs inside the step', questions: 'becomes the questions asked at', approval: 'becomes the approval of', open: 'waits for your answer at'
});
const APPROVAL_WORDS = Object.freeze({ person: 'a person approves it', none: 'no approval', 'sflow-when-clean': 'SFlow approves it when clean' });

const lifecycleWords = (state) => (!state ? null : state === 'proposed' ? 'proposed: not yet reviewed by its maintainers' : state);

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
      agent: source.agent ?? null, version: source.version ?? null, lifecycle: lifecycleWords(source.lifecycleState),
      maintainer: source.maintainer ?? null, sourceRepository: source.sourceRepository ?? null
    },
    workflow: { id: result.workflow?.id ?? null, label: result.workflow?.label ?? null },
    rows,
    stages: stages.map((stage) => ({ ...stage, words: `${STAGE_WORDS[stage.becomes] ?? stage.becomes} ${byStep.get(stage.step)?.label ?? stage.step ?? 'no step'}` })),
    changes: findings.filter((finding) => finding.owner === 'sflow'),
    open: (result.open ?? []).map((entry) => ({ step: entry.step, stage: entry.stage, question: entry.question, why: entry.why ?? null, choices: entry.choices ?? [] })),
    checks,
    feedback: findings.filter((finding) => finding.owner !== 'sflow'),
    ready
  };
}

const bullet = (text) => `- ${text}`;

/** The review as Markdown: the same sections, for Copilot and the terminal. */
export function conversionReviewMarkdown(review) {
  const { source } = review;
  const from = source.marketplace ? `marketplace ${source.marketplace}${source.commit ? ` at commit ${String(source.commit).slice(0, 12)}` : ''}` : `folder ${source.folder}`;
  const lines = [
    `# Conversion review: ${review.workflow.label ?? source.agent}`, '',
    '## Where it came from', '',
    bullet(`${source.agent}${source.version ? ` ${source.version}` : ''}, from ${from}${source.repository ? ` (${source.repository})` : ''}.`),
    ...(source.lifecycle ? [bullet(`Lifecycle: ${source.lifecycle}.`)] : []),
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
    '', '## Feedback for the marketplace', '',
    ...(review.feedback.length ? review.feedback.map((entry) => bullet(`${entry.words}${entry.fix ? ` Fix: ${entry.fix}` : ''}`)) : ['Nothing to report.']),
    '', review.ready ? 'Ready to make: nothing waits for your answer and every check passed.' : 'Not ready to make yet: see Needs your answer and Checks.'
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The feedback for the marketplace as Markdown (MCR §6): only the findings the marketplace owns, each with its fix,
 * and where it came from. It holds nothing of the importer's repository, Story or person.
 */
export function conversionFeedbackMarkdown(review, { date = new Date().toISOString().slice(0, 10) } = {}) {
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
  const path = /gitlab/iu.test(page) ? '/-/issues/new' : '/issues/new';
  const title = `SFlow conversion feedback: ${review.source.agent}${review.source.version ? ` ${review.source.version}` : ''}`;
  const titled = `${page}${path}?title=${encodeURIComponent(title)}`;
  const full = `${titled}&body=${encodeURIComponent(markdown)}`;
  return full.length <= maximumUrl ? { url: full, title, bodyInUrl: true } : { url: titled, title, bodyInUrl: false };
}

/** What the host saves, copies or opens: the feedback document of `review`, or null when the marketplace owns nothing here. */
export function feedbackDocument(review, { date } = {}) {
  if (!review.feedback.length) return null;
  const markdown = conversionFeedbackMarkdown(review, { date });
  const safe = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'agent';
  return { name: `conversion-feedback-${safe(review.source.agent)}${review.source.version ? `-${safe(review.source.version)}` : ''}.md`, markdown, issue: feedbackIssue(review, markdown) };
}
