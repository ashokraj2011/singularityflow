/**
 * Optional structured narration over one XPL2 subject view [XPL2 13.2, XPL2-LAW-003].
 *
 * A model may only choose and order statement IDs under a closed set of connectives. Everything a
 * reader sees is the computed statement text for those IDs: proposed prose is discarded, unknown
 * IDs and connectives are dropped and counted, and every attention statement the view reports is
 * shown whether or not the model chose it, so ranking can never hide a blocker. The narration
 * never changes the computed view or its hashes, is never stored, and grants no authority.
 *
 * An explicitly requested free-form commentary is kept apart [XPL2 13.3]: matching IDs and words is
 * citation syntax, not semantic support, so commentary is always labelled unverified, and markup,
 * control sequences, secret-shaped or oversized text is withheld with its reason instead of shown.
 *
 * Everything but `narrateXpl2Explanation` is pure. That one function is the optional model call: it is
 * reached only through `--narrate`, loads the model runner lazily, and goes through the existing runner
 * with its own operation context, audit and prompt-capture setting (capture is never switched on here),
 * with no tools and the approved projection as its only input. Any failure — model disabled, provider
 * unavailable, invalid output — is reported as unavailable narration; the computed view is unchanged.
 */
import path from 'node:path';

import { compactCanonicalJson, recordSha256 } from '../../records.mjs';
import { looksSecretValue } from '../../secret-looking.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { displayText } from './templates.mjs';

export const XPL2_NARRATION_CONTRACT = 'xpl2-narration@1';
export const XPL2_NARRATION_BANNER = 'AI-organized summary — record-derived, advisory';
export const XPL2_COMMENTARY_BANNER = 'AI commentary — semantic support unverified';

export const XPL2_NARRATION_LENGTHS = Object.freeze({ brief: 100, standard: 250, long: 500 });

export const XPL2_NARRATION_LIMITS = Object.freeze({
  inputStatements: 160,
  sections: 12,
  idsPerSection: 40,
  outputBytes: 64 * 1024,
  commentaryCharacters: 4000
});

/** The closed connective catalog: a section heading is one of these, never model text. */
export const XPL2_CONNECTIVES = Object.freeze({
  start: 'Start here',
  changes: 'What changed',
  links: 'Why it is linked',
  checks: 'What was checked',
  attention: 'What needs attention',
  unknown: 'What these records do not show',
  next: 'What to inspect next'
});

/** Why a commentary was not shown. Each is visible to the reader; the computed view is unaffected. */
export const XPL2_COMMENTARY_WITHHELD = Object.freeze({
  'commentary-shape-invalid': 'The commentary was not plain text with a list of citations.',
  'commentary-oversized': 'The commentary was longer than the requested length allows.',
  'commentary-control-characters': 'The commentary contained control or terminal escape characters.',
  'commentary-markup': 'The commentary contained markup, links or code.',
  'commentary-secret-shaped': 'The commentary contained text shaped like a secret or credential.',
  'commentary-uncited': 'The commentary cited no statement.',
  'commentary-unknown-citation': 'The commentary cited IDs that are not statements of this explanation.'
});

