/**
 * JSON whose bytes read the same in every code page.
 *
 * Windows PowerShell decodes a native command's output with the console's code page whenever it
 * captures it (`2>&1`, a pipe, a variable, a hook launcher), and that is an OEM code page unless the
 * machine opted into UTF-8. A UTF-8 path such as `C:\Users\José` then reaches the agent as
 * `C:\Users\JosÃ©` or `C:\Users\Jos├⌐`, and the agent opens a file that does not exist. Outside a
 * string JSON is ASCII already, so escaping every other character as `\uXXXX` leaves bytes any code
 * page decodes alike, and a parser reads the same values. Other platforms keep readable UTF-8.
 */
export function codePageSafeJson(text, platform = process.platform) {
  if (platform !== 'win32' || !/[^\x00-\x7f]/u.test(text)) return text;
  return text.replace(/[^\x00-\x7f]/gu, (character) => Array.from({ length: character.length },
    (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''));
}
