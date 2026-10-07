/** Project a normalized runner without disclosing arbitrary approved command arguments. */
export function projectTestExecutionCommand(command, { configuredIndex = -1, testPolicy = null } = {}) {
  const configured = configuredIndex >= 0;
  return {
    id: configured ? `qualityCommands[${configuredIndex}]` : command.id,
    availability: 'ready',
    argv: configured ? null : command.argv,
    argvWithheld: configured,
    argvSource: configured ? 'approved-configuration' : 'inferred',
    workingDirectory: command.workingDirectory,
    affectedRoots: command.affectedRoots,
    result: {
      adapter: command.result.adapter,
      path: command.result.path,
      minimumDiscovered: Math.max(command.result.minimumDiscovered, testPolicy?.minimumDiscovered ?? 1),
      minimumPassed: Math.max(command.result.minimumPassed, testPolicy?.minimumPassed ?? 1)
    }
  };
}

/**
 * Runner availability is not test success or phase readiness. Execution stays in the existing
 * publication/submission transaction, which owns freshness, isolation and failure handling.
 * A caller may supply a command only after the corresponding lifecycle readiness check passes.
 */
export function testExecutionHandoff(testExecution, { published = false, command = null } = {}) {
  if (testExecution.status === 'not-required') return {
    runnerStatus: 'not-required', configurationRequired: false,
    executionOwner: null, command: null, onSuccess: null, guidance: null
  };
  const available = testExecution.status === 'not-run' && testExecution.commands?.length > 0
    && testExecution.commands.every((entry) => entry.availability === 'ready');
  if (!available) return {
    runnerStatus: 'unavailable', configurationRequired: null,
    executionOwner: null, command: null, onSuccess: null,
    guidance: 'Follow the reported runner or lifecycle repair action; no executable test handoff is ready.'
  };
  const owner = published ? 'submission' : 'publication';
  return {
    runnerStatus: 'ready', configurationRequired: false,
    executionOwner: owner, command, onSuccess: `continue-${owner}`,
    guidance: `The runner is resolved. argv: null with argvWithheld: true means approved arguments are hidden, not missing; do not request configuration adoption for this. ${published
      ? 'Use the returned submit route only when submission readiness permits it; do not republish an unchanged generation.'
      : 'Use returned commands.publish when prepublish is ready.'} ${owner === 'publication' ? 'Publication' : 'Submission'} runs the exact resolved command and validates fresh results, then continues automatically when required tests pass. Do not stop for runner adoption or repeat a separate test run merely because arguments are withheld. Tests do not waive other findings or required human approval.`
  };
}
