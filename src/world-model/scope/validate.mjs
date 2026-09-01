import { contractFailure } from '../contracts.mjs';
import { validateScopeManifest } from './manifest.mjs';
import { classifyScopePath } from './matcher.mjs';

export function assertSubjectAllowed(subjectKind, manifest) {
  const scope = validateScopeManifest(manifest);
  if (!scope.allowedSubjects.includes(subjectKind)) {
    contractFailure(`World-model subject kind '${subjectKind}' is outside the Scope Manifest.`, 'WMB_SCOPE_VIOLATION', { subjectKind });
  }
  return subjectKind;
}

export function assertPathInsideScope(value, manifest, label = 'World-model evidence path') {
  const result = classifyScopePath(value, manifest);
  if (result.status !== 'inside') {
    contractFailure(`${label} '${result.path}' is ${result.status} for the Scope Manifest.`, 'WMB_SCOPE_VIOLATION', result);
  }
  return result;
}

export function validateScopeCoverage(sourceSnapshot, manifest) {
  const scope = validateScopeManifest(manifest);
  const counts = { inside: 0, excluded: 0, outside: 0, 'too-deep': 0 };
  for (const file of sourceSnapshot.files ?? []) counts[classifyScopePath(file.path, scope).status] += 1;
  return Object.freeze({ scopeSha256: scope.scopeSha256, files: sourceSnapshot.files?.length ?? 0, counts });
}
