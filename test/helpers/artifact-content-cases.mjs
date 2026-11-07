/** Artifact contracts shared by baseline capture and portable-rule qualification. */
export function artifactContentCases() {
  const metadata = '<!-- singularity-flow:metadata\n{"phase":"custom-phase","generation":1}\n-->\n\n';
  const complete = '# Result\n\n## Overview\nA substantive, verified result.\n\n## Evidence\nA retained observation.\n';
  const contract = { kind: 'custom-document', path: 'artifacts/custom/result.md', minimumBytes: 25, maximumBytes: 4096,
    validation: { requiredHeadings: ['Overview', 'Evidence'], forbiddenPlaceholders: ['REPLACE-ME'] } };
  const variants = [
    ['complete', complete], ['managed', metadata + complete], ['empty', ''], ['short', '# Result\n'],
    ['uppercase-todo', complete + 'TODO\n'], ['ordinary-todo-word', complete + 'A todo list for the team.\n'],
    ['other-markers', complete + 'TBD tBc FixMe {{unknown}} [describe outcome]\n'],
    ['uppercase-markers', complete + 'XXX PLACEHOLDER\n'],
    ['angle-prose', complete + '<capability> <the intended result> <more...>\n'],
    ['angle-command', complete + '--url <AUTHORIZED-URL> <DIRECTORY> <https://example.invalid> <span class="name">\n'],
    ['qualified-identities', complete + '[TODO:REQ-001] `ADD-FACTORIAL:AC-002` TBC:BEH-003\n'],
    ['malformed-identities', complete + 'OTHER:TODO:REQ-001 TODO:REQ-001-extra TODO:REQ-001.prefix\n'],
    ['hidden-comments', complete + '<!-- TODO and missing markers -->\n'],
    ['unterminated-comment', '# Result\n<!-- TODO\n## Overview\nNot visible.\n'],
    ['fenced-comment', complete + '```html\n<!-- TODO -->\n```\n'],
    ['inline-comment', complete + '`<!-- TODO -->`\n'],
    ['missing-heading', '# Result\n\nThe result is substantive but lacks headings.\n'],
    ['empty-heading', '# Result\n\n## Overview\n\n## Evidence\nA retained observation.\n'],
    ['near-heading', '# Result\n\n## 1. Overview:\nSubstantive body.\n\n**Evidence**\nObservation.\n'],
    ['managed-inputs', metadata + complete + '<!-- singularity-flow:inputs:start -->\nTODO {{upstream}}\n<!-- singularity-flow:inputs:end -->\n'],
    ['malformed-metadata', '<!-- singularity-flow:metadata\n{"phase":"custom-phase"}\n' + complete],
    ['duplicate-metadata', metadata + metadata + complete],
    ['misplaced-metadata', '# Prefix\n' + metadata + complete],
    ['unicode', complete + 'Résumé Ελληνικά 日本語 🧭 e\u0301\n'],
    ['lone-surrogates', complete + '\ud800 boundary \udfff\n'],
    ['nul-content', complete + '\u0000\n'],
    ['crlf', (metadata + complete).replaceAll('\n', '\r\n')],
    ['cr-only', complete.replaceAll('\n', '\r')],
    ['forbidden', complete + 'replace-me\n'],
    ['too-large', complete + 'x'.repeat(4100)]
  ];
  const make = (name, text, changes = {}) => ({ name, text, metadata, complete,
    phase: { id: 'custom-phase', status: 'in_progress', generation: 0, requiredArtifact: structuredClone(contract),
      authoringBaseline: { generation: 1, fingerprint: null }, ...changes }, options: {} });
  const cases = variants.map(([name, text]) => make(name, text));
  cases.push(make('unchanged-template', complete), make('whitespace-padded-template', '\n\n' + complete + '\n\n'));
  cases.push({ ...make('placeholders-disabled', complete + 'TODO\n'), options: { placeholders: false } });
  cases.push({ ...make('minimum-disabled', ''), options: { minimumBytes: false } });
  cases.push(make('no-baseline', metadata + complete, { authoringBaseline: null }));
  cases.push(make('submitted-generation', complete, { generation: 1, status: 'awaiting_approval' }));
  cases.push({ ...make('explicit-generation', complete), options: { generation: 3 } });
  return cases;
}

export function observeArtifactContent(api, entry) {
  const phase = structuredClone(entry.phase);
  phase.authoringBaseline &&= { ...phase.authoringBaseline, fingerprint: api.authoredArtifactFingerprint(entry.complete) };
  const contract = { ...phase.requiredArtifact, generation: 1 };
  return { content: api.inspectArtifactContent(entry.text, { path: phase.requiredArtifact.path, contract, baseline: phase.authoringBaseline }),
    required: api.inspectRequiredArtifactText(entry.text, phase, { path: phase.requiredArtifact.path, ...entry.options }),
    placeholders: api.artifactPlaceholderFindings(entry.text), metadata: api.inspectManagedArtifactMetadata(entry.text),
    repair: api.repairPreparedArtifactMetadata(entry.text, { canonicalMetadata: entry.metadata, baselineText: entry.metadata + entry.complete }) };
}
