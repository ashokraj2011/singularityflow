import path from 'node:path';
import { lstat, readdir, rm } from 'node:fs/promises';
import { ensureSecureRepositoryDirectory, secureRepositoryPath, SingularityFlowError } from '../util.mjs';
import { trackedPaths } from '../git.mjs';
import { isInferredSwiftTestCommand, SWIFT_TEST_REPORT_NAMES } from '../swift-manifests.mjs';

/** Prepare the inferred SwiftPM pair without granting a directory-wide source exemption. */
export async function prepareInferredSwiftTestReports(root, command, { clear = false } = {}) {
  if (!isInferredSwiftTestCommand(command)) return;
  const relative = path.posix.join(String(command.workingDirectory ?? '.').replaceAll('\\', '/'), command.result.path);
  const target = await secureRepositoryPath(root, relative, { label: 'SwiftPM report directory' });
  if (clear) {
    // Readiness must never erase or amend selected Git-base inputs. Publication owns its own
    // transient staging/restore protocol and calls this helper only to create the output folder.
    if (trackedPaths(root, [relative]).length) throw new SingularityFlowError(
      'SwiftPM readiness requires an untracked generated report directory; tracked reports were preserved.',
      { code: 'SWIFT_TEST_REPORT_TARGET_UNSAFE', details: { path: relative } }
    );
    const entries = target.exists ? await readdir(target.absolute, { withFileTypes: true }) : [];
    // Inspect the entire pair before deleting either file. Unknown XML, nested output, links and
    // hard links are not inferred tool output and cannot be cleared or credited silently.
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()
          || /\.xml$/iu.test(entry.name) && !SWIFT_TEST_REPORT_NAMES.includes(entry.name)) {
        throw new SingularityFlowError('SwiftPM report directory contains unsupported output; existing files were preserved.', {
          code: 'SWIFT_TEST_REPORT_TARGET_UNSAFE', details: { path: path.posix.join(relative, entry.name) }
        });
      }
      if (SWIFT_TEST_REPORT_NAMES.includes(entry.name)) {
        const file = await secureRepositoryPath(root, path.posix.join(relative, entry.name), {
          label: 'SwiftPM generated report', mustExist: true, type: 'file'
        });
        const info = await lstat(file.absolute);
        if (info.nlink !== 1) throw new SingularityFlowError('SwiftPM report must not be hard-linked.', {
          code: 'SWIFT_TEST_REPORT_TARGET_UNSAFE', details: { path: path.posix.join(relative, entry.name) }
        });
      }
    }
    for (const name of SWIFT_TEST_REPORT_NAMES) {
      const file = await secureRepositoryPath(root, path.posix.join(relative, name), { label: 'SwiftPM generated report' });
      if (file.exists) await rm(file.absolute);
    }
  }
  await ensureSecureRepositoryDirectory(root, relative, { label: 'SwiftPM report directory' });
}
