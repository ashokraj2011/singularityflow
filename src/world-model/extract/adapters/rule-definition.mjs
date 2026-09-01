import path from 'node:path';

import {
  adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256, result,
  unavailableDraft
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

function ruleName(item, fallback = null) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    for (const field of ['id', 'name', 'key', 'ruleId']) {
      if (typeof item[field] === 'string' && SAFE_RULE_ID.test(item[field])) return item[field];
    }
  }
  return fallback && SAFE_RULE_ID.test(fallback) ? fallback : null;
}

/** Find only explicitly named objects below registered rule/policy/predicate containers. */
export function scanRuleObjects(root) {
  const found = [];
  const visit = (value, segments = [], depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 10 || found.length >= 1_000) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...segments, String(index)], depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const next = [...segments, key];
      if (RULE_CONTAINERS.has(key.toLowerCase()) && child && typeof child === 'object') {
        const entries = Array.isArray(child) ? child.map((item, index) => [String(index), item]) : Object.entries(child);
        for (const [entryKey, entry] of entries) {
          const name = ruleName(entry, Array.isArray(child) ? null : entryKey);
          if (!name) continue;
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
  return found.filter((item, index, values) => values.findIndex((candidate) => (
    candidate.name === item.name && candidate.container === item.container
  )) === index).sort((left, right) => (
    `${left.container}.${left.name}`.localeCompare(`${right.container}.${right.name}`)
  ));
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
    for (const item of scanRuleObjects(parsed.root)) {
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
  }
  return result(RULE_DEFINITION_ID, observations, facts);
}