const MARKUP = /<\s*[A-Za-z!/?]|\]\s*\(|```|&#?[A-Za-z0-9]+;|\b(?:javascript|data|vbscript|file):|\[[^\]]*\]:/iu;
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const STATEMENT_ID = /^[SD]-\d{3,}$/u;

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function invalid(message) {
  return new SingularityFlowError(`${message} The computed explanation remains available.`, { code: 'XPL2_NARRATION_INVALID' });
}

function words(text) {
  return String(text ?? '').split(/\s+/u).filter(Boolean).length;
}

const unique = (values) => [...new Set(values)];

export function xpl2NarrationWordLimit(length = 'standard') {
  const value = XPL2_NARRATION_LENGTHS[length];
  if (!value) {
    throw new SingularityFlowError(`Narration length '${length}' is invalid. Use brief, standard or long.`,
      { code: 'XPL2_NARRATION_LENGTH_INVALID' });
  }
  return value;
}

/**
 * The approved model input: the delivered statements' IDs, kinds, computed text, citations and
 * limits, the attention list and counts — nothing else from the view, no source, no paths beyond
 * what statements already say, no tools [XPL2-AC-047]. Attention statements come first, then the
 * deterministic reading tour, then the rest; past the bound the subset is declared, never implied
 * complete.
 */
export function xpl2NarrationInput(model, { maximumStatements = XPL2_NARRATION_LIMITS.inputStatements } = {}) {
  const delivered = [...(model.statements ?? []), ...(model.derived ?? [])];
  const byId = new Map(delivered.map((entry) => [entry.id, entry]));
  const attention = (model.attention ?? []).filter((entry) => byId.has(entry.statement));
  const mandatory = unique(attention.map((entry) => entry.statement));
  const tour = (model.presentation?.tour ?? []).flatMap((step) => step.statements ?? []);
  const order = unique([...mandatory, ...tour, ...delivered.map((entry) => entry.id)]).filter((id) => byId.has(id));
  const bound = Math.max(1, Number.isSafeInteger(maximumStatements) ? maximumStatements : XPL2_NARRATION_LIMITS.inputStatements);
  const selected = order.slice(0, bound);
  const selectedSet = new Set(selected);
  const core = {
    contract: XPL2_NARRATION_CONTRACT,
    subject: { kind: model.subject?.kind ?? null, status: model.subject?.status ?? null, reason: model.subject?.reason ?? null },
    explanationSha256: model.explanationSha256 ?? null,
    counts: model.inventory?.counts ?? null,
    connectives: Object.keys(XPL2_CONNECTIVES),
    statements: selected.map((id) => {
      const entry = byId.get(id);
      return { id, kind: entry.kind, text: entry.text, cites: [...entry.cites], limitations: [...entry.limitations] };
    }),
    attention: attention.filter((entry) => selectedSet.has(entry.statement))
      .map((entry) => ({ category: entry.category, reason: entry.reason, statement: entry.statement })),
    omittedStatements: order.length - selected.length
  };
  return freezeDeep({
    ...core,
    mandatory: mandatory.filter((id) => selectedSet.has(id)),
    inputSha256: `sha256:${recordSha256(core)}`
  });
}

function promptPayload({ mandatory: _mandatory, inputSha256: _digest, ...core }) {
  return core;
}

/** The prompt: the closed output shape, the rules, then the approved input as canonical JSON. */
export function buildXpl2NarrationPrompt(input, { length = 'standard', commentary = false } = {}) {
  const maximumWords = xpl2NarrationWordLimit(length);
  return [
    'Return JSON only with this exact shape: {"sections":[{"connective":"CONNECTIVE","statements":["STATEMENT-ID"]}]}'
      + (commentary ? ' and, optionally, "commentary":{"text":"...","citations":["STATEMENT-ID"]}.' : '.'),
    `Use only these connectives: ${input.connectives.join(', ')}. At most ${XPL2_NARRATION_LIMITS.sections} sections `
      + `and ${XPL2_NARRATION_LIMITS.idsPerSection} statement IDs per section.`,
    'Choose and order statement IDs from the statements below so a person can read the explanation in a sensible order.',
    'Do not write sentences, headings or summaries in the sections: Singularity Flow discards any text you write there and shows the recorded statement for each ID you choose.',
    'The statements listed under attention are always shown, whether or not you choose them. Your order is not a risk ranking.',
    commentary
      ? `The optional commentary is plain text of at most ${maximumWords} words that cites statement IDs; no markup, links or code. It is shown labelled "${XPL2_COMMENTARY_BANNER}", or withheld.`
      : 'Do not add commentary.',
    `The shown statements are limited to about ${maximumWords} words, plus the attention statements.`,
    'XPL2_NARRATION_INPUT_JSON',
    compactCanonicalJson(promptPayload(input)).trimEnd()
  ].join('\n');
}

function parseOutput(output) {
  const text = String(output ?? '').trim();
  if (Buffer.byteLength(text, 'utf8') > XPL2_NARRATION_LIMITS.outputBytes) throw invalid('The narration was larger than its bound.');
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/u.exec(text);
  try { return JSON.parse((fenced ? fenced[1] : text).trim()); }
  catch { throw invalid('The narration did not return the requested JSON.'); }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Judge a commentary for display. It is never semantically supported: a valid citation list is
 * citation syntax only. Any unsafe trait withholds it, and every reason found is reported.
 */
function judgeCommentary(raw, known, maximumWords) {
  if (raw === undefined) return { status: 'not-returned', banner: XPL2_COMMENTARY_BANNER, authority: 'none' };
  const reasons = [];
  if (!plainObject(raw) || typeof raw.text !== 'string' || !Array.isArray(raw.citations)
      || Object.keys(raw).some((key) => !['text', 'citations'].includes(key))
      || raw.citations.some((entry) => typeof entry !== 'string')) {
    reasons.push('commentary-shape-invalid');
  } else {
    if (words(raw.text) > maximumWords || raw.text.length > XPL2_NARRATION_LIMITS.commentaryCharacters) reasons.push('commentary-oversized');
    if (CONTROL.test(raw.text.replace(/[\n\t]/gu, ' '))) reasons.push('commentary-control-characters');
    if (MARKUP.test(raw.text)) reasons.push('commentary-markup');
    if (looksSecretValue(raw.text)) reasons.push('commentary-secret-shaped');
    if (!raw.citations.length) reasons.push('commentary-uncited');
    if (raw.citations.some((id) => !known.has(id))) reasons.push('commentary-unknown-citation');
  }
  if (reasons.length) {
    return {
      status: 'withheld', banner: XPL2_COMMENTARY_BANNER, authority: 'none',
      reasons, explanation: reasons.map((reason) => XPL2_COMMENTARY_WITHHELD[reason])
    };
  }
  return {
    status: 'shown', banner: XPL2_COMMENTARY_BANNER, authority: 'none',
    text: displayText(raw.text, XPL2_NARRATION_LIMITS.commentaryCharacters),
    citations: unique(raw.citations).sort(),
    // Matching IDs and words establishes citation syntax only, never what the text means [XPL2 13.3].
    citationSyntax: 'valid',
    semanticSupport: 'unverified'
  };
}

/**
 * Validate a model's narration against the approved input and render it from computed statements
 * only. Throws `XPL2_NARRATION_INVALID` for unusable output; the caller then reports narration as
 * unavailable and the computed explanation is unchanged.
 */
export function validateXpl2Narration(output, input, { length = 'standard', commentary = false } = {}) {
  const maximumWords = xpl2NarrationWordLimit(length);
  const parsed = parseOutput(output);
  if (!plainObject(parsed) || !Array.isArray(parsed.sections)
      || Object.keys(parsed).some((key) => !['sections', 'commentary'].includes(key))) {
    throw invalid('The narration returned an unsupported shape.');
  }
  if (parsed.sections.length > XPL2_NARRATION_LIMITS.sections) throw invalid('The narration returned too many sections.');
  const byId = new Map(input.statements.map((entry) => [entry.id, entry]));
  const discarded = { prose: 0, unknownIds: 0, duplicates: 0, connectives: 0, invalidSections: 0, byLength: 0, commentary: 0 };
  const shown = new Set();
  const sections = [];
  let used = 0;
  for (const candidate of parsed.sections) {
    if (!plainObject(candidate) || typeof candidate.connective !== 'string' || !Array.isArray(candidate.statements)
        || candidate.statements.length > XPL2_NARRATION_LIMITS.idsPerSection) {
      discarded.invalidSections += 1;
      continue;
    }
    // Any other field is proposed prose or structure; it never reaches the reader.
    discarded.prose += Object.keys(candidate).filter((key) => !['connective', 'statements'].includes(key)).length;
    if (!Object.hasOwn(XPL2_CONNECTIVES, candidate.connective)) {
      discarded.connectives += 1;
      continue;
    }
    const chosen = [];
    for (const id of candidate.statements) {
      if (typeof id !== 'string' || !STATEMENT_ID.test(id) || !byId.has(id)) { discarded.unknownIds += 1; continue; }
      if (shown.has(id)) { discarded.duplicates += 1; continue; }
      const statement = byId.get(id);
      const cost = words(statement.text);
      if (used + cost > maximumWords) { discarded.byLength += 1; continue; }
      used += cost;
      shown.add(id);
      chosen.push({ id, text: statement.text, cites: [...statement.cites] });
    }
    if (chosen.length) {
      sections.push({ connective: candidate.connective, heading: XPL2_CONNECTIVES[candidate.connective], statements: chosen });
    }
  }
  // Attention statements are always visible, outside the length budget: ordering is not risk authority.
  const appended = input.mandatory.filter((id) => !shown.has(id));
  if (appended.length) {
    sections.push({
      connective: 'attention', heading: `${XPL2_CONNECTIVES.attention} (always shown)`, appendedByKernel: true,
      statements: appended.map((id) => ({ id, text: byId.get(id).text, cites: [...byId.get(id).cites] }))
    });
  }
  let commentaryResult = null;
  if (commentary) {
    commentaryResult = judgeCommentary(parsed.commentary, byId, maximumWords);
  } else if (parsed.commentary !== undefined) {
    discarded.commentary = 1;
  }
  return freezeDeep({
    status: 'available',
    mode: commentary ? 'structured-with-commentary' : 'structured',
    contract: XPL2_NARRATION_CONTRACT,
    banner: XPL2_NARRATION_BANNER,
    authority: 'none',
    advisory: true,
    stored: false,
    length,
    maximumWords,
    words: used,
    sections,
    mandatory: { required: input.mandatory.length, appended },
    discarded,
    coverage: { statements: input.statements.length, omittedFromInput: input.omittedStatements },
    inputSha256: input.inputSha256,
    explanationSha256: input.explanationSha256,
    commentary: commentaryResult
  });
}

/** The unavailable narration shape: the reason, the label, and nothing that looks like a summary. */
export function unavailableXpl2Narration(reason, model = null) {
  return freezeDeep({
    status: 'unavailable',
    reason: String(reason ?? 'XPL2_NARRATION_UNAVAILABLE'),
    contract: XPL2_NARRATION_CONTRACT,
    banner: XPL2_NARRATION_BANNER,
    authority: 'none',
    advisory: true,
    stored: false,
    explanationSha256: model?.explanationSha256 ?? null
  });
}

export const XPL2_NARRATION_OPERATION = 'explain.subject.narrate';
export const XPL2_NARRATION_CHANNEL = 'xpl2-narration-advisory';

function narrationSubject(root, { workId = null, phase = null, subject = 'change' } = {}) {
  return workId ? {
    kind: 'story', id: workId, workId, phase,
    repositoryId: path.basename(root), purpose: XPL2_NARRATION_CHANNEL, explanationSubject: subject
  } : { kind: 'repository-code-explanation', id: path.basename(root), phase, explanationSubject: subject };
}

/**
 * Narrate one computed view. `provider` overrides the configured provider (tests use a local
 * stand-in executable); the runner, its audit and its capture setting are always the real ones.
 */
export async function narrateXpl2Explanation(root, model, {
  operation = null, length = 'standard', commentary = false, workId = null, phase = null, provider = null
} = {}) {
  if (operation?.id !== XPL2_NARRATION_OPERATION) return unavailableXpl2Narration('model-disabled-fallback', model);
  try {
    const input = xpl2NarrationInput(model);
    const prompt = buildXpl2NarrationPrompt(input, { length, commentary });
    const [{ invokeModel, resolveModelProvider }, { summarizingRoute }] = await Promise.all([
      import('../../model-runner.mjs'), import('../../model-tiers.mjs')
    ]);
    let selected = provider;
    let route = {};
    if (!selected) {
      const { loadDefinition } = await import('../../config.mjs');
      selected = resolveModelProvider(await loadDefinition(root));
      route = await summarizingRoute(root, selected.model);
    }
    const invocation = await invokeModel({
      provider: selected.provider,
      providerConfig: selected.providerConfig,
      ...route,
      cwd: root,
      allowedRoots: [root],
      prompt: { text: prompt },
      channel: XPL2_NARRATION_CHANNEL,
      subject: narrationSubject(root, { workId, phase, subject: model.subject?.kind }),
      tools: { mode: 'none', names: [] },
      limits: { timeoutMs: 2 * 60 * 1000, outputBytes: 64 * 1024 }
    });
    return validateXpl2Narration(invocation.output, input, { length, commentary });
  } catch (error) {
    return unavailableXpl2Narration(error?.code ?? 'XPL2_NARRATION_UNAVAILABLE', model);
  }
}
