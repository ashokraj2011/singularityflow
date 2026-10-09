/**
 * Render knowledge for people and for phase prompts.
 *
 * Views are written for a reader who has never seen the repository: what it is, where things
 * are, the rules it enforces, how a request or a click travels, what is tested, and what a change
 * will touch. Every line keeps its `path:line` so the reader (or an agent) can open the code.
 * A slice is the same material cut to one role, one Story focus and a byte budget; it opens with
 * what a newcomer would get wrong, because that is what a prompt most needs.
 */
export const KNOWLEDGE_VIEWS = Object.freeze(['overview', 'business', 'rules', 'journeys', 'entities', 'tests', 'system', 'change']);
export const KNOWLEDGE_ROLES = Object.freeze(['developer', 'tester', 'architect', 'product']);

/** Which sections each role reads, most important first. */
const ROLE_SECTIONS = Object.freeze({
  developer: ['pitfalls', 'summary', 'rules', 'journeys', 'entities', 'tests', 'impact', 'system', 'areas'],
  tester: ['pitfalls', 'summary', 'requirements', 'rules', 'tests', 'errors', 'journeys', 'messages'],
  architect: ['summary', 'areas', 'journeys', 'system', 'entities', 'hotspots', 'errors', 'pitfalls'],
  product: ['summary', 'requirements', 'journeys', 'rules', 'messages', 'entities', 'pitfalls']
});
const VIEW_SECTIONS = Object.freeze({
  overview: ['summary', 'pitfalls', 'areas', 'journeys', 'rules', 'requirements', 'entities', 'tests', 'system', 'hotspots'],
  // For a product owner: what was asked for, what the product does, what it decides and says.
  business: ['summary', 'requirements', 'journeys', 'rules', 'messages', 'glossary'],
  rules: ['rules', 'messages', 'errors'],
  journeys: ['journeys', 'system'],
  entities: ['entities'],
  tests: ['tests', 'pitfalls'],
  system: ['areas', 'system', 'errors'],
  change: ['hotspots', 'impact', 'pitfalls']
});

/**
 * Which reader a phase's knowledge is written for, by the words in its ID, first match wins; any
 * other phase gets the developer's. Data, so the Workflow Studio shows the same reader for a new step.
 */
export const KNOWLEDGE_READER_RULES = Object.freeze([
  Object.freeze({ reader: 'product', pattern: '(intake|requirement|specif|discover|product|business|story)' }),
  Object.freeze({ reader: 'architect', pattern: '(design|architect|plan)' }),
  Object.freeze({ reader: 'tester', pattern: '(test|verif|conform|qa|accept)' })
]);

export const KNOWLEDGE_PROMPT_DEFAULT_BYTES = 8192;

/** Whether phase prompts get repository knowledge, and how many bytes of it. */
export function knowledgePromptPolicy(definition) {
  const policy = definition?.worldModel?.knowledge ?? {};
  const prompt = policy.prompt ?? 'slice';
  const maxBytes = Number.isInteger(policy.maxBytes) ? Math.min(32768, Math.max(2048, policy.maxBytes)) : KNOWLEDGE_PROMPT_DEFAULT_BYTES;
  return { prompt, maxBytes };
}

/** Lifecycle phases mapped to the reader they need. */
export function roleForPhase(phase) {
  const id = String(phase ?? '').toLowerCase();
  return KNOWLEDGE_READER_RULES.find((rule) => new RegExp(rule.pattern, 'u').test(id))?.reader ?? 'developer';
}

/** Where an item was read, and what a person said about it when the review still applies. */
const cite = (item) => (item.citations[0] ? `\`${item.citations[0].path}:${item.citations[0].lines[0]}\`` : '');
const at = (item) => `${cite(item)}${reviewNote(item)}`;
function reviewNote(item) {
  const review = item.review;
  if (!review) return '';
  if (!review.current) return ' · reviewed before this code changed; review it again';
  if (review.status === 'confirmed') return ` · confirmed${review.by ? ` by ${review.by}` : ''}`;
  if (review.status === 'corrected') return ` · correction${review.by ? ` from ${review.by}` : ''}: ${review.note}`;
  return '';
}
const code = (text) => `\`${String(text ?? '').replace(/`/gu, "'").slice(0, 160)}\``;
/** A condition as code, or as words when it is a context the analyzer phrased ("if that fails"). */
const condition = (text) => (/^the step before fails/u.test(String(text)) ? String(text)
  : /^not \(.*\)$/u.test(String(text)) ? `not ${code(String(text).slice(5, -1))}` : code(text));

