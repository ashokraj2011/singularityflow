/** SwiftPM conventions shared by intake, capability inspection and publication. */
export const SWIFT_TEST_REPORT_DIRECTORY = '.sflow/results/swift-tests';
export const SWIFT_TEST_REPORT_NAMES = Object.freeze(['tests.xml', 'tests-swift-testing.xml']);
export const SWIFT_TEST_ARGUMENTS = Object.freeze([
  'test', '--parallel', '--xunit-output', `${SWIFT_TEST_REPORT_DIRECTORY}/tests.xml`
]);

/** An Xcode project/workspace is a build signal, not a guessed scheme or simulator. */
export function isXcodeManifest(relative) {
  return /(?:^|\/)[^/]+\.xcodeproj\/project\.pbxproj$/u.test(relative)
    || /(?:^|\/)[^/]+\.xcworkspace\/contents\.xcworkspacedata$/u.test(relative);
}

/** Only the closed inferred report directory receives generated-output treatment. */
export function isInferredSwiftTestCommand(command) {
  if (!Array.isArray(command?.argv)) return false;
  const executable = String(command.argv?.[0] ?? '').replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  return ['swift', 'swift.exe'].includes(executable)
    && JSON.stringify(command.argv.slice(1)) === JSON.stringify(SWIFT_TEST_ARGUMENTS)
    && command.result?.adapter === 'junit-xml'
    && command.result?.path === SWIFT_TEST_REPORT_DIRECTORY;
}
