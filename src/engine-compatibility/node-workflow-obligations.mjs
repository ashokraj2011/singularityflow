/** Bind the shared graph compiler to native UTF-8 SHA-256. No repository, provider or admission rules. */
import { NODE_TEXT_DIGESTS } from '../records.mjs';
import { createWorkflowObligationCompiler } from '../kernel/workflow-obligations.mjs';
export const compileObligationGraph = /* @__PURE__ */ createWorkflowObligationCompiler(NODE_TEXT_DIGESTS);
