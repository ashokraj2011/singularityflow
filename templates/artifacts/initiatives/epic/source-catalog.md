# Source Catalog — {{workId}}

The source catalog is the evidence register for this Epic. Every requirement and
acceptance criterion must cite an entry here plus a page, frame, or section, so
the catalog defines what the Epic is permitted to claim.

Source IDs are assigned when the source is pinned (`SRC-` followed by twelve hex
characters) and are immutable. Never renumber them: approved requirements cite
them by hash-verified ID.

## Sources

| Source ID | Name | Type | Provider | Version | SHA-256 | Authority | Currency | Relevant sections |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SRC-000000000000 | | Requirement / Design / Contract / Policy / Data / Research / Correspondence | | | | Authoritative / Supporting / Informational | Current / Ageing / Superseded | |

**Authority** records how much weight a source carries. *Authoritative* sources
can settle a disagreement on their own; *supporting* sources corroborate;
*informational* sources provide background and must never be the only citation
behind a requirement.

**Currency** records whether the source still reflects reality. An *ageing* or
*superseded* source may still be cited, but the risk must be recorded in source
gaps.

## Coverage by scope area

Show which parts of the Epic scope each source actually covers, so gaps are
visible before requirements are written rather than after.

| Scope area | Covering sources | Coverage | Notes |
| --- | --- | --- | --- |
| | | Full / Partial / None | |

## Conflicts and precedence

Where sources disagree, record the disagreement and the ruling. An unrecorded
conflict becomes an arbitrary choice made silently during requirements.

| ID | Conflicting sources | Nature of conflict | Ruling | Decided by | Date |
| --- | --- | --- | --- | --- | --- |
| CONF-001 | | | | | |

## Excluded and superseded material

Record material that was considered and deliberately not pinned, so a later
reviewer does not assume it was missed.

| Material | Reason for exclusion | Superseded by |
| --- | --- | --- |
| | Out of scope / Superseded / Unreliable / Unavailable | |

## Provenance notes

Document how each non-obvious source was obtained, any access restrictions, and
anything a future reader would need in order to retrieve the same version. Note
explicitly where a source could not be retrieved and what was used instead.
