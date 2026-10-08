/**
 * Render knowledge for people and for phase prompts.
 *
 * Views are written for a reader who has never seen the repository: what it is, where things
 * are, the rules it enforces, how a request or a click travels, what is tested, and what a change
 * will touch. Every line keeps its `path:line` so the reader (or an agent) can open the code.
 * A slice is the same material cut to one role, one Story focus and a byte budget; it opens with
 * what a newcomer would get wrong, because that is what a prompt most needs.
 */
export const KNOWLEDGE_VIEWS = Object.freeze(['overview', 'rules', 'journeys', 'entities', 'tests', 'system', 'change']);
export const KNOWLEDGE_ROLES = Object.freeze(['developer', 'tester', 'architect', 'product']);

/** Which sections each role reads, most important first. */
const ROLE_SECTIONS = Object.freeze({
  developer: ['pitfalls', 'rules', 'journeys', 'entities', 'tests', 'impact', 'system', 'areas'],
  tester: ['pitfalls', 'rules', 'tests', 'errors', 'journeys', 'messages'],
  architect: ['areas', 'journeys', 'system', 'entities', 'hotspots', 'errors', 'pitfalls'],
  product: ['journeys', 'rules', 'messages', 'entities', 'pitfalls']
});
const VIEW_SECTIONS = Object.freeze({
  overview: ['pitfalls', 'areas', 'journeys', 'rules', 'entities', 'tests', 'system', 'hotspots'],
  rules: ['rules', 'messages', 'errors'],
  journeys: ['journeys', 'system'],
  entities: ['entities'],
  tests: ['tests', 'pitfalls'],
  system: ['areas', 'system', 'errors'],
  change: ['hotspots', 'impact', 'pitfalls']
});

/** Lifecycle phases mapped to the reader they need. */
export function roleForPhase(phase) {
  const id = String(phase ?? '').toLowerCase();
  if (/(intake|requirement|specif|discover|product|business|story)/u.test(id)) return 'product';
  if (/(design|architect|plan)/u.test(id)) return 'architect';
  if (/(test|verif|conform|qa|accept)/u.test(id)) return 'tester';
  return 'developer';
}

const at = (item) => (item.citations[0] ? `\`${item.citations[0].path}:${item.citations[0].lines[0]}\`` : '');
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

/** Keep items about the focus terms, plus what they relate to. Falls back to everything. */
export function focusItems(knowledge, focus) {
  const terms = String(focus ?? '').toLowerCase().match(/[a-z0-9_]{4,}/gu) ?? [];
  if (!terms.length) return { items: knowledge.items, matched: null };
  const stems = [...new Set(terms.map((term) => term.replace(/(?:ing|ed|es|s)$/u, '')))].filter((term) => term.length >= 4);
  const text = (item) => JSON.stringify([item.subject, item.statement, item.area]).toLowerCase();
  const hit = new Set(knowledge.items.filter((item) => stems.some((stem) => text(item).includes(stem))).map((item) => item.id));
  const paths = new Set(knowledge.items.filter((item) => hit.has(item.id)).flatMap((item) => [item.subject?.path, ...item.citations.map((entry) => entry.path)]).filter(Boolean));
  for (const item of knowledge.items) {
    if (item.relations.some((relation) => hit.has(relation.to))) hit.add(item.id);
    if (['test-case', 'impact', 'untested-rule', 'drift', 'entity', 'error-path', 'message', 'limit'].includes(item.kind)
        && [item.subject?.path, ...item.citations.map((entry) => entry.path)].some((value) => paths.has(value))) hit.add(item.id);
  }
  const items = knowledge.items.filter((item) => hit.has(item.id) || ['command', 'language'].includes(item.kind));
  return hit.size ? { items, matched: hit.size } : { items: knowledge.items, matched: 0 };
}

