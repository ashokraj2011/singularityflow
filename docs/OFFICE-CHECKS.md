# Office checks

Some SFlow work needs facts only an office laptop and its Git host can give. The office checks collect them
in one report that you send back.

## Run them

1. Install SFlow from main the way the office installs it. On a machine with the source, build the pair
   (`./build-distribution.sh`, or `.\build-distribution.cmd` on Windows). Put the `.tgz` and `.vsix` from
   `dist/` in the team's SharePoint folder, or copy them to the laptop. On the laptop, run
   **Singularity Flow: Update SFlow…** in VS Code (or `singularity-flow update --local-folder FOLDER`), then
   reload VS Code.
2. In VS Code, open the repository you work in. Open it at its real place, not through a link.
3. Run **SFlow: Run office checks** from the Command Palette. It is also on the Diagnostics page. In a
   terminal inside the repository, run `singularity-flow probe office` instead.
4. Answer the questions. Each one says why it is asked and what Yes and No do. No skips that check.
   - Push two throwaway refs to your remote and delete them right after (the Git host check).
   - Only if the free VS Code check cannot run here: send one chat message. This uses ONE premium request.
   - Only if IntelliJ or Android Studio with Copilot is used here: send one message with each of its two
     agents. This uses two premium requests.
   - Optional: one Jira issue key. Only the length of its title is reported.
5. Send back `sflow-office-checks-<date>.md` and the `.json` file beside it. They are written in the
   repository folder, and the last message says where.

## What it checks

- **A. Machine:** the system and processor, shells, Node.js, Git and its line-ending settings, commit
  signing, whether a proxy is set (never its address), whether npm and the Git host answer, and the
  temporary folder.
- **B. Editors and Copilot:** VS Code and its Copilot versions, its agent host, hook settings and policies,
  Copilot CLI, and IntelliJ or Android Studio with their Copilot plugin.
- **C. Hooks:** whether SFlow's Copilot hooks run in VS Code chat and Copilot CLI, using a stand-in model
  on this laptop, so they cost nothing. It also checks IntelliJ (guided) and whether the folder is opened
  through a link.
- **D. Git host:** the host's kind (never its address or organisation). It also checks whether the host
  takes an atomic push with SFlow's hidden records ref, gives it back, and lets SFlow delete it.
- **E. State checkout:** how this Git treats `.sflow-state/` under `git status`, `git stash -u` and
  `git clean`, in a temporary repository.
- **F. Commit rules:** the repository's commit policy and hooks, read only, and what the host's own hooks said.
- **G. Jira:** whether SFlow's Jira settings are there, and whether it can read the one issue you name.

## What it never does

- It never changes your working tree, branches, Git settings or other settings. Its work happens in a
  temporary folder that is removed at the end.
- It pushes only after your Yes, only the two throwaway refs, and deletes them right after.
- It uses a premium request only after a Yes that says so.
- The report holds no names, emails, hostnames, organisation or repository names, addresses, tokens,
  environment values or file paths. Read it before you send it.
