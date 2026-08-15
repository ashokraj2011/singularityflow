/**
 * The five model-facing tools, and nothing else. `[INT:IFC-010]` `[INT:CON-034]`
 *
 * Five is a product decision, not a starting point. A tool surface that grows with the command set
 * costs context on every single turn, teaches the model a vocabulary it will then try to use
 * creatively, and turns "which operations can a model invoke" into a question nobody can answer by
 * reading one screen. So the commands are not tools; the registry is data behind `sflow_resolve`,
 * and the tools are the four verbs of a conversation plus a way to ask what something means.
 *
 * The asymmetry between `sflow_resolve` and the other four is the design. Resolve is the only tool
 * that takes words, and it returns handles. Read and run take a handle and refuse everything else
 * `[INT:IFC-013]` `[INT:IFC-015]` — no operation name, no command line, no Git argv, no path, no
 * free-form arguments — which is enforced here as `additionalProperties: false` over exactly one
 * property, so a host cannot widen it by passing extra fields that happen to be honoured.
 */
import { BROAD_GOALS } from './goals.mjs';

export const TOOL_SCHEMA_VERSION = 1;

/** Where `sflow_next` may be asked for legal actions. `[INT:IFC-014]` */
export const NEXT_SCOPES = Object.freeze(['home', 'subject', 'investigation']);

const SUBJECT_HINT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    workspaceId: { type: 'string', maxLength: 128 },
    repositoryId: { type: 'string', maxLength: 128 },
    workId: { type: 'string', maxLength: 128 }
  })
});

/**
 * A handle-only input.
 *
 * Written once and shared, because the property that matters is structural — one field, closed
 * object — and two copies of it are two chances for one of them to gain a second field.
 */
const handleOnly = (property, description) => Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze([property]),
  properties: Object.freeze({ [property]: { type: 'string', maxLength: 128, description } })
});

export const SFLOW_TOOLS = Object.freeze([
  {
    name: 'sflow_resolve',
    description: 'Turn a request into one resolved operation, a bounded choice, a question, or a refusal.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['utterance']),
      properties: Object.freeze({
        utterance: { type: 'string', maxLength: 2000, description: 'What the user actually said.' },
        /**
         * Advisory, and closed `[INT:CON-035]`. The enum is inlined rather than described in prose
         * because a described vocabulary is one the model will extend helpfully.
         */
        goalHint: { type: 'string', enum: BROAD_GOALS, description: 'Roughly what the user seems to want.' },
        arguments: { type: 'object', description: 'Proposed typed arguments; validated against the operation schema.' },
        subject: SUBJECT_HINT,
        selectionHandle: { type: 'string', maxLength: 128, description: 'A choice the kernel previously offered.' }
      })
    })
  },
  {
    name: 'sflow_read',
    description: 'Execute a read the kernel already resolved.',
    inputSchema: handleOnly('resolutionId', 'A read handle from sflow_resolve.')
  },
  {
    name: 'sflow_next',
    description: 'Ask the kernel which actions are currently legal.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['scope']),
      properties: Object.freeze({
        scope: { type: 'string', enum: NEXT_SCOPES },
        subject: SUBJECT_HINT
      })
    })
  },
  {
    name: 'sflow_run',
    description: 'Carry out one plan the kernel created and the user confirmed.',
    // The confirmation receipt is injected out of band by the host and is deliberately not a
    // property here `[INT:CON-039]`: a field the model can see is a field the model can invent.
    inputSchema: handleOnly('planId', 'A plan handle from sflow_resolve.')
  },
  {
    name: 'sflow_explain',
    description: 'Answer a question about the product, the current state, or the evidence, with citations.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['question']),
      properties: Object.freeze({
        question: { type: 'string', maxLength: 2000 },
        topic: { type: 'string', maxLength: 128 },
        subject: SUBJECT_HINT
      })
    })
  }
].map(Object.freeze));

export const SFLOW_TOOL_NAMES = Object.freeze(SFLOW_TOOLS.map((tool) => tool.name));

/**
 * How the five schemas are serialized when handed to a host, and measured. `[INT:REQ-031]`
 *
 * One method, used by both the adapter and the budget gate, so the number the release report
 * carries is the number the model is actually charged for. Compact JSON because that is what goes
 * over the wire; pretty-printing would inflate the measurement by a third and prove nothing.
 */
export const TOOL_SERIALIZATION = 'json-compact';

export function serializeToolSchemas(tools = SFLOW_TOOLS) {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema
  })));
}

/**
 * The estimator, named and pinned. `[INT:CON-174]`
 *
 * This product ships with no runtime dependencies, so there is no provider tokenizer here and this
 * is an approximation — four bytes per token, the standard rough figure for English-and-JSON. It is
 * named in every place it is reported so nobody mistakes it for billing, and the budget below
 * carries enough headroom to absorb the error rather than being tuned to it.
 */
export const TOOL_TOKENIZER = 'bytes-per-token-4.0';

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/**
 * The release budget for the whole five-tool surface. `[INT:REQ-031]` `[INT:AC-020]`
 *
 * Not a limit anyone is near — it is a tripwire for the change that quietly registers a sixth tool
 * or inlines the operation catalog into a description. Those are the two ways this surface grows,
 * and both look reasonable in a diff.
 */
export const TOOL_SCHEMA_TOKEN_BUDGET = 900;

export function toolSchemaMeasurement(tools = SFLOW_TOOLS) {
  const serialized = serializeToolSchemas(tools);
  return Object.freeze({
    schemaVersion: TOOL_SCHEMA_VERSION,
    tools: tools.length,
    serialization: TOOL_SERIALIZATION,
    tokenizer: TOOL_TOKENIZER,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    tokens: estimateTokens(serialized),
    budget: TOOL_SCHEMA_TOKEN_BUDGET
  });
}
