import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';

function sha(value) { return `sha256:${recordSha256(value)}`; }

export function worldModelRefusal({ code, view, preserved, failures, nextAction }) {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-refusal'),
    kind: 'world-model-refusal',
    code,
    view,
    preserved: {
      evidenceCatalogSha256: preserved.evidenceCatalogSha256,
      factLedgerSha256: preserved.factLedgerSha256,
      validViewIds: [...new Set(preserved.validViewIds ?? [])].sort()
    },
    failures: (failures ?? []).map((entry) => structuredClone(entry)),
    nextAction: structuredClone(nextAction)
  };
  return Object.freeze({ ...base, refusalSha256: sha(base) });
}
