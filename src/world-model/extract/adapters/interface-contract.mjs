import path from 'node:path';

import {
  SOURCE_LIKE, adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256,
  languageForPath, observeAdapterPathOutcome, result, unavailableDraft
} from './common.mjs';
import {
  scanInterfaceContracts, scanProtocolFieldsWithLimitations
} from './closed-structure.mjs';
import { configurationFormat, parseConfigurationObject } from './configuration-object.mjs';

export const INTERFACE_CONTRACT_ID = 'interface-contract';
export const INTERFACE_CONTRACT_VERSION = '1.1.0';
export const INTERFACE_CONTRACT_IMPLEMENTATION_SHA256 = implementationSha256(
  INTERFACE_CONTRACT_ID,
  INTERFACE_CONTRACT_VERSION,
  'closed-explicit-interface-implementation-protocol-field-and-schema-syntax-v2'
);

const MAXIMUM_SCHEMA_PROTOCOL_FIELDS = 256;

export function scanSchemaContract(root, { explicitSchemaPath = false } = {}) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const recognized = explicitSchemaPath
    || Object.hasOwn(root, '$schema') || Object.hasOwn(root, 'openapi') || Object.hasOwn(root, 'asyncapi');
  if (!recognized) return null;
  const propertyNames = root.properties && typeof root.properties === 'object' && !Array.isArray(root.properties)
    ? Object.keys(root.properties)
    : [];
  const admitted = propertyNames
    .filter((key) => /^[A-Za-z0-9][A-Za-z0-9_.@$-]{0,99}$/.test(key))
    .sort();
  return {
    properties: admitted.slice(0, MAXIMUM_SCHEMA_PROTOCOL_FIELDS),
    propertyCount: propertyNames.length,
    rejectedPropertyCount: propertyNames.length - admitted.length,
    limitedPropertyCount: Math.max(0, admitted.length - MAXIMUM_SCHEMA_PROTOCOL_FIELDS)
  };
}

