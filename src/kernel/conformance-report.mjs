/** Shared conformance table and disclosure values. No storage, clock, command or model access. */
import { clauseMentionPattern, normalizeQualifiedClauseId, qualifiedClauseMatches } from '../foundation/traceability-ids.mjs';
import {parseMarkdownStructure,authoredArtifactText} from './artifact-content.mjs';
import {textDigestCapability} from '../foundation/record-schema.mjs';
import {shown} from './draft-diagnostics.mjs';

const BLOCKING = new Set(['missing', 'partial']);
const CLAUSE_HEADERS = new Set(['clause id', 'clause', 'id', 'criterion', 'specification clause']);

function tableCells(line) {
  const text = String(line).trim();
  if (!text.startsWith('|') || !text.endsWith('|')) return null;
  const cells = [];
  let cell = '';
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === '\\' && text[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (text[index] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += text[index];
    }
  }
  return cells;
}

function plainCell(cell) {
  return String(cell).replaceAll('`', '').replace(/^\*+|\*+$/g, '').trim();
}

function heading(cell) {
  return plainCell(cell).toLowerCase().replace(/\s+/g, ' ');
}

function separator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function fenceMarker(line) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  return match ? { character: match[1][0], length: match[1].length, rest: match[2] } : null;
}

function visibleTableLines(markdown) {
  let fence = null;
  const authored = authoredArtifactText(markdown, { preserveLines: true });
  return parseMarkdownStructure(authored).visibleText.split(/\r?\n/).map((line) => {
    const marker = fenceMarker(line);
    if (fence) {
      if (marker?.character === fence.character && marker.length >= fence.length
          && /^[ \t]*$/u.test(marker.rest)) fence = null;
      return '';
    }
    if (marker) {
      fence = marker;
      return '';
    }
    return line;
  });
}

/** Read only comparison tables that identify their clause and verdict columns in the header. */
export function conformanceTableRows(markdown) {
  const rows = [];
  let candidate = null;
  let columns = null;
  for (const [index, line] of visibleTableLines(markdown).entries()) {
    const cells = tableCells(line);
    if (!cells) {
      candidate = null;
      columns = null;
      continue;
    }
    if (separator(cells)) {
      if (candidate && cells.length === candidate.length) {
        const headers = candidate.map(heading);
        const clause = headers.findIndex((value) => CLAUSE_HEADERS.has(value));
        const verdict = headers.findIndex((value) => value === 'verdict');
        columns = clause >= 0 && verdict >= 0 ? { clause, verdict } : null;
      } else columns = null;
      candidate = null;
      continue;
    }
    if (!columns) {
      candidate = cells;
      continue;
    }
    if (cells.length <= Math.max(columns.clause, columns.verdict)) continue;
    rows.push({
      clauseId: plainCell(cells[columns.clause]),
      verdict: plainCell(cells[columns.verdict]).toLowerCase(),
      line: index + 1
    });
  }
  return rows;
}

/**
 * Tables whose header lacks a clause column or a Verdict column, so none of their rows is read. A
 * "Status" column read as no rows at all, and the report then said every clause had no row
 * (2026-10-29). Returns each such table's line and header.
 */
export function unreadConformanceTables(markdown) {
  const found = [];
  let candidate = null;
  for (const [index, line] of visibleTableLines(markdown).entries()) {
    const cells = tableCells(line);
    if (!cells) { candidate = null; continue; }
    if (separator(cells)) {
      if (candidate && cells.length === candidate.cells.length) {
        const headers = candidate.cells.map(heading);
        if (!headers.some((value) => CLAUSE_HEADERS.has(value)) || !headers.includes('verdict')) found.push({ line: candidate.line, header: candidate.cells });
      }
      candidate = null;
      continue;
    }
    candidate = candidate ? candidate : { line: index + 1, cells };
  }
  return found;
}

