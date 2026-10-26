/** Pure Story display metadata. Never infer creation from activity or the current Git user. */
export function storyCreatorName(createdBy) {
  const value = typeof createdBy === 'string' ? createdBy : createdBy && typeof createdBy === 'object'
    ? [createdBy.name, createdBy.login, createdBy.githubLogin, createdBy.email].find(item => typeof item === 'string' && item.trim()) : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function compareStoryCreation(left, right) {
  const timestamp = item => typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : NaN;
  const a = timestamp(left), b = timestamp(right);
  const validA = Number.isFinite(a), validB = Number.isFinite(b);
  if (validA !== validB) return validA ? -1 : 1;
  if (validA && a !== b) return b - a;
  const identity = item => [item.id ?? item.workId ?? item.planId ?? '',
    item.repositoryId ?? item.repository?.id ?? item.repository ?? '', item.checkoutPath ?? item.repositoryPath ?? ''].join('\0');
  return identity(left).localeCompare(identity(right));
}
