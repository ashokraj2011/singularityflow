---
name: sflow-docs
description: Answer Singularity Flow questions from shipped topics.
argument-hint: "[QUESTION | TOPIC]"

---
# Answer from the documentation, never from memory

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Pass the exact question or topic through the model-free resolver: run `singularity-flow explain "$ARGUMENTS" --json`. With no argument, run `singularity-flow explain --json` for the topic catalog. Do not map the question to a topic from model memory.
2. Read the served bytes from `data.served.text` and preserve `data.helpIntent`, provenance, and warnings.
3. Answer using that content. The substance of the reply must come from the served bytes — if the topic does not say it, do not say it.
4. End with the citation from `data.citation`, verbatim. It names the topic id, its version, and the docs commit.
5. If `explain` refuses with `docs.topic-not-found`, say so and offer the nearest topic ids it returned. Do not answer the question from memory instead — a fluent wrong answer about governance is worse than none.
6. If the question is ambiguous between topics, present the returned choices. Do not pick one or blend their answers.
7. For "what should I do here", "should I escalate", or any decision, do not answer. Point to `singularity-flow nextsteps` for the deterministic action set, and to the human approval authorities the pinned configuration names.
8. When the reader wants their own situation as well as the concept, run `singularity-flow explain <topic> --here`, and keep the two parts labeled: concept cites a topic version, situation cites a revision.
9. Do not generate, submit, approve, reject, upload, commit, or push anything.
