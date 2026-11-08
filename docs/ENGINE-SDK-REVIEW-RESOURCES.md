# Exact resources for a retained phase review

Registered `phase.review.resources` returns an explicit `sflow-phase-review-resources/v1` manifest.
It complements `phase.review` without changing that operation's input, output or existing native
CLI projection. The new query has one SDK registry entry and an explicit namespace read port.

```js
const { manifest } = await engine.run('phase.review.resources', { phaseId });
for (const resource of manifest.resources) {
  const { document } = await engine.run('document.read', { reference: resource.reference });
  // Display these exact retained bytes to the reviewer.
}
```

The first resource is the submitted review packet. Its companion is the actual authored artifact.
When routing inputs reuse earlier decisions, the same manifest includes those decisions' exact
submitted packets and artifacts, after verifying their retained human approval thresholds. No
client needs to infer packet IDs, physical files, worktree locations or another laptop's paths.

The namespace host obtains this resource set through one submission-proof traversal. It checks
the canonical document index against the retained hashes and generations, then rechecks the
current head, locator and authority before issuing the manifest. Reading does not create a
submission, record a human review, cast a vote or authorize a route.

A real current submitted review can return its fresh review binding. An approved historical phase
can expose its current-generation resources without becoming a new approval opportunity. Existing
`document.read` references still enforce their exact generation; after rework, clients request the
new manifest rather than rewriting old references. Older-generation receipt acknowledgement is a
separate approval concern.

An unprepared phase points to registered preparation; an already-published but unsubmitted phase
points to submission. A projection-only read head explicitly requires a canonical submission
owner. Real storage deadlines, permissions, missing content and changed-context errors retain
their original details. A missing or ambiguous catalog binding is reported as corruption with the
exact phase, generation, resource kind and expected content reference.

The shared kernel validates the manifest shape and references; the SDK owns coordination; SDA
owns content/record reads. Native Git review output remains on its existing registered route. The
new query does not route workflow decisions or finish the portable execution milestone. Versioned
routed approval outcomes, historical receipt recovery, human choices and bounded loops remain
required Phase 7 work, followed by existing-project migration and final cleanup/qualification.

## Mac qualification

On macOS 26.7.2 / Node 26.12.0, 121 distinct checks across nine affected files passed without
failures, cancellations or skips in their final runs. They cover actual filesystem, SQLite and
application-backed packet/artifact reads; original storage errors; a moved authority; malformed
references; generation guidance; existing review/document compatibility; exact pre-routing v1
approval bytes; and the installed package's separate-process and NodeNext checks. The complete
reused-routing journey still needs the routed approval owner.

Source validation passed 3,828 checks across 191 skills, VS Code typechecking passed, and the Git
ownership audit retained its existing 2,011 process/Git sites. All 13 bundle budgets passed with
unchanged limits: gateway 851 modules / 6,859,900 bytes; extension 152 modules / 1,290,541 bytes.
The SDK preview contains 50 registry operations, 114 owned modules and 1,180,833 runtime bytes.
These are artifact and local compatibility measurements, not full application-Story qualification.