/** Require an individual qualified row, not an incidental identifier elsewhere in prose. */
export function missingQualifiedConformanceRows(markdown, expectedIds) {
  const reported = new Set(conformanceTableRows(markdown)
    .map((row) => normalizeQualifiedClauseId(row.clauseId)).filter(Boolean));
  return [...new Set(expectedIds)].filter((id) => !reported.has(normalizeQualifiedClauseId(id)));
}

export function duplicateQualifiedConformanceRows(markdown) {
  const seen = new Set(), duplicates = new Set();
  for (const row of conformanceTableRows(markdown)) {
    const id = normalizeQualifiedClauseId(row.clauseId);
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates];
}

/** Partial and missing table verdicts with the line each is stated on. */
function incompleteVerdictRows(markdown) {
  const identified = conformanceTableRows(markdown);
  // Historical custom reports may predate named comparison headers. Preserve the former
  // fifth-column interpretation only when no named comparison table is present at all.
  const rows = identified.length ? identified : visibleTableLines(markdown).flatMap((line, index) => {
    const cells = tableCells(line);
    return cells?.length >= 5 ? [{ clauseId: plainCell(cells[0]), verdict: plainCell(cells[4]).toLowerCase(), line: index + 1 }] : [];
  });
  return rows.flatMap(({ clauseId, verdict, line }) => {
    const status = /^(missing|partial)(?:\s|\(|$)/u.exec(verdict)?.[1];
    return status && BLOCKING.has(status) ? [{ clauseId, verdict: status, line }] : [];
  });
}

export function blockingConformanceVerdicts(markdown) {
  return incompleteVerdictRows(markdown).map(({ clauseId, verdict }) => ({ clauseId, verdict }));
}

/**
 * Each clause the report's table honestly calls partial or missing, once, with its line. The gap
 * may bind to an existing issue owned by an earlier step; it never stops report publication, and a
 * person decides the gap before approval. No issue/decision is written by this reader.
 */
function conformanceVerdictGaps(markdown, { workflow = null, phaseId = null, discrepancyDigest } = {}) {
  const seen = new Set();
  const gaps = incompleteVerdictRows(markdown).flatMap((row) => {
    const clauseId = normalizeQualifiedClauseId(row.clauseId) ?? row.clauseId;
    if (!clauseId || seen.has(clauseId.toUpperCase())) return [];
    seen.add(clauseId.toUpperCase());
    return [{ clauseId, verdict: row.verdict, line: row.line ?? null }];
  });
  if (!workflow || !phaseId || !gaps.length) return gaps;
  return linkReportIssues(markdown, workflow, phaseId, gaps, discrepancyDigest);
}

/**
 * Bind a row to existing issues from authored references, never proximity or a phase name alone.
 * Legacy reports sometimes say "both clauses" instead of spelling out IDs. That is unambiguous
 * only for a two-clause table and an issue filed from this exact discrepancy item. An arbitrary
 * section issue, another report, a changed item or a larger table cannot claim those clauses.
 * These are derived read facts, not new records and never authority to edit an approved report.
 */
function linkReportIssues(markdown, workflow, phaseId, gaps, discrepancyItemSha256) {
  const lines = visibleTableLines(markdown);
  const clauses = new Set(conformanceTableRows(markdown).map((row) => normalizeQualifiedClauseId(row.clauseId) ?? row.clauseId));
  // The issue already retains the exact item text and its filing digest. Verify those bytes are
  // still in the authored section instead of loading the full authoring/ownership parser on a
  // read path. Table items use the same cell separator and backtick removal as their filing reader.
  const section = (lines.join('\n').split(/^##\s+Upstream discrepancies\s*$/imu)[1]?.split(/^#{1,2}\s/mu)[0] ?? '').split('\n')
    .map((line) => tableCells(line)?.map((cell) => cell.replaceAll('`', '').trim()).filter(Boolean).join(' — ') ?? line)
    .join('\n').replace(/\s+/gu, ' ').trim();
  const artifact = workflow.phases?.[phaseId]?.requiredArtifact?.path;
  const suffix = artifact ? `/${workflow.workItem.id}/${artifact}` : null;
  const issues = workflow.upstreamIssues ?? [];
  const bound = issues.filter((issue) => {
    const text = String(issue.problem ?? '').replace(/\s+/gu, ' ').trim();
    return clauses.size === 2 && /\bboth\s+(?:of\s+the\s+)?clauses\b/iu.test(String(issue.impact ?? '').replace(/[`*_]/gu, ''))
      && text && section.includes(text) && suffix && issue.source?.path?.endsWith(suffix)
      && issue.source.itemSha256 === discrepancyItemSha256(issue.phase, issue.problem);
  });
  return gaps.map((gap) => {
    const row = lines[(gap.line ?? 0) - 1] ?? '';
    const ids = row.match(/(?<![\w:-])UPI-\d{3,}(?![\w-])/gu) ?? [];
    const explicit = issues.filter((issue) => ids.includes(issue.id));
    const linked = explicit.length ? explicit : bound;
    return linked.length ? { ...gap, issueRefs: [...new Set(linked.map((issue) => issue.id))] } : gap;
  });
}

const PROSE_SECTION = /^(?:upstream discrepancies|impact\b.*)$/iu;
const STATED_VERDICT = /\b(partial|missing)\b/giu;
const NOT_STATED = /\b(?:not|no|never|no longer|previously|formerly|was|were|isn't|aren't|wasn't|weren't)\s+(?:yet\s+|still\s+)?$/iu;
const NEAR = 100;

/** Sentences under `## Upstream discrepancies` and any Impact heading, outside comments and fences. */
function discrepancyStatements(markdown) {
  const statements = [];
  let section = null;
  let level = 0;
  let block = [];
  const flush = () => {
    if (section && block.length) {
      for (const text of block.join(' ').split(/(?<=[.;!?])\s+/u)) if (text.trim()) statements.push({ section, text: text.trim() });
    }
    block = [];
  };
  for (const line of visibleTableLines(markdown)) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flush();
      if (section && heading[1].length <= level) section = null;
      if (!section && PROSE_SECTION.test(heading[2].trim())) {
        section = /^impact/iu.test(heading[2].trim()) ? 'Impact' : 'Upstream discrepancies';
        level = heading[1].length;
      }
      continue;
    }
    if (!section) continue;
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)]|\|)\s*/u.test(line)) flush();
    block.push(line.trim());
  }
  flush();
  return statements;
}

/**
 * Clauses the table calls matched while the report's own discrepancy or Impact text calls them
 * partial or missing, close to their exact ID in one sentence. Conservative on purpose: a negated
 * or past-tense mention ("no longer partial", "was missing") is not a contradiction.
 */
export function contradictedConformanceVerdicts(markdown) {
  const statements = discrepancyStatements(markdown);
  if (!statements.length) return [];
  const seen = new Set();
  const found = [];
  for (const row of conformanceTableRows(markdown)) {
    if (!/^matched(?:\s|\(|$)/u.test(row.verdict)) continue;
    const clauseId = normalizeQualifiedClauseId(row.clauseId) ?? row.clauseId;
    if (!clauseId || seen.has(clauseId.toUpperCase())) continue;
    const mention = clauseMentionPattern(clauseId);
    for (const statement of statements) {
      const positions = [...statement.text.matchAll(mention)].map((match) => match.index);
      const stated = positions.length ? [...statement.text.matchAll(STATED_VERDICT)].find((match) =>
        !NOT_STATED.test(statement.text.slice(Math.max(0, match.index - 30), match.index))
        && positions.some((position) => Math.abs(position - match.index) <= NEAR)) : null;
      if (!stated) continue;
      seen.add(clauseId.toUpperCase());
      found.push({ clauseId, verdict: 'matched', stated: stated[1].toLowerCase(), section: statement.section,
        line: row.line, excerpt: statement.text.length > 200 ? `${statement.text.slice(0, 199)}…` : statement.text });
      break;
    }
  }
  return found;
}

const VERDICT = /^(matched|partial|missing|deviated|unplanned)(?:\s|\(|$)/u;
const ANY_VERDICT = /\b(matched|partial|missing|deviated|unplanned)\b/;
const MULTIPLE_VERDICTS = /\b(?:matched|partial|missing|deviated|unplanned)\s*(?:\/|\bor\b)\s*(?:matched|partial|missing|deviated|unplanned)\b/u;
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/gu;
const MANAGED_METADATA = /^<!-- singularity-flow:(?:initiative-)?metadata\n[\s\S]*?\n-->\s*/u;

function authoredConformanceText(markdown) {
  return String(markdown ?? '').replace(MANAGED_METADATA, '').replace(MANAGED_INPUTS, '');
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

/**
 * Whether `text` names `value` whole: a phase ID, login or email not run into a longer one, so
 * `implementation` is not named by `implementation-spec` or `implementation.md`, nor `ann` by `anna`.
 */
export function mentionsWhole(text, value) {
  if (!value) return false;
  return new RegExp(`(?<![\\w.@+-])${String(value).replace(REGEXP_SPECIAL, '\\$&')}(?![\\w@+-]|\\.\\w)`, 'u').test(String(text ?? ''));
}

function retainedSelfApprovals(workflow) {
  const entries = [];
  const phaseIds = [...new Set([...(workflow?.phaseOrder ?? []), ...Object.keys(workflow?.phases ?? {})])];
  for (const phaseId of phaseIds) {
    for (const approval of workflow?.phases?.[phaseId]?.approvals ?? []) {
      if (approval.invalidatedAt || !approval.selfApproval) continue;
      const actor = approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name ?? null;
      entries.push({ phaseId, actor,
        line: `- \`${phaseId}\`: self-approved${actor ? ` by ${actor}` : ''}; not an independent review.` });
    }
  }
  return entries;
}

/**
 * Each retained self-approval `text` does not disclose: one that names neither its phase ID nor its
 * approver whole. Draft check, publication and the gate share it [gate parity]; the message names
 * the exact line that satisfies it.
 */
export function undisclosedSelfApprovals(text, workflow) {
  return retainedSelfApprovals(workflow)
    .filter(({ phaseId, actor }) => !(mentionsWhole(text, phaseId) && (!actor || mentionsWhole(text, actor))))
    .map((entry) => ({ ...entry,
      message: `conformance report does not disclose self-approval for ${entry.phaseId}${entry.actor ? ` by ${entry.actor}` : ''}; `
        + `add this line under the report's self-approval section, naming the phase and approver exactly: ${entry.line}` }));
}

/** Required disclosure is derived from retained approvals, not model-authored recollection. */
export function inspectSelfApprovalDisclosures(markdown, workflow) {
  return undisclosedSelfApprovals(authoredConformanceText(markdown), workflow).map(({ message }) => ({
    code: 'conformance.self-approval-undisclosed', clauseId: null, line: null, message
  }));
}

/** Each self-approval a conformance report owes, from retained approvals, as one Markdown line. */
export function selfApprovalDisclosureLines(workflow) {
  return retainedSelfApprovals(workflow).map(({ line }) => line);
}

/**
 * A new conformance report starts with the self-approval disclosures it owes.
 *
 * The draft check refuses a report that omits one, and an agent that forgets it pays for a bounded
 * repair loop to add a paragraph the engine already knows. The template's own disclosure section,
 * when it has one, receives the lines in place of its TODO; otherwise the section is appended.
 */
export function withSelfApprovalDisclosures(markdown, workflow) {
  const lines = selfApprovalDisclosureLines(workflow);
  if (!lines.length) return markdown;
  const block = ['Recorded from the retained approvals. Keep every line.', '', ...lines].join('\n');
  const section = /^## Self-approval disclosures?[ \t]*\n(?:(?!^## )[\s\S])*?^TODO:[^\n]*$/mu;
  if (section.test(markdown)) return markdown.replace(section, (match) => match.replace(/^TODO:[^\n]*$/mu, block));
  return `${String(markdown).trimEnd()}\n\n## Self-approval disclosures\n\n${block}\n`;
}

/**
 * What every conformance report owes the approval gate apart from qualified rows and self-approval
 * disclosure, read exactly as the gate reads it: a mention of each traceable identifier and at least
 * one recognized verdict. The gate and the earlier checks call this one function, so a report is
 * never refused first at approval [gate parity]. A partial or missing verdict is not a defect of the
 * report: it is an advisory here (inspectConformanceVerdictAdvisories), decided by a person before
 * approval. `rowsQualified` means the qualified row contract already judged the rows.
 */
export function inspectConformanceReportContract(report, { expected = [], rowsQualified = false } = {}) {
  const text = String(report ?? '');
  const findings = [];
  if (!rowsQualified) {
    for (const id of expected) {
      if (!text.includes(id)) findings.push({ code: 'conformance.clause-row-missing', clauseId: id, line: null, message: `conformance report has no row for ${id}` });
    }
  }
  if (!ANY_VERDICT.test(text)) findings.push({ code: 'conformance.verdict-invalid', clauseId: null, line: null, message: 'conformance report has no recognized verdict' });
  return findings;
}

/** One report-row contract for draft, publication, approval, and terminal review. */
export function inspectQualifiedConformanceReport(markdown, clauseIds) {
  const known = new Set((clauseIds ?? []).map(normalizeQualifiedClauseId).filter(Boolean));
  if (!known.size) return [];
  const findings = [];
  // No table read at all: say which table was skipped and why, not "no row" once per clause.
  const unread = conformanceTableRows(markdown).length ? [] : unreadConformanceTables(markdown);
  if (unread.length) {
    findings.push({ code: 'conformance.table-unrecognized', clauseId: null, line: unread[0].line,
      message: `conformance report has no comparison table: one needs a Clause ID column (or Clause, ID, Criterion) and a Verdict column; the table at line ${unread[0].line} has ${shown(unread[0].header.join(' | '))}` });
    return findings;
  }
  for (const id of missingQualifiedConformanceRows(markdown, known)) {
    findings.push({ code: 'conformance.clause-row-missing', clauseId: id,
      message: `conformance report has no row for ${id}`, line: null });
  }
  for (const id of duplicateQualifiedConformanceRows(markdown)) {
    findings.push({ code: 'conformance.clause-row-duplicate', clauseId: id,
      message: `conformance report has duplicate row for ${id}`, line: null });
  }
  for (const row of conformanceTableRows(markdown)) {
    const id = normalizeQualifiedClauseId(row.clauseId);
    if (!id) {
      findings.push({ code: 'conformance.clause-row-invalid', clauseId: row.clauseId,
        message: `conformance report has an invalid qualified clause ID on line ${row.line}: it holds ${shown(row.clauseId)}; write it in full, such as ORDER:REQ-001`, line: row.line });
      continue;
    }
    if (!known.has(id)) {
      findings.push({ code: 'conformance.clause-row-unknown', clauseId: id,
        message: `conformance report references unapproved clause ${id} on line ${row.line}`, line: row.line });
    } else if (!VERDICT.test(row.verdict) || MULTIPLE_VERDICTS.test(row.verdict)) {
      findings.push({ code: 'conformance.verdict-invalid', clauseId: id,
        message: `conformance ${id} has no recognized verdict on line ${row.line}: its Verdict holds ${shown(row.verdict)}; start it with one word of matched, partial, missing, deviated or unplanned, then any note`, line: row.line });
    }
  }
  return findings;
}


/** Native digest primitives stay with the host; issue association keeps its original byte identity. */
export function conformanceVerdictPolicies(digests){
  const hash=textDigestCapability(digests).sha256Utf8;
  const discrepancyDigest=(phaseId,text)=>hash(`${phaseId}\n${String(text).replace(/\s+/gu,' ').trim()}`);
  return Object.freeze({conformanceVerdictGaps:(markdown,options)=>conformanceVerdictGaps(markdown,{...options,discrepancyDigest}),
    linkedConformanceEvidence:(markdown,options)=>{
      const result=evaluateConformanceEvidence(markdown,options),workflow=options.workflow;
      const visible=visibleTableLines(markdown),positioned=result.gaps.map(gap=>({...gap,line:result.rows.find(row=>row.clauseId===gap.clauseId)?.line??null}));
      for(const gap of positioned)for(const id of (visible[(gap.line??0)-1]??'').match(/(?<![\w:-])UPI-\d{3,}(?![\w-])/gu)??[])if(!(workflow.upstreamIssues??[]).some(row=>row.id===id))result.findings.push({
        code:'conformance.upstream-issue-unknown',clauseId:gap.clauseId,line:gap.line,message:id+' has no retained issue in this Story.'});
      result.gaps=linkReportIssues(markdown,workflow,options.phaseId,positioned,discrepancyDigest).map(({line,...gap})=>{
        if(!gap.issueRefs?.length)return gap;
        const issues=gap.issueRefs.map(id=>(workflow.upstreamIssues??[]).find(row=>row.id===id));
        const {issueRefs,...unlinked}=gap,filed=linkReportIssues(markdown,workflow,options.phaseId,[{...unlinked,line:null}],discrepancyDigest)[0];
        for(const issue of issues.filter(Boolean)){
          const named=qualifiedClauseMatches([issue.about,issue.problem,issue.impact].filter(Boolean).join(' ')).map(normalizeQualifiedClauseId);
          if(!named.includes(gap.clauseId)&&!filed.issueRefs?.includes(issue.id))result.findings.push({code:'conformance.upstream-clause-unbound',clauseId:gap.clauseId,line:null,
            message:issue.id+' does not bind this clause or an exact filed discrepancy covering it. Keep unrelated decisions separate.'});
        }
        for(const issue of issues)if(!issue||!workflow.phaseOrder.slice(0,workflow.phaseOrder.indexOf(options.phaseId)).includes(issue.phase))result.findings.push({
          code:'conformance.upstream-owner-invalid',clauseId:gap.clauseId,line:gap.line??null,message:'The conformance row must name an actual earlier producer issue.'});
        return {...gap,owners:[...new Set(issues.filter(Boolean).map(row=>row.phase))]};
      });return result;
    }});
}

/** New retained conformance profile: a matched label requires actual observed delivery facts. */
export function evaluateConformanceEvidence(markdown,{workflow,clauseIds,observations=[]}){
  const findings=[...inspectQualifiedConformanceReport(markdown,clauseIds),
    ...inspectConformanceReportContract(markdown,{rowsQualified:clauseIds.length>0}),...inspectSelfApprovalDisclosures(markdown,workflow)],rows=[];
  for(const row of conformanceTableRows(markdown)){
    const clauseId=normalizeQualifiedClauseId(row.clauseId),verdict=/^(matched|partial|missing|deviated|unplanned)(?:\s|\(|$)/u.exec(row.verdict)?.[1]??null,
      evidence=observations.filter(item=>item.clauseId===clauseId);
    if(verdict==='matched'&&(!evidence.length||evidence.some(item=>item.verdict!=='matched'
      ||/:AC-\d+$/u.test(clauseId)&&(!item.witnesses.length||item.witnesses.some(witness=>witness.status!=='met'||typeof witness.id!=='string'||!witness.id)))))findings.push({
      code:'conformance.evidence-not-matched',clauseId,line:row.line,message:`${clauseId} has no complete retained delivery and acceptance proof for a matched verdict.`});
    rows.push({...row,clauseId,verdict,evidence});
  }
  for(const entry of contradictedConformanceVerdicts(markdown))findings.push({code:'conformance.verdict-contradicted',...entry,
    message:`${entry.clauseId} has conflicting table and discrepancy verdicts.`});
  return {findings,rows,gaps:rows.filter(row=>row.verdict!=='matched').map(row=>({clauseId:row.clauseId,verdict:row.verdict,
    owners:[...new Set(row.evidence.map(item=>item.phase))]}))};
}
