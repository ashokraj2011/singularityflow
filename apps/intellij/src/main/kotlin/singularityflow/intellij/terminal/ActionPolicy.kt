package singularityflow.intellij.terminal

import singularityflow.intellij.model.Confirmation
import singularityflow.intellij.model.HomeCommands
import singularityflow.intellij.model.NextAction

enum class LaunchMode {
    /** Run on click: the command is a read the engine classifies as unable to change anything. */
    RUN,

    /** Type into the terminal and leave Enter to the developer. */
    TYPE
}

sealed interface ActionDecision {
    data class Launch(val mode: LaunchMode, val argv: List<String>, val command: String) : ActionDecision
    data class Unavailable(val reason: String) : ActionDecision
}

/**
 * Whether a click runs an action's command or only types it.
 *
 * Home actions cannot decide this themselves: every one is `executable: false`, and `confirmation`
 * describes the action's session-bound handle, not its fallback command. "Continue" is
 * `confirmation: none`, yet its command, `resume <ID>`, switches the checkout to the Story branch.
 * So only a command matching a template the engine classifies as a read is run; first match wins.
 */
object ActionPolicy {

    fun decide(action: NextAction, commands: HomeCommands): ActionDecision {
        val fallback = action.fallback ?: return ActionDecision.Unavailable("This action has no command to run.")
        return decide(fallback.command, fallback.copyable, action.confirmation, action.ceremony, commands)
    }

    fun decide(
        command: String,
        copyable: Boolean,
        confirmation: Confirmation,
        ceremony: Boolean,
        commands: HomeCommands
    ): ActionDecision {
        val validated = CommandGuidance.validate(command)
            ?: return ActionDecision.Unavailable("The command this action names failed the safety check, so it is not offered: $command")
        val mode = when {
            // Placeholders such as <WORK-ID> must be filled in by the developer.
            !copyable || !validated.copyable -> LaunchMode.TYPE
            ceremony || confirmation != Confirmation.NONE -> LaunchMode.TYPE
            commands.classify(validated.argv) == "read" -> LaunchMode.RUN
            else -> LaunchMode.TYPE
        }
        return ActionDecision.Launch(mode, validated.argv, command)
    }
}
