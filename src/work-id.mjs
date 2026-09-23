import { SingularityFlowError } from './util.mjs';

// Win32 treats the superscript digits ¹, ² and ³ as device-number aliases too (for example COM¹),
// even though they are not ordinary ASCII digits. Refuse the complete documented device family
// before an ID becomes either a branch component or a worktree directory.
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)(?:[1-9]|[¹²³]))(?:\..*)?$/iu;
const GIT_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*\[\\]/u;

function invalid(label, code, reason) {
  throw new SingularityFlowError(
    `${label} must be one Windows- and Git-portable identifier (${reason}).`,
    { code }
  );
}

/**
 * Validate the one component used for Story state directories and, ordinarily, its Git branch.
 *
 * Keep this independent of a workflow's configurable `idPattern`: the pattern can narrow the
 * namespace, but it cannot make a DOS device basename or an invalid Git ref portable. Never trim
 * here, because Windows resolves terminal dots/spaces to a different filesystem name.
 */
export function validatePortableWorkId(value, {
  label = 'Work ID', code = 'WORK_ID_INVALID'
} = {}) {
  if (typeof value !== 'string' || !value) invalid(label, code, 'it is empty');
  if (value.length > 64) invalid(label, code, 'it exceeds 64 characters');
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    invalid(label, code, 'slashes and traversal names are not allowed');
  }
  if (/[. ]$/u.test(value)) invalid(label, code, 'a trailing dot or space is not allowed');
  if (WINDOWS_RESERVED_BASENAME.test(value)) {
    invalid(label, code, 'Windows reserved device names are not allowed');
  }
  if (value.startsWith('.') || value.startsWith('-') || value === '@' || value === 'HEAD'
      || value.includes('..') || value.includes('@{') || /\.lock$/iu.test(value)
      || GIT_FORBIDDEN.test(value) || /["<>|]/u.test(value)) {
    invalid(label, code, 'Git would not accept it as a branch name');
  }
  return value;
}
