/**
 * The optional model call behind `explain --subject ... --narrate` [XPL2 13.2, 13.4].
 *
 * Loaded only when narration is requested, so an ordinary subject view never reaches the model
 * runner. The call goes through the existing runner with its own operation context, audit and
 * prompt-capture setting (capture is never switched on here), with no tools and the approved
 * computed projection as its only input. Any failure — model disabled, provider unavailable,
 * invalid output — is reported as unavailable narration; the computed view is unchanged.
 */
import path from 'node:path';

import {
  buildXpl2NarrationPrompt, unavailableXpl2Narration, validateXpl2Narration, xpl2NarrationInput
} from './narration.mjs';

export const XPL2_NARRATION_OPERATION = 'explain.subject.narrate';
export const XPL2_NARRATION_CHANNEL = 'xpl2-narration-advisory';

function narrationSubject(root, { workId = null, phase = null, subject = 'change' } = {}) {
  return workId ? {
    kind: 'story', id: workId, workId, phase,
    repositoryId: path.basename(root), purpose: XPL2_NARRATION_CHANNEL, explanationSubject: subject
  } : { kind: 'repository-code-explanation', id: path.basename(root), phase, explanationSubject: subject };
}

/**
 * Narrate one computed view. `provider` overrides the configured provider (tests use a local
 * stand-in executable); the runner, its audit and its capture setting are always the real ones.
 */
export async function narrateXpl2Explanation(root, model, {
  operation = null, length = 'standard', commentary = false, workId = null, phase = null, provider = null
} = {}) {
  if (operation?.id !== XPL2_NARRATION_OPERATION) return unavailableXpl2Narration('model-disabled-fallback', model);
  try {
    const input = xpl2NarrationInput(model);
    const prompt = buildXpl2NarrationPrompt(input, { length, commentary });
    const [{ invokeModel, resolveModelProvider }, { summarizingRoute }] = await Promise.all([
      import('../../model-runner.mjs'), import('../../model-tiers.mjs')
    ]);
    let selected = provider;
    let route = {};
    if (!selected) {
      const { loadDefinition } = await import('../../config.mjs');
      selected = resolveModelProvider(await loadDefinition(root));
      route = await summarizingRoute(root, selected.model);
    }
    const invocation = await invokeModel({
      provider: selected.provider,
      providerConfig: selected.providerConfig,
      ...route,
      cwd: root,
      allowedRoots: [root],
      prompt: { text: prompt },
      channel: XPL2_NARRATION_CHANNEL,
      subject: narrationSubject(root, { workId, phase, subject: model.subject?.kind }),
      tools: { mode: 'none', names: [] },
      limits: { timeoutMs: 2 * 60 * 1000, outputBytes: 64 * 1024 }
    });
    return validateXpl2Narration(invocation.output, input, { length, commentary });
  } catch (error) {
    return unavailableXpl2Narration(error?.code ?? 'XPL2_NARRATION_UNAVAILABLE', model);
  }
}