function outcomeText(outcome) {
  if (!outcome) return 'continues';
  if (outcome.kind === 'refuses') return `refuses: "${outcome.text}"`;
  if (outcome.kind === 'shows') return `shows "${outcome.text}"`;
  if (outcome.kind === 'returns') return `returns ${code(outcome.text)}`;
  if (outcome.kind === 'checks') return `then checks ${code(outcome.text)}`;
  return code(outcome.text);
}

function ruleLine(item, limits) {
  if (item.statement.then?.kind === 'computes') {
    const context = item.statement.when.length ? `when ${item.statement.when.map(condition).join(' and ')}, ` : '';
    return `${context}computes ${code(item.statement.then.text)} — ${at(item)}`;
  }
  if (item.statement.kind === 'cap') {
    const constants = item.statement.values.constants.map((entry) => `${entry.name}${entry.value != null ? ` = ${entry.value}` : ''}`).join(', ');
    return `caps a value with ${constants}: ${code(item.statement.then.text)} — ${at(item)}`;
  }
  const conditions = item.statement.when.map(condition).join(' and ');
  const named = new Set([...item.statement.values.constants.map((entry) => entry.name),
    ...(String(item.statement.then?.text ?? '').match(/\b[A-Z][A-Z0-9_]{2,}\b/gu) ?? [])]);
  const constants = [...named].filter((name) => limits.has(name)).map((name) => `${name} = ${limits.get(name)}`);
  const tests = item.relations.filter((relation) => relation.type === 'tested-by' || relation.type === 'tested-through').length;
  return `when ${conditions} → ${outcomeText(item.statement.then)}${constants.length ? ` (${constants.join(', ')})` : ''} — ${at(item)}${tests ? '' : ' · no test'}`;
}

/**
 * A word's stem for matching a Story's words to code: "rules" and "rule", "coupons" and "coupon",
 * "ordering" and "order". Deliberately light; it only has to make plurals and tenses meet.
 */
export function stemOf(word) {
  const value = String(word).toLowerCase();
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  // "shipping" and "stopped" meet "ship" and "stop": a doubled final consonant is undone.
  const undouble = (stem) => (/([bdgmnprt])\1$/u.test(stem) && stem.length > 4 ? stem.slice(0, -1) : stem);
  if (value.endsWith('ing') && value.length > 5) return undouble(value.slice(0, -3));
  if (value.endsWith('ed') && value.length > 4) return undouble(value.slice(0, -2));
  if (value.endsWith('s') && !value.endsWith('ss') && value.length > 4) return value.slice(0, -1);
  return value;
}

/** The distinct stems of the words a focus text uses (four letters or more). */
export function focusStems(focus) {
  return [...new Set((String(focus ?? '').toLowerCase().match(/[a-z0-9_]{4,}/gu) ?? []).map(stemOf))].filter((term) => term.length >= 4);
}

/** Keep items about the focus terms, plus what they relate to. Falls back to everything. */
export function focusItems(knowledge, focus) {
  const stems = focusStems(focus);
  if (!stems.length) return { items: knowledge.items, matched: null };
  const text = (item) => JSON.stringify([item.subject, item.statement, item.area]).toLowerCase();
  const hit = new Set(knowledge.items.filter((item) => stems.some((stem) => text(item).includes(stem))).map((item) => item.id));
  const paths = new Set(knowledge.items.filter((item) => hit.has(item.id)).flatMap((item) => [item.subject?.path, ...item.citations.map((entry) => entry.path)]).filter(Boolean));
  for (const item of knowledge.items) {
    // A word match is a lead, not a link: it never pulls an item into a Story's focus.
    if (item.relations.some((relation) => !relation.inferred && hit.has(relation.to))) hit.add(item.id);
    if (['test-case', 'impact', 'untested-rule', 'drift', 'entity', 'error-path', 'message', 'limit'].includes(item.kind)
        && [item.subject?.path, ...item.citations.map((entry) => entry.path)].some((value) => paths.has(value))) hit.add(item.id);
  }
  const items = knowledge.items.filter((item) => hit.has(item.id) || ['command', 'language'].includes(item.kind));
  return hit.size ? { items, matched: hit.size } : { items: knowledge.items, matched: 0 };
}

