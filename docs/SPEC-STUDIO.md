# Spec Studio — write together

Open **Spec Studio** in the SFlow sidebar, or run **Singularity Flow: Spec Studio** from the command palette. A Story is not required.

Describe an idea and choose **Help me write it**, or **Save draft** to write by hand. The title is optional and the specification ID is generated automatically. Choose **Business needs** for people, outcomes and rules, or **Technical details** for components, interfaces and delivery. You can leave that choice until the draft is ready for review.

The document stays open while you write. Use the writing toolbar or switch to Markdown. Changes save on this laptop after a short pause, and Ctrl/Cmd+S saves immediately. Saving incomplete wording does not require resolving questions, running checks or contacting a model. **Earlier versions** lets you view or restore wording while keeping later versions and decisions in history.

Use the Copilot panel to explain an idea, improve selected wording, investigate gaps or ask what could go wrong. Copilot reads the saved draft and stages suggestions. You accept or reject them. Focused suggestions apply only to exact wording that still matches; unrelated manual writing is preserved. Reading a packet does not finish a drafting task. The skill must stage a valid proposal or give a concrete access, file or human-choice recovery route.

## Sources

Add files or images, a link, selected code or an existing reviewed specification. File originals live in this clone’s private local document store and are shared by its linked worktrees. Shared drafts and reviewed versions carry descriptors and hashes, not the uploaded bytes or absolute source paths. Draft wording, accepted quotations and research are specification content and may be shared.

The source reader returns text in finite pages, or the exact native file/image path. It reports unread URLs, unsupported extraction and missing originals explicitly. On supported VS Code hosts, the native tool delivers images as binary image parts; older hosts retain the native image-read route. Neither a filename nor opening an image constitutes human acceptance. See the [VS Code data-part API](https://code.visualstudio.com/api/references/vscode-api#LanguageModelDataPart).

Another clone or laptop asks for the matching original again. Re-upload verifies its digest and restores the existing source ID; different bytes must be added as another source. Local backup/restore also carries specification attachments. Forking and splitting copy only verified originals that exist on this laptop; missing originals remain missing.

## Local save, shared draft, reviewed version

These are separate states:

- **Saved on this laptop:** an immutable local snapshot has confirmed the write.
- **Synced:** an unreviewed draft checkpoint was shared on the selected state branch. It is available to continue on another laptop and cannot be used as an approved Story specification.
- **Ready to use:** a person reviewed the specification and published an immutable reviewed version through the existing review checks.

Sharing runs after a quiet period and does not hold up local writing. It uses exact shared-head comparisons and a per-library automatic attempt interval. **Sync now** bypasses that advisory interval. A timeout preserves the real error and the saved local text. Retrying reconciles the checkpoint rather than publishing a second copy.

When another writer saved a newer shared draft, compare it before choosing **Use the shared draft** or **Keep mine as another draft**. Local history is retained. A stale local save is refused instead of overwriting another window. Copy the writing, keep it as another draft, or discard only the unconfirmed text and reload. VS Code keeps a private recovery copy of unconfirmed saves until the engine confirms them.

Draft checkpoints are stored under `singularity/specification-drafts/` on the selected state branch. Reviewed versions remain under `singularity/specifications/`; their existing hashes and signatures are not rewritten. Private acknowledgement and scheduling files do not advance document history or approval state.

Autosave and quick status use a rebuildable private index and verify the current snapshot. They do not reread the contents of every earlier version. An operation retry verifies its original snapshot before reporting success. A missing, torn or out-of-date index falls back to immutable history; a failed optional index write cannot undo a durable save. Explicit history and backup reads still inspect the saved versions.

Writing can continue while a reviewed version is publishing. The publication acknowledgement retains any newer local text as draft changes; it cannot mark those changes as already reviewed. Sharing failures show their original diagnostic and a retry without replacing the editor.

## Business needs to technical details to a Story

Make a reviewed business version ready, then choose **Work out the technical details**. The new technical draft has its own ID and pins the exact parent version and digest. Additional exact reviewed parents can be selected with CLI `derive --parent SPEC-ID@N`; repeated references are deduplicated and conflicting versions require a choice. Its **Business coverage** table maps every parent requirement and acceptance clause to technical clauses, or records an explicit exclusion/deferral and reason. Unmapped requirements prevent reviewed publication, while local saving remains available.

Choose **Create a Story**, review the exact ready version and select the clauses for this Story. Intake receives that pinned selection and settled decisions. Relevant parent requirements remain inherited constraints; attaching or approving technical work does not itself claim that a business outcome was delivered. Existing slice dependency, size, presence and approval checks still apply. No Story is created by Copilot or by saving a draft.

## Settings and command line

VS Code settings under `singularityFlow.specStudio`:

| Setting | Default |
| --- | --- |
| `autosaveMs` | 750 ms |
| `automaticSync` | true |
| `syncQuietMs` | 10,000 ms |
| `syncMinIntervalMs` | 30,000 ms |

All editor operations use the same CLI services. Run `singularity-flow help spec` for the full forms. The core routes are `spec author new`, `edit`, `status --quick`, `sync`, `shared --refresh`, `resume`, `source`, `sources`, `history`, `restore-version`, `fork`, `derive`, `check` and `publish`. Acceptance, gap decisions, reviewed publication and Story creation remain explicit person actions.

The explicit local browser check is `node scripts/spec-studio-visual-check.mjs <OUTPUT-DIRECTORY>`. It checks rich/Markdown round trips, escaping, editing metadata, save acknowledgements and responsive layouts without a model or hosted CI.
