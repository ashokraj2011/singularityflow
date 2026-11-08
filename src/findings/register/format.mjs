/**
 * SFlow's findings workbook format [CQF:REQ-060]: a `Security` sheet and a `TLM` sheet, the first row
 * holding the headers. A header is matched by name, ignoring case, spaces and punctuation, against the
 * column's own name, its aliases and the `columns:` map a team keeps in singularity/findings.yml, so a
 * sheet with other headers needs no code change.
 *
 * Each row becomes a register item or is rejected with its sheet, row number and reason; the rest
 * import. Cell text is data: one line (a description keeps its line breaks), control characters
 * dropped, secrets redacted, bounded. It is quoted wherever it is shown and is never read as an
 * instruction or put into a URL.
 */
import { redactDiagnosticText } from '../../git-remote-diagnostics.mjs';

export const FEEDS = Object.freeze(['security', 'tlm']);
export const SHEET_NAMES = Object.freeze({ security: 'Security', tlm: 'TLM' });

const column = (key, header, aliases = [], options = {}) => Object.freeze({ key, header, aliases: Object.freeze(aliases), required: false, ...options });

/** The columns in the order the template and the report write them. Required ones first. */
export const COLUMNS = Object.freeze({
  security: Object.freeze([
    column('id', 'ID', ['findingid', 'ticket', 'ticketid', 'key', 'reference', 'ref', 'issueid'], { required: true, kind: 'id' }),
    column('title', 'Title', ['summary', 'name', 'finding', 'findingtitle', 'issue'], { required: true, kind: 'text', maximum: 200 }),
    column('severity', 'Severity', ['risk', 'riskrating', 'risklevel', 'criticality', 'impact'], { required: true, kind: 'severity' }),
    column('repository', 'Repository', ['repo', 'repositoryname', 'repositoryurl', 'repourl', 'gitrepository'], { required: true, kind: 'repository' }),
    column('type', 'Type', ['findingtype', 'category', 'class'], { kind: 'type' }),
    column('file', 'File', ['path', 'filepath', 'filename', 'location'], { kind: 'path' }),
    column('line', 'Line', ['linenumber', 'startline'], { kind: 'line' }),
    column('package', 'Package', ['packagename', 'library', 'dependency', 'component', 'module'], { kind: 'text', maximum: 214 }),
    column('installedVersion', 'Installed version', ['currentversion', 'version', 'installed'], { kind: 'version' }),
    column('fixedVersion', 'Fixed version', ['fixversion', 'patchedversion', 'remediationversion', 'fixedin'], { kind: 'version' }),
    column('cve', 'CVE', ['cveid', 'advisory', 'advisoryid', 'ghsa'], { kind: 'text', maximum: 64 }),
    column('cwe', 'CWE', ['cweid'], { kind: 'text', maximum: 64 }),
    column('rule', 'Rule', ['ruleid', 'check', 'checkid', 'query'], { kind: 'text', maximum: 256 }),
    column('tool', 'Tool', ['scanner', 'toolname', 'detectedby'], { kind: 'text', maximum: 128 }),
    column('description', 'Description', ['details', 'detail', 'recommendation', 'remediation'], { kind: 'paragraph', maximum: 2000 }),
    column('dueAt', 'Due date', ['due', 'dueby', 'sladate', 'targetdate', 'deadline'], { kind: 'date' }),
    column('status', 'Status', ['state', 'findingstatus'], { kind: 'status' }),
    column('exceptionExpiresAt', 'Exception expiry', ['exceptionexpires', 'exceptionexpirydate', 'riskacceptanceexpiry', 'acceptanceexpiry'], { kind: 'date' }),
    column('owner', 'Owner', ['assignee', 'assignedto', 'team'], { kind: 'text', maximum: 128 })
  ]),
  tlm: Object.freeze([
    column('id', 'ID', ['itemid', 'ticket', 'ticketid', 'key', 'reference', 'ref'], { required: true, kind: 'id' }),
    column('component', 'Component', ['name', 'technology', 'library', 'package', 'software', 'product'], { required: true, kind: 'text', maximum: 214 }),
    column('repository', 'Repository', ['repo', 'repositoryname', 'repositoryurl', 'repourl', 'gitrepository'], { required: true, kind: 'repository' }),
    column('targetVersion', 'Target version', ['target', 'requiredversion', 'upgradeto', 'minimumversion', 'targetrelease'], { required: true, kind: 'version' }),
    column('ecosystem', 'Ecosystem', ['platform', 'packagemanager', 'componenttype'], { kind: 'ecosystem' }),
    column('currentVersion', 'Current version', ['version', 'installedversion', 'installed'], { kind: 'version' }),
    column('endOfLifeAt', 'End of life date', ['endoflife', 'eol', 'eoldate', 'endofsupport', 'endofsupportdate'], { kind: 'date' }),
    column('dueAt', 'Due date', ['due', 'dueby', 'targetdate', 'deadline'], { kind: 'date' }),
    column('status', 'Status', ['state'], { kind: 'status' }),
    column('waiverExpiresAt', 'Waiver expiry', ['waiverexpires', 'waiverexpirydate', 'exceptionexpiry'], { kind: 'date' }),
    column('owner', 'Owner', ['assignee', 'assignedto', 'team'], { kind: 'text', maximum: 128 }),
    column('notes', 'Notes', ['note', 'comments', 'comment', 'remarks'], { kind: 'paragraph', maximum: 1000 })
  ])
});

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);
const SEVERITY_WORDS = Object.freeze({
  critical: 'critical', blocker: 'critical', veryhigh: 'critical', high: 'high', major: 'high', medium: 'medium', moderate: 'medium',
  low: 'low', minor: 'low', info: 'info', informational: 'info', information: 'info', none: 'info'
});
const TYPES = Object.freeze({ code: 'code', dependency: 'dependency', library: 'dependency', configuration: 'configuration', config: 'configuration', container: 'container', image: 'container' });
export const ECOSYSTEMS = Object.freeze(['npm', 'maven', 'gradle', 'pypi', 'nuget', 'go', 'runtime', 'container', 'os']);
const ECOSYSTEM_WORDS = Object.freeze({
  npm: 'npm', node: 'npm', yarn: 'npm', pnpm: 'npm', maven: 'maven', gradle: 'gradle', pypi: 'pypi', pip: 'pypi', python: 'pypi',
  nuget: 'nuget', dotnet: 'nuget', go: 'go', golang: 'go', runtime: 'runtime', container: 'container', docker: 'container', image: 'container', os: 'os'
});
/** What a row's Status says, in the register's words. */
const STATUS_WORDS = Object.freeze({
  security: { open: 'open', new: 'open', inprogress: 'open', acceptedrisk: 'accepted-risk', riskaccepted: 'accepted-risk', falsepositive: 'false-positive', fixed: 'fixed', closed: 'fixed', resolved: 'fixed' },
  tlm: { open: 'open', new: 'open', inprogress: 'open', waiver: 'waiver', waived: 'waiver', done: 'done', closed: 'done', completed: 'done' }
});
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,79}$/u;

