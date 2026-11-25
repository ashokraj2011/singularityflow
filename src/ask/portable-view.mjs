import { readEvidence } from './evidence.mjs';

export async function readPortableEvidence(scope, link, detail = true) {
  const verified = await scope.sources.verify(link);
  return readEvidence(scope.root, link, { audience: scope.audience, detail, verifiedSpecification: verified.specification });
}

export async function restorePortable(scope, record, { answer, diagnostic, lookup }) {
  const { refs, history, pending } = record.result;
  if (pending) {
    return answer('resume', { status: 'clarification',
      choices: pending.choices.filter(choice => choice.kind !== 'help').map(({ id, kind }) => ({ id, kind })),
      candidates: pending.choices.filter(choice => choice.kind === 'help').map(({ id }) => ({ id, title: id })),
      diagnostics: [diagnostic('ASK_CHOICE_REQUIRED', 'Choose one of the saved options to continue.', 'clarification')] });
  }

  const data = answer('resume', { savedResults: [] });
  for (const [index, link] of refs.entries()) {
    const position = index + 1;
    try {
      const verified = await scope.sources.verify(link);
      const evidence = await readEvidence(scope.root, link, { audience: scope.audience, detail: false,
        verifiedSpecification: verified.specification });
      data.savedResults.push({ position, availability: 'available', evidenceId: link.id, title: evidence.title, kind: evidence.kind });
      if (verified.currentWork) {
        data.work = verified.currentWork;
        data.observedAt = new Date().toISOString();
        if (data.work.recordCommit === link.ref.commit && data.work.recordSha256 === link.ref.sha256) data.work.evidenceId = link.id;
      }
      if (evidence.specification) (data.specifications ??= []).push({ ...evidence.specification, evidenceId: link.id });
      if (evidence.help) data.help = { ...evidence.help, evidenceId: link.id };
    } catch (error) {
      const local = error.code === 'ASK_EVIDENCE_LOCAL_ONLY';
      data.savedResults.push({ position, availability: local ? 'local-only' : 'unavailable', evidenceId: link.id });
      data.diagnostics.push(diagnostic(error.code?.startsWith('ASK_') ? error.code : 'ASK_SHARED_SOURCE_UNAVAILABLE',
        'Saved result ' + position + (local ? ' is available only on the original device.' : ' is unavailable in this checkout.')));
    }
  }
  if (record.selected && !refs.some(link => link.id === record.selected.id)) {
    try { await readPortableEvidence(scope, record.selected, false); }
    catch (error) {
      data.diagnostics.push(diagnostic(error.code ?? 'ASK_SHARED_SOURCE_UNAVAILABLE', error.code === 'ASK_EVIDENCE_LOCAL_ONLY'
        ? 'The selected evidence is available only on the original device.' : 'The selected evidence is unavailable in this checkout.'));
    }
  }
  if (history && !data.diagnostics.length) {
    try {
      await scope.sources.verifyHistory(history);
      const verified = await lookup(scope, 'saved history', { replay: { ...history, next: history.start } });
      if (JSON.stringify(refs.map(link => link.originalId ?? link.id)) === JSON.stringify(verified.result.refs.map(link => link.id))) {
        for (const [index, row] of (verified.value.history?.rows ?? verified.value.comparison?.rows ?? []).entries()) {
          row.evidenceId = refs[index].id;
        }
        return verified.value;
      }
    } catch { /* Preserve the ordered individually verified results when the full page cannot be replayed. */ }
    data.diagnostics.push(diagnostic('ASK_SAVED_RESULTS_CHANGED', 'The saved page could not be replayed. Open its available evidence or ask a new question.'));
  }
  if (record.shared.missingHistory && !data.diagnostics.some(item => item.code === 'ASK_EVIDENCE_LOCAL_ONLY')) {
    data.diagnostics.push(diagnostic('ASK_EVIDENCE_LOCAL_ONLY', 'The saved page is available only on the original device.'));
  }
  if (record.shared.missingPending) {
    data.diagnostics.push(diagnostic('ASK_EVIDENCE_LOCAL_ONLY', 'The saved choices are available only on the original device.'));
  }
  if (data.diagnostics.length) data.status = data.savedResults.some(row => row.availability === 'available') ? 'partial' : 'unavailable';
  return data;
}
