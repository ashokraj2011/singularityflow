# Retained phase coordination

The registered `phase.assign` operation accepts an explicit operation ID, exact Story phase and
assignee. Its conditional namespace transaction records the authenticated actor and original time,
updates coordination notifications once, and leaves the phase, author permissions and approval
authority unchanged. Lost replies resume the original candidate. A later process can replay the
accepted result without the old checkout, private draft or a new timestamp.

Native assignments and namespace assignments share one pure reducer. The native adapter retains
its original clock checkpoint, errors, record fields and notification/history values. A capture
from `e03809e24` covers those compatibility cases, including partial state on an invalid reducer
input. The existing native CLI path and Git authority are unchanged; the new registered namespace
operation is not a replacement installed command.

Required-assignment workflows now retain `phase-assignment/v1` publication evidence. The report
is reconstructed from actual accepted assignment receipts and the publication's original basis.
An assignment-shaped state value does not establish provenance. Diagnostic checks show the
missing coordinator without writing; the author can record coordination, explicitly rebase the
preserved draft and continue publication. The immutable report stays readable during independent
approval and later takeover, even after another coordinator is recorded.

The Mac qualification covers filesystem, SQLite and application stores, exact permissions,
independent approval, actual missing-record errors, interrupted writes and shared-only replay.
The actual offline-installed archive also records/replays coordination and reviews the original
publication evidence. Qualification passes 186 distinct affected Mac checks with no failures, cancellations or skips.
The unchanged original installed-package qualifier passes all 34 checks alone in 38.4 seconds,
within its existing 120/60-second bounds. Source validation passes 4,158 checks; architecture
(91), schema (6), VS Code types, the unchanged 2,011-site Git audit and all 13 original bundle
ceilings pass. The gateway remains 850 of 852 permitted modules.

Assignments do not satisfy any other required policy owner. The remaining Phase 5/7 work stays in
[the completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md).