/** A header or alias as matched: lower case, letters and digits only. */
export const headerKey = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/gu, '');

/** A sheet name's feed: `Security` → security, `TLM` → tlm, anything else null. */
export function sheetFeed(name) {
  const key = headerKey(name);
  if (key === 'security' || key === 'securityfindings') return 'security';
  if (key === 'tlm' || key === 'technologylifecycle' || key === 'tlmitems') return 'tlm';
  return null;
}

/** One cell's display text: booleans and numbers as Excel shows them, dates as ISO. */
function cellText(cell) {
  if (!cell) return '';
  if (cell.type === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  if (cell.type === 'error') return '';
  return String(cell.value ?? '').trim();
}

const oneLine = (value, maximum) => {
  const text = redactDiagnosticText(String(value ?? '')).replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
};
const paragraph = (value, maximum) => {
  const text = redactDiagnosticText(String(value ?? ''), { multiline: true }).replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
};

/** A repository named in a row, as the key it is matched by: `owner/name` from a URL, or a bare name. */
export function repositoryKey(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  const scp = /^[^@\s/]+@[^:\s]+:(.+)$/u.exec(text);
  if (scp) text = scp[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    try { text = new URL(text).pathname; } catch { return null; }
  }
  const key = text.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '').toLowerCase();
  if (!key || key.length > 200 || !/^[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)*$/u.test(key)) return null;
  return key;
}

