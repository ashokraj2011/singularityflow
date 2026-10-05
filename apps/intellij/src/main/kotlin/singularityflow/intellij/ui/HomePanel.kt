package singularityflow.intellij.ui

import com.intellij.ide.ui.laf.darcula.ui.DarculaButtonUI
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.dsl.builder.Panel
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import singularityflow.intellij.actions.OpenSettingsAction
import singularityflow.intellij.actions.RefreshAction
import singularityflow.intellij.model.AttentionItem
import singularityflow.intellij.model.Confirmation
import singularityflow.intellij.model.Failure
import singularityflow.intellij.model.Home
import singularityflow.intellij.model.NextAction
import singularityflow.intellij.service.HomeViewState
import singularityflow.intellij.service.SflowAppService
import singularityflow.intellij.service.SflowHomeService
import singularityflow.intellij.settings.SflowConfigurable
import singularityflow.intellij.terminal.ActionDecision
import singularityflow.intellij.terminal.ActionLauncher
import singularityflow.intellij.terminal.ActionPolicy
import singularityflow.intellij.terminal.LaunchMode
import java.awt.BorderLayout
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.swing.JPanel

/** The tool window: the state of `sflow home`, rebuilt whenever it changes. */
class HomePanel(private val project: Project, parent: Disposable) : JPanel(BorderLayout()) {
    private val body = JPanel(BorderLayout())
    private val app = SflowAppService.get()

    init {
        val toolbar = ActionManager.getInstance().createActionToolbar(
            "SingularityFlowPanel", DefaultActionGroup(RefreshAction(), OpenSettingsAction()), true
        )
        toolbar.targetComponent = this
        add(toolbar.component, BorderLayout.NORTH)
        add(JBScrollPane(body).apply { border = JBUI.Borders.empty() }, BorderLayout.CENTER)
        val service = SflowHomeService.get(project)
        service.observe(parent) { render(it) }
        service.refreshIfOlderThan(5_000)
    }

    private fun render(state: HomeViewState) {
        val content = panel {
            when {
                state.setup != null -> setup(state)
                state.home == null && state.failure == null -> row { label(if (state.loading) "Reading your work…" else "Open this panel to read your work.") }
                else -> {
                    state.failure?.let { failure(it) }
                    state.home?.let { home(it, state, current = state.failure == null) }
                }
            }
            state.notice?.let { row { comment(it) } }
            footer(state)
        }.apply { border = JBUI.Borders.empty(8, 12) }
        body.removeAll()
        body.add(content, BorderLayout.NORTH)
        body.revalidate()
        body.repaint()
    }

    private fun Panel.setup(state: HomeViewState) {
        val problem = state.setup ?: return
        row { label("Set up Singularity Flow").bold() }
        row { text(escape(problem.message)) }
        row {
            button("Open Settings") { ShowSettingsUtil.getInstance().showSettingsDialog(project, SflowConfigurable::class.java) }
            button("Detect Again") {
                app.forgetDetection()
                SflowHomeService.get(project).refresh()
            }
        }
        if (problem.searched.isNotEmpty()) {
            collapsibleGroup("Places searched") {
                problem.searched.forEach { row { comment(escape(it)) } }
            }
        }
    }

    private fun Panel.failure(failure: Failure) {
        row { label(failure.headline.take(300)).bold() }
        failure.code?.let { row { comment(escape(it)) } }
        failure.reasons.forEach { row { text(escape(it)) } }
        failure.steps.forEach { step ->
            val command = step.command
            row {
                if (command == null) {
                    text(escape(step.label))
                } else {
                    val decision = ActionPolicy.decide(command, step.copyable, Confirmation.NONE, false, app.commands)
                    actionButton(step.label, decision, primary = false)
                }
            }
        }
        if (failure.steps.isEmpty()) row { comment("Nothing was changed. Refresh to read your work again.") }
    }

    private fun Panel.home(home: Home, state: HomeViewState, current: Boolean) {
        val section = group(if (current) messages(home.messageId ?: "gateway.home", home.slots) else "Last result") {
            context(home)
            val directory = state.actionDirectory
            if (directory != null && directory != state.projectRoot) {
                row { comment("Actions run in ${escape(directory.toString())}") }
            }
            home.why.forEach { row { comment(escape(messages(it.code, it.slots))) } }
            home.activeWork?.let { work ->
                row { label(listOfNotNull(work.id, work.title).joinToString(" · ")).bold() }
                val rail = work.rail.joinToString("   ") { step ->
                    val marker = when (step.state) { "done", "complete", "completed" -> "✓"; "current" -> "●"; else -> "○" }
                    "$marker ${step.label}"
                }
                if (rail.isNotEmpty()) row { comment(escape(rail)) }
            }
            if (home.next.isNotEmpty()) {
                row { label("Next").bold() }
                home.next.sortedBy { if (it.primary) -1 else it.rank }.forEach { action -> row { actionButton(action) } }
            }
            attention("Needs you", home.needsUser, home)
            attention("Worth checking", home.worthChecking, home)
            if (home.recent.isNotEmpty()) {
                row { label("Recent").bold() }
                home.recent.forEach { work ->
                    row { comment(escape(listOfNotNull(work.id, work.title, work.phase).joinToString(" · "))) }
                }
            }
            if (!home.healthy && home.warnings.isNotEmpty()) {
                home.warnings.forEach { row { comment(escape(messages(it.code, it.slots))) } }
            }
        }
        if (!current) section.enabled(false)
    }

    private fun Panel.context(home: Home) {
        val parts = listOfNotNull(home.context.workspaceLabel, home.context.repositoryId, home.context.branch)
        if (parts.isNotEmpty()) row { comment(escape(parts.joinToString(" · "))) }
    }

    private fun Panel.attention(title: String, items: List<AttentionItem>, home: Home) {
        if (items.isEmpty()) return
        row { label(title).bold() }
        items.forEach { item ->
            row {
                text(escape(item.title))
                home.action(item.actionId)?.let { actionButton(it) }
            }
        }
    }

    private fun com.intellij.ui.dsl.builder.Row.actionButton(action: NextAction) =
        actionButton(action.label, ActionPolicy.decide(action, app.commands), action.primary)

    private fun com.intellij.ui.dsl.builder.Row.actionButton(label: String, decision: ActionDecision, primary: Boolean) {
        button(label) { ActionLauncher.launch(project, decision, label) }.applyToComponent {
            toolTipText = when (decision) {
                is ActionDecision.Unavailable -> decision.reason
                is ActionDecision.Launch -> (if (decision.mode == LaunchMode.RUN) "Runs on click: " else "Typed into the terminal for you to review and run: ") +
                    decision.command
            }
            isEnabled = decision is ActionDecision.Launch
            if (primary) putClientProperty(DarculaButtonUI.DEFAULT_STYLE_KEY, true)
        }
    }

    private fun Panel.footer(state: HomeViewState) {
        val parts = listOfNotNull(
            state.readAt?.let { "Read at ${TIME.format(it.atZone(ZoneId.systemDefault()))}" },
            state.installation?.let { "sflow ${it.cliVersion}" },
            if (state.loading && (state.home != null || state.failure != null)) "refreshing…" else null
        )
        if (parts.isNotEmpty()) row { comment(parts.joinToString(" · ")) }
    }

    private fun messages(code: String, slots: Map<String, String>) = app.messages.label(code, slots)

    private fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    companion object {
        private val TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")
    }
}
