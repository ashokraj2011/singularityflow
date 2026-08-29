import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GVM_OPCODES,
  compileSgosProgram,
  explainSgosProgram,
  registrySnapshotDigest,
  simulateSgosProgram
} from '../src/sgos/compiler.mjs';
import {
  createIntentIr,
  createWorkflowIr,
  createWorkflowRatification,
  validateGvmProgram
} from '../src/sgos/contracts.mjs';
import { recordSha256 } from '../src/records.mjs';

const POLICY_SHA = `sha256:${'1'.repeat(64)}`;
const STORAGE_SHA = `sha256:${'3'.repeat(64)}`;
const OBJECTIVE_ID = 'INT-COPY-MESSAGE:objective';
const MANIFEST_SHA = `sha256:${'8'.repeat(64)}`;

const DEFAULT_OPERATION_IDS = Object.freeze([
  'core.copy', 'core.equals', 'core.orphan', 'core.a', 'core.b', 'core.stranded',
  'core.verify', 'device.unregistered'
]);

function registryEntry(id, extra = {}) {
  return { id, version: '1', status: 'active', manifestSha256: MANIFEST_SHA, ...extra };
}

function registrySnapshot({ operations = DEFAULT_OPERATION_IDS, taskKinds = [], devices = [] } = {}) {
  const core = {
    kind: 'registry-snapshot',
    operations: operations.map((entry) => typeof entry === 'string' ? registryEntry(entry) : entry),
    taskKinds: taskKinds.map((entry) => typeof entry === 'string' ? registryEntry(entry) : entry),
    devices: devices.map((entry) => typeof entry === 'string' ? registryEntry(entry) : entry)
  };
  return { ...core, registrySnapshotSha256: registrySnapshotDigest(core) };
}

const DEFAULT_REGISTRY_SNAPSHOT = registrySnapshot();
const REGISTRY_SHA = DEFAULT_REGISTRY_SNAPSHOT.registrySnapshotSha256;

function digest(value, field) {
  const copy = structuredClone(value);
  delete copy[field];
  delete copy.recordSha256;
  return `sha256:${recordSha256(copy)}`;
}

function seal(value, field) {
  const record = structuredClone(value);
  record[field] = digest(record, field);
  return record;
}

function baseTask(overrides = {}) {
  const defaults = {
    kind: 'task',
    opcode: 'KERNEL',
    operation: 'core.copy',
    dependsOn: [],
    inputs: [{ ref: 'input:message' }],
    outputs: [{ ref: 'artifact:message-copy' }],
    resources: {
      reads: ['input:message'],
      writes: ['artifact:message-copy'],
      devices: [],
      externalEffects: []
    },
    evidence: { required: ['candidate', 'verification-result'] },
    authority: {},
    recovery: {},
    metadata: { operationVersion: '1', verification: { kind: 'kernel', operation: 'core.equals' } },
    retry: { maximumAttempts: 1 },
    policySnapshotSha256: POLICY_SHA,
    material: true,
    intentClauseIds: [OBJECTIVE_ID]
  };
  return {
    ...defaults,
    ...overrides,
    resources: { ...defaults.resources, ...(overrides.resources ?? {}) },
    metadata: { ...defaults.metadata, ...(overrides.metadata ?? {}) }
  };
}

