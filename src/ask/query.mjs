import { askHistoryIntent } from './history-intent.mjs';

// A closed lexical resolver. Verbs in free text never acquire execution meaning.
const prefix = /^(?:(?:open|show|read|find|get)\s+)?(?:the\s+)?/iu;
const specRef = /^spec-[a-z0-9]+(?:-[a-z0-9]+)*(?:@[1-9][0-9]*)?$/iu;
const workRef = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const namedWork = new RegExp('^(story|initiative)\\s+(' + workRef + ')(?:\\s+(?:status|blockers))?$', 'iu');
const storySpec = new RegExp(
  '^(?:specification|spec)\\s+(?:used\\s+(?:for|by)|(?:for|behind|of))\\s+(?:the\\s+)?(?:(this|current)\\s+(?:story|work)|story\\s+(' + workRef + ')|(' + workRef + '))$', 'iu'
);

export function askIntent(query, workId = null) {
  const value = query.trim().replace(/[?]+$/u, '').trim();
  const request = value.replace(prefix, '');
  const preciseSpec = request.replace(/^(?:specification|spec)\s+(?=spec-)/iu, '');
  if (specRef.test(preciseSpec)) return { kind: 'spec', reference: preciseSpec.toUpperCase() };
  const usage = storySpec.exec(request);
  if (usage) return { kind: 'story-spec', workId: usage[2] ?? usage[3] ?? workId, workKind: 'story' };
  const history = askHistoryIntent(request, workId);
  if (history) return history;
  const explicit = namedWork.exec(request);
  if (explicit) return { kind: 'work', workId: explicit[2], workKind: explicit[1].toLowerCase() };
  if (workId || /^(?:my work|current work|active (?:work|story)|(?:this|current) (?:work|story)(?: status)?|what (?:am i working on|is (?:my current work|blocking (?:me|(?:this|my) (?:story|work)|progress)))|what['’]s blocking (?:me|(?:this|my) (?:story|work)|progress)|(?:my |current )?blockers|work status)$/iu.test(request)) {
    return { kind: 'work', workId, workKind: null };
  }
  if (/^(?:implement|investigate|start a (?:story|task))\b/iu.test(request)) {
    return { kind: 'unsupported', feature: 'task' };
  }
  return { kind: 'discovery' };
}

export function askNeedsRepository(intent) {
  return ['work', 'story-spec', 'spec', 'work-history', 'commits', 'comparison'].includes(intent.kind);
}

const ordinal = value => /^\d+$/u.test(value) ? Number(value) : ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(value) + 1;

export function askSavedReference(query) {
  const text = query.toLowerCase().trim().replace(/[?.!]+$/u, '');
  const position = /^(?:show |open )?(?:the )?(first|second|third|fourth|fifth|\d+)(?: result)?$/u.exec(text);
  if (position) return { action: 'position', index: ordinal(position[1]) - 1 };
  const related = /^(?:open|show) (?:the )?spec(?:ification)? (?:behind|for) (?:the )?(this work|that result|(?:first|second|third|fourth|fifth|\d+) (?:result|change))$/u.exec(text);
  if (related) return { action: 'linked-spec', index: ordinal(related[1].split(' ')[0]) - 1 };
  if (/^(?:open |show )?(?:that|the|this) (?:spec|specification)$/u.test(text)) return { action: 'selected-spec' };
  if (/^(?:show )?(?:those changes|these results|the same results)$/u.test(text)) return { action: 'resume' };
  if (/^(?:next page|more results)$/u.test(text)) return { action: 'next' };
  if (/^(?:also include|include) (?:the )?previous week$/u.test(text)) return { action: 'previous-week' };
  if (/^(?:what is )?(?:its|that work's) (?:status now|current status)$/u.test(text)) return { action: 'work-status' };
  if (/^(?:use|open|show) (?:the )?(?:newest|latest) (?:published )?(?:spec|specification|revision)$/u.test(text)) return { action: 'latest-spec' };
  return null;
}
