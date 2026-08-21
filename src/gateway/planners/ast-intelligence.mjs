/** Model-free, bounded AST reads for gateway and Copilot hosts. */
import { astContext, astDoctor, astQuery } from '../../ast-intelligence.mjs';
import { replayAstEvidence } from '../../ast-replay.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, sflowResult } from '../result.mjs';

function optionsFor(args = {}) {
  return {
    ...(args.path ? { paths: [args.path] } : {}),
    ...(args.all === true ? { all: true } : {}),
    ...(args.maxFiles ? { 'max-files': args.maxFiles } : {}),
    ...(args.maxFacts ? { 'max-facts': args.maxFacts } : {}),
    ...(args.maxOutputBytes ? { 'max-output-bytes': args.maxOutputBytes } : {}),
    ...(args.cursor ? { cursor: args.cursor } : {})
  };
}

function result(operation, subject, data, slots = {}) {
  return sflowResult({
    kind: 'read',
    operation: { id: operation, classification: 'read' },
    subject,
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots },
    effects: noEffects(),
    why: [{
      code: 'ast.bounded-structural-evidence', source: 'deterministic',
      slots: { status: data.status ?? (data.healthy === false ? 'diagnostic' : 'available') }
    }],
    restState: 'informational',
    data: { ast: data }
  });
}

function repositoryRoot(root, operation) {
  if (!root) throw new SingularityFlowError(`${operation} requires the repository root it should read.`, {
    code: 'AST_GATEWAY_NO_ROOT'
  });
  return root;
}

export async function astStatusPlanner({ root = null, subject = null } = {}) {
  const data = await astDoctor(repositoryRoot(root, 'wm.ast.status'));
  return result('wm.ast.status', subject, data, {
    mode: data.effective?.mode ?? 'unknown', adapters: String(data.adapters?.length ?? 0)
  });
}

export async function astContextPlanner({ root = null, subject = null, arguments: args = {} } = {}) {
  const data = await astContext(repositoryRoot(root, 'wm.ast.context'), optionsFor(args));
  return result('wm.ast.context', subject, data, {
    status: data.status, files: String(data.coverage?.processed ?? 0), facts: String(data.coverage?.factsReturned ?? 0)
  });
}

export async function astQueryPlanner({ root = null, subject = null, arguments: args = {} } = {}) {
  const data = await astQuery(repositoryRoot(root, 'wm.ast.query'), {
    ...optionsFor(args), ...(args.predicate ? { predicate: args.predicate } : {}),
    ...(args.value ? { value: args.value } : {})
  });
  return result('wm.ast.query', subject, data, {
    status: data.status, matched: String(data.coverage?.factsMatched ?? 0)
  });
}

async function specializedQuery(operation, predicate, { root = null, subject = null, arguments: args = {} } = {}) {
  const value = args.symbolId ?? args.name ?? args.module ?? args.value;
  const data = await astQuery(repositoryRoot(root, operation), {
    ...optionsFor(args), predicate, value
  });
  return result(operation, subject, data, {
    status: data.status, matched: String(data.coverage?.factsMatched ?? 0), assurance: data.assurance
  });
}

export const astSymbolPlanner = (request) => specializedQuery('wm.ast.symbol', request.arguments?.symbolId ? 'symbol-id' : 'symbol', request);
export const astReferencesPlanner = (request) => specializedQuery('wm.ast.references', 'references', request);
export const astHierarchyPlanner = (request) => specializedQuery('wm.ast.hierarchy', 'hierarchy', request);
export const astModulePlanner = (request) => specializedQuery('wm.ast.module', 'module', request);

export async function astEvidenceReplayPlanner({ root = null, subject = null, arguments: args = {} } = {}) {
  const data = await replayAstEvidence(repositoryRoot(root, 'wm.ast.evidence.replay'), {
    receipt: args.receipt
  });
  return result('wm.ast.evidence.replay', subject, data, {
    result: data.result, derivation: data.derivationSha256?.slice(0, 12) ?? 'unavailable'
  });
}
