# Git host requirements

Singularity Flow needs a working Git installation. Xcode is not an SFlow requirement, on macOS
or any other platform. A particular application's native build or tests may separately need Apple
developer tools; that belongs to its test/build command, not Story selection or configuration review.

## Selection

On macOS, bare Git commands prefer a standalone executable from the host's absolute PATH over
Apple Git. For GUI hosts whose PATH includes Apple Git but omits shell setup, the selection also
checks the fixed Homebrew and MacPorts locations: `/opt/homebrew/bin`, `/usr/local/bin`, and
`/opt/local/bin`. This policy is shared by the CLI's process boundary, the GAL runtime and VS Code's
local/remote runner. No repository or home-directory search and no Xcode invocation is performed.
The selected Git's directory is also placed first in its macOS child-process PATH so hooks and
helpers do not silently return to Apple Git; all credential/proxy values remain unchanged.

Every applicable existing canonical-path, regular-file, executable-mode and checkout-shadow check
still applies. If only Apple Git exists, it is retained: a working Apple Git is supported. Explicit
trusted GAL executable selections remain exact and never fall back. Windows and Linux retain their
existing Git selection rules.

Selection happens before an operation and before reading its Git transport configuration. SFlow
does not retry failed mutations with another executable, accept licenses, install packages, clear
credentials, suppress configuration-read failures, or treat partial reads as complete policy.

## Recovery

If Apple Git refuses because of an unaccepted license or missing developer tools, use a working
standalone Git installation and reload VS Code. Terminal and VS Code must both resolve usable Git.
The diagnostic identifies unavailable Git tooling, not a missing Story checkout. Existing Story
bytes, selection, index, publications and approval history are preserved. Retry the original
operation after Git works; do not recreate the Story or workspace to fix a host-tool failure.

If no Git works, Git-backed operations must remain unavailable until Git is repaired. That is a Git
requirement, not an Xcode requirement. Unreadable transport or credential configuration still fails
closed, with its original configuration preserved.
