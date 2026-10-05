package singularityflow.intellij.actions

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAwareAction
import singularityflow.intellij.service.SflowAppService
import singularityflow.intellij.service.SflowHomeService
import singularityflow.intellij.settings.SflowConfigurable

/** Reads `sflow home` again, and looks for Node and the CLI again in case either was just installed. */
class RefreshAction : DumbAwareAction("Refresh", "Read sflow home again", AllIcons.Actions.Refresh) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        SflowAppService.get().forgetDetection()
        SflowHomeService.get(project).refresh()
    }
}

class OpenSettingsAction : DumbAwareAction("Settings", "Singularity Flow settings", AllIcons.General.Settings) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        ShowSettingsUtil.getInstance().showSettingsDialog(e.project, SflowConfigurable::class.java)
    }
}
