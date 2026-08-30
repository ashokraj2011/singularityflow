# SGOS assurance-classified simulation

SGOS Program simulation is a pure read of one immutable `gvm-program`. It computes the finite task
order, dependency-based critical path, parallel waves, human stops, declared Devices and external
effects, storage resources, blast radius, dependency availability gaps, and declared failure and
recovery routes. It never starts an Execution Unit, invokes a Device, reads live credentials, calls a
model, changes a Process, or writes Git.

The public model-free API is:

```js
import {
  simulateSgosProgramAssurance,
  whatIfSgosProgram,
  planSgosProgramFault
} from 'singularity-flow/sgos';

const simulation = simulateSgosProgramAssurance(program);
const removal = whatIfSgosProgram(program, {
  withoutDeviceIds: ['snowflake']
});
const faultPlan = planSgosProgramFault(program, {
  target: { kind: 'device', id: 'snowflake' },
  failure: 'timeout'
});
```

`simulateSgosProgram` remains compatible and now returns the same enriched report while preserving
its original `waves`, `topologicalOrder`, `maximumReadyWidth`, `terminalTaskIds`, and
`receiptRequiredTaskIds` fields.

Every operational claim is classified as `deterministically-proven`, `historically-estimated`,
`model-advised`, or `unknown`. This first release deliberately produces only deterministic and
unknown claims. It does not invent cost or time estimates. Runtime adapter availability, live
storage capacity, reachable network systems, and recovery success stay `unknown` because they
cannot be proven from Program bytes alone.

What-if analysis removes only exact, declared Device IDs and reports the directly blocked tasks,
their transitive successors, unaffected tasks, and blocked terminal tasks. Fault planning accepts
only a closed failure vocabulary and an exact task or Device target. It produces a plan; it does not
inject the fault.

Deliberately unsupported in this slice:

- Process replay or Process-state fault injection;
- historical estimators or model-advised projections;
- live registry, credential, network, storage-capacity, or adapter probes;
- callbacks, custom failure strings, arbitrary selectors, or executable simulation extensions;
- claims that a declared retry or recovery route will succeed.

All reports are deterministic, content-addressed, frozen, and bounded by the installed SGOS Program
and record byte ceilings.
