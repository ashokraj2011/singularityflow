# Spec Studio — write together

Open **Spec Studio** in the SFlow sidebar, or run **Singularity Flow: Spec Studio** from the command palette. A Story is not required.

Describe an idea and choose **Help me write it**, or **Save draft** to write by hand. The title is optional and the specification ID is generated automatically. Choose **Business needs** for people, outcomes and rules, or **Technical details** for components, interfaces and delivery. You can leave that choice until the draft is ready for review, when making it ready asks you to confirm it. A script confirms it with `spec author edit SPEC-ID --kind business --expected-seq N`; the refusal names the command with the current sequence. A draft saved before kinds existed keeps its existing rules.

The document stays open while you write. Use the writing toolbar or switch to Markdown. Changes save on this laptop after a short pause, and Ctrl/Cmd+S saves immediately. Saving incomplete wording does not require resolving questions, running checks or contacting a model. **Earlier versions** lets you view or restore wording while keeping later versions and decisions in history.

Use the Copilot panel to explain an idea, improve selected wording, investigate gaps or ask what could go wrong. Copilot reads the saved draft and stages suggestions. You accept or reject them. Focused suggestions apply only to exact wording that still matches; unrelated manual writing is preserved. Reading a packet does not finish a drafting task. The skill must stage a valid proposal or give a concrete access, file or human-choice recovery route.

## Sources

Add files or images, a link, selected code or an existing reviewed specification. File originals live in this clone’s private local document store and are shared by its linked worktrees. Shared drafts and reviewed versions carry descriptors and hashes, not the uploaded bytes or absolute source paths. Draft wording, accepted quotations and research are specification content and may be shared.

Sources take the same refusals as every other document input. A file or code path the repository's environment rules call local, or whose content holds a secret, is refused when it is added or restored, and again when it is read, so its text never reaches Copilot. With no `singularity/environments.yml`, `.env` and `.env.*` are refused by name, for sources and document upload alike; `.env.example`, `.env.sample` and `.env.template` are allowed, and an unquoted value such as `API_KEY=abc123xyz987LMN` in any env-style file counts as a secret. A selected folder is read natively, so its read lists the files under `excluded` not to read. A code file too large to check or that is not text can still be chosen, and its read says nothing vouches for it. A link carrying an access credential, such as `?sig=` or `#access_token=` with a real-looking value, is refused because a link is shared with the draft.

The source reader returns text in finite pages small enough for a host to show whole, each stating its continuation before its text, or the exact native file/image path. `--max-bytes` asks for a larger page where there is room. It reports unread URLs, unsupported extraction and missing originals explicitly. On supported VS Code hosts, the native tool delivers images as binary image parts; older hosts retain the native image-read route. Neither a filename nor opening an image constitutes human acceptance. See the [VS Code data-part API](https://code.visualstudio.com/api/references/vscode-api#LanguageModelDataPart).

Another clone or laptop asks for the matching original again. Re-upload verifies its digest and restores the existing source ID; different bytes must be added as another source. Local backup/restore also carries specification attachments. Forking and splitting copy only verified originals that exist on this laptop; missing originals remain missing.

## Local save, shared draft, reviewed version

These are separate states:

- **Saved on this laptop:** an immutable local snapshot has confirmed the write.
- **Synced:** an unreviewed draft checkpoint was shared on the selected state branch. It is available to continue on another laptop and cannot be used as an approved Story specification.
- **Ready to use:** a person reviewed the specification and published an immutable reviewed version through the existing review checks.

Sharing runs after a quiet period and does not hold up local writing. It uses exact shared-head comparisons and a per-library automatic attempt interval. **Sync now** bypasses that advisory interval. A timeout preserves the real error and the saved local text. Retrying reconciles the checkpoint rather than publishing a second copy, even when you kept writing after a push whose acknowledgement was lost. A failure that may pass, such as an unreachable remote, stays on the page and sharing tries again by itself, further apart each time, up to every 15 minutes.

A shared checkpoint, a published version or a published split cannot be taken back, so the exact files that would ship are checked first with the repository's secret scanner, along with any link carrying a credential. A link is judged by its value: `?auth=true`, `?token=<TOKEN>` and an address on a reserved example host such as `api.example.com` are ordinary writing. When the check trips, or cannot run, nothing is shared: the page says **Not shared**, where to look and how to clear it, without repeating the value, and your writing stays saved on this laptop. Sharing resumes once the value is gone, whatever held it. A suggestion you rejected or a finding you settled keeps only its outcome in a checkpoint, so its text is not shared. For a real example in the text, end that line with the scanner's waiver marker, `sflow-allow-secret`, then a colon and why it is safe. Recorded decisions cannot be edited, so a value in one means starting another draft from your text.

Copilot is not shown such a value either. Every `spec author` answer withholds it, on the #sflowSpecStudio tool and the command line alike, and the Studio's own page reads your words intact with `--for-person`, which an agent is refused. A request or selected wording that looks private is not sent to chat: the page says so and keeps what you typed.

When another writer saved a newer shared draft, compare it before choosing **Use the shared draft** or **Keep mine as another draft**. Local history is retained. A save is refused as stale only when the wording, title or kind it would replace changed: a proposal staged by Copilot, a source or a decision saved meanwhile is kept, and your writing saves on top. When wording really did change, nothing overwrites another window. Copy your writing, keep it as another draft, or discard only the unconfirmed text and reload. VS Code keeps a private recovery copy of unconfirmed saves until the engine confirms them.

Saving and other background changes never replace the editor: your caret, undo history, scroll position, Markdown mode and an unsent Copilot request stay as they are. The document text changes only when saved wording arrives and nothing of yours is unsaved, such as an accepted suggestion or a restored version.

Draft checkpoints are stored under `singularity/specification-drafts/` on the selected state branch. Reviewed versions remain under `singularity/specifications/`; their existing hashes and signatures are not rewritten. Private acknowledgement and scheduling files do not advance document history or approval state.

Autosave, quick status, checking and publishing use a rebuildable private index and verify the current snapshot. They do not reread the contents of every earlier version. An operation retry verifies its original snapshot before reporting success. A missing, torn or out-of-date index falls back to immutable history; a failed optional index write cannot undo a durable save. Explicit history and backup reads still inspect the saved versions.

Each save is a whole local snapshot, so older autosaves are thinned behind a bound. Only ordinary wording saves are removed, and never the current version, decisions, accepted suggestions, sources, publications, the version last shared, the newest 200 saves or the last save of each older hour. `SINGULARITY_FLOW_SPEC_HISTORY_RECENT` changes the 200, and `spec author history SPEC-ID --retention --json` shows what the next pass would remove and what it keeps. Shared checkpoints stay on the state branch: they are immutable, and removing one from its tip would leave its bytes in Git history.

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
