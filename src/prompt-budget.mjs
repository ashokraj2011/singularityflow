import { createHash } from 'node:crypto';

import { normalizeTokenEconomy, selectedTokenEconomyProfile } from './token-economy.mjs';
import { SingularityFlowError } from './util.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function bytes(value) { return Buffer.byteLength(String(value ?? ''), 'utf8'); }
function tokens(value) { return Math.ceil(bytes(value) / 4); }

function render(sections) {
  const body = sections.map((section) => section.text.trim()).filter(Boolean).join('\n\n');
  return body ? `${body}\n` : '';
}

function omissionText(omitted) {
  if (!omitted.length) return '';
  return [
    '# Context omitted by the approved token budget',
    '',
    'The following optional sections were not sent. Their hashes preserve an auditable expansion target.',
    '',
    ...omitted.map((section) => `- ${section.id}: ${section.bytes} bytes · SHA-256 \`${section.sha256}\`${section.expandHandle ? ` · expand \`${section.expandHandle}\`` : ''}`)
  ].join('\n');
}

/**
 * Compile named prompt sections under the pinned token-economy policy.
 *
 * Mandatory governance is never silently truncated. Optional sections are evicted by declared
 * priority (larger numbers first), while the final rendering keeps the original section order.
 */
export function compilePromptSections(inputSections, policyValue = {}) {
  const policy = normalizeTokenEconomy(policyValue);
  const profile = selectedTokenEconomyProfile(policy);
  const maximumBytes = profile.maxInputTokens * 4;
  const sections = inputSections
    .map((section, index) => ({
      id: String(section.id), text: String(section.text ?? ''),
      mandatory: section.mandatory === true,
      priority: Number.isFinite(section.priority) ? section.priority : 100,
      expandHandle: section.expandHandle ?? null,
      index
    }))
    .filter((section) => section.text.trim())
    .map((section) => ({ ...section, bytes: bytes(section.text), sha256: sha256(section.text) }));
  const original = render(sections);
  const originalBytes = bytes(original);
  const originalTokens = tokens(original);
  const report = (selected, omitted, text, warnings = []) => ({
    text,
    policy: { mode: policy.mode, profile: profile.id, maximumBytes, maximumInputTokens: profile.maxInputTokens },
    originalBytes,
    originalEstimatedTokens: originalTokens,
    finalBytes: bytes(text),
    finalEstimatedTokens: tokens(text),
    overflow: originalBytes > maximumBytes,
    warnings,
    sections: sections.map((section) => ({
      id: section.id, mandatory: section.mandatory, priority: section.priority,
      bytes: section.bytes, estimatedTokens: Math.ceil(section.bytes / 4), sha256: section.sha256,
      included: selected.some((entry) => entry.id === section.id),
      omissionReason: omitted.some((entry) => entry.id === section.id) ? 'budget' : null,
      expandHandle: section.expandHandle
    })),
    omitted: omitted.map((section) => ({
      id: section.id, bytes: section.bytes, sha256: section.sha256,
      expandHandle: section.expandHandle, reason: 'budget'
    }))
  });

  if (!['assist', 'enforce'].includes(policy.mode) || originalBytes <= maximumBytes) {
    const warnings = policy.mode === 'observe' && originalBytes > maximumBytes
      ? [`Composed prompt is ${originalBytes} bytes (${originalTokens} estimated tokens), above profile ${profile.id}'s ${maximumBytes}-byte limit.`]
      : [];
    return report(sections, [], original, warnings);
  }

  const mandatory = sections.filter((section) => section.mandatory);
  const mandatoryBytes = bytes(render(mandatory));
  if (mandatoryBytes > maximumBytes) {
    if (policy.mode !== 'enforce') {
      const omitted = sections.filter((section) => !section.mandatory);
      const text = render(mandatory);
      return report(mandatory, omitted, text, [
        `Mandatory prompt content alone requires ${mandatoryBytes} bytes, above profile ${profile.id}'s ${maximumBytes}-byte limit; assist mode removed every optional section and preserved governance.`
      ]);
    }
    throw new SingularityFlowError(
      `Mandatory governed prompt context requires ${mandatoryBytes} bytes but token-economy profile '${profile.id}' permits ${maximumBytes} bytes.`,
      {
        code: 'TKN_MANDATORY_CONTEXT_OVERFLOW',
        details: {
          requiredBytes: mandatoryBytes, configuredLimitBytes: maximumBytes,
          bySection: Object.fromEntries(mandatory.map((section) => [section.id, section.bytes])),
          unsafeReason: 'Applicable governance context cannot be truncated or budget-evicted.',
          nextAction: 'Select an approved larger profile, narrow the operation, or split the work.'
        }
      }
    );
  }

  const selected = [...sections];
  const omitted = [];
  const removable = sections.filter((section) => !section.mandatory)
    .sort((left, right) => right.priority - left.priority || right.index - left.index);
  let text = render(selected);
  while (bytes(text) > maximumBytes && removable.length) {
    const removed = removable.shift();
    selected.splice(selected.findIndex((section) => section.id === removed.id), 1);
    omitted.push(removed);
    const omission = omissionText(omitted);
    text = render([
      ...selected,
      ...(omission ? [{ id: 'token-budget-omissions', text: omission, index: Number.MAX_SAFE_INTEGER }] : [])
    ].sort((left, right) => left.index - right.index));
  }
  if (bytes(text) > maximumBytes) {
    // The omission receipt itself cannot make mandatory content fail. Retain section hashes in the
    // structured audit record and keep the transport exactly within the approved budget.
    text = render(selected);
  }
  return report(selected, omitted, text, [
    `Token budget omitted ${omitted.length} optional section${omitted.length === 1 ? '' : 's'}; exact hashes are recorded in the prompt audit.`
  ]);
}
