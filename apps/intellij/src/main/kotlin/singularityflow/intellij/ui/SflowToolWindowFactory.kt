package singularityflow.intellij.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class SflowToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val disposable = Disposer.newDisposable("Singularity Flow panel")
        val content = ContentFactory.getInstance().createContent(HomePanel(project, disposable), "", false)
        content.setDisposer(disposable)
        toolWindow.contentManager.addContent(content)
    }
}