/** Whether a register item's repository is this one: the same `owner/name`, or the same bare name. */
export function repositoryMatches(itemRepository, current) {
  if (!itemRepository || !current) return false;
  if (itemRepository.includes('/')) return Boolean(current.slug) && itemRepository === current.slug;
  return itemRepository === current.name || (current.slug ?? '').split('/').at(-1) === itemRepository;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

function dateValue(cell) {
  if (!cell) return { value: null };
  if (cell.type === 'date') return ISO_DATE.test(cell.value) ? { value: cell.value.slice(0, 10) } : { error: `'${cell.value}' is not a date` };
  const text = cellText(cell);
  if (!text) return { value: null };
  const match = ISO_DATE.exec(text);
  if (match) {
    const time = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    if (Number.isFinite(time) && new Date(time).toISOString().startsWith(`${match[1]}-${match[2]}-${match[3]}`)) return { value: `${match[1]}-${match[2]}-${match[3]}` };
  }
  return { error: `'${oneLine(text, 40)}' is not an ISO date (YYYY-MM-DD) or an Excel date` };
}

/**
 * Which column each header names: `{ key: index }`, the headers nothing matched, and the required
 * columns missing. `columns` is the findings.yml map of key → the team's header text.
 */
export function matchHeaders(feed, headerCells, columns = {}) {
  const definitions = COLUMNS[feed];
  const byKey = new Map();
  for (const definition of definitions) {
    for (const name of [definition.header, definition.key, ...definition.aliases]) {
      if (!byKey.has(headerKey(name))) byKey.set(headerKey(name), definition.key);
    }
  }
  // A team's own header wins over a built-in alias.
  for (const [key, header] of Object.entries(columns ?? {})) {
    if (definitions.some((definition) => definition.key === key) && typeof header === 'string') byKey.set(headerKey(header), key);
  }
  const indexes = {};
  const unknown = [];
  headerCells.forEach((cell, index) => {
    const text = cellText(cell);
    if (!text) return;
    const key = byKey.get(headerKey(text));
    if (key && indexes[key] == null) indexes[key] = index;
    else if (!key) unknown.push(oneLine(text, 64));
  });
  const missing = definitions.filter((definition) => definition.required && indexes[definition.key] == null).map((definition) => definition.header);
  return { indexes, unknown, missing };
}

/**
 * One row as a register item of `feed`, or `{ reason }` when it fails validation. A row with no
 * text at all is `{ empty: true }` and is neither imported nor reported.
 */
export function normalizeRow(feed, row, indexes) {
  const definitions = COLUMNS[feed];
  const cell = (key) => (indexes[key] == null ? undefined : row.cells[indexes[key]]);
  if (!definitions.some((definition) => cellText(cell(definition.key)))) return { empty: true };
  const item = { id: null, feed };
  for (const definition of definitions) {
    const value = cell(definition.key);
    const text = cellText(value);
    if (definition.required && !text) return { reason: `${definition.header} is empty` };
    if (!text && definition.kind !== 'date') { item[definition.key] = null; continue; }
    switch (definition.kind) {
      case 'id':
        if (!ID_PATTERN.test(text)) return { reason: `ID '${oneLine(text, 40)}' must be 1 to 80 letters, digits or . _ : # / - with no spaces or commas` };
        item.id = text;
        break;
      case 'severity': {
        const severity = SEVERITY_WORDS[headerKey(text)];
        if (!severity) return { reason: `Severity '${oneLine(text, 40)}' is not Critical, High, Medium, Low or Info` };
        item.severity = severity;
        break;
      }
      case 'repository': {
        const key = repositoryKey(text);
        if (!key) return { reason: `Repository '${oneLine(text, 80)}' is not a repository name or URL` };
        item.repository = key;
        break;
      }
      case 'type': {
        const type = TYPES[headerKey(text)];
        if (!type) return { reason: `Type '${oneLine(text, 40)}' is not Code, Dependency, Configuration or Container` };
        item.type = type;
        break;
      }
      case 'ecosystem': {
        const ecosystem = ECOSYSTEM_WORDS[headerKey(text)];
        if (!ecosystem) return { reason: `Ecosystem '${oneLine(text, 40)}' is not one of ${ECOSYSTEMS.join(', ')}` };
        item.ecosystem = ecosystem;
        break;
      }
      case 'status': {
        const status = STATUS_WORDS[feed][headerKey(text)];
        if (!status) return { reason: `Status '${oneLine(text, 40)}' is not ${feed === 'security' ? 'Open, In progress, Accepted risk, False positive or Fixed' : 'Open, In progress, Waiver or Done'}` };
        item.status = status;
        break;
      }
      case 'line': {
        const line = value?.type === 'number' ? value.value : Number(text);
        if (!Number.isInteger(line) || line < 1) return { reason: `Line '${oneLine(text, 20)}' is not a line number` };
        item.line = line;
        break;
      }
      case 'path': {
        const file = text.replaceAll('\\', '/').replace(/^\.\//u, '');
        if (file.startsWith('/') || /^[A-Za-z]:\//u.test(file) || file.split('/').includes('..') || file.length > 512) {
          return { reason: `File '${oneLine(text, 80)}' is not a path inside the repository` };
        }
        item.file = file;
        break;
      }
      case 'date': {
        const parsed = dateValue(value);
        if (parsed.error) return { reason: `${definition.header} ${parsed.error}` };
        item[definition.key] = parsed.value;
        break;
      }
      case 'version':
        item[definition.key] = oneLine(text, 64);
        break;
      case 'paragraph':
        item[definition.key] = paragraph(text, definition.maximum);
        break;
      default:
        item[definition.key] = oneLine(text, definition.maximum ?? 256);
    }
  }
  item.status ??= 'open';
  if (feed === 'security' && !item.type) item.type = item.package ? 'dependency' : 'code';
  return { item };
}

/** A register item as one row of its feed's sheet, in the column order (dates as date cells). */
export function itemRow(feed, item) {
  const statusText = {
    security: { open: 'Open', 'accepted-risk': 'Accepted risk', 'false-positive': 'False positive', fixed: 'Fixed' },
    tlm: { open: 'Open', waiver: 'Waiver', done: 'Done' }
  }[feed];
  return COLUMNS[feed].map((definition) => {
    const value = item[definition.key];
    if (value == null || value === '') return null;
    if (definition.kind === 'date') return { date: value };
    if (definition.kind === 'status') return statusText[value] ?? value;
    if (definition.kind === 'severity') return value[0].toUpperCase() + value.slice(1);
    if (definition.kind === 'type') return value[0].toUpperCase() + value.slice(1);
    return value;
  });
}

/** One example row per sheet, made up, so the template shows each column's shape. */
export const TEMPLATE_EXAMPLES = Object.freeze({
  security: Object.freeze({
    id: 'SEC-1001', title: 'SQL query built from request text in the order search', severity: 'high', repository: 'example-org/payments-api',
    type: 'code', file: 'src/orders/search.js', line: 42, rule: 'js/sql-injection', tool: 'CodeQL', cwe: 'CWE-89',
    description: 'The search term is joined into the SQL text. Use a parameterised query.', dueAt: '2026-12-31', status: 'open', owner: 'app-security'
  }),
  tlm: Object.freeze({
    id: 'TLM-2001', component: 'node', repository: 'example-org/payments-api', targetVersion: '22', ecosystem: 'runtime',
    currentVersion: '18.20.4', endOfLifeAt: '2025-04-30', dueAt: '2026-12-31', status: 'open', owner: 'platform-team',
    notes: 'Node 18 is past its end of life.'
  })
});

/** The sheets of the template workbook: both feeds, their headers and one example row each. */
export function templateSheets() {
  return FEEDS.map((feed) => ({
    name: SHEET_NAMES[feed],
    headers: COLUMNS[feed].map((definition) => definition.header),
    rows: [itemRow(feed, TEMPLATE_EXAMPLES[feed])],
    widths: COLUMNS[feed].map((definition) => (['title', 'description', 'notes'].includes(definition.key) ? 48 : 16))
  }));
}