function fixture({
  mutateIntent, mutateWorkflow, mutateRatification,
  registrySnapshot: suppliedRegistrySnapshot = DEFAULT_REGISTRY_SNAPSHOT
} = {}) {
  const selectedRegistrySnapshot = suppliedRegistrySnapshot == null
    ? null
    : structuredClone(suppliedRegistrySnapshot);
  const registrySha256 = selectedRegistrySnapshot?.registrySnapshotSha256 ?? REGISTRY_SHA;
  let intentIr = {
    schemaVersion: 1,
    kind: 'intent-ir',
    intentId: 'INT-COPY-MESSAGE',
    generation: 1,
    objective: {
      statement: 'Copy the input message exactly.',
      provenance: 'human-confirmed'
    },
    outcomes: [],
    successCriteria: [{
      clauseId: 'REQ-SUCCESS',
      statement: 'The copied output equals the input byte for byte.',
      provenance: 'explicit',
      required: true
    }],
    constraints: [],
    invariants: [],
    preferences: [],
    nonGoals: [],
    assumptions: [],
    unknowns: [],
    contradictions: [],
    risks: [],
    subjects: [],
    evidenceExpectations: [],
    authorityRequirements: [],
    budgets: [],
    domainCandidates: [],
    workTypeCandidates: []
  };
  mutateIntent?.(intentIr);
  intentIr = seal(intentIr, 'intentIrSha256');

  let workflow = {
    schemaVersion: 1,
    apiVersion: 'sflow/v1',
    kind: 'workflow-ir',
    workflowId: 'WFL-COPY-MESSAGE',
    version: '1',
    intentIrSha256: intentIr.intentIrSha256,
    policySnapshotSha256: POLICY_SHA,
    metadata: { id: 'copy-message', version: '1', domainPack: 'core@1' },
    spec: {
      inputs: { message: { schema: 'string' } },
      tasks: {
        copy: baseTask(),
        end: { kind: 'end', dependsOn: ['copy'], material: false }
      },
      joins: {},
      terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts: 1 },
      recovery: {},
      evidence: {},
      authority: {},
      storageRequirements: { profileSha256: STORAGE_SHA }
    }
  };
  mutateWorkflow?.(workflow);
  workflow = seal(workflow, 'workflowSha256');

  let ratification = {
    schemaVersion: 1,
    kind: 'workflow-ratification',
    ratificationId: 'RAT-COPY-MESSAGE',
    decision: 'ratified',
    intentIrSha256: intentIr.intentIrSha256,
    workflowSha256: workflow.workflowSha256,
    policySnapshotSha256: POLICY_SHA,
    registrySnapshotSha256: registrySha256,
    storageProfileSha256: STORAGE_SHA,
    packetSha256: `sha256:${'4'.repeat(64)}`,
    principal: { id: 'person:ashok', kind: 'human' },
    decidedAt: '2026-08-29T00:00:00.000Z',
    coverage: {
      clauses: {
        [OBJECTIVE_ID]: [{ kind: 'task', targetId: 'copy' }],
        'REQ-SUCCESS': [{ kind: 'evidence-contract', targetId: 'copy' }]
      },
      tasks: {
        copy: [{ kind: 'intent-clause', sourceId: OBJECTIVE_ID }]
      }
    }
  };
  mutateRatification?.(ratification);
  ratification = seal(ratification, 'ratificationSha256');

  return {
    intentIr,
    workflow,
    ratification,
    policySnapshotSha256: POLICY_SHA,
    registrySnapshotSha256: registrySha256,
    storageProfileSha256: STORAGE_SHA,
    ...(selectedRegistrySnapshot ? { registrySnapshot: selectedRegistrySnapshot } : {})
  };
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, code, error?.stack);
    return true;
  });
}

test('same confirmed inputs compile to the same canonical finite Program', () => {
  const firstInput = fixture();
  const untouched = structuredClone(firstInput);
  const first = compileSgosProgram(firstInput);

  // Reconstruct objects in a different insertion order; canonical identity must not care.
  const reordered = fixture({
    mutateWorkflow(workflow) {
      workflow.spec.tasks = {
        end: workflow.spec.tasks.end,
        copy: workflow.spec.tasks.copy
      };
      workflow.metadata = {
        domainPack: workflow.metadata.domainPack,
        version: workflow.metadata.version,
        id: workflow.metadata.id
      };
    }
  });
  const second = compileSgosProgram(reordered);

  assert.deepEqual(first.program, second.program);
  assert.equal(first.program.programSha256, second.program.programSha256);
  assert.equal(first.program.programId, second.program.programId);
  assert.deepEqual(first.program.taskTemplates.map((task) => task.taskTemplateId), ['copy', 'end']);
  assert.deepEqual(first.program.edges.map(({ from, to }) => [from, to]), [['copy', 'end']]);
  assert.deepEqual(firstInput, untouched, 'the compiler must not mutate its confirmed inputs');
  assert.deepEqual(GVM_OPCODES, [
    'KERNEL', 'AGENT', 'DEVICE', 'VERIFY', 'HUMAN_REQUEST', 'JOIN',
    'MERGE', 'CHECKPOINT', 'SPAWN', 'COMPENSATE', 'NOOP', 'END'
  ]);
});

