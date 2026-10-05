package singularityflow.intellij.terminal

import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.wm.ToolWindowManager
import singularityflow.intellij.cli.Installation
import singularityflow.intellij.service.SflowHomeService
import java.awt.datatransfer.StringSelection

/** Carries out a clicked action: in a terminal tab when possible, otherwise via the clipboard. */
object ActionLauncher {
    private const val NOTIFICATION_GROUP = "Singularity Flow"

    fun launch(project: Project, decision: ActionDecision, label: String) {
        when (decision) {
            is ActionDecision.Unavailable -> notify(project, decision.reason, NotificationType.WARNING)
            is ActionDecision.Launch -> launch(project, decision, label)
        }
    }

    private fun launch(project: Project, decision: ActionDecision.Launch, label: String) {
        val service = SflowHomeService.get(project)
        val state = service.state.value
        val installation = state.installation
        val directory = state.actionDirectory
        if (installation == null || directory == null) {
            notify(project, "Singularity Flow is not ready yet. Refresh the panel and try again.", NotificationType.WARNING)
            return
        }
        val request = TerminalRequest(decision.argv, decision.mode, directory, label, program(installation))
        val onFinished = { service.refreshSoon(500) }
        val launched = TerminalLauncher.EP_NAME.extensionList.any { launcher ->
            try {
                launcher.launch(project, request, onFinished)
            } catch (error: Exception) {
                // The Terminal API is experimental; a changed signature must not lose the command.
                false
            }
        }
        if (!launched) copy(project, request)
    }

    /**
     * The bare `singularity-flow` when the terminal's PATH finds the same CLI the plugin uses,
     * otherwise Node and the entry by absolute path.
     */
    private fun program(installation: Installation): Program {
        val onPath = PathEnvironmentVariableUtil.findInPath("singularity-flow")?.toPath()
        val same = try {
            onPath != null && onPath.toRealPath() == installation.entry.toRealPath()
        } catch (_: Exception) {
            false
        }
        return if (same) Program.OnPath else Program.Explicit(installation.node, installation.entry)
    }

    private fun copy(project: Project, request: TerminalRequest) {
        val text = TerminalCommandBuilder.renderWithDirectory(request, SystemInfo.isWindows)
        CopyPasteManager.getInstance().setContents(StringSelection(text))
        val what = if (request.mode == LaunchMode.RUN) "Paste it into a terminal and run it." else "Paste it into a terminal, review it, then run it."
        NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP)
            .createNotification("Command copied", "$what<br><code>${escape(text)}</code>", NotificationType.INFORMATION)
            .addAction(NotificationAction.createSimpleExpiring("Open Terminal") {
                ToolWindowManager.getInstance(project).getToolWindow("Terminal")?.activate(null)
            })
            .notify(project)
    }

    fun notify(project: Project, message: String, type: NotificationType) {
        NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP)
            .createNotification(escape(message), type)
            .notify(project)
    }

    private fun escape(text: String): String = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}
