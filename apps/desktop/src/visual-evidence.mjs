const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isPreviewImage(record) {
  return IMAGE_TYPES.has(record?.mimeType);
}

function searchable(record) {
  return `${record?.label ?? ''} ${record?.path ?? ''} ${record?.kind ?? ''}`.toLowerCase();
}

export function classifyVisualEvidence(records = []) {
  const images = records.filter(isPreviewImage);
  const pinnedDesigns = images.filter((record) => (
    ['design-intake', 'design-inventory'].includes(record.phase)
    || (record.type === 'file' && /(figma|design|reference|wireframe|mockup)/.test(searchable(record)))
  ));
  const verification = images.filter((record) => record.phase === 'visual-verification');
  const diffs = verification.filter((record) => /(diff|pixelmatch|overlay|mismatch)/.test(searchable(record)));
  const builds = verification.filter((record) => !diffs.includes(record));
  return { images, pinnedDesigns, builds, diffs };
}

export function extractVisualDifference(content = '') {
  const patterns = [
    /(?:pixel|visual|image)?\s*(?:diff(?:erence)?|mismatch)(?:\s+rate)?\s*[:|=\-]?\s*(\d+(?:\.\d+)?)\s*%/i,
    /(\d+(?:\.\d+)?)\s*%\s*(?:pixel|visual|image)?\s*(?:diff(?:erence)?|mismatch)/i
  ];
  const match = patterns.map((pattern) => content.match(pattern)).find(Boolean);
  if (!match) return null;
  const percent = Number(match[1]);
  return {
    percent,
    verdict: /\b(matched|pass(?:ed)?|within threshold)\b/i.test(content) ? 'matched' : 'reported'
  };
}
