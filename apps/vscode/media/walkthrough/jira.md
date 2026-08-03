# Secure Jira connection

Your Jira URL, account, authentication mode, and optional project routes are
configured separately from workspaces. The API token or PAT is stored in VS Code
SecretStorage, backed by the operating-system keychain, and exposed only to the
`sflow` child process. Jira is optional for local intake.

[Connect Jira](command:singularityFlow.connectJira)
