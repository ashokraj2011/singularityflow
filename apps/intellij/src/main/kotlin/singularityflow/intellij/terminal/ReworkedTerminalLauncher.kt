package singularityflow.intellij.terminal

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTabsManager
import kotlinx.coroutines.launch
import org.jetbrains.plugins.terminal.TerminalProjectOptionsProvider
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalCommandExecutionListener
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalCommandFinishedEvent

/**
 * Types or runs a request in a new tab of the Terminal tool window, through the Terminal plugin's
 * API (2025.3+, experimental). Registered only by sflow-terminal.xml, so this class is never loaded
 * when the Terminal plugin is disabled.
 */
class ReworkedTerminalLauncher : TerminalLauncher {

    override fun launch(project: Project, request: TerminalRequest, onCommandFinished: () -> Unit): Boolean {
        val shell = ShellKind.of(TerminalProjectOptionsProvider.getInstance(project).shellPath, SystemInfo.isWindows)
        val text = TerminalCommandBuilder.render(request, shell) ?: return false
        val tab = TerminalToolWindowTabsManager.getInstance(project).createTabBuilder()
            .workingDirectory(request.directory.toString())
            .tabName("sflow")
            .requestFocus(true)
            .createTab()
        val sender = tab.view.createSendTextBuilder()
        if (request.mode == LaunchMode.RUN) sender.shouldExecute() else sender.useBracketedPasteMode()
        sender.send(text)
        // Refresh after anything run in this tab, including a typed command the developer then runs.
        tab.view.coroutineScope.launch {
            tab.view.shellIntegrationDeferred.await().addCommandExecutionListener(tab.content, object : TerminalCommandExecutionListener {
                override fun commandFinished(event: TerminalCommandFinishedEvent) = onCommandFinished()
            })
        }
        ToolWindowManager.getInstance(project).getToolWindow("Terminal")?.activate(null)
        return true
    }
}
