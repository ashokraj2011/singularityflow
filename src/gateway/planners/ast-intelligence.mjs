/** Model-free, bounded AST reads for gateway and Copilot hosts. */
import { astContext, astDoctor, astQuery } from '../../ast-intelligence.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, sflowResult } from '../result.mjs';

function optionsFor(args = {}) {
  return {
    ...(args.path ? { paths: [args.path] } : {}),
    ...(args.all === true ? { all: true } : {}),
    ...(args.maxFiles ? { 'max-files': args.maxFiles } : {})
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
    ...optionsFor(args), predicate: args.predicate, value: args.value
  });
  return result('wm.ast.query', subject, data, {
    status: data.status, matched: String(data.coverage?.factsMatched ?? 0)
  });
}
