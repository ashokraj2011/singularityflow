import { createHash } from 'node:crypto';

import { assessTokenAdmission } from './token-admission.mjs';
import { normalizeTokenEconomy, selectedTokenEconomyProfile } from './token-economy.mjs';
import { SingularityFlowError } from './util.mjs';

const SECTION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_SECTION_IDS = new Set(['token-budget-omissions', 'kernel-law', 'active-human-instruction']);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function bytes(value) { return Buffer.byteLength(String(value ?? ''), 'utf8'); }
function tokens(value) { return Math.ceil(bytes(value) / 4); }

/** The exact section bytes used by rendering, identity, cache keys, audit and expansion checks. */
export function normalizePromptSection(value) { return String(value ?? '').trim(); }

function render(sections) {
  const body = sections.map((section) => section.canonicalText).filter(Boolean).join('\n\n');
  return body ? `${body}\n` : '';
}

function utf8Prefix(value, maximumBytes) {
  const source = Buffer.from(value, 'utf8');
  if (source.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return source.subarray(0, end).toString('utf8').trimEnd();
}

function expansionHandles(section) {
  return [...new Set([
    ...(section.expandHandle ? [section.expandHandle] : []),
    ...(Array.isArray(section.expandHandles) ? section.expandHandles : [])
  ].map((value) => String(value).trim()).filter(Boolean))];
}

/** A fixed-size, non-evictable model-visible receipt for every omitted section. */
function omissionCapsule(omitted, maximumBytes) {
  if (!omitted.length) return null;
  const header = [
    '# Context omitted under approved policy',
    '',
    'Optional context was omitted. A source hash proves identity; only an explicit Expand value is retrievable.',
    ''
  ];
  const lines = [...header];
  let included = 0;
  for (const section of omitted) {
    const handles = section.expandHandles.length ? section.expandHandles.join(', ') : 'unavailable';
    const block = [
      `- Section: ${section.id}`,
      '  Reason: budget',
      `  Source: sha256:${section.sha256}`,
      `  Expand: ${handles}`,
      ''
    ];
    const remainder = omitted.length - included - 1;
    const candidate = [...lines, ...block, ...(remainder ? [`- Additional omitted sections: ${remainder} (see structured audit)`] : [])].join('\n');
    if (bytes(candidate) > maximumBytes) break;
    lines.push(...block);
    included += 1;
  }
  if (!included) {
    const first = omitted[0];
    const compact = [
      '# Context omitted under approved policy', '',
      `- Section: ${first.id}`,
      '  Reason: budget',
      `  Expand: ${first.expandHandles[0] ?? 'unavailable'}`,
      ...(omitted.length > 1 ? [`- Additional omitted sections: ${omitted.length - 1} (see structured audit)`] : [])
    ].join('\n');
    lines.splice(0, lines.length, utf8Prefix(compact, maximumBytes));
  } else if (included < omitted.length) {
    const remainder = `- Additional omitted sections: ${omitted.length - included} (see structured audit)`;
    if (bytes([...lines, remainder].join('\n')) <= maximumBytes) lines.push(remainder);
  }
  const canonicalText = utf8Prefix(lines.join('\n'), maximumBytes);
  return {
    id: 'token-budget-omissions', canonicalText, mandatory: true,
    priority: Number.NEGATIVE_INFINITY, index: Number.MAX_SAFE_INTEGER,
    bytes: bytes(canonicalText), sha256: sha256(canonicalText), expandHandles: []
  };
}

function normalizeSections(inputSections) {
  if (!Array.isArray(inputSections)) {
    throw new SingularityFlowError('Prompt sections must be an array.', { code: 'TKN_SECTION_INVALID' });
  }
  const seen = new Set();
  return inputSections.map((section, index) => {
    const id = String(section?.id ?? '');
    if (!SECTION_ID.test(id)) {
      throw new SingularityFlowError(`Prompt section ID '${id}' must match ${SECTION_ID}.`, {
        code: 'TKN_SECTION_ID_INVALID', details: { id, index }
      });
    }
    if (RESERVED_SECTION_IDS.has(id)) {
      throw new SingularityFlowError(`Prompt section ID '${id}' is reserved by the kernel.`, {
        code: 'TKN_SECTION_ID_RESERVED', details: { id, index }
      });
    }
    if (seen.has(id)) {
      throw new SingularityFlowError(`Prompt section ID '${id}' is duplicated.`, {
        code: 'TKN_SECTION_ID_DUPLICATE', details: { id, index }
      });
    }
    seen.add(id);
    const canonicalText = normalizePromptSection(section?.text);
    return {
      id, canonicalText,
      mandatory: section?.mandatory === true,
      priority: Number.isFinite(section?.priority) ? section.priority : 100,
      expandHandles: expansionHandles(section ?? {}),
      index,
      bytes: bytes(canonicalText),
      sha256: sha256(canonicalText)
    };
  }).filter((section) => section.canonicalText);
}

function admissionFor(text, profile, options = {}) {
  const supplied = options.tokenAdmission ?? {};
  const exactCounter = options.tokenCounter;
  const exact = typeof exactCounter === 'function'
    ? { value: exactCounter(text), assurance: 'tokenizer-exact' }
    : supplied.logicalPromptTokens ?? null;
  return assessTokenAdmission({
    ...supplied,
    logicalPromptBytes: bytes(text),
    logicalPromptTokens: exact,
    maximumInputTokens: supplied.maximumInputTokens ?? profile.maximumEstimatedPromptTokens
  });
}

function fits(text, profile, mode, options) {
  const admission = admissionFor(text, profile, options);
  if (mode === 'enforce') return {
    fits: admission.safeToEnforce && admission.admitted === true,
    admission
  };
  return { fits: bytes(text) <= profile.maximumEstimatedPromptTokens * 4, admission };
}

function overflowError(profile, mandatory, text, admission, unsafe = false) {
  if (unsafe) {
    return new SingularityFlowError(
      `Token-economy profile '${profile.id}' cannot enforce this request because tokenizer/provider admission assurance is incomplete.`,
      {
        code: 'TKN_ADMISSION_ASSURANCE_INSUFFICIENT',
        details: {
          admission,
          unsafeReason: 'Estimated prompt bytes cannot prove a provider context-window boundary.',
          nextAction: 'Configure tokenizer-exact, provider-reported, host-observed, or policy-approved conservative admission evidence; otherwise use observe or assist.'
        }
      }
    );
  }
  return new SingularityFlowError(
    `Mandatory governed prompt context does not fit token-economy profile '${profile.id}'.`,
    {
      code: 'TKN_MANDATORY_CONTEXT_OVERFLOW',
      details: {
        requiredBytes: bytes(text),
        configuredEstimatedPromptLimitBytes: profile.maximumEstimatedPromptTokens * 4,
        admission,
        bySection: Object.fromEntries(mandatory.map((section) => [section.id, section.bytes])),
        unsafeReason: 'Applicable governance context and the omission capsule cannot be truncated or budget-evicted.',
        nextAction: 'Select an approved larger profile, narrow the operation, or split the work.'
      }
    }
  );
}

/**
 * Compile named prompt sections under the pinned token-economy policy.
 *
 * Observe changes no bytes. Assist evicts only optional sections under an explicitly estimated
 * prompt-text budget. Enforce requires tokenizer/provider-safe admission and never mistakes the
 * bytes/4 estimate for a provider context-window proof.
 */
export function compilePromptSections(inputSections, policyValue = {}, options = {}) {
  const policy = normalizeTokenEconomy(policyValue);
  const profile = selectedTokenEconomyProfile(policy);
  const maximumBytes = profile.maximumEstimatedPromptTokens * 4;
  const capsuleMaximumBytes = Math.max(256, profile.observationCapsuleTokens * 4);
  const sections = normalizeSections(inputSections);
  const original = render(sections);
  const originalBytes = bytes(original);
  const originalTokens = tokens(original);
  const originalAdmission = admissionFor(original, profile, options);

  if (policy.mode === 'enforce' && !originalAdmission.safeToEnforce) {
    throw overflowError(profile, sections.filter((section) => section.mandatory), original, originalAdmission, true);
  }

  const report = (selected, omitted, text, warnings = [], compliance = 'compliant') => {
    const admission = admissionFor(text, profile, options);
    const omittedIds = new Set(omitted.map((entry) => entry.id));
    const selectedIds = new Set(selected.map((entry) => entry.id));
    const budgetEvictedPromptBytes = omitted.reduce((total, entry) => total + entry.bytes, 0);
    return {
      text,
      policy: {
        mode: policy.mode, profile: profile.id, maximumBytes,
        maximumEstimatedPromptTokens: profile.maximumEstimatedPromptTokens,
        policyOnBudgetBreach: profile.policyOnBudgetBreach,
        assurance: policy.mode === 'enforce' ? 'admission-backed' : 'estimated-prompt-text'
      },
      admission,
      compliance,
      originalBytes,
      originalEstimatedTokens: originalTokens,
      finalBytes: bytes(text),
      finalEstimatedTokens: tokens(text),
      overflow: policy.mode === 'enforce'
        ? originalAdmission.admitted === false
        : originalBytes > maximumBytes,
      warnings,
      economics: {
        prompt: {
          candidatePromptBytes: originalBytes,
          deduplicatedPromptBytes: 0,
          budgetEvictedPromptBytes,
          finalPromptBytes: bytes(text)
        },
        provider: {
          inputTokens: null, cachedInputTokens: null, uncachedInputTokens: null,
          assurance: 'unavailable'
        },
        system: { totalSystemTokens: null, assurance: 'unavailable' }
      },
      sections: sections.map((section) => ({
        id: section.id, mandatory: section.mandatory, priority: section.priority,
        bytes: section.bytes, estimatedTokens: Math.ceil(section.bytes / 4), sha256: section.sha256,
        included: selectedIds.has(section.id),
        omissionReason: omittedIds.has(section.id) ? 'budget' : null,
        expandHandles: section.expandHandles,
        expandability: section.expandHandles.length ? 'available' : 'unavailable'
      })),
      omitted: omitted.map((section) => ({
        id: section.id, bytes: section.bytes, sha256: section.sha256,
        expandHandles: section.expandHandles,
        expandability: section.expandHandles.length ? 'available' : 'unavailable',
        reason: 'budget'
      }))
    };
  };

  const originalFits = policy.mode === 'enforce'
    ? originalAdmission.admitted === true
    : originalBytes <= maximumBytes;
  if (!['assist', 'enforce'].includes(policy.mode) || originalFits) {
    const warnings = policy.mode === 'observe' && !originalFits
      ? [`Composed prompt is ${originalBytes} bytes (${originalTokens} estimated tokens), above profile ${profile.id}'s estimated ${maximumBytes}-byte prompt-text limit.`]
      : [];
    return report(sections, [], original, warnings);
  }

  const mandatory = sections.filter((section) => section.mandatory);
  const optional = sections.filter((section) => !section.mandatory);
  const selected = [...sections];
  const omitted = [];
  const removable = [...optional]
    .sort((left, right) => right.priority - left.priority || right.index - left.index);
  const renderedSelection = () => {
    const capsule = omissionCapsule(omitted, capsuleMaximumBytes);
    return render([...selected, ...(capsule ? [capsule] : [])].sort((left, right) => left.index - right.index));
  };
  let text = renderedSelection();
  let admission = admissionFor(text, profile, options);
  while (!fits(text, profile, policy.mode, options).fits && removable.length) {
    const removed = removable.shift();
    selected.splice(selected.findIndex((section) => section.id === removed.id), 1);
    omitted.push(removed);
    text = renderedSelection();
    admission = admissionFor(text, profile, options);
  }
  if (!fits(text, profile, policy.mode, options).fits) {
    if (profile.policyOnBudgetBreach === 'refuse') {
      throw overflowError(profile, mandatory, text, admission);
    }
    return report(selected, omitted, text, [
      `Mandatory prompt context remains above the ${policy.mode === 'enforce' ? 'admission' : 'estimated prompt-text'} limit. Policy '${profile.policyOnBudgetBreach}' preserved it and marked the request partial and non-compliant.`
    ], 'partial-non-compliant');
  }
  return report(selected, omitted, text, [
    `Token budget omitted ${omitted.length} optional section${omitted.length === 1 ? '' : 's'}; the non-evictable omission capsule is model-visible and exact section identities are recorded.`
  ]);
}
