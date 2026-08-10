---
id: visual-verification
title: Visual verification for mobile
aliases: [visual, pixel-compare, device-profiles, figma-mobile]
commands: [visual]
related: [mcp-integration, approvals]
---
The figma-mobile work type pins the design file version itself: design-source records carry file key, version, nodes, and export hashes; a newer design version surfaces as a staleness warning, never silent drift; promotion requires exact-record confirmation and invalidates downstream approvals. Declared device profiles make coverage arithmetic — `sflow visual status` lists uncovered profiles and unclaimed artifacts as set operations, promotable from warning to gate. `sflow visual compare` produces a deterministic pixel diff (zero-dependency, honestly RGBA8-only) as evidence for the human decision — never an auto-verdict. The screenshot a reviewer approves is hash-bound into the record.
