/**
 * SF Guard's stamping hook as exact frontmatter text [SPEC-SFG-v1 D4]. An agent file with no hooks of
 * its own gets this block just before its closing `---`, and nothing else in the file changes, so a
 * packaged agent stays recognisably packaged: identity reads the file without the block.
 */
export { withoutSfGuardStampBlock } from '../agent-document-parser.mjs';

/** The block for `hooks` (sfGuardStampingHooks' value): JSON strings are YAML double-quoted scalars. */
export function sfGuardStampBlockText(hooks) {
  const lines = ['hooks:'];
  for (const [event, entries] of Object.entries(hooks)) {
    lines.push(`  ${event}:`);
    for (const entry of entries) {
      Object.entries(entry).forEach(([key, value], index) => lines.push(`${index ? '      ' : '    - '}${key}: ${typeof value === 'string' && key !== 'type' ? JSON.stringify(value) : value}`));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** `text` with `block` inserted before the frontmatter's closing `---`, or null when it has none. */
export function withSfGuardStampBlock(text, block) {
  const opening = /^﻿?---\r?\n/u.exec(text);
  if (!opening) return null;
  const closing = /\r?\n---(?:\r?\n|$)/u.exec(text.slice(opening[0].length));
  if (!closing) return null;
  const at = opening[0].length + closing.index + closing[0].indexOf('---');
  return `${text.slice(0, at)}${block}${text.slice(at)}`;
}
