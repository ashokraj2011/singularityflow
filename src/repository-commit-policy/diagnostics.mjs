/** Native command guidance for semantic RCP refusals. Kernel errors contain no host commands. */
import {SingularityFlowError,PolicyViolation} from '../foundation/failures.mjs';

export function rcpFailure(code, message, details = {}) {
  throw new SingularityFlowError(message, { code, details: { ...details,
    nextAction: details.nextAction ?? { copilot: '/sf-git-policy show', shell: 'singularity-flow git-policy show --json', vscode: '@sflow /git-policy', command: 'singularity-flow git-policy show --json', copilotCommand: '/sf-git-policy show', modelFreeCommand: '@sflow /git-policy' } } });
}

export function invokeCommitPolicyRule(fn,args) {
  try { return Reflect.apply(fn,undefined,args); }
  catch(error) {
    if(error instanceof PolicyViolation && typeof error.code==='string' && error.code.startsWith('RCP_'))rcpFailure(error.code,error.message,error.details);
    throw error;
  }
}
