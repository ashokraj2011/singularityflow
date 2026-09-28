/**
 * XPL2 explanation model builder.
 *
 * One builder produces every XPL2 subject view. It admits source descriptors and read
 * observations, renders typed statements through the closed template catalog, records typed
 * relationships between typed nodes, and computes two semantic identities:
 *
 * - `explanationSetSha256` covers the complete statement/node/relationship set, its admitted
 *   sources and observations, and the interpretation contracts for one bounded source universe;
 * - `explanationSha256` covers the selected subject and returned selection over that set.
 *
 * Rendered text, audience order, folding and walkthrough order are presentation; they never enter
 * either identity [XPL2-LAW-005, XPL2-LAW-006]. The builder refuses a citation that does not
 * resolve and a relationship whose endpoints are not nodes [XPL2-LAW-001]. It performs no I/O.
 */
import { recordSha256 } from '../../records.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { xpl2Reason } from './reasons.mjs';
import { renderTemplate, templateKind, XPL2_TEMPLATE_CATALOG_VERSION } from './templates.mjs';
import { XPL2_RELATIONSHIPS } from './vocabulary.mjs';

export const XPL2_CONTRACT = Object.freeze({
  model: 'xpl2-explanation@1',
  templates: XPL2_TEMPLATE_CATALOG_VERSION,
  reasons: 'xpl2-reasons@1',
  relationships: 'xpl2-relationships@1',
  accessView: 'local-repository-reader@1'
});

export { XPL2_AUDIENCES, XPL2_RELATIONSHIPS, XPL2_SUBJECTS } from './vocabulary.mjs';

const NODE_KINDS = new Set(['clause', 'file', 'unit', 'test', 'run', 'decision', 'invocation', 'diagnostic']);
const INTEGRITY = new Set(['verified', 'self-hashed', 'unverified', 'failed', 'unavailable']);
const ORIGIN = new Set(['observed-local', 'recorded-local', 'unauthenticated', 'unavailable']);
const APPLICABILITY = new Set(['current', 'stale', 'unknown', 'not-applicable']);
const AVAILABILITY = new Set(['present', 'disabled', 'not-recorded', 'expired', 'inaccessible', 'unavailable']);
// Severity order for review: owner-reported failures, then missing reasons, then prompts worth
// inspecting, then visibility limits of this reader.
const ATTENTION = Object.freeze(['blocker', 'missing-explanation', 'advisory', 'visibility']);
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._@/+-]{0,199}$/u;

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

export function xpl2Sha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function assert(condition, message) {
  if (!condition) throw new SingularityFlowError(message, { code: 'XPL2_MODEL_INVALID' });
}

function enumValue(set, value, label) {
  assert(set.has(value), `XPL2 ${label} '${String(value)}' is not registered.`);
  return value;
}

