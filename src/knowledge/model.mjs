/**
 * The model a repository knowledge call uses, in any repository. Without singularity/workflow.yml the
 * default provider is used. A configured model is named directly; otherwise the request routes by
 * task when singularity/modelTiers.yml exists, and leaves the choice to the provider when it does not.
 */
import { loadDefinition } from '../config.mjs';
import { invokeModel, resolveModelProvider } from '../model-runner.mjs';
import { loadModelTiers } from '../model-tiers.mjs';

export async function knowledgeModel(root) {
  let definition = null;
  try { definition = await loadDefinition(root); } catch { definition = null; }
  const provider = resolveModelProvider(definition);
  const tiers = provider.model ? null : await loadModelTiers(root);
  return {
    model: provider.model,
    label: provider.model ?? provider.provider ?? null,
    request: {
      provider: provider.provider,
      // The transport reads the executable and transport from this; an empty one means `copilot`, auto.
      providerConfig: provider.providerConfig ?? {},
      ...(tiers ? { task: 'summarize' } : { model: provider.model })
    }
  };
}

/** One tool-less call with a prompt; the answer's text and the model's label. */
export async function askKnowledgeModel(root, { text, channel, subject, timeoutMs = 4 * 60 * 1000 }) {
  const provider = await knowledgeModel(root);
  const invocation = await invokeModel({
    ...provider.request,
    cwd: root,
    allowedRoots: [root],
    prompt: { text },
    channel,
    subject,
    tools: { mode: 'none', names: [] },
    limits: { timeoutMs, outputBytes: 256 * 1024 }
  });
  return { output: invocation.output, model: provider.label };
}
