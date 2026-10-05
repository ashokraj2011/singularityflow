package singularityflow.intellij.settings

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import singularityflow.intellij.service.SflowAppService
import singularityflow.intellij.service.SflowHomeService

class SflowConfigurable(private val project: Project) : BoundConfigurable("Singularity Flow") {
    override fun createPanel(): DialogPanel {
        val machine = SflowSettings.get().state
        val local = SflowProjectSettings.get(project).state
        return panel {
            group("All Projects") {
                row("Node.js:") {
                    textField().columns(COLUMNS_LARGE)
                        .bindText({ machine.nodePath.orEmpty() }, { machine.nodePath = it.trim().ifEmpty { null } })
                        .comment("Path to the node executable, version 20 or newer. Leave empty to find it automatically.")
                }
                row("Singularity Flow CLI:") {
                    textField().columns(COLUMNS_LARGE)
                        .bindText({ machine.cliPath.orEmpty() }, { machine.cliPath = it.trim().ifEmpty { null } })
                        .comment("The sflow launcher or its bin/singularity-flow.mjs. Leave empty to find it automatically.")
                }
                row("Refresh every:") {
                    intTextField(0..3600).columns(6)
                        .bindIntText({ machine.refreshIntervalSeconds }, { machine.refreshIntervalSeconds = it })
                        .comment("Seconds, while the panel is visible. 0 turns the timer off.")
                }
            }
            group("This Project") {
                row("Workspace:") {
                    textField().columns(COLUMNS_LARGE)
                        .bindText({ local.workspace.orEmpty() }, { local.workspace = it.trim().ifEmpty { null } })
                        .comment("Show this sflow workspace instead of the machine's active one.")
                }
            }
        }
    }

    override fun apply() {
        super.apply()
        SflowAppService.get().forgetDetection()
        SflowHomeService.get(project).refresh()
    }
}
