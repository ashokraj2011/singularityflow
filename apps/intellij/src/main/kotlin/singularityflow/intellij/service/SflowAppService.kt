package singularityflow.intellij.service

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.EnvironmentUtil
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import singularityflow.intellij.cli.CliLocator
import singularityflow.intellij.cli.Detection
import singularityflow.intellij.cli.ProcessRunner
import singularityflow.intellij.cli.SflowInvocation
import singularityflow.intellij.model.HomeCommands
import singularityflow.intellij.model.HomeParser
import singularityflow.intellij.model.MessageCatalog
import singularityflow.intellij.settings.SflowSettings
import java.nio.file.Path

/** Shared by every project: finding the CLI, the bundled engine resources, and a cap on parallel reads. */
@Service(Service.Level.APP)
class SflowAppService {
    val messages: MessageCatalog by lazy { MessageCatalog.load() }
    val commands: HomeCommands by lazy { HomeCommands.load() }
    val parser: HomeParser by lazy { HomeParser(messages) }

    /** At most two `home` reads run at once across all open projects. */
    val readPermits = Semaphore(2)

    val runner = ProcessRunner { command, directory ->
        GeneralCommandLine(command)
            // The environment the IDE loaded from the login shell, so PATH matches the terminal.
            .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
            .withEnvironment(SflowInvocation.ENVIRONMENT)
            .withCharset(Charsets.UTF_8)
            .withWorkDirectory(directory?.toFile())
            .createProcess()
    }

    private val detectionLock = Mutex()
    @Volatile private var detection: Detection? = null

    suspend fun detect(force: Boolean = false): Detection = detectionLock.withLock {
        detection?.takeIf { !force } ?: locate().also { detection = it }
    }

    fun forgetDetection() {
        detection = null
    }

    private suspend fun locate(): Detection {
        val settings = SflowSettings.get().state
        val locator = CliLocator(
            environment = EnvironmentUtil.getEnvironmentMap(),
            findInPath = { name -> PathEnvironmentVariableUtil.findInPath(name)?.toPath() },
            home = Path.of(System.getProperty("user.home")),
            windows = SystemInfo.isWindows,
            probe = { command ->
                val outcome = runner.run(command, SflowInvocation.CliVersion.timeoutMillis)
                outcome.stdout.trim().takeIf { outcome.exitCode == 0 && it.isNotEmpty() }
            },
            builtFor = pluginVersion()?.let { CliLocator.Version.parse(it) } ?: CliLocator.MIN_CLI
        )
        return locator.locate(settings.nodePath, settings.cliPath)
    }

    companion object {
        // The verifier refuses plugin IDs containing "intellij", so the ID names the CLI instead.
        const val PLUGIN_ID = "singularityflow.sflow"

        fun get(): SflowAppService = service()

        fun pluginVersion(): String? = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.version
    }
}