function sections(knowledge, items, explanations = [], { focused = false } = {}) {
  const of = (kind) => items.filter((item) => item.kind === kind);
  const present = new Set(items.map((item) => item.id));
  const limits = new Map(of('limit').map((item) => [item.statement.name, item.statement.value]));
  const out = {};
  // What a newcomer would get wrong: drift, refusals, limits, untested rules.
  // Model-written sentences that passed the citation check; kept only where they cite what this slice shows.
  out.summary = { title: 'In plain words (inferred: model-written, checked against the cited code)', lines: explanations
    .filter((sentence) => sentence.cites.some((id) => present.has(id)))
    .map((sentence) => `${sentence.text}${sentence.citations[0] ? ` — \`${sentence.citations[0].path}:${sentence.citations[0].lines[0]}\`` : ''}`) };
  out.pitfalls = { title: 'Things a newcomer would get wrong', lines: [
    ...of('drift').map((item) => `Test and code disagree: "${item.statement.testTitle}" — ${item.statement.detail} — ${code(item.statement.condition)} ${cite(knowledge.items.find((rule) => rule.id === item.statement.rule) ?? item)}${reviewNote(item)}`),
    ...of('limit').map((item) => {
      const users = [...new Set((item.statement.usedIn ?? []).filter((use) => !use.test && use.symbol).map((use) => use.symbol))];
      return `Limit ${item.statement.name} = ${item.statement.value}${users.length ? `, applied in ${users.join(', ')}` : ''} — ${at(item)}`;
    }),
    ...of('rule').filter((item) => item.statement.kind === 'refusal').map((item) => `${item.subject.symbol} refuses "${item.statement.then.text}" when ${item.statement.when.map(condition).join(' and ')} — ${at(item)}`),
    ...of('untested-rule').map((item) => `No test exercises ${item.subject.symbol} (${item.statement.rules} rule${item.statement.rules === 1 ? '' : 's'}) — \`${item.subject.path}\``),
    ...(knowledge.orphaned ?? []).map((entry) => `A review of ${entry.about ?? entry.item} (${entry.status}${entry.by ? ` by ${entry.by}` : ''}) no longer matches any item: its code changed — \`${entry.at ?? ''}\``)
  ] };
  out.areas = { title: 'Areas', lines: of('area').map((item) => {
    const layers = item.statement.layers.length ? `; ${item.statement.layers.join(', ').toLowerCase()}` : '';
    return `${item.subject.path === '.' ? '(top level)' : `\`${item.subject.path}/\``} — ${item.statement.files} files${item.statement.tests ? `, ${item.statement.tests} tests` : ''}${item.statement.rules ? `, ${item.statement.rules} rules` : ''}${layers}`;
  }) };
  const routes = of('entry-point');
  out.journeys = { title: 'Entry points and journeys', lines: [
    ...routes.map((item) => `${item.statement.label} — ${at(item)}`),
    ...of('journey').map((item) => `${item.statement.trigger.replace(/<(\w+)>/gu, '`<$1>`')} → ${item.statement.steps.join(' → ') || '(no calls found)'}${item.statement.effects.length ? ` ⇒ ${item.statement.effects.join('; ')}` : ''} ${at(item)}`)
  ] };
  const byFunction = new Map();
  for (const item of of('rule')) {
    const key = `${item.subject.symbol}\0${item.subject.path}`;
    if (!byFunction.has(key)) byFunction.set(key, []);
    byFunction.get(key).push(item);
  }
  out.rules = { title: 'Business rules and decisions', lines: [...byFunction.entries()].flatMap(([key, rules]) => {
    const [symbol, file] = key.split('\0');
    return [`**${symbol}** (\`${file}\`)`, ...rules.map((rule) => `  - ${ruleLine(rule, limits)}`)];
  }).concat(of('decision').flatMap((item) => {
    // A function that branches on a value (a reducer, a dispatcher) lists its cases.
    const choice = item.statement.steps.find((step) => step.k === 'switch');
    return choice ? [`**${item.subject.symbol}** chooses by ${code(choice.subject || 'value')}: ${choice.cases.map((entry) => entry.label).join(', ')} — ${at(item)}`] : [];
  })) };
  // Approved clauses, then where code or tests name them; a word match is only a lead.
  const byId = new Map(knowledge.items.map((item) => [item.id, item]));
  out.requirements = { title: 'Approved requirements', lines: of('requirement').map((item) => {
    const statement = item.statement;
    const where = [
      statement.implementedAt.length ? `implemented at ${statement.implementedAt.map((value) => `\`${value}\``).join(', ')}` : null,
      statement.testedAt.length ? `tested at ${statement.testedAt.map((value) => `\`${value}\``).join(', ')}` : null
    ].filter(Boolean);
    const leads = (statement.wordMatches ?? []).map((entry) => byId.get(entry.item)).filter(Boolean)
      .map((related) => `${related.subject?.symbol ?? related.statement.name ?? related.statement.label ?? related.kind} ${cite(related)}`);
    const link = where.length ? where.join('; ')
      : leads.length ? `no code names it; shares words with ${leads.join(', ')} (matched by words, inferred)` : 'no code names it';
    const approved = [statement.story, statement.approvedBy ? `approved by ${statement.approvedBy}` : 'approved'].filter(Boolean).join(', ');
    return `${statement.clause} "${statement.text.slice(0, 220)}" (${approved}) — ${link} — ${at(item)}`;
  }).concat((focused ? [] : knowledge.repository.specificationsSkipped ?? []).map((entry) => `Not read: \`${entry.path}\`${entry.story ? ` (${entry.story})` : ''} ${
    entry.reason === 'changed-after-approval' ? 'changed after it was approved; approve it again to use it'
      : entry.reason === 'unreadable-clauses' ? `has clauses that could not be read: ${entry.detail}` : 'is over the size budget'}`)) };
  // The words the code uses for things, with where each is defined.
  out.glossary = { title: 'Words the code uses', lines: [
    // Component props and hook results are how the code is wired, not words of the business.
    ...of('entity').filter((item) => !['props', 'shape'].includes(item.statement.kind) && !/props$/iu.test(item.statement.name)).map((item) => {
      const values = item.statement.values?.length ? `: one of ${item.statement.values.slice(0, 10).join(', ')}` : '';
      const fields = !values && item.statement.fields?.length ? `: has ${item.statement.fields.slice(0, 8).map((field) => field.name).join(', ')}` : '';
      return `${item.statement.name}${values}${fields} — ${at(item)}`;
    }),
    ...of('limit').filter((item) => /^-?\d[\d_.,]*$/u.test(String(item.statement.value))).map((item) => `${item.statement.name} = ${item.statement.value} — ${at(item)}`)
  ] };
  out.messages = { title: 'What users are told', lines: of('message').map((item) => `"${item.statement.text}"${item.statement.when.length ? ` when ${item.statement.when.map(condition).join(' and ')}` : ''} — ${at(item)}`) };
  out.errors = { title: 'Error paths', lines: of('error-path').map((item) => `${item.statement.exception ?? 'error'}${item.statement.message ? ` "${item.statement.message}"` : ''}${item.statement.status ? ` → HTTP ${item.statement.status}` : ''} — ${at(item)}`) };
  out.entities = { title: 'Data shapes', lines: of('entity').filter((item) => item.statement.kind !== 'props' || items.length < 200).map((item) => {
    const fields = (item.statement.fields ?? []).map((field) => `${field.name}${field.type ? `: ${field.type}` : ''}`).slice(0, 12).join(', ');
    const values = item.statement.values?.length ? `values ${item.statement.values.join(', ')}` : '';
    return `${item.statement.name} (${item.statement.kind}) ${[fields, values].filter(Boolean).join('; ')} — ${at(item)}`;
  }) };
  const commands = of('command');
  out.tests = { title: 'Tests', lines: [
    ...commands.filter((item) => item.statement.purpose === 'test').map((item) => `Run: ${code(item.statement.command)}${item.statement.runs ? ` (${item.statement.runs})` : ''}`),
    ...of('test-case').map((item) => `"${item.statement.title}" exercises ${item.statement.exercises.join(', ') || 'nothing this build could name'} — ${at(item)}`),
    ...of('untested-rule').map((item) => `Not tested: ${item.subject.symbol} — \`${item.subject.path}\``)
  ] };
  out.system = { title: 'External calls and configuration', lines: [
    ...of('external-dependency').map((item) => `Calls ${item.statement.method} ${item.statement.target} — ${at(item)}`),
    ...of('configuration').map((item) => `Setting ${item.statement.key} = ${item.statement.value} — ${at(item)}`),
    ...commands.filter((item) => item.statement.purpose !== 'test').map((item) => `${item.statement.purpose}: ${code(item.statement.command)}`)
  ] };
  out.hotspots = { title: 'Where change concentrates', lines: of('hotspot').map((item) => `\`${item.subject.path}\` — ${item.statement.changes != null ? `${item.statement.changes} change${item.statement.changes === 1 ? '' : 's'}, ` : ''}complexity ${item.statement.complexity}, imported by ${item.statement.importedBy}`) };
  out.hotspots.lines.push(...of('co-change').map((item) => `\`${item.statement.files[0]}\` and \`${item.statement.files[1]}\` changed together in ${item.statement.together} commits${item.statement.importLinked ? '' : ' with no import between them'}`));
  out.impact = { title: 'What a change touches', lines: of('impact').map((item) => `Changing ${item.subject.symbol} affects ${[
    item.statement.callers.length ? `callers ${item.statement.callers.join(', ')}` : null,
    item.statement.importedBy.length ? `importers ${item.statement.importedBy.map((value) => `\`${value}\``).join(', ')}` : null,
    item.statement.changesWith?.length ? `usually changes with ${item.statement.changesWith.map((value) => `\`${value}\``).join(', ')}` : null,
    item.statement.tests.length ? `tests ${item.statement.tests.map((value) => `\`${value}\``).join(', ')}${item.statement.testedThrough ? ` (through ${item.statement.testedThrough})` : ''}` : 'no tests'
  ].filter(Boolean).join('; ')}`) };
  return out;
}

