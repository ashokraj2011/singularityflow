import path from 'node:path';

import {
  adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256, result,
  observeAdapterPathOutcome, unavailableDraft
} from './common.mjs';
import { configurationFormat, parseConfigurationObject } from './configuration-object.mjs';

export const RULE_DEFINITION_ID = 'rule-definition';
export const RULE_DEFINITION_VERSION = '1.0.0';
export const RULE_DEFINITION_IMPLEMENTATION_SHA256 = implementationSha256(
  RULE_DEFINITION_ID,
  RULE_DEFINITION_VERSION,
  'explicit-named-rule-policy-predicate-objects-with-condition-field-presence-v1'
);

const RULE_CONTAINERS = new Set(['policies', 'predicates', 'rules']);
const CONDITION_FIELDS = new Set(['condition', 'expression', 'if', 'predicate', 'when']);
const SAFE_RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const MAXIMUM_RULE_OBJECTS = 1_000;
const MAXIMUM_RULE_TRAVERSAL_DEPTH = 10;

function ruleName(item, fallback = null) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    for (const field of ['id', 'name', 'key', 'ruleId']) {
      if (typeof item[field] === 'string' && SAFE_RULE_ID.test(item[field])) return item[field];
    }
  }
  return fallback && SAFE_RULE_ID.test(fallback) ? fallback : null;
}

