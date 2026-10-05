package singularityflow.intellij.refresh

import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.components.serviceIfCreated
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.BranchChangeListener
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.wm.IdeFrame
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ex.ToolWindowManagerListener
import singularityflow.intellij.service.SflowHomeService

/** A change under a watched `singularity/` directory, or to the active-workspace file. */
class SflowFileListener(private val project: Project) : BulkFileListener {
    override fun after(events: List<VFileEvent>) {
        val service = project.serviceIfCreated<SflowHomeService>() ?: return
        val prefixes = service.watchedPrefixes
        val workspaceFile = service.activeWorkspaceFile
        if (events.any { event -> relevant(event.path, prefixes, workspaceFile) }) service.refreshSoon()
    }

    companion object {
        /** Never `.git/`: every CLI run appends timings there, which would refresh in a loop. */
        fun relevant(path: String, prefixes: List<String>, workspaceFile: String): Boolean =
            !path.contains("/.git/") && (path == workspaceFile || prefixes.any { path.startsWith(it) })
    }
}

class SflowToolWindowListener(private val project: Project) : ToolWindowManagerListener {
    override fun toolWindowShown(toolWindow: ToolWindow) {
        if (toolWindow.id == SflowHomeService.TOOL_WINDOW_ID) {
            project.serviceIfCreated<SflowHomeService>()?.refreshIfOlderThan(5_000)
        }
    }
}

class SflowActivationListener : ApplicationActivationListener {
    override fun applicationActivated(ideFrame: IdeFrame) {
        ideFrame.project?.serviceIfCreated<SflowHomeService>()?.refreshIfOlderThan(60_000)
    }
}

/** Registered only when the IDE has version control (sflow-vcs.xml). */
class SflowBranchListener(private val project: Project) : BranchChangeListener {
    override fun branchWillChange(branchName: String) = Unit

    override fun branchHasChanged(branchName: String) {
        project.serviceIfCreated<SflowHomeService>()?.refreshSoon()
    }
}