test('contract-created Intent/Workflow/Ratification compile to a contract-valid Program', () => {
  const intentIr = createIntentIr({
    generation: 1,
    objective: { statement: 'Copy the message exactly.', provenance: 'human-confirmed' },
    outcomes: [],
    successCriteria: [{
      clauseId: 'REQ-SUCCESS',
      statement: 'Copied bytes equal input bytes.',
      provenance: 'explicit',
      required: true
    }],
    constraints: [], invariants: [], preferences: [], nonGoals: [], assumptions: [],
    unknowns: [], contradictions: [], risks: [], evidenceExpectations: [],
    authorityRequirements: [], budgets: [], domainCandidates: [], workTypeCandidates: [], subjects: []
  });
  const objectiveId = `${intentIr.intentId}:objective`;
  const coverage = {
    clauses: {
      [objectiveId]: [{ kind: 'task', targetId: 'copy' }],
      'REQ-SUCCESS': [{ kind: 'evidence-contract', targetId: 'copy' }]
    },
    tasks: { copy: [{ kind: 'intent-clause', sourceId: objectiveId }] }
  };
  const workflow = createWorkflowIr({
    apiVersion: 'sflow/v1',
    version: '1',
    intentIrSha256: intentIr.intentIrSha256,
    policySnapshotSha256: POLICY_SHA,
    metadata: { id: 'copy-message', version: '1', domainPack: 'core' },
    spec: {
      inputs: { message: { type: 'string' } },
      tasks: {
        copy: {
          kind: 'task', opcode: 'KERNEL', operation: 'core.copy', dependsOn: [],
          resources: {
            reads: ['input:message'], writes: ['artifact:message-copy'], devices: [], externalEffects: []
          },
          evidence: { required: ['candidate', 'verification-result'] },
          authority: {}, recovery: {}, intentClauseIds: [objectiveId], material: true,
          metadata: { operationVersion: '1', verification: { kind: 'kernel', operation: 'core.equals' } },
          inputs: [{ ref: 'input:message' }], outputs: [{ ref: 'artifact:message-copy' }],
          retry: { maximumAttempts: 1 }, policySnapshotSha256: POLICY_SHA
        },
        end: { kind: 'end', opcode: 'END', dependsOn: ['copy'], material: false }
      },
      joins: {},
      terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts: 1 }, recovery: {}, evidence: {}, authority: {},
      storageRequirements: { profileSha256: STORAGE_SHA },
      intentWorkflowMap: coverage
    }
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: intentIr.intentIrSha256,
    workflowSha256: workflow.workflowSha256,
    policySnapshotSha256: POLICY_SHA,
    registrySnapshotSha256: REGISTRY_SHA,
    storageProfileSha256: STORAGE_SHA,
    packetSha256: `sha256:${'4'.repeat(64)}`,
    decision: 'ratified',
    principal: { id: 'person:ashok', kind: 'human' },
    coverage,
    decidedAt: '2026-08-29T00:00:00.000Z'
  });

  const { program } = compileSgosProgram({
    intentIr, workflow, ratification,
    policySnapshotSha256: POLICY_SHA,
    registrySnapshotSha256: REGISTRY_SHA,
    storageProfileSha256: STORAGE_SHA,
    registrySnapshot: DEFAULT_REGISTRY_SNAPSHOT
  });

  assert.deepEqual(validateGvmProgram(program), program);
  assert.equal(program.taskTemplates[0].operation, 'core.copy');
  assert.deepEqual(program.edges, [{ from: 'copy', to: 'end' }]);
  assert.deepEqual(program.joins, []);
});

test('explain and simulate are pure, deterministic compiler views', () => {
  const compiled = compileSgosProgram(fixture());
  const explanation = explainSgosProgram(compiled.program);
  const simulation = simulateSgosProgram(compiled.program);

  assert.deepEqual(explanation, compiled.explanation);
  assert.equal(explanation.deterministic, true);
  assert.deepEqual(explanation.graph.topologicalOrder, ['copy', 'end']);
  assert.deepEqual(simulation.waves, [['copy'], ['end']]);
  assert.deepEqual(simulation.terminalTaskIds, ['end']);
  assert.equal(simulation.bounded, true);
});

test('model-proposed clauses remain non-normative until confirmed', () => {
  const request = fixture({
    mutateIntent(intent) {
      intent.risks.push({
        clauseId: 'RISK-MODEL-ONLY',
        statement: 'A model-only possibility.',
        provenance: 'model-proposed'
      });
    }
  });
  const compiled = compileSgosProgram(request);
  assert.equal(compiled.program.kind, 'gvm-program');
  assert.equal(compiled.program.taskTemplates.some((task) =>
    task.intentClauseIds.includes('RISK-MODEL-ONLY')), false);
});

