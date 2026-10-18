# Source-review packet repair

## Failure and correction

A published specification could reach independent review with a structurally valid packet,
rejected line/quote citations, and an unmapped scenario such as S2. The reviewer had been told
to repair format only and then stop on a non-retainable packet. Small sources remained escaped
JSON strings; the check did not provide exact field/line proposals or its next staging route.
The strict check agent-output flag was also refused, and stage/retain errors discarded repair detail.

The correction keeps the exact evidence validator and changes the packet/continuation contract:

- Pinned source text, including short sources, is available once as native-readable Git-private
  text files in the bounded Copilot view. Their 1-based lines are the citation domain; bytes and
  source hashes are unchanged. Ordinary JSON context remains compatible.
- The citation guide lists every specification scenario and clause, including clarified scenarios.
  A clarification is acknowledged separately, not invented as a readable source ID.
- Checks identify exact row/finding field paths. An unchanged quote appearing on one pinned line
  gets a proposed line-number edit. Multiple or absent matches require independent reading;
  there is no automatic choice, fuzzy quote substitution, or source edit.
- The reviewer repairs private packet errors in the same turn, with at most two changed-packet
  attempts. Unchanged retries are forbidden. Stage/retain refusals preserve bounded repair hints.
- Missing mappings are independently assessed before an author handoff. Add genuinely supported
  rows; retain real unsupported scope as blocking findings. A valid correction-required review is
  retainable evidence, not phase approval. A reviewer omission does not require re-authoring a spec.
- Read-only `review-source check` supports output-only `--for-agent --json` and returns exact check
  and retain routes. Source-review context and mutation authority boundaries remain enforced.

The logic follows the published review kind and phase responsibilities, not built-in phase names.
Seeded, copied, renamed and future custom scope/planning steps use the same contract. Other steps
do not acquire a new review gate.

## Qualification

Native qualification run `39134899906`, source/test revision `5bebebe5`, passed on Node 22:

| Host | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| macOS | 249 | 0 | 0 |
| Windows | 249 | 0 | 0 |

Windows ran 232 contract/host cases and 17 review CLI cases in three disjoint groups (10, 4, 3).
All 11 top-level CLI tests were checked to belong to exactly one group; none were omitted.
The CI revision `264df56320db2c7212f5dee290195d89552b2d8b` differed only by its temporary workflow.
Both hosts also passed VS Code typechecking, building and unchanged bundle budgets.

Coverage includes LF/CRLF sources, wrong lines, paraphrases, duplicate/multiline quotes, S2 and
clarifications, stale bindings, malformed reports, bounded hints, genuine retained gaps, reviewer
independence, human dispositions, read-only guards, linked worktrees, and copied phase contracts.
Windows fixtures explicitly declare their Git identity, canonical line endings and long-path
support; path assertions compare normalized paths. The blank-machine smoke remains bounded and
must complete and clean its sandbox. The first qualification exposed these pre-existing fixture
assumptions; no Windows cases were skipped to obtain a passing run.

Local checks additionally passed the packaged CLI source/bundle parity and cold-closure tests.
No prompt or bundle limit was increased. Repair uses already-loaded pinned inputs, not network
lookups or branch/history scans.

Latest main was checked again and its unrelated VS Code symlink change `f9510971` integrated without
conflicts. No CLI, plugin or schema source changed in that integration. Follow-up native run
`39135679846` passed 22 targeted integration checks per host (19 citation/refresh cases and three
built-extension host cases), with zero failures or skips, plus typechecking, build and unchanged
bundle limits. It exercised source/test revision `0cb0c429`; CI revision
`bdbc641c4af4d762d03df2be1ac46168f7963ea7` differed only by the temporary workflow. The upstream
refresh test's raw-path dynamic import was made portable with `pathToFileURL` before that run.

## Upgrade and retained work

Update the CLI and Copilot/VS Code integration, then run the current phase's source review again.
Published Story sources, artifacts, clarifications, prior reviews and approvals are not rewritten.
This change does not itself retain the user's rejected packet, approve a phase or decide a human
exception. A new Story or author generation is unnecessary for packet-only citation/mapping repair.
