/**
 * A step's next version opens only on the person's yes, the agent's own correction too (owner, 2026-11-17)
 * [D3, OSA:REQ-030]. Its preview (`phase rollover <step> --json`) asks the question, and the person confirms it in
 * their own terminal (`phase rollover <step> --confirm <confirmation>`), outside every Copilot turn; then the step is
 * prepared or begun as before. Tests that walk a Story through a return, a reopen or an amendment open a published
 * step's next version this way.
 *
 * `cli(...args)` runs the CLI and returns its stdout, or a spawn result with `stdout`. `extra` (for example
 * `'--work-id', id`) goes on both commands. Returns the preview the person answered.
 */
export function confirmNextVersion(cli, step, ...extra) {
  const text = (result) => (typeof result === 'string' ? result : String(result?.stdout ?? ''));
  const json = (output) => JSON.parse(output.slice(Math.max(0, output.search(/^\s*\{/mu))));
  const preview = json(text(cli('phase', 'rollover', step, ...extra, '--json')));
  if (typeof preview.confirmation !== 'string' || !/^Start version \d+ of /u.test(preview.question ?? '')) {
    throw new Error(`The preview of ${step}'s next version asked nothing: ${JSON.stringify(preview).slice(0, 600)}`);
  }
  cli('phase', 'rollover', step, '--confirm', preview.confirmation, ...extra, '--json');
  return preview;
}