function sections(knowledge, items) {
  const of = (kind) => items.filter((item) => item.kind === kind);
  const limits = new Map(of('limit').map((item) => [item.statement.name, item.statement.value]));
  const out = {};
  // What a newcomer would get wrong: drift, refusals, limits, untested rules.
  out.pitfalls = { title: 'Things a newcomer would get wrong', lines: [
    ...of('drift').map((item) => `Test and code disagree: "${item.statement.testTitle}" — ${item.statement.detail} — ${code(item.statement.condition)} ${at(knowledge.items.find((rule) => rule.id === item.statement.rule) ?? item)}`),
    ...of('limit').map((item) => {
      const users = [...new Set((item.statement.usedIn ?? []).filter((use) => !use.test && use.symbol).map((use) => use.symbol))];
      return `Limit ${item.statement.name} = ${item.statement.value}${users.length ? `, applied in ${users.join(', ')}` : ''} — ${at(item)}`;
    }),
    ...of('rule').filter((item) => item.statement.kind === 'refusal').map((item) => `${item.subject.symbol} refuses "${item.statement.then.text}" when ${item.statement.when.map(condition).join(' and ')} — ${at(item)}`),
    ...of('untested-rule').map((item) => `No test exercises ${item.subject.symbol} (${item.statement.rules} rule${item.statement.rules === 1 ? '' : 's'}) — \`${item.subject.path}\``)
  ] };
  out.areas = { title: 'Areas', lines: of('area').map((item) => {
    const layers = item.statement.layers.length ? `; ${item.statement.layers.join(', ').toLowerCase()}` : '';
    return `${item.subject.path === '.' ? '(top level)' : `\`${item.subject.path}/\``} — ${item.statement.files} files${item.statement.tests ? `, ${item.statement.tests} tests` : ''}${item.statement.rules ? `, ${item.statement.rules} rules` : ''}${layers}`;
  }) };
  const routes = of('entry-point');
  out.journeys = { title: 'Entry points and journeys', lines: [
    ...routes.map((item) => `${item.statement.label} — ${at(item)}`),
    ...of('journey').map((item) => `${item.statement.trigger} → ${item.statement.steps.join(' → ') || '(no calls found)'}${item.statement.effects.length ? ` ⇒ ${item.statement.effects.join('; ')}` : ''} ${at(item)}`)
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
  out.impact = { title: 'What a change touches', lines: of('impact').map((item) => `Changing ${item.subject.symbol} affects ${[
    item.statement.callers.length ? `callers ${item.statement.callers.join(', ')}` : null,
    item.statement.importedBy.length ? `importers ${item.statement.importedBy.map((value) => `\`${value}\``).join(', ')}` : null,
    item.statement.tests.length ? `tests ${item.statement.tests.map((value) => `\`${value}\``).join(', ')}` : 'no tests'
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
    `Levels: ${levels}`,
    ...weak.map((line) => `> ${line}`),
    'Everything below was read from the committed source; each line ends with where it was read.',
    ''
  ];
}

/** Render named sections into Markdown under a byte budget, saying what was left out. */
function renderSections(knowledge, items, order, label, maximumBytes) {
  const built = sections(knowledge, items);
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
    if (added < section.lines.length) block.push(`- … ${section.lines.length - added} more in \`wm knowledge show ${name === 'pitfalls' ? 'overview' : name}\``);
    block.push('');
    used += encoder(block.join('\n'));
    lines.push(...block);
  }
  if (omitted.length) lines.push(`Left out to stay within ${maximumBytes} bytes: ${omitted.join(', ')}.`, '');
  return lines.join('\n');
}

export function renderKnowledgeView(knowledge, view = 'overview', { maximumBytes = null, focus = null } = {}) {
  if (!VIEW_SECTIONS[view]) throw new TypeError(`Unknown knowledge view '${view}'. Use one of: ${KNOWLEDGE_VIEWS.join(', ')}.`);
  const { items } = focusItems(knowledge, focus);
  return renderSections(knowledge, items, VIEW_SECTIONS[view], view === 'overview' ? 'how the code works' : view, maximumBytes);
}

/** The slice a phase prompt receives: one role, an optional Story focus, a byte budget. */
export function renderKnowledgeSlice(knowledge, { role = 'developer', focus = null, maximumBytes = 8192 } = {}) {
  if (!ROLE_SECTIONS[role]) throw new TypeError(`Unknown knowledge role '${role}'. Use one of: ${KNOWLEDGE_ROLES.join(', ')}.`);
  const { items, matched } = focusItems(knowledge, focus);
  const label = `knowledge for the ${role}${matched ? ' (focused on this Story)' : ''}`;
  return renderSections(knowledge, items, ROLE_SECTIONS[role], label, maximumBytes);
}
