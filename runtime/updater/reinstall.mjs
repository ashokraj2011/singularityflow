/** Removal hooks run inside the downloaded full-product installer's existing lease and recovery. */
const EXTENSION = 'singularityflow.singularity-flow-vscode';
const containsExtension = result => String(result.stdout || '').split(/\r?\n/u)
  .some(line => line.trim().toLowerCase().split('@')[0] === EXTENSION);

export function reinstallHooks({ runProcess, runNode, log = console.log }) {
  const observed = { vscode: false, copilot: false };
  function checked(command, args, options) {
    const result = runProcess(command, args, { ...options, allowFailure: true, stdio: 'pipe' });
    if (result.status !== 0) throw new Error('SFlow reinstallation failed: '
      + String(result.stderr || result.stdout || 'exit ' + result.status).trim());
    return result;
  }
  return {
    execute(command, args, options) {
      if (args[0] === '--install-extension') {
        log('Removing the existing SFlow VS Code extension before reinstalling…');
        if (containsExtension(checked(command, ['--list-extensions'], options))) {
          checked(command, ['--uninstall-extension', EXTENSION], options);
          if (containsExtension(checked(command, ['--list-extensions'], options))) {
            throw new Error('VS Code still reports the SFlow extension after removal. Close VS Code and run the updater again.');
          }
        }
        observed.vscode = true;
      }
      return runProcess(command, args, options);
    },
    async executeNode(command, args, options) {
      if (args[1] === 'plugin' && args[2] === 'install') {
        log('Removing the existing SFlow Copilot plugin and owned skills before reinstalling…');
        await runNode(command, [args[0], 'plugin', 'uninstall'], options);
        observed.copilot = true;
      }
      return runNode(command, args, options);
    },
    verify() {
      if (!observed.vscode || !observed.copilot) {
        throw new Error('The downloaded installer did not perform the requested SFlow reinstallation. No clean-reinstall completion was claimed. Use a compatible current CLI package.');
      }
    }
  };
}
