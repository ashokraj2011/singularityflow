/**
 * The SharePoint link a person gives, checked in plain words: an HTTPS folder link with no
 * credentials, never a link to one file, and a page that is a shared folder rather than a sign-in or
 * site page. No imports, so VS Code checks a pasted link with the same rules the updater uses.
 */
const fail = message => { throw new Error(message); };

/** An error about the source itself: the person fixes it by choosing another link or folder. */
export function sourceError(message, code) {
  return Object.assign(new Error(message), { code, sourceProblem: true });
}
export const FOLDER_LINK_NEEDED = 'Use the SharePoint folder link you were given to install SFlow: it opens the folder with the .tgz and .vsix, is shared with "Anyone with the link", and needs no sign-in.';
const SIGN_IN_HOSTS = /(?:^|\.)(?:login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|login\.microsoft\.com)$/iu;

export function folderUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('Give the HTTPS SharePoint folder link.'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('Use an HTTPS folder link without embedded credentials.');
  url.hash = '';
  return url.href;
}

/** The link a person gives: an HTTPS folder link, never a link to one file (SharePoint's /:x:/ kinds). */
export function shareLink(value) {
  let href;
  try { href = folderUrl(value); }
  catch (error) { throw sourceError('That is not a SharePoint link. ' + FOLDER_LINK_NEEDED, 'SOURCE_NOT_LINK'); }
  const kind = /\/:([a-z]):\//iu.exec(new URL(href).pathname)?.[1]?.toLowerCase();
  if (kind && kind !== 'f') throw sourceError('That link opens a single file, not a folder. ' + FOLDER_LINK_NEEDED, 'SOURCE_FILE_LINK');
  return href;
}

/** Why a landing page holds no folder: a sign-in page, or a SharePoint page that is not a shared folder. */
export function landingProblem(page, effectiveUrl) {
  let location = null;
  try { location = new URL(effectiveUrl); } catch { /* reported below as a page */ }
  const signIn = (location && (SIGN_IN_HOSTS.test(location.hostname)
      || /\/_forms\/|\/_layouts\/15\/(?:Authenticate|AccessDenied)\.aspx|\/_login\//iu.test(location.pathname)))
    || /login\.microsoftonline\.com|Sign in to your account|<form[^>]+(?:id|name)=["']?(?:loginForm|f1)\b/iu.test(page);
  if (signIn) {
    return sourceError('This link asks people to sign in, so the updater cannot download from it. '
      + 'It is probably shared only with people in your organisation. ' + FOLDER_LINK_NEEDED, 'SOURCE_SIGN_IN');
  }
  return sourceError('This link opens a SharePoint page, not a shared folder. ' + FOLDER_LINK_NEEDED, 'SOURCE_NOT_FOLDER');
}