export function extractInterfaceContracts(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context).filter((entry) => (
    SOURCE_LIKE.has(path.posix.extname(entry.path).toLowerCase())
  ))) {
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      facts.push(unavailableDraft({
        factType: 'interface',
        subject: { kind: 'file', id: file.path },
        attemptedProducer: INTERFACE_CONTRACT_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    for (const item of scanInterfaceContracts(source, languageForPath(file.path))) {
      if (item.kind === 'interface') {
        const subject = { kind: 'symbol', id: `${file.path}#${item.name}` };
        const evidence = evidenceDescriptor(file, {
          kind: 'signature',
          locator: {
            symbol: item.name,
            range: { startLine: item.line, endLine: item.line }
          },
          subject
        });
        observations.push(evidence);
        facts.push(factDraft({
          factType: 'interface',
          subject,
          claim: `${item.name} is explicitly declared as an interface contract in ${file.path} at line ${item.line}.`,
          assurance: 'structurally-derived',
          evidence: [evidence]
        }));
        continue;
      }
      const subject = {
        kind: 'symbol', id: `${file.path}#${item.implementation}->${item.interface}`
      };
      const evidence = evidenceDescriptor(file, {
        kind: 'interface-implementation',
        locator: {
          symbol: item.implementation,
          target: item.interface,
          range: { startLine: item.line, endLine: item.line }
        },
        subject
      });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'implementation',
        subject,
        claim: `${item.implementation} explicitly implements ${item.interface} in ${file.path} at line ${item.line}.`,
        assurance: 'structurally-derived',
        evidence: [evidence]
      }));
      facts.push(factDraft({
        factType: 'consumer-dependency',
        subject,
        claim: `${item.implementation} is an explicit consumer of interface ${item.interface} in ${file.path}.`,
        assurance: 'structurally-derived',
        evidence: [evidence]
      }));
    }
    const protocolScan = scanProtocolFieldsWithLimitations(source, languageForPath(file.path));
    for (const item of protocolScan.items) {
      const subject = { kind: 'symbol', id: `${file.path}#${item.interface}.${item.name}` };
      const evidence = evidenceDescriptor(file, {
        kind: 'signature',
        locator: {
          symbol: `${item.interface}.${item.name}`,
          range: { startLine: item.line, endLine: item.line }
        },
        subject
      });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'protocol-field',
        subject,
        claim: `${item.interface} declares protocol field ${item.signature} in ${file.path} at line ${item.line}.`,
        assurance: 'structurally-derived',
        evidence: [evidence]
      }));
    }
    if (protocolScan.limitations.length) {
      observeAdapterPathOutcome(context, file, {
        status: 'partial', reasonCode: protocolScan.limitations[0].code
      });
      const subject = { kind: 'file', id: file.path };
      const limitation = protocolScan.limitations[0];
      const evidence = evidenceDescriptor(file, {
        kind: 'signature',
        locator: { range: { startLine: limitation.line, endLine: limitation.line } },
        subject
      });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'protocol-field', subject,
        attemptedProducer: INTERFACE_CONTRACT_ID,
        code: limitation.code,
        detail: `At least one recognized protocol field in ${file.path} exceeds the closed signature limit.`,
        evidence: [evidence]
      }));
    }
  }
  const schemaFiles = adapterFiles(context).filter((entry) => {
    if (!configurationFormat(entry.path)) return false;
    const basename = path.posix.basename(entry.path).toLowerCase();
    return /(?:^|\.)(?:schema|openapi|asyncapi)(?:\.|$)/.test(basename);
  });
  for (const file of schemaFiles) {
    const subject = { kind: 'contract', id: `${file.path}#schema` };
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      facts.push(unavailableDraft({
        factType: 'schema-contract', subject,
        attemptedProducer: INTERFACE_CONTRACT_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned schema source ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    let schema;
    try {
      const parsed = parseConfigurationObject(source, file.path);
      schema = scanSchemaContract(parsed?.root, { explicitSchemaPath: true });
    } catch (error) {
      const evidence = evidenceDescriptor(file, { kind: 'configuration-object', subject });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'schema-contract', subject,
        attemptedProducer: INTERFACE_CONTRACT_ID,
        code: 'PARSE_FAILURE',
        detail: `The selected schema ${file.path} was refused: ${error.message}`,
        evidence: [evidence]
      }));
      continue;
    }
    if (!schema) {
      const evidence = evidenceDescriptor(file, { kind: 'configuration-object', subject });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'schema-contract', subject,
        attemptedProducer: INTERFACE_CONTRACT_ID,
        code: 'UNSUPPORTED_LANGUAGE',
        detail: `The registered interface extractor cannot derive a structured schema from ${file.path}.`,
        evidence: [evidence]
      }));
      continue;
    }
    const evidence = evidenceDescriptor(file, { kind: 'configuration-object', subject });
    observations.push(evidence);
    facts.push(factDraft({
      factType: 'schema-contract',
      subject,
      claim: `${file.path} declares a schema contract with ${schema.propertyCount} root property entry or entries; ${schema.properties.length} bounded safe protocol field(s) were emitted.`,
      assurance: 'deterministically-derived',
      evidence: [evidence]
    }));
    for (const field of schema.properties) {
      const fieldSubject = { kind: 'contract', id: `${file.path}#schema.${field}` };
      const fieldEvidence = evidenceDescriptor(file, {
        kind: 'configuration-object', locator: { target: field }, subject: fieldSubject
      });
      observations.push(fieldEvidence);
      facts.push(factDraft({
        factType: 'protocol-field',
        subject: fieldSubject,
        claim: `${file.path} explicitly declares schema field ${field}.`,
        assurance: 'deterministically-derived',
        evidence: [fieldEvidence]
      }));
    }
    const omissions = [
      {
        count: schema.limitedPropertyCount,
        code: 'EXTRACTION_LIMIT_REACHED',
        detail: `${schema.limitedPropertyCount} admitted schema field(s) were omitted after the ${MAXIMUM_SCHEMA_PROTOCOL_FIELDS}-field bound was reached.`
      },
      {
        count: schema.rejectedPropertyCount,
        code: 'EXTRACTION_VALUE_NOT_ADMITTED',
        detail: `${schema.rejectedPropertyCount} schema field name(s) were outside the closed safe-name grammar.`
      }
    ];
    for (const omission of omissions.filter((entry) => entry.count > 0)) {
      observeAdapterPathOutcome(context, file, {
        status: 'partial', reasonCode: omission.code
      });
      facts.push(unavailableDraft({
        factType: 'protocol-field', subject,
        attemptedProducer: INTERFACE_CONTRACT_ID,
        code: omission.code,
        detail: omission.detail,
        evidence: [evidence]
      }));
    }
  }
  return result(INTERFACE_CONTRACT_ID, observations, facts);
}