function header(knowledge, label) {
  const repository = knowledge.repository;
  const levels = Object.entries(knowledge.levels).map(([level, value]) => `${level} ${value.status}`).join(' · ');
  const weak = Object.entries(knowledge.levels).filter(([, value]) => value.status !== 'ready').map(([level, value]) => `${level}: ${value.reason}`);
  return [
    `# ${repository.name ?? 'Repository'} — ${label}`,
    '',
    `Commit \`${String(repository.commit).slice(0, 12)}\`${repository.area ? ` · area \`${repository.area}\`` : ''} · ${repository.files} code files · ${repository.frameworks.join(', ') || 'no framework detected'}`,
    '',
    `Levels: ${levels}`,
    '',
    ...weak.flatMap((line) => [`> ${line}`, '']),
    'Everything below was read from the committed source; each line ends with where it was read.',
    ''
  ];
}

/** The view that shows a whole section, for the "… more" pointer. */
function viewOfSection(name) {
  if (KNOWLEDGE_VIEWS.includes(name)) return name;
  if (name === 'pitfalls' || name === 'summary') return 'overview';
  return Object.entries(VIEW_SECTIONS).find(([view, list]) => view !== 'overview' && list.includes(name))?.[0] ?? 'overview';
}

/** Render named sections into Markdown under a byte budget, saying what was left out. */
function renderSections(knowledge, items, order, label, maximumBytes, explanations = [], { focused = false } = {}) {
  const built = sections(knowledge, items, explanations, { focused });
  const lines = header(knowledge, label);
  const encoder = (value) => Buffer.byteLength(value, 'utf8');
  let used = encoder(lines.join('\n'));
  const omitted = [];
  for (const name of order) {
    const section = built[name];
    if (!section?.lines.length) continue;
    const block = [`## ${section.title}`, ''];
    let added = 0;
    for (const line of section.lines) {
      const text = line.startsWith('  - ') ? line : `- ${line}`;
      if (maximumBytes && used + encoder(block.join('\n')) + encoder(text) + 64 > maximumBytes) break;
      block.push(text);
      added += 1;
    }
    if (!added) { omitted.push(`${section.title} (${section.lines.length})`); continue; }
    if (added < section.lines.length) block.push(`- … ${section.lines.length - added} more in \`wm knowledge show ${viewOfSection(name)}\``);
    block.push('');
    used += encoder(block.join('\n'));
    lines.push(...block);
  }
  if (omitted.length) lines.push(`Left out to stay within ${maximumBytes} bytes: ${omitted.join(', ')}.`, '');
  return lines.join('\n');
}

export function renderKnowledgeView(knowledge, view = 'overview', { maximumBytes = null, focus = null, explanations = [] } = {}) {
  if (!VIEW_SECTIONS[view]) throw new TypeError(`Unknown knowledge view '${view}'. Use one of: ${KNOWLEDGE_VIEWS.join(', ')}.`);
  const { items, matched } = focusItems(knowledge, focus);
  return renderSections(knowledge, items, VIEW_SECTIONS[view], view === 'overview' ? 'how the code works' : view, maximumBytes, explanations, { focused: Boolean(matched) });
}

/** The slice a phase prompt receives: one role, an optional Story focus, a byte budget. */
export function renderKnowledgeSlice(knowledge, { role = 'developer', focus = null, maximumBytes = 8192, explanations = [] } = {}) {
  if (!ROLE_SECTIONS[role]) throw new TypeError(`Unknown knowledge role '${role}'. Use one of: ${KNOWLEDGE_ROLES.join(', ')}.`);
  const { items, matched } = focusItems(knowledge, focus);
  const label = `knowledge for the ${role}${matched ? ' (focused on this Story)' : ''}`;
  return renderSections(knowledge, items, ROLE_SECTIONS[role], label, maximumBytes, explanations, { focused: Boolean(matched) });
}
