import { portableCheckPath } from './check-path-policy.mjs';

/** Documentation includes native skills, templates and generated catalogs, wherever stored. */
export function isDocumentationPath(value) {
  return /\.(?:md|mdx|markdown|mdown|rst|txt|html?|adoc|asciidoc|tex|org|svg)$/i
    .test(portableCheckPath(value));
}

const personalName = new RegExp(['ash', 'ok'].join(''), 'i');
const homePath = /(?:\/(?:Users|home)\/|[a-z]:[\\/]+Users[\\/]+)(?!<|\$\{|\$\(|\{|%|\[)[a-z0-9_.-]+/i;

/** Keep examples portable without treating placeholder usernames as real identities. */
export function documentationPrivacyProblems(relative, text) {
  if (!isDocumentationPath(relative)) return [];
  const problems = [];
  if (personalName.test(relative)) problems.push(`${relative}: personal name in documentation filename`);
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    if (personalName.test(line)) problems.push(`${relative}:${index + 1}: personal name or account reference`);
    if (homePath.test(line)) problems.push(`${relative}:${index + 1}: use a placeholder instead of a machine-specific home path`);
  }
  return problems;
}
