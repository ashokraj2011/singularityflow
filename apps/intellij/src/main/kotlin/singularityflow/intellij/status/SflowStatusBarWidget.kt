package singularityflow.intellij.status

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.Consumer
import singularityflow.intellij.service.HomeViewState
import singularityflow.intellij.service.SflowHomeService
import java.awt.Component
import java.awt.event.MouseEvent

class SflowStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = ID
    override fun getDisplayName() = "Singularity Flow"
    override fun createWidget(project: Project): StatusBarWidget = SflowStatusBarWidget(project)

    companion object {
        const val ID = "singularityflow.sflow.status"
    }
}

/** `SFlow: FIX-12 · implement · 2 waiting on you`. A click opens the panel; it never triggers a read. */
class SflowStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private val disposable = Disposer.newDisposable("Singularity Flow status")
    private var statusBar: StatusBar? = null
    private var shown = StatusText.of(HomeViewState())

    override fun ID() = SflowStatusBarWidgetFactory.ID

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val service = SflowHomeService.get(project)
        service.observe(disposable) { state ->
            shown = StatusText.of(state)
            statusBar.updateWidget(ID())
        }
        service.refreshAtStartupIfRelevant()
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this
    override fun getText(): String = shown.text
    override fun getTooltipText(): String = shown.tooltip
    override fun getAlignment(): Float = Component.LEFT_ALIGNMENT
    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
        ToolWindowManager.getInstance(project).getToolWindow(SflowHomeService.TOOL_WINDOW_ID)?.activate(null)
    }

    override fun dispose() {
        Disposer.dispose(disposable)
        statusBar = null
    }
}

/** The status bar's words for a state, kept free of IDE types so it can be tested directly. */
data class StatusText(val text: String, val tooltip: String) {
    companion object {
        fun of(state: HomeViewState): StatusText {
            if (state.setup != null) return StatusText("SFlow: setup", state.setup.message)
            val home = state.home
            if (home == null) {
                return if (state.failure != null) StatusText("SFlow: error", state.failure.headline)
                else StatusText("SFlow", "Singularity Flow: open the panel to read your work.")
            }
            val waiting = home.slots["decisions"]?.toIntOrNull()?.takeIf { it > 0 }
            val work = home.activeWork
            val text = when {
                state.failure != null -> "SFlow: error"
                work != null && work.group == "recovery-required" -> "SFlow: ${work.id} · finish publishing"
                work != null -> listOfNotNull("SFlow: ${work.id}", work.phase, waiting?.let { "$it waiting on you" }).joinToString(" · ")
                home.context.workspaceLabel != null -> "SFlow: ${home.context.workspaceLabel} · no work"
                else -> "SFlow: no workspace"
            }
            val tooltip = listOfNotNull(
                state.failure?.headline,
                home.context.workspaceLabel?.let { "Workspace: $it" },
                home.context.repositoryId?.let { "Repository: $it" },
                home.context.branch?.let { "Branch: $it" },
                work?.title?.let { "Work: ${work.id} · $it" },
                home.primary?.let { "Next: ${it.label}" }
            ).joinToString("\n").ifEmpty { "Singularity Flow" }
            return StatusText(text, tooltip)
        }
    }
}