test('required confirmed intent clause must be mapped', () => {
  expectCode(() => compileSgosProgram(fixture({
    mutateRatification(ratification) {
      ratification.coverage.clauses['REQ-SUCCESS'] = [];
    }
  })), 'SGOS_INTENT_CLAUSE_UNMAPPED');
});

test('material orphan task is refused', () => {
  expectCode(() => compileSgosProgram(fixture({
    mutateWorkflow(workflow) {
      workflow.spec.tasks.orphan = baseTask({
        operation: 'core.orphan',
        dependsOn: ['copy'],
        resources: { reads: ['artifact:message-copy'], writes: ['artifact:orphan'], externalEffects: [] },
        intentClauseIds: []
      });
      workflow.spec.tasks.end.dependsOn = ['orphan'];
      workflow.spec.budgets.maximumTasks = 3;
    }
  })), 'SGOS_ORPHAN_TASK');
});

test('unknown task kind and unknown closed opcode are refused', async (t) => {
  await t.test('task kind', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        workflow.spec.tasks.copy.kind = 'mystery-operation';
        delete workflow.spec.tasks.copy.opcode;
      }
    })), 'SGOS_WORKFLOW_CONTRACT_INVALID');
  });
  await t.test('opcode', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        workflow.spec.tasks.copy.opcode = 'TELEPORT';
      }
    })), 'SGOS_WORKFLOW_CONTRACT_INVALID');
  });
});

test('unknown registered device is refused', () => {
  expectCode(() => compileSgosProgram(fixture({
    registrySnapshot: registrySnapshot({ devices: ['device.approved'] }),
    mutateWorkflow(workflow) {
      workflow.spec.tasks.copy = baseTask({
        kind: 'task',
        opcode: 'DEVICE',
        operation: 'device.unregistered'
      });
    }
  })), 'SGOS_DEVICE_UNKNOWN');
});

test('unbounded fan-out and loops are refused', async (t) => {
  await t.test('fan-out', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        workflow.spec.tasks.copy.kind = 'foreach';
        delete workflow.spec.tasks.copy.opcode;
      }
    })), 'SGOS_UNBOUNDED_CONSTRUCT');
  });
  await t.test('loop', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        workflow.spec.tasks.copy.kind = 'bounded-loop';
        delete workflow.spec.tasks.copy.opcode;
      }
    })), 'SGOS_UNBOUNDED_CONSTRUCT');
  });
});

test('unsafe unordered writes are refused before dispatch can race', () => {
  expectCode(() => compileSgosProgram(fixture({
    mutateWorkflow(workflow) {
      workflow.spec.tasks = {
        a: baseTask({
          operation: 'core.a',
          resources: { reads: [], writes: ['workspace:/shared/**'], externalEffects: [] },
          intentClauseIds: [OBJECTIVE_ID]
        }),
        b: baseTask({
          operation: 'core.b',
          resources: { reads: [], writes: ['workspace:/shared/file.txt'], externalEffects: [] },
          intentClauseIds: ['REQ-SUCCESS']
        }),
        end: { kind: 'end', dependsOn: ['a', 'b'], material: false }
      };
      workflow.spec.budgets.maximumTasks = 3;
    },
    mutateRatification(ratification) {
      ratification.coverage = {
        clauses: {
          [OBJECTIVE_ID]: [{ kind: 'task', targetId: 'a' }],
          'REQ-SUCCESS': [{ kind: 'task', targetId: 'b' }]
        },
        tasks: {
          a: [{ kind: 'intent-clause', sourceId: OBJECTIVE_ID }],
          b: [{ kind: 'intent-clause', sourceId: 'REQ-SUCCESS' }]
        }
      };
    }
  })), 'SGOS_PARALLEL_WRITE_CONFLICT');
});

test('material task without evidence is refused', () => {
  expectCode(() => compileSgosProgram(fixture({
    mutateWorkflow(workflow) {
      workflow.spec.tasks.copy.evidence = {};
    }
  })), 'SGOS_EVIDENCE_REQUIRED');
});

test('human judgment without exact authority is refused', () => {
  expectCode(() => compileSgosProgram(fixture({
    mutateWorkflow(workflow) {
      workflow.spec.tasks.copy = baseTask({
        kind: 'human-request',
        opcode: 'HUMAN_REQUEST',
        authority: {},
        metadata: { verification: { kind: 'human-judgment' } }
      });
    }
  })), 'SGOS_HUMAN_AUTHORITY_REQUIRED');
});

