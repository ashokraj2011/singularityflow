const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const DATE = '[0-9]{4}-[0-9]{2}-[0-9]{2}';
const ZONE = '[A-Za-z][A-Za-z0-9_+/-]*';
const windowPattern = '(?:from (' + DATE + ') to (' + DATE + ')|(today|yesterday|last week))(?: in (' + ZONE + '))?';
const commits = /^(?:git commits|commits|what was committed|committed changes)(?: (.*?))?(?: on (\S+))?$/iu;
const range = new RegExp('^' + windowPattern + '$', 'iu');
const list = new RegExp('^(?:which )?(stories|initiatives) (completed|(?:with|had) activity)(?: (.+))?$', 'iu');
const current = /^(?:currently (?:complete|completed) (stories|initiatives)|(?:which )?(stories|initiatives) (?:are )?currently (?:complete|completed))$/iu;
const history = new RegExp('^(?:(story|initiative|work|change) )?history(?: for (story|initiative) (' + ID + '))?(?: (.+))?$', 'iu');
const asOf = new RegExp('^(story|initiative) (' + ID + ') as of (' + DATE + ')(?: in (' + ZONE + '))?$', 'iu');
const explicitPair = /^compare (?:revisions )?(\S+) (?:with|to|and) (\S+)(?: (path|patch) (.+))?$/iu;
const workKind = value => ({ stories: 'story', story: 'story', initiatives: 'initiative', initiative: 'initiative' })[value?.toLowerCase()] ?? null;
const workRangeHint = 'Enter a period such as from 2026-11-01 to 2026-11-07 in Asia/Kolkata, or last week.';
const compareHint = 'Name two exact endpoints, for example compare main with release/v1.';

function periodFor(value) {
  const match = range.exec(value ?? '');
  return match ? { startDate: match[1], endDate: match[2], period: match[3]?.toLowerCase(), timeZone: match[4] } : null;
}

const clarify = message => ({ kind: 'clarification', message });

export function askHistoryIntent(request, selectedWorkId) {
  const comparison = explicitPair.exec(request);
  if (comparison) {
    return {
      kind: 'comparison', left: comparison[1], right: comparison[2],
      path: comparison[4]?.trim() ?? null, patch: comparison[3]?.toLowerCase() === 'patch'
    };
  }
  if (/^compare\b/iu.test(request)) return clarify(compareHint);
  if (/\bknown at\b/iu.test(request) && /^(?:what|story|initiative|work|history)/iu.test(request)) {
    return { kind: 'unsupported', feature: 'knowledge-time' };
  }
  if (/^(?:authored|integrated|merged|deployed) (?:changes|commits|from|last week|today|yesterday)\b/iu.test(request) ||
      /^(?:what changed|change history|my changes)\b/iu.test(request)) {
    return { kind: 'unsupported', feature: 'change-basis' };
  }
  // Pull the ref off the end separately: an optional date must not consume "on main".
  const git = commits.exec(request);
  if (git) {
    const branchFirst = /^on (\S+) (.+)$/iu.exec(git[1] ?? '');
    const period = periodFor(branchFirst?.[2] ?? git[1]);
    return period && !(branchFirst && git[2])
      ? { kind: 'commits', revision: branchFirst?.[1] ?? git[2] ?? 'HEAD', period }
      : clarify('Ask for commits during a specific period. ' + workRangeHint);
  }
  const historical = asOf.exec(request);
  if (historical) return {
    kind: 'work-history', mode: 'as-of', workKind: workKind(historical[1]), workId: historical[2],
    period: { startDate: historical[3], endDate: historical[3], timeZone: historical[4], asOf: true }
  };
  if (/^(?:story|initiative)\b.*\bas of\b/iu.test(request)) {
    return clarify('Enter a work ID and a calendar date, for example story STORY-1 as of 2026-11-07 in UTC.');
  }
  const latest = current.exec(request);
  if (latest) return { kind: 'work-history', mode: 'currently-complete', workKind: workKind(latest[1] ?? latest[2]), workId: selectedWorkId };
  const filtered = list.exec(request);
  if (filtered) {
    const period = periodFor(filtered[3]);
    return period ? {
      kind: 'work-history', mode: filtered[2].toLowerCase() === 'completed' ? 'completed-during' : 'activity-during',
      workKind: workKind(filtered[1]), workId: selectedWorkId, period
    } : clarify(workRangeHint);
  }
  const named = /^(story|initiative) (\S+) history$/iu.exec(request);
  const retained = history.exec(named ? ['history for', named[1], named[2]].join(' ') : request);
  if (retained) {
    const period = retained[4] ? periodFor(retained[4]) : null;
    if (retained[4] && !period) return clarify(workRangeHint);
    return {
      kind: 'work-history', mode: period ? 'activity-during' : 'history',
      workKind: workKind(retained[2] ?? retained[1]), workId: retained[3] ?? selectedWorkId, period
    };
  }
  if (/^what did (?:we|i) (?:finish|complete)\b/iu.test(request)) return clarify(
    'Choose completed Stories or completed Initiatives and enter the period. ' + workRangeHint
  );
  return null;
}
