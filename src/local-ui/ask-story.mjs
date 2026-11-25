/** Story evidence for browser conversations, projected from the existing read owners. */
const topics = {
  status: {
    title: 'Story status', questions: [
      /^(?:(?:active|current) (?:story|work)|(?:story|work) status|what is my current work|what am i working on)$/u,
      /^where does (?:this|my) story stand$/u,
      /^what (?:is the (?:current )?phase|phase (?:are we|is (?:this|the current) story) in)$/u
    ]
  },
  decisions: {
    title: 'Pending decisions', operation: 'decision.list', questions: [
      /^(?:pending decisions|what(?:'s| is) (?:still pending|blocking (?:this story|it|me|approval|progress)))$/u,
      /^why (?:is (?:this story|it) blocked|are we blocked)$/u,
      /^what (?:needs (?:a decision|approval|my approval)|decisions (?:are pending|do i need to make))$/u
    ]
  },
  tests: {
    title: 'Test evidence', operation: 'tests.summary', questions: [
      /^(?:what (?:tests (?:ran|passed|failed)|ran)|(?:show )?(?:test results|test evidence))$/u,
      /^(?:what about|did) (?:the |its |this story's )?tests(?: pass| fail)?$/u
    ]
  },
  changes: {
    title: 'Code changes', operation: 'code.changes', questions: [
      /^(?:what changed(?: in (?:this|the current) story)?|which files changed|(?:show )?(?:my |the )?code changes)$/u
    ]
  },
  specifications: {
    title: 'Attached specifications', questions: [
      /^(?:which spec(?:ification)? is attached(?: to this story)?|what spec(?:ification)? is this story using)$/u,
      /^(?:attached spec(?:ification)?s?|spec(?:ification)? used for this story)$/u
    ]
  }
};
const referring = /\b(?:it|its|they|them|those|these|that|earlier|same|previous)\b/u;
const current = /\b(?:this|my|active|current) story\b/u;
const mentions = {
  decisions: /\b(?:approval|approv\w*|block\w*|decision\w*|review\w*|pending|waiting)\b/u,
  tests: /\b(?:tests?|testing|verif\w*|regressions?|pass(?:ed|ing)?|fail(?:ed|ing|ures?)?)\b/u,
  changes: /\b(?:code|files?|diff|chang\w*|implement\w*|clause\w*|trace\w*)\b/u,
  specifications: /\b(?:specs?|specification\w*|requirements?|acceptance criteria)\b/u
};
const normalize = value => value.toLowerCase().replace(/[’]/gu, "'").replace(/[?!.]+$/u, '').trim();
const phaseName = phase => phase?.replace(/[-_]+/gu, ' ');
const shorten = (value, max = 140) => String(value ?? '').trim().slice(0, max);

export function storyQuestion(question, previous) {
  const value = normalize(question);
  const direct = Object.keys(topics).find(topic => topics[topic].questions.some(pattern => pattern.test(value)));
  if (direct) return direct;
  if (previous?.topic && /^(?:show me the source|where did (?:you|that) (?:get|come from)(?: that)?)$/u.test(value)) return previous.topic;
  const wasAbout = topic => previous?.topic === topic || previous?.sources?.some(source => source.type === 'story-' + topic);
  if (wasAbout('tests') && /^(?:did (?:they|it|those) (?:pass|fail)|(?:how many|which ones) (?:passed|failed|were skipped))$/u.test(value)) return 'tests';
  if (wasAbout('changes') && /^(?:(?:what|which) files|where (?:is it|are they))$/u.test(value)) return 'changes';
  return null;
}

export function storyForQuestion(story, question, previous) {
  if (!story || !previous?.subject || previous.subject.toLowerCase() === story.workId.toLowerCase()) return story;
  return current.test(normalize(question)) ? story : null;
}

export function asksForStorySummary(question) {
  return /^(?:summari[sz]e (?:this|the current) story|what(?:'s| is) (?:next|left)(?: (?:for|on) this story)?|what should i review before i hand (?:this|it) off)$/u.test(normalize(question));
}

export function relatedStoryTopics(question, previous) {
  const value = normalize(question);
  const relevant = Object.keys(mentions).filter(topic => mentions[topic].test(value));
  if (previous?.topic && previous.topic !== 'status' && referring.test(value) && !relevant.includes(previous.topic)) relevant.push(previous.topic);
  if (/\b(?:summari[sz]e|handoff|hand .* off|ready|what(?:'s| is) next|what needs attention|progress)\b/u.test(value)) {
    for (const topic of ['decisions', 'tests']) if (!relevant.includes(topic)) relevant.push(topic);
  }
  return relevant.slice(0, 2);
}

function source(story, topic, snippet) {
  return { type: 'story-' + topic, id: story.workId, title: topics[topic].title,
    subtitle: [story.title, story.workId, story.repository.id, phaseName(story.phase)].filter(Boolean).join(' · ').slice(0, 320),
    snippet: snippet.slice(0, 1200) };
}

export async function readStorySources(story, topic, { read, specifications }) {
  const display = story.title && story.title !== story.workId ? story.title + ' (' + story.workId + ')' : story.workId;
  if (topic === 'status') {
    const phase = story.phase ? display + ' is in ' + phaseName(story.phase) +
      (story.phaseStatus ? ' (' + phaseName(story.phaseStatus) + ')' : '') + '.' : display + ' has no active phase recorded.';
    const status = story.storyStatus && story.storyStatus !== story.phaseStatus ? ' Story status is ' + phaseName(story.storyStatus) + '.' : '';
    return [source(story, topic, phase + status)];
  }
  if (topic === 'specifications') {
    const result = await specifications(story.workId);
    const pins = (result.specifications ?? []).slice(0, 4);
    const diagnostic = result.diagnostics?.[0]?.message;
    const snippet = pins.length ? 'Attached to ' + story.workId + ': ' + pins.map(pin => pin.reference + ' · ' + shorten(pin.title)).join('; ') + '.'
      : diagnostic ?? 'SFlow could not confirm an attached specification.';
    return [source(story, topic, snippet), ...pins.map(pin => ({ type: 'spec', id: pin.reference, title: pin.title,
      reference: pin.reference, stateCommit: pin.stateCommit, manifestSha256: pin.manifestSha256 }))];
  }
  const value = await read(topics[topic].operation).then(raw => raw?.resultType === 'command-result' ? raw.data : raw).catch(error => {
    if (topic === 'decisions' && error.code === 'DECISIONS_PHASE_UNKNOWN') return { noCurrentPhase: true };
    throw error;
  });
  if (topic === 'decisions' && value?.noCurrentPhase) return [source(story, topic, 'This Story has no active phase to review.')];
  if (topic === 'decisions' && value?.workId === story.workId && Array.isArray(value.items)) {
    const headline = value.plain?.headline ?? (value.items.length ? 'Decisions are waiting.' : 'No decisions are waiting in this phase.');
    const questions = value.items.slice(0, 4).map(item => [item.plain?.question ?? item.title, item.plain?.why ?? item.why]
      .filter(Boolean).map(part => shorten(part, 125)).join(' · ')).filter(Boolean);
    return [source(story, topic, [headline, ...questions, value.items.length > questions.length ? 'See Decisions for the remaining items.' : '']
      .filter(Boolean).join('\n'))];
  }
  if (topic === 'tests' && value?.scope?.workId === story.workId) {
    const { scope, run, totals, commands } = value;
    if (!run) return [source(story, topic, 'No retained test run for ' + story.workId + ' in this phase.')];
    const counts = ['passed', 'failed', 'skipped'].filter(key => Number.isFinite(totals?.[key])).map(key => totals[key] + ' ' + key);
    const lines = [shorten(run.label ?? run.id) + ' · ' + phaseName(scope.phase),
      counts.length ? counts.join(', ') + '.' : '', ...(commands ?? []).slice(0, 4).map(command => shorten(command.label ?? command.id) + ' · ' + phaseName(command.status))];
    return [source(story, topic, lines.filter(Boolean).join('\n'))];
  }
  const model = value?.codeMap?.model;
  if (topic === 'changes' && model?.story?.workId === story.workId && model.change) {
    const { change } = model;
    if (change.status !== 'available') {
      return [source(story, topic, change.reason ?? 'No application code changes were found for this Story.')];
    }
    const files = (model.modules ?? []).filter(file => file.status !== 'unchanged' && file.path).slice(0, 6);
    const clauses = (model.trace?.requirements ?? []).filter(clause => clause.modules?.length).slice(0, 4)
      .map(clause => shorten(clause.id) + ' (' + shorten(clause.status, 32) + ')');
    const summary = [change.files + ' changed ' + (change.files === 1 ? 'file' : 'files') + ' in ' + (story.repository.id ?? 'this repository') + '.',
      ...(clauses.length ? ['Recorded links to requirements: ' + clauses.join(', ') + '.'] : []),
      '+' + change.added + ' added, −' + change.removed + ' removed.', ...files.map(file => shorten(file.path, 160))];
    return [source(story, topic, summary.join('\n'))];
  }
  return [source(story, topic, 'SFlow could not confirm this evidence for ' + story.workId + '. Open the source to check the current record.')];
}

export function searchTurn(query, value) {
  const { kind, work, help, specifications, results, diagnostics, history, comparison, evidence } = value;
  if (kind === 'workspace-search') {
    const matches = results.slice(0, 4).filter(result => !result.draft);
    return { question: query, answer: value.total ? value.total + ' workspace matches.' : 'No matching results.',
      modelSummary: matches.length ? matches.map(result => shorten(result.title) + ' (' + shorten(result.reference ?? result.id) + ')').join('\n') : '',
      answeredBy: 'search', scoped: true };
  }
  const parts = [work && [work.title, work.id, work.phaseLabel ?? work.phase, work.status ?? work.workStatus].filter(Boolean).join(' · '),
    help?.title, evidence?.title, ...(specifications ?? []).slice(0, 4).map(pin => pin.reference + ' · ' + pin.title),
    history ? 'Opened retained history.' : '', comparison ? 'Opened a revision comparison.' : '',
    diagnostics?.[0]?.message].filter(Boolean);
  return { question: query, answer: shorten(parts.join('\n'), 900) || 'Search results are available.', answeredBy: 'search',
    scoped: true, ...(work?.kind === 'story' ? { subject: work.id, topic: 'status' } : {}) };
}