test('external effect without recovery is refused', () => {
  expectCode(() => compileSgosProgram(fixture({
    mutateWorkflow(workflow) {
      workflow.spec.tasks.copy.resources.externalEffects = ['external:message-send'];
      workflow.spec.tasks.copy.recovery = {};
    }
  })), 'SGOS_EXTERNAL_EFFECT_RECOVERY_REQUIRED');
});

test('cycles and paths that cannot reach END are refused', async (t) => {
  await t.test('cycle', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        workflow.spec.tasks.copy.dependsOn = ['end'];
      }
    })), 'SGOS_GRAPH_CYCLE');
  });
  await t.test('no END', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        delete workflow.spec.tasks.end;
        workflow.spec.terminalConditions = [];
      }
    })), 'SGOS_TERMINAL_UNREACHABLE');
  });
  await t.test('stranded path', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        workflow.spec.tasks.stranded = baseTask({
          operation: 'core.stranded',
          resources: { reads: ['input:other'], writes: ['artifact:other'], externalEffects: [] },
          intentClauseIds: ['REQ-SUCCESS']
        });
        workflow.spec.budgets.maximumTasks = 3;
      },
      mutateRatification(ratification) {
        ratification.coverage.tasks.stranded = [{ kind: 'intent-clause', sourceId: 'REQ-SUCCESS' }];
      }
    })), 'SGOS_TERMINAL_UNREACHABLE');
  });
});

test('ratification and pinned snapshot drift are refused', async (t) => {
  await t.test('not ratified', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateRatification(ratification) { ratification.decision = 'changes-requested'; }
    })), 'SGOS_WORKFLOW_NOT_RATIFIED');
  });
  await t.test('policy drift', () => {
    const request = fixture();
    request.policySnapshotSha256 = `sha256:${'9'.repeat(64)}`;
    expectCode(() => compileSgosProgram(request), 'SGOS_WORKFLOW_POLICY_MISMATCH');
  });
});

test('compiler validates the complete strict SGOS input contracts', async (t) => {
  await t.test('Intent IR', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateIntent(intent) { intent.compilerOnlyAlias = true; }
    })), 'SGOS_INTENT_CONTRACT_INVALID');
  });
  await t.test('Workflow IR', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { workflow.spec.compilerOnlyAlias = {}; }
    })), 'SGOS_WORKFLOW_CONTRACT_INVALID');
  });
  await t.test('Workflow Ratification', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateRatification(ratification) { ratification.approved = true; }
    })), 'SGOS_RATIFICATION_CONTRACT_INVALID');
  });
});

test('actual pinned registry snapshot content is mandatory and canonical', async (t) => {
  await t.test('digest without content', () => {
    expectCode(() => compileSgosProgram(fixture({ registrySnapshot: null })),
      'SGOS_REGISTRY_SNAPSHOT_REQUIRED');
  });
  await t.test('empty operation catalog', () => {
    expectCode(() => compileSgosProgram(fixture({
      registrySnapshot: registrySnapshot({ operations: [] })
    })), 'SGOS_REGISTRY_CATALOG_EMPTY');
  });
  await t.test('content drift from pinned digest', () => {
    const drifted = structuredClone(DEFAULT_REGISTRY_SNAPSHOT);
    drifted.operations[0].version = '2';
    expectCode(() => compileSgosProgram(fixture({ registrySnapshot: drifted })),
      'SGOS_PINNED_REGISTRY_MISMATCH');
  });
  await t.test('malformed catalog entry', () => {
    const malformed = structuredClone(DEFAULT_REGISTRY_SNAPSHOT);
    malformed.operations[0].ambientCapability = true;
    expectCode(() => compileSgosProgram(fixture({ registrySnapshot: malformed })),
      'SGOS_REGISTRY_SNAPSHOT_INVALID');
  });
});

test('every executable and verification operation must exist in the pinned registry', async (t) => {
  await t.test('primary operation', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { workflow.spec.tasks.copy.operation = 'core.unknown'; }
    })), 'SGOS_TASK_OPERATION_UNKNOWN');
  });
  await t.test('verification operation', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        workflow.spec.tasks.copy.metadata.verification.operation = 'core.unknown-verifier';
      }
    })), 'SGOS_TASK_OPERATION_UNKNOWN');
  });
});

