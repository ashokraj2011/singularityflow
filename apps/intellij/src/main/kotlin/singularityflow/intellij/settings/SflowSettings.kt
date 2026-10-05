package singularityflow.intellij.settings

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/** Machine-wide settings: where Node and the CLI are, and the optional refresh timer. */
@Service(Service.Level.APP)
@State(name = "SingularityFlow", storages = [Storage("singularity-flow.xml")])
class SflowSettings : SimplePersistentStateComponent<SflowSettings.Options>(Options()) {
    class Options : BaseState() {
        var nodePath by string()
        var cliPath by string()

        /** 0 turns the timer off. While on, the panel re-reads only when it is visible. */
        var refreshIntervalSeconds by property(0)
    }

    companion object {
        fun get(): SflowSettings = service()
    }
}

/** Per project: which sflow workspace to show instead of the machine's active one. */
@Service(Service.Level.PROJECT)
@State(name = "SingularityFlowProject", storages = [Storage("singularity-flow.xml")])
class SflowProjectSettings : SimplePersistentStateComponent<SflowProjectSettings.Options>(Options()) {
    class Options : BaseState() {
        var workspace by string()
    }

    companion object {
        fun get(project: Project): SflowProjectSettings = project.service()
    }
}
