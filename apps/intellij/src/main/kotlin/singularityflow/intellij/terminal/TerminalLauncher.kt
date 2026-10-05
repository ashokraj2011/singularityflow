package singularityflow.intellij.terminal

import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.project.Project
import java.nio.file.Path

/** How the terminal invokes sflow: the bare program name, or Node and the CLI entry by path. */
sealed interface Program {
    val words: List<String>

    data object OnPath : Program {
        override val words = listOf("singularity-flow")
    }

    data class Explicit(val node: Path, val entry: Path) : Program {
        override val words get() = listOf(node.toString(), entry.toString())
    }
}

data class TerminalRequest(
    val argv: List<String>,
    val mode: LaunchMode,
    val directory: Path,
    val label: String,
    val program: Program
)

enum class ShellKind {
    POSIX, POWERSHELL, COMMAND_PROMPT,

    /** A shell whose quoting the plugin cannot guarantee, such as nushell: copy instead of typing. */
    UNSUPPORTED;

    companion object {
        fun of(shellPath: String?, windows: Boolean): ShellKind {
            val name = shellPath?.substringAfterLast('/')?.substringAfterLast('\\')?.lowercase()
                ?.removeSuffix(".exe") ?: return if (windows) POWERSHELL else POSIX
            return when (name) {
                "bash", "zsh", "sh", "dash", "ksh", "fish", "ash", "mksh" -> POSIX
                "pwsh", "powershell" -> POWERSHELL
                "cmd" -> COMMAND_PROMPT
                "" -> if (windows) POWERSHELL else POSIX
                else -> if (name.startsWith("bash") || name.startsWith("zsh")) POSIX else UNSUPPORTED
            }
        }
    }
}

/** The exact text typed into a terminal of the given shell for a request. */
object TerminalCommandBuilder {
    fun render(request: TerminalRequest, shell: ShellKind): String? {
        val words = request.program.words + request.argv
        return when (shell) {
            ShellKind.POSIX -> CommandGuidance.render(words, CommandGuidance.Platform.POSIX)
            ShellKind.POWERSHELL -> CommandGuidance.render(words, CommandGuidance.Platform.POWERSHELL)
            ShellKind.COMMAND_PROMPT -> CommandGuidance.renderCommandPrompt(words)
            ShellKind.UNSUPPORTED -> null
        }
    }

    /** For the clipboard: change to the action's directory first, in the shell the developer will paste into. */
    fun renderWithDirectory(request: TerminalRequest, windows: Boolean): String {
        val platform = if (windows) CommandGuidance.Platform.POWERSHELL else CommandGuidance.Platform.POSIX
        val separator = if (windows) "; " else " && "
        return CommandGuidance.renderChangeDirectory(request.directory.toString(), platform) + separator +
            CommandGuidance.render(request.program.words + request.argv, platform)
    }
}

/**
 * Opens a terminal tab for a request. Implementations are registered through the
 * `singularityflow.sflow.terminalLauncher` extension point, so the one that uses the Terminal
 * plugin's API is loaded only when that plugin is enabled.
 */
interface TerminalLauncher {
    /**
     * Opens a tab in [TerminalRequest.directory] and types or runs the request. [onCommandFinished] is
     * called whenever a command in that tab finishes. Returns false when this launcher cannot serve
     * the request, so the caller falls back to the clipboard.
     */
    fun launch(project: Project, request: TerminalRequest, onCommandFinished: () -> Unit): Boolean

    companion object {
        val EP_NAME: ExtensionPointName<TerminalLauncher> =
            ExtensionPointName.create("singularityflow.sflow.terminalLauncher")
    }
}
