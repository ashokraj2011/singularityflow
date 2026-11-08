/** Portable repository component and path-value identity. No host or filesystem access. */
import { SingularityFlowError } from './failures.mjs';


const WINDOWS_RESERVED_PORTABLE_BASENAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)(?:[1-9]|[¹²³]))(?:\..*)?$/iu;


/**
 * Validate one exact component of a durable repository-relative path.
 *
 * Do not trim or normalize here: Git can retain names on macOS/Linux that Windows either aliases
 * to a DOS device (including a reserved stem with an extension) or resolves after removing a final
 * dot/space. Returning false for those spellings prevents one approved record from identifying
 * different filesystem objects on different hosts.
 */
export function isPortableRepositoryPathComponent(value, { allowGit = false } = {}) {
  return typeof value === 'string' && Boolean(value) && value === value.normalize('NFC')
    && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
    && !/[\u0000-\u001f\u007f:*?"<>|]/u.test(value) && !/[. ]$/u.test(value)
    && !WINDOWS_RESERVED_PORTABLE_BASENAME.test(value)
    && (allowGit || value.toLocaleLowerCase('en-US') !== '.git');
}


/**
 * One filesystem identifier contract shared by workspace and governed repository records.
 *
 * Windows reserves device basenames even when an extension is present, and trims terminal dots and
 * spaces before resolving a path. Accepting those names on macOS/Linux creates approved maps that a
 * Windows laptop cannot materialize. Keep the contract deliberately narrower than a Git ref: these
 * identifiers become direct child directory names on every supported host.
 */
export function portableIdentifier(value, label = 'Identifier') {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
      || id === '.' || id === '..' || /[. ]$/.test(id)
      || WINDOWS_RESERVED_PORTABLE_BASENAME.test(id)) {
    throw new SingularityFlowError(`${label} must be a portable identifier and must not use a Windows reserved filename.`);
  }
  return id;
}


export function portableFilesystemPathIdentity(value) {
  // Approximate the case/compatibility identity used by default Windows and macOS filesystems.
  // Configured authority roots themselves are printable ASCII, but candidate/baseline paths may
  // still be repository-controlled Unicode input and must compare fail-closed.
  return String(value).split('/').map((component) => component
    // Win32 strips trailing dots and spaces from ordinary path components.
    .replace(/[. ]+$/u, '')
    .normalize('NFKC')
    .toLocaleUpperCase('en-US').toLocaleLowerCase('en-US').normalize('NFC'))
    .join('/');
}
