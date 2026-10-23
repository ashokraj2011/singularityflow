# Careful change: a sample user-defined agent

This folder is what a user-defined agent looks like: one main agent file and the skills it names.
SFlow ships it as an example. Start a Story with it:

    singularity-flow start <WORK-ID> --agent careful-change

and run its step in Copilot with `/sf-call careful-change`.

To make your own, put your main agent (`*.agent.md`) and the files it uses in a folder and run
`singularity-flow call add <FOLDER>` (or Singularity Flow: Add Your Own Agent Folder… in VS Code).
The folder is copied unchanged into `singularity/user-defined/<name>/`, and every file in it is
given to the agent when its step runs.
