---
id: waivers
title: Policy waivers
aliases: [waiver, quick-fix-waiver]
related: [quick-fix, approvals, escalation]
---
On low-ceremony rails, low-risk changes may complete under a policy waiver: a deterministic evaluation against the pinned waiver policy (its ID and hash recorded, predicates listed, evaluated at the exact commit). Denial is automatic for protected paths, public-interface changes, migrations, security boundaries, regulated data, or any classifier that cannot run — path count alone is never sufficient. A waiver is recorded as a waiver: it is never rendered, counted, or exported as a human approval, and impact receipts keep the distinction.
