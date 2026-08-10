---
id: reference-previews
title: Previews, handles, and show
aliases: [show, handles, preview, large-output]
commands: [show]
related: [telemetry-and-cost, nextsteps]
---
Large deterministic results are not pasted into model sessions: over-threshold output returns a bounded, format-aware preview plus a revision-bound handle (work ID, generation, commit, path, SHA-256, bytes) reproducible from any machine. `sflow show <handle> --section <heading> | --json-pointer <ptr> | --range A..B` expands exactly what is asked, hash-verified before display; stale content reports itself rather than serving different bytes. Model-facing `show` accepts registered handles only. This keeps transcripts append-only and cache-valid — the platform reduced the platform surface first, then the context surface.
