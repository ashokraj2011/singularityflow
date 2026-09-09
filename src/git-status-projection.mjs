/**
 * Parse the NUL-delimited Git porcelain-v2 status used by read-only repository snapshots.
 *
 * Keep this parser dependency-free: both the established snapshot reader and the typed FOS query
 * registry use it, so shadow comparison proves the readers interpret the exact same bytes rather
 * than comparing two independently implemented parsers.
 */
export function parsePorcelainV2Revision(value) {
  const tokens = String(value ?? '').split('\0').filter(Boolean);
  const changedFiles = [];
  const untrackedFiles = [];
  let branchName = null;
  let commit = null;
  for (const token of tokens) {
    if (token.startsWith('# branch.head ')) branchName = token.slice('# branch.head '.length).trim();
    else if (token.startsWith('# branch.oid ')) commit = token.slice('# branch.oid '.length).trim();
    else if (token.startsWith('? ')) {
      const file = token.slice(2);
      changedFiles.push(file);
      untrackedFiles.push(file);
    } else if (/^[12u] /.test(token)) {
      // Porcelain-v2 type 1/unmerged records have eight fields before the path; rename/copy type 2
      // records have nine. With `-z`, the source path of a rename is a following NUL token and the
      // destination path in this record is the same path `git diff --name-only HEAD` reports.
      const fieldsBeforePath = token[0] === '2' ? 9 : 8;
      const file = token.split(' ').slice(fieldsBeforePath).join(' ');
      if (file) changedFiles.push(file);
    }
  }
  return Object.freeze({
    branchName,
    commit,
    changedFiles: Object.freeze([...new Set(changedFiles)].sort()),
    untrackedFiles: Object.freeze([...new Set(untrackedFiles)].sort())
  });
}