function padded(prefix, index) {
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

/** Create one builder for one bounded source universe. */
export function createXpl2Builder() {
  const sources = new Map();
  const observations = new Map();
  // Subject-scoped inputs belong to one query (a line lookup, a gap register read); they are
  // citable but hashed only into that subject view, never into the shared universe identity.
  const subjectScoped = new Set();
  const statements = [];
  const nodes = new Map();
  const relationships = [];
  const relationshipKeys = new Set();
  const attention = [];
  const derived = [];

  const builder = {
    /** Admit one source with separately stated properties; integrity never abbreviates the rest. */
    source({
      id, owner, family, version = 1, recordId = null, digest = null,
      integrity, origin, applicability, availability, coverage = null, label = null, subject = false
    }) {
      assert(ID.test(String(id)) && !sources.has(id) && !observations.has(id), `XPL2 source id '${id}' is invalid or duplicated.`);
      if (subject) subjectScoped.add(id);
      assert(digest == null || SHA256.test(String(digest)), `XPL2 source ${id} digest is not exact.`);
      // An unavailable source has no invented record hash.
      assert(!(digest && ['not-recorded', 'unavailable', 'inaccessible', 'disabled'].includes(availability)),
        `XPL2 source ${id} cannot carry a digest while ${availability}.`);
      sources.set(id, freezeDeep({
        id,
        label: label == null ? null : String(label),
        owner: String(owner),
        family: String(family),
        version,
        recordId: recordId == null ? null : String(recordId),
        digest: digest ?? null,
        properties: {
          integrity: enumValue(INTEGRITY, integrity, 'source integrity'),
          origin: enumValue(ORIGIN, origin, 'source origin'),
          applicability: enumValue(APPLICABILITY, applicability, 'source applicability'),
          availability: enumValue(AVAILABILITY, availability, 'source availability')
        },
        coverage: coverage == null ? null : { ...coverage }
      }));
      return id;
    },

    /**
     * Record a transient read observation: what scope an admitted adapter searched and why it
     * found no record. Missing-source statements cite this, never a fabricated record.
     */
    observation({ id, adapter, scope, completeness = 'complete-for-scope', reason, evidenceCut = null, subject = false }) {
      assert(ID.test(String(id)) && !observations.has(id) && !sources.has(id), `XPL2 observation id '${id}' is invalid or duplicated.`);
      if (subject) subjectScoped.add(id);
      const core = {
        id,
        kind: 'read-observation',
        adapter: String(adapter),
        scope: String(scope),
        completeness: String(completeness),
        reason: xpl2Reason(reason),
        evidenceCut: evidenceCut ?? null
      };
      observations.set(id, freezeDeep({ ...core, observationSha256: xpl2Sha256(core) }));
      return id;
    },

    statement({ about, template, arguments: raw = {}, cites, limitations = [] }) {
      assert(Array.isArray(cites) && cites.length > 0, `XPL2 statement about ${about} must cite a source or observation.`);
      const rendered = renderTemplate(template, raw);
      const id = padded('S', statements.length + 1);
      statements.push({
        id,
        kind: templateKind(template),
        about: String(about),
        template,
        arguments: rendered.arguments,
        cites: [...new Set(cites)].sort(),
        limitations: [...new Set(limitations.map(xpl2Reason))].sort(),
        authority: 'none',
        text: rendered.text
      });
      return id;
    },

    /**
     * A query-derived statement (for example "after-side line 41 is inside H-004"). It follows the
     * same template and citation rules but belongs to one subject's selection, so it is hashed into
     * `explanationSha256` and never into the shared universe identity.
     */
    derivedStatement({ about, template, arguments: raw = {}, cites, limitations = [] }) {
      assert(Array.isArray(cites) && cites.length > 0, `XPL2 derived statement about ${about} must cite a source or observation.`);
      const rendered = renderTemplate(template, raw);
      const id = padded('D', derived.length + 1);
      derived.push({
        id,
        kind: templateKind(template),
        about: String(about),
        template,
        arguments: rendered.arguments,
        cites: [...new Set(cites)].sort(),
        limitations: [...new Set(limitations.map(xpl2Reason))].sort(),
        authority: 'none',
        text: rendered.text
      });
      return id;
    },

    node({ id, kind, label, status = null, detail = null, cites = [] }) {
      assert(ID.test(String(id)), `XPL2 node id '${id}' is invalid.`);
      enumValue(NODE_KINDS, kind, 'node kind');
      if (nodes.has(id)) return id;
      nodes.set(id, { id, kind, label: String(label), status, detail, cites: [...new Set(cites)].sort() });
      return id;
    },

    relationship({ type, from, to, scope, qualifier = null, cites }) {
      assert(Object.hasOwn(XPL2_RELATIONSHIPS, type), `XPL2 relationship '${type}' is not registered.`);
      const key = `${type}\0${from}\0${to}\0${qualifier ?? ''}`;
      if (relationshipKeys.has(key)) return null;
      relationshipKeys.add(key);
      const id = padded('R', relationships.length + 1);
      relationships.push({
        id, type, from, to,
        granularity: XPL2_RELATIONSHIPS[type].granularity,
        scope: String(scope),
        qualifier: qualifier == null ? null : String(qualifier),
        cites: [...new Set(cites)].sort()
      });
      return id;
    },

    attention({ category, about, reason, statement, action = null }) {
      assert(ATTENTION.includes(category), `XPL2 attention category '${category}' is not registered.`);
      attention.push({
        id: padded('A', attention.length + 1),
        category, about: String(about), reason: xpl2Reason(reason), statement, action
      });
    },

    hasNode: (id) => nodes.has(id),
    sourceIds: () => [...sources.keys()],

    build({ subject, snapshot, inventory, availability, next = [], presentation = {}, selection = null, delivery = null }) {
      const citable = new Set([...sources.keys(), ...observations.keys()]);
      for (const entry of [...statements, ...derived]) {
        for (const citation of entry.cites) assert(citable.has(citation), `XPL2 statement ${entry.id} cites unknown source ${citation}.`);
      }
      for (const node of nodes.values()) {
        for (const citation of node.cites) assert(citable.has(citation), `XPL2 node ${node.id} cites unknown source ${citation}.`);
      }
      for (const edge of relationships) {
        assert(nodes.has(edge.from) && nodes.has(edge.to), `XPL2 relationship ${edge.id} has an endpoint that is not a node.`);
        assert(edge.cites.length > 0, `XPL2 relationship ${edge.id} must cite a source.`);
        for (const citation of edge.cites) assert(citable.has(citation), `XPL2 relationship ${edge.id} cites unknown source ${citation}.`);
      }
      const statementIds = new Set(statements.map((entry) => entry.id));
      // Attention categories are stable by severity; within a category, discovery order is kept.
      const orderedAttention = ATTENTION.flatMap((category) => attention.filter((entry) => entry.category === category))
        .map((entry, index) => ({ ...entry, id: padded('A', index + 1) }));
      for (const entry of orderedAttention) {
        assert(statementIds.has(entry.statement), `XPL2 attention ${entry.id} names unknown statement ${entry.statement}.`);
      }
      const sourceList = [...sources.values()];
      const observationList = [...observations.values()];
      const universeSources = sourceList.filter((entry) => !subjectScoped.has(entry.id));
      const universeObservations = observationList.filter((entry) => !subjectScoped.has(entry.id));
      const nodeList = [...nodes.values()];
      const identityStatements = statements.map(({ text, ...core }) => core);
      const setCore = {
        contract: XPL2_CONTRACT,
        snapshot,
        sources: universeSources,
        observations: universeObservations,
        statements: identityStatements,
        nodes: nodeList.map(({ label, ...core }) => core),
        relationships,
        inventory: {
          units: (inventory?.units ?? []).map((unit) => unit.explanationUnitSha256),
          counts: inventory?.counts ?? null,
          completeness: inventory?.completeness ?? null
        },
        availability,
        attention: orderedAttention.map(({ id, category, about, reason, statement }) => ({ id, category, about, reason, statement }))
      };
      const explanationSetSha256 = xpl2Sha256(setCore);
      const returned = selection ?? {
        statements: statements.map((entry) => entry.id),
        nodes: nodeList.map((node) => node.id),
        relationships: relationships.map((edge) => edge.id)
      };
      // Only the returned members are delivered; the universe identity above still covers all of them.
      const statementSet = new Set(returned.statements);
      const nodeSet = new Set(returned.nodes);
      const relationshipSet = new Set(returned.relationships);
      const deliveredInventory = inventory ? {
        ...inventory,
        units: (inventory.units ?? []).filter((unit) => nodeSet.has(unit.nodeId)),
        files: (inventory.files ?? []).filter((file) => nodeSet.has(file.fileId))
      } : inventory;
      const explanationSha256 = xpl2Sha256({
        explanationSetSha256, subject, selection: returned,
        derived: derived.map(({ text, ...core }) => core),
        subjectInputs: [...sourceList, ...observationList].filter((entry) => subjectScoped.has(entry.id)),
        delivery: delivery ?? { complete: true }
      });
      return freezeDeep({
        schemaVersion: 1, // schema-transient: read-only XPL2 projection; never persisted or authorized
        kind: 'xpl2-explanation',
        contract: XPL2_CONTRACT,
        mode: 'observe-only',
        authoritative: false,
        authority: 'none',
        lifecycleGate: false,
        subject,
        snapshot,
        sources: sourceList,
        observations: observationList,
        statements: statements.filter((entry) => statementSet.has(entry.id)),
        derived,
        nodes: nodeList.filter((node) => nodeSet.has(node.id)),
        relationships: relationships.filter((edge) => relationshipSet.has(edge.id)),
        inventory: deliveredInventory,
        availability,
        attention: orderedAttention,
        next,
        selection: returned,
        delivery: delivery ?? { complete: true, reason: null },
        presentation,
        explanationSetSha256,
        explanationSha256
      });
    }
  };
  return builder;
}
