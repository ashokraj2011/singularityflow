# Artifact template content rules

Artifact token admission, legacy token compatibility, traceability namespace substitution and
rendering have one pure owner in `src/kernel/artifact-content.mjs`. Native configuration APIs
re-export those same functions. Checkout loading and retained-resource verification remain with
their host; the rules receive already supplied text and logical Story/phase values.

The installable SDK exposes these rules through `@singularity-flow/engine-sdk/artifacts`:

```js
import { renderArtifactTemplateText } from '@singularity-flow/engine-sdk/artifacts';

const draftText = renderArtifactTemplateText(retainedTemplateText, pinnedPhase, {
  id: workId, title, workType: workflowId, inputs: approvedInputsText
});
```

The helper replaces the existing six artifact tokens and traceability namespaces, preserving
the supplied template's content. It adds no model instructions or generated prose. Model prompt
composition, template selection, source reads, machine-local draft persistence, authorization
and final publication checks remain separate responsibilities. The text result is an unfinished
artifact, not evidence that authoring, tests, human review or publication succeeded.

Namespace configuration approval now applies the same token rule to every referenced artifact
template before accepting the configuration. It verifies the real retained bytes and reports the
exact template/phase and original error for an unsupported token. Each used template is checked
once, even when many workflows share it. Agent/skill/instruction bodies and unrelated configuration
files retain their own syntax. Valid configuration bytes, approval identities, immutable decisions
and replay protocols keep their existing meaning.

Pre-extraction native function-body hashes and rendered hashes were captured from `d78273423`.
The regression fixture covers all 18 shipped workflows and 85 effective phase templates. Tests
compare both the original bodies and actual rendered bytes, including template source hashes;
native compatibility exports must have the same function identities. The installed package is
also exercised outside the checkout with no programs on PATH, under an infrastructure-import
guard, and its NodeNext declarations are compiled in the consumer.

Mac qualification exercised 171 tests across eleven files, including source/bundled CLI
preparation and approved-input parity, native template conformance and the installed archive.
The initial run passed 168 and exposed one stale import guard plus two parity captures which
observed a later `story.next` query instead of the target operation. The guard now names the
exact pure dependency, and the test-only capture can select its registered operation without
changing execution or results. All 53 architecture/input-parity rechecks passed. A final 46-test
template/approval run, including retained agent-backed templates, and two real guide/next parity
checks also passed without failures, cancellations or skips. These suites overlap.

Source validation passed 3,797 checks across 191 skills, three agents and two extensions. VS Code
typechecking and the unchanged 2,011-site Git ownership audit passed. All thirteen rebuilt runtime
bundles have the same bytes and module counts as `d78273423`, with their existing budgets intact.
No Windows, hosted CI or live model runs were used.

This removes the Git-loading module from portable artifact rendering. It does not complete
namespace phase preparation: machine-private drafts, complete preparation admission, source and
approved-input binding, and the end-to-end portable lifecycle remain Phase 7 work. Remaining
native rule/query extraction, verified authority migration and final cleanup/distribution/
performance qualification retain their Phase 5, 8 and 9 scope.
