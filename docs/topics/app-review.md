---
id: app-review
title: Application review and acceptance
version: 5
commands: [app-review]
---

# Application review and acceptance

Inspect a delivered result, report problems in ordinary language, repair through its existing code phase, and recheck the repair. **All good** confirms the live application and retained test results. SFlow then captures evidence locally and records application acceptance. Phase approval remains separate.

## Adopt a profile

Application review is opt-in per workflow. Add `applicationReview` to an approved work type before starting a new Story:

```yaml
workTypes:
  example-delivery:
    applicationReview:
      mode: optional
      surface: backend
      repairAttempts: 2
      totalRepairAttempts: 10
      capture:
        maximumPages: 100
        casesPerPage: 20
        maximumBytes: 67108864
        timeoutMs: 120000
```

Use `surface: web` for a browser application. A static preview also needs `preview.entry` referencing a declared capability application entry, and `preview.outputDirectory` naming its static build output, such as `dist`. The adapter copies verified source into a controlled workspace-local materialization, runs only that entry's already-declared before-launch steps, and serves the exact built output with hot reload disabled. An absent output or missing setup produces a configuration route; SFlow does not guess commands or install application dependencies.

`auto` detects observed UI files and otherwise remains unresolved until an explicit profile identifies the surface. A backend profile never silently exempts newly observed UI changes. Adopted `quality` entries are additional inspection expectations, with their own source in the plan.

Existing Stories retain their pinned policy. Installation, saving a specification, opening the outcome view, and refreshing configuration do not adopt application review for existing work.

Adopted Stories pin the `sflow-phase-semantics/ara-v1` runtime profile. An older runtime that cannot enforce it must upgrade before operating on that pinned Story; the usual phase interpretation remains unchanged for non-adopted Stories.

Workflow exports carry the same interpreter requirement, review policy and referenced approval groups. Importers verify that requirement before writing configuration; an older importer refuses the profile instead of silently dropping application review.

Required profiles need an existing human approval boundary on every code-bearing phase. The first release refuses `required` with `approval.mode: none` before Story creation; it does not create a hidden extra approval step. Optional profiles can name `authorities` from configured approval groups. Neither setting creates group membership.

## Open the review

Every published code phase first offers **Check the Outcome**, regardless of whether Application Review is adopted. VS Code opens that read-only handoff once per delivered generation by default. Its application-review button appears only when this Story pinned the profile below; opening the outcome never opts an existing Story into acceptance policy.

- Copilot: `/sf-app-review`
- Shell: `singularity-flow app-review start --json`, then `singularity-flow app-review inspect <SESSION>`
- VS Code (model-free): Command Palette → **Singularity Flow: Review Application**, or **Check the Outcome** → **Open application review**.

The read-only `app-review plan` and `app-review status` commands do not launch an application, capture images, record consent, or alter Story state. Opening the local review page also does not start the application. Choose **Start / refresh verified preview** to authorize its declared local build and controlled browser.

Provision the pinned SFlow browser once using `singularity-flow app-review browser install`. It is separate from the team's browser and global Node installation. Review and capture do not silently download it.

The local review host proves readiness with a fresh challenge bound to its private instance, checkout, session and process. Startup and reuse do not depend on PowerShell process-start queries; the probe reads no Story state and grants no human consent.

Use **Report and fix** to authorize an in-scope repair, or **Report only** to retain an observation. Missing screenshots do not prevent feedback. The configured phase agent, skills, instructions, tests, scope and publication rules remain authoritative. A closed delivery needs its existing owner to admit a successor before source edits. Passing tests leads to recheck; it does not resolve a human finding.

After the workflow advances, the review retains feedback and shows the existing owner route legal in the current phase. Approved code is corrected through an authorized return or reopening. Once a repaired target has its own submitted checks, SFlow records the actual outcome automatically; duplicate finding merges preserve the consumed repair budget.

## Accept and capture

Final acceptance uses the current immutable submission packet's test execution records. Inspection can start earlier, but an earlier local or implementation test run cannot substitute for the submitted result. Review all applicable coverage and select its visual/functional dimensions, then click **All good** in the local human surface.

SFlow first retains that exact human action, then captures the current controlled application screen and deterministic pages of actual retained test data. It never replays Save, payments, API mutations or tests to get an image. Structured results stay the verdict source. Backend images depict test reports and do not imply that a backend application has a browser UI.

If capture fails, confirmation stays retained and acceptance remains pending. Use **Resume evidence capture** against unchanged inputs. Material changes to source, configuration, test results, requirements or the inspected state require fresh review. The old evidence and decisions remain historical.

Images stay in this workspace clone's private Git storage. Only record references, hashes and metadata are published through the existing Story state provider. Another laptop establishes and inspects its own runtime before acceptance; unavailable old images remain historical references. PIDs, browser sessions and private action URLs never transfer as execution authority.

## Capability limits

The initial adapters support a controlled static web preview and actual retained test-result reports. Arbitrary HMR servers, secret-bearing/full-stack runtime bundles, native desktop automation, multi-repository repair, stronger BRL attestation and EXR runs require their registered adapters. Unsupported capabilities stay visible. Free-text chat acceptance is unsupported until its host can prove the actual unquoted human event; model text cannot record acceptance.

| Capability | Implemented behavior |
| --- | --- |
| Story phases | One repository and its current code-bearing phase, including custom phase names |
| Static web | Declared build steps, immutable output, managed Chromium, one actual inspected page/context; extra pages, native dialogs and socket-backed runtimes require another adapter |
| Backend / CLI / library | Actual submitted structured test results; no application launched just for a report image |
| Feedback and repair | Text-only reporting, exact existing obligation mapping, owner-admitted successor and human recheck; two attempts per root and ten total by default |
| Human confirmation | Actual local review form; visual and functional dimensions remain separate |
| Capture recovery | Same confirmation reused; admitted evidence can finish finalization without capture, test or API replay |
| Evidence and takeover | Images local, published metadata only; another laptop re-establishes and inspects its local target |
| Existing contracts | Valid live visual acceptance satisfies its named visual slots; it never manufactures a screenshot-inspection checklist or waives a separate document-inspection slot |
| Signed person presence | Explicitly unavailable until a signed-review adapter is qualified; Story creation refuses this combination instead of enabling unsigned acceptance |

Refreshing unchanged inputs preserves the existing confirmation and decisions. Starting a replacement preview creates a new instance binding and requires inspection of that result. Closing a successful preview removes only its owned disposable build; failed materializations are retained for diagnosis, and admitted images remain available.

The namespace `ARA` belongs to application review records and this contract. It does not allocate or renumber Story requirement IDs. Records are versioned and content addressed through the existing schema registry and Story publication transaction, with local browser/capture effects kept separate from phase approval.