test('control flow unsupported by the runtime is rejected at compile time', async (t) => {
  await t.test('conditional task edge', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { workflow.spec.tasks.copy.condition = { when: 'runtime-value' }; }
    })), 'SGOS_CONDITIONAL_EDGE_UNSUPPORTED');
  });
  await t.test('explicit edge vocabulary is closed', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) {
        workflow.spec.edges = [{ from: 'copy', to: 'end', condition: { when: 'runtime-value' } }];
      }
    })), 'SGOS_WORKFLOW_CONTRACT_INVALID');
  });
  await t.test('declared join contract', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { workflow.spec.joins = { all: { mode: 'all' } }; }
    })), 'SGOS_OPCODE_RUNTIME_UNSUPPORTED');
  });
  for (const [kind, opcode] of [
    ['join', 'JOIN'],
    ['merge', 'MERGE'],
    ['subprocess', 'SPAWN'],
    ['compensation', 'COMPENSATE']
  ]) {
    await t.test(opcode, () => {
      expectCode(() => compileSgosProgram(fixture({
        mutateWorkflow(workflow) {
          workflow.spec.tasks.copy.kind = kind;
          workflow.spec.tasks.copy.opcode = opcode;
        }
      })), 'SGOS_OPCODE_RUNTIME_UNSUPPORTED');
    });
  }
});

test('task-count and retry ceilings are enforced at compile time', async (t) => {
  await t.test('maximumTasks is required', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { delete workflow.spec.budgets.maximumTasks; }
    })), 'SGOS_MAXIMUM_TASKS_REQUIRED');
  });
  await t.test('task count cannot exceed maximumTasks', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { workflow.spec.budgets.maximumTasks = 1; }
    })), 'SGOS_MAXIMUM_TASKS_EXCEEDED');
  });
  await t.test('workflow retry ceiling is required', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { delete workflow.spec.budgets.maximumAttempts; }
    })), 'SGOS_RETRY_CEILING_REQUIRED');
  });
  await t.test('task retry ceiling is required', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { workflow.spec.tasks.copy.retry = {}; }
    })), 'SGOS_RETRY_CEILING_REQUIRED');
  });
  await t.test('task retry cannot exceed workflow ceiling', () => {
    expectCode(() => compileSgosProgram(fixture({
      mutateWorkflow(workflow) { workflow.spec.tasks.copy.retry.maximumAttempts = 2; }
    })), 'SGOS_RETRY_CEILING_EXCEEDED');
  });
});

test('hash-affecting task and edge order uses defined Unicode code-point order', () => {
  const make = (reverse) => fixture({
    mutateWorkflow(workflow) {
      const upper = baseTask({
        operation: 'core.a', resources: { reads: [], writes: ['artifact:upper'] }
      });
      const lower = baseTask({
        operation: 'core.b', resources: { reads: [], writes: ['artifact:lower'] },
        intentClauseIds: ['REQ-SUCCESS']
      });
      workflow.spec.tasks = reverse
        ? { end: { kind: 'end', dependsOn: ['a-copy', 'Z-copy'], material: false }, 'a-copy': lower, 'Z-copy': upper }
        : { 'Z-copy': upper, 'a-copy': lower, end: { kind: 'end', dependsOn: ['a-copy', 'Z-copy'], material: false } };
      const privateUse = { taskTemplateId: 'end', state: 'succeeded', label: '\uE000' };
      const supplementary = { taskTemplateId: 'end', state: 'succeeded', label: '😀' };
      workflow.spec.terminalConditions = [supplementary, privateUse];
      workflow.spec.budgets.maximumTasks = 3;
    },
    mutateRatification(ratification) {
      ratification.coverage = {
        clauses: {
          [OBJECTIVE_ID]: [{ kind: 'task', targetId: 'Z-copy' }],
          'REQ-SUCCESS': [{ kind: 'task', targetId: 'a-copy' }]
        },
        tasks: {
          'Z-copy': [{ kind: 'intent-clause', sourceId: OBJECTIVE_ID }],
          'a-copy': [{ kind: 'intent-clause', sourceId: 'REQ-SUCCESS' }]
        }
      };
    }
  });
  const first = compileSgosProgram(make(false)).program;
  const second = compileSgosProgram(make(true)).program;
  assert.deepEqual(first.taskTemplates.map((task) => task.taskTemplateId), ['Z-copy', 'a-copy', 'end']);
  assert.deepEqual(first.edges, [
    { from: 'Z-copy', to: 'end' },
    { from: 'a-copy', to: 'end' }
  ]);
  assert.deepEqual(first.terminalConditions.map((condition) => condition.label), ['\uE000', '😀']);
  assert.equal(first.programSha256, second.programSha256);
});