/** Find only explicitly named objects below registered rule/policy/predicate containers. */
export function scanRuleObjectsWithLimitations(root) {
  const found = [];
  let truncated = false;
  let rejectedIdentifiers = 0;
  const visit = (value, segments = [], depth = 0) => {
    if (!value || typeof value !== 'object') return;
    if (depth > MAXIMUM_RULE_TRAVERSAL_DEPTH || found.length >= MAXIMUM_RULE_OBJECTS) {
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (found.length >= MAXIMUM_RULE_OBJECTS) { truncated = true; break; }
        visit(value[index], [...segments, String(index)], depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (found.length >= MAXIMUM_RULE_OBJECTS) { truncated = true; break; }
      const next = [...segments, key];
      if (RULE_CONTAINERS.has(key.toLowerCase()) && child && typeof child === 'object') {
        const entries = Array.isArray(child) ? child.entries() : Object.entries(child);
        for (const [entryKey, entry] of entries) {
          if (found.length >= MAXIMUM_RULE_OBJECTS) { truncated = true; break; }
          const name = ruleName(entry, Array.isArray(child) ? null : entryKey);
          if (!name) { rejectedIdentifiers += 1; continue; }
          const conditionFields = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? Object.keys(entry).filter((field) => CONDITION_FIELDS.has(field.toLowerCase())).sort()
            : [];
          found.push({
            name,
            container: next.join('.'),
            conditionFields
          });
        }
      }
      visit(child, next, depth + 1);
    }
  };
  visit(root);
  const rules = found.filter((item, index, values) => values.findIndex((candidate) => (
    candidate.name === item.name && candidate.container === item.container
  )) === index).sort((left, right) => (
    `${left.container}.${left.name}`.localeCompare(`${right.container}.${right.name}`)
  ));
  return { rules, truncated, rejectedIdentifiers };
}

/** Safe explicitly named rules only. Use the detailed form when completeness is recorded. */
export function scanRuleObjects(root) {
  return scanRuleObjectsWithLimitations(root).rules;
}

export function extractRuleDefinitions(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context).filter((entry) => configurationFormat(entry.path))) {
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      if (/(?:rule|policy)/i.test(path.posix.basename(file.path))) {
        facts.push(unavailableDraft({
          factType: 'rule-definition',
          subject: { kind: 'file', id: file.path },
          attemptedProducer: RULE_DEFINITION_ID,
          code: 'INVALID_UTF8',
          detail: `The pinned rule configuration ${file.path} is not valid UTF-8.`
        }));
      }
      continue;
    }
    let parsed;
    try {
      parsed = parseConfigurationObject(source, file.path);
    } catch (error) {
      observeAdapterPathOutcome(context, file, {
        status: 'failed', reasonCode: 'PARSE_FAILURE'
      });
      if (/(?:rule|policy)/i.test(path.posix.basename(file.path))) {
        const subject = { kind: 'file', id: file.path };
        const evidence = evidenceDescriptor(file, { kind: 'file', subject });
        observations.push(evidence);
        facts.push(unavailableDraft({
          factType: 'rule-definition', subject,
          attemptedProducer: RULE_DEFINITION_ID,
          code: 'PARSE_FAILURE',
          detail: `The selected rule configuration ${file.path} was refused: ${error.message}`,
          evidence: [evidence]
        }));
      }
      continue;
    }
    if (!parsed?.root) {
      observeAdapterPathOutcome(context, file, {
        status: 'unsupported', reasonCode: 'UNSUPPORTED_LANGUAGE'
      });
      if (/(?:rule|policy)/i.test(path.posix.basename(file.path))) {
        const subject = { kind: 'file', id: file.path };
        const evidence = evidenceDescriptor(file, { kind: 'file', subject });
        observations.push(evidence);
        facts.push(unavailableDraft({
          factType: 'rule-definition', subject,
          attemptedProducer: RULE_DEFINITION_ID,
          code: 'UNSUPPORTED_LANGUAGE',
          detail: `The registered rule-definition extractor does not support ${parsed?.format ?? 'unknown'} rule objects.`,
          evidence: [evidence]
        }));
      }
      continue;
    }
    const scanned = scanRuleObjectsWithLimitations(parsed.root);
    for (const item of scanned.rules) {
      const subject = { kind: 'rule', id: `${file.path}#${item.container}.${item.name}` };
      const locator = { target: `${item.container}.${item.name}` };
      const ruleEvidence = evidenceDescriptor(file, { kind: 'rule-object', locator, subject });
      observations.push(ruleEvidence);
      facts.push(factDraft({
        factType: 'rule-definition',
        subject,
        claim: `Rule '${item.name}' is explicitly registered under ${item.container} in ${file.path}.`,
        assurance: 'deterministically-derived',
        evidence: [ruleEvidence]
      }));
      for (const field of item.conditionFields) {
        const conditionEvidence = evidenceDescriptor(file, {
          kind: 'condition-expression',
          locator: { target: `${item.container}.${item.name}.${field}` },
          subject
        });
        observations.push(conditionEvidence);
        facts.push(factDraft({
          factType: 'condition-expression',
          subject,
          claim: `Rule '${item.name}' declares the condition field '${field}' in ${file.path}.`,
          assurance: 'deterministically-derived',
          evidence: [conditionEvidence]
        }));
      }
    }
    if (scanned.truncated) {
      observeAdapterPathOutcome(context, file, {
        status: 'partial', reasonCode: 'EXTRACTION_LIMIT_REACHED'
      });
      const subject = { kind: 'file', id: file.path };
      const evidence = evidenceDescriptor(file, { kind: 'file', subject });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'rule-definition', subject,
        attemptedProducer: RULE_DEFINITION_ID,
        code: 'EXTRACTION_LIMIT_REACHED',
        detail: `The bounded rule scan for ${file.path} reached its item or traversal-depth limit.`,
        evidence: [evidence]
      }));
    }
    if (scanned.rejectedIdentifiers) {
      observeAdapterPathOutcome(context, file, {
        status: 'partial', reasonCode: 'EXTRACTION_VALUE_NOT_ADMITTED'
      });
      const subject = { kind: 'file', id: file.path };
      const evidence = evidenceDescriptor(file, { kind: 'file', subject });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'rule-definition', subject,
        attemptedProducer: RULE_DEFINITION_ID,
        code: 'EXTRACTION_VALUE_NOT_ADMITTED',
        detail: `${scanned.rejectedIdentifiers} rule container entry or entries in ${file.path} lacked an admitted stable identifier.`,
        evidence: [evidence]
      }));
    }
  }
  return result(RULE_DEFINITION_ID, observations, facts);
}
