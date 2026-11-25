import { dataOf, escape, icon, markdown, testSummary, words } from './views.js';

const types = {
  story: ['Stories', 'Story', 'stories'], initiative: ['Initiatives', 'Initiative', 'stories'],
  spec: ['Specifications', 'Specification', 'specs'], file: ['Files', 'File', 'code'],
  workflow: ['Workflows', 'Workflow', 'workflows'], agent: ['Agents', 'Agent', 'agents'],
  skill: ['Skills', 'Skill', 'skills'], instruction: ['Instructions', 'Instruction', 'instructions'],
  help: ['Help', 'Help', 'about'], page: ['Pages', 'Page', 'home']
};

function target(result) {
  const id = encodeURIComponent(result.id);
  if (result.selection) return result.type === 'file' ? { file: result.selection } : { selection: result.selection };
  if (result.type === 'spec' && result.draft) return { route: 'spec/' + id };
  if (result.type === 'story') return result.local ? { query: 'story ' + result.id } : { route: 'stories/' + id };
  if (result.type === 'initiative') return { query: 'initiative ' + result.id };
  if (result.type === 'help') return { query: result.id };
  if (result.type === 'page') return result.id === 'help' ? { query: 'help' } : { route: result.id };
  const page = types[result.type]?.[2];
  return page && ['workflows', 'agents', 'skills', 'instructions'].includes(page) ? { route: page + '/' + id } : {};
}

function resultAction(result, child, className) {
  const [key, value] = Object.entries(target(result))[0] ?? [];
  if (!key) return `<span>${child}</span>`;
  if (key === 'route') return `<a class="${className}" href="#${escape(value)}">${child}</a>`;
  return `<button type="button" class="${className}" data-${key}="${escape(value)}">${child}</button>`;
}

export function searchResultsView(value, selectedType = 'all') {
  const available = Object.keys(types).filter(type => value.counts[type]);
  const results = selectedType === 'all' ? value.results : value.results.filter(result => result.type === selectedType);
  const count = selectedType === 'all' ? value.total : value.counts[selectedType];
  const filters = [['all', 'All', value.total], ...available.map(type => [type, types[type][0], value.counts[type]])];
  if (!value.results.length) return `<section class="ask-no-results"><h2>No matching results</h2>
    <p>Try a name, ID, file path, or shorter phrase.</p><button type="button" data-ask-mode="chat">Ask Copilot</button>
    ${value.missing.length ? `<p class="muted">Some sources were unavailable · ${escape(value.missing.join(', '))}</p>` : ''}</section>`;
  return `<section class="ask-result-panel" aria-label="Workspace search results">
    <div class="ask-filters" role="group" aria-label="Filter results">${filters.map(([key, label, number]) =>
      `<button type="button" data-result-filter="${key}" aria-pressed="${key === selectedType}">${label} <small>${number}</small></button>`).join('')}</div>
    <div class="ask-result-toolbar"><p class="ask-result-count">${count > results.length ? `Showing ${results.length} of ` : ''}${count} ${count === 1 ? 'match' : 'matches'}</p>
    <button class="quiet" type="button" data-ask-mode="chat" data-discuss-results>Ask about these results ${icon('chat')}</button></div>
    <ol class="ask-results">${results.map(result => {
      const [, noun, pictogram] = types[result.type] ?? ['Results', 'Result', 'ask'];
      const caption = result.subtitle ? [noun, words(result.subtitle)] : [noun];
      if (result.line) caption.push('Line ' + result.line);
      if (result.type !== 'file' && result.type !== 'page' && result.id !== result.title) caption.push(result.reference ?? result.id);
      return `<li><article class="ask-result"><span class="ask-result-icon">${icon(pictogram)}</span><div>
        <p class="ask-result-type">${caption.map(escape).join(' · ')}</p>
        <h2>${resultAction(result, escape(result.title), 'ask-result-title')}</h2>
        ${result.snippet ? `<p class="ask-result-snippet">${escape(result.snippet)}</p>` : ''}</div></article></li>`;
    }).join('')}</ol>
    ${value.missing.length ? `<p class="muted">Some sources were unavailable · ${escape(value.missing.join(', '))}</p>` : ''}
  </section>`;
}

export function chatLogView(turns) {
  return turns.map(turn => `<article class="ask-turn">
    <p class="ask-chat-question">${escape(turn.question)}</p>
    <div class="ask-chat-reply"><div class="ask-chat-byline">${icon('chat')}<strong>Copilot</strong></div>
      ${markdown(turn.answer)}
      ${turn.sources?.length ? `<div class="ask-citations" aria-label="Sources">${turn.sources.map(source =>
        resultAction(source, `<small>${escape(source.citation)}</small> ${escape(source.title)}`, 'ask-citation')).join('')}</div>` : ''}
    </div></article>`).join('');
}

export function searchFileView(file) {
  return `<article class="card ask-answer ask-file-preview">
    <h2>${escape(file.path)}</h2><p class="muted">Commit <code>${escape(file.revision.slice(0, 12))}</code>
      ${file.truncated ? ' · Preview' : ''}</p>
    <pre class="section-output"><code>${escape(file.text)}</code></pre></article>`;
}

export function storyAnswerView(question, raw, story) {
  const value = dataOf(raw);
  let body, route, label, phase;
  if (question === 'decisions' && value?.noCurrentPhase) {
    body = '<p>This Story has no active phase to review.</p>';
    route = 'stories/' + encodeURIComponent(story.workId); label = 'Open Stories';
  } else if (question === 'decisions' && value?.workId === story.workId && Array.isArray(value.items)) {
    const items = value.items.slice(0, 5);
    body = `<p>${escape(value.plain?.headline ?? (items.length ? 'Decisions are waiting.' : 'No decisions are waiting.'))}</p>
      ${items.length ? `<ul class="ask-story-items">${items.map(item => `<li>${escape(item.plain?.question ?? item.title ?? 'Decision')}</li>`).join('')}</ul>` : ''}
      ${items.length < value.items.length ? `<p class="muted">${value.items.length - items.length} more in Decisions.</p>` : ''}`;
    phase = value.phaseLabel ?? value.phase;
    route = 'decisions'; label = 'Open Decisions';
  } else if (question === 'tests' && value?.scope?.workId === story.workId) {
    body = testSummary(value);
    phase = value.scope.phase;
    route = 'run'; label = 'Open Run & Test';
  } else if (question === 'changes' && value?.codeMap?.model?.story?.workId === story.workId) {
    const { change } = value.codeMap.model;
    body = change.status === 'available'
      ? `<p>${change.files} changed ${change.files === 1 ? 'file' : 'files'} in ${escape(story.repositoryId ?? 'this repository')}.</p>
        <div class="test-counts" aria-label="Changed lines"><span><strong>+${change.added}</strong> added</span><span><strong>−${change.removed}</strong> removed</span></div>`
      : `<p>${escape(change.reason ?? 'No application code changes were found for this Story.')}</p>`;
    if (value.codeMap.notices?.length) body += `<p class="muted">${escape(value.codeMap.notices[0])}</p>`;
    route = 'code'; label = 'Open Code Explainer';
  } else {
    throw new Error('SFlow returned no matching result for this Story. Check the selected checkout and try again.');
  }
  const title = { decisions: 'Pending decisions', tests: 'Test evidence', changes: 'Code changes' }[question];
  return `<section class="card ask-answer ask-story-answer"><h2>${title}</h2>
    <p class="ask-result-type">${escape([story.workId, phase && words(phase)].filter(Boolean).join(' · '))}</p>
    ${body}<a class="text-link" href="#${route}">${label} ${icon('right')}</a></section>`;
}
