package singularityflow.intellij.service

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.EDT
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.EnvironmentUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import singularityflow.intellij.cli.Detection
import singularityflow.intellij.cli.Installation
import singularityflow.intellij.cli.SflowInvocation
import singularityflow.intellij.model.Failure
import singularityflow.intellij.model.Home
import singularityflow.intellij.model.HomeRead
import singularityflow.intellij.settings.SflowProjectSettings
import singularityflow.intellij.settings.SflowSettings
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/** What the panel and status bar show. A failure keeps the last good [home] on screen, greyed. */
data class HomeViewState(
    val loading: Boolean = false,
    val home: Home? = null,
    val failure: Failure? = null,
    val setup: Detection.Problem? = null,
    val notice: String? = null,
    val installation: Installation? = null,
    val projectRoot: Path? = null,
    val readAt: Instant? = null
) {
    /** Where an action's command runs: the checkout home names, else this project's Git root. */
    val actionDirectory: Path? get() = home?.repositoryPath?.let { Path.of(it) } ?: projectRoot
}

/**
 * Reads `sflow home --json` for one project: one read at a time, at most one more queued, and
 * file-change bursts collapsed into a single read.
 */
@Service(Service.Level.PROJECT)
class SflowHomeService(private val project: Project, private val scope: CoroutineScope) : Disposable {
    private val _state = MutableStateFlow(HomeViewState())
    val state: StateFlow<HomeViewState> = _state.asStateFlow()

    private val requests = Channel<Unit>(Channel.CONFLATED)
    private var debounce: Job? = null
    @Volatile private var lastReadMillis = 0L
    @Volatile private var watches: Set<LocalFileSystem.WatchRequest> = emptySet()

    /** Paths whose changes mean home may have changed. Never under `.git/`: each CLI run writes timings there. */
    @Volatile var watchedPrefixes: List<String> = emptyList()
        private set
    @Volatile var activeWorkspaceFile: String = FileUtil.toSystemIndependentName(activeWorkspaceFile().toString())
        private set

    init {
        scope.launch { for (ignored in requests) read() }
        scope.launch { timer() }
    }

    fun refresh() {
        requests.trySend(Unit)
    }

    /** Collapses a burst of triggers, such as file events, into one read. */
    fun refreshSoon(delayMillis: Long = DEBOUNCE_MILLIS) {
        debounce?.cancel()
        debounce = scope.launch {
            delay(delayMillis)
            refresh()
        }
    }

    fun refreshIfOlderThan(millis: Long) {
        if (System.currentTimeMillis() - lastReadMillis > millis) refresh()
    }

    /** At startup, read only where sflow is in use: a governed project or a selected workspace. */
    fun refreshAtStartupIfRelevant() {
        scope.launch(Dispatchers.IO) {
            val root = projectRoot()
            val governed = root != null && Files.exists(root.resolve("singularity").resolve("workflow.yml"))
            if (lastReadMillis == 0L && (governed || Files.exists(activeWorkspaceFile()))) refresh()
        }
    }

    /** Calls [onState] on the UI thread with every state until [parent] is disposed. */
    fun observe(parent: Disposable, onState: (HomeViewState) -> Unit) {
        val job = scope.launch(Dispatchers.EDT) { state.collect { onState(it) } }
        Disposer.register(parent, Disposable { job.cancel() })
    }

    private suspend fun read() {
        _state.update { it.copy(loading = true) }
        val app = SflowAppService.get()
        val detection = app.detect()
        val root = projectRoot()
        if (detection is Detection.Problem) {
            lastReadMillis = System.currentTimeMillis()
            _state.value = HomeViewState(setup = detection, projectRoot = root, readAt = Instant.now())
            return
        }
        val ready = detection as Detection.Ready
        val installation = ready.installation
        val invocation = SflowInvocation.Home(SflowProjectSettings.get(project).state.workspace)
        val outcome = app.readPermits.withPermit {
            app.runner.run(invocation.command(installation.node, installation.entry), invocation.timeoutMillis, root)
        }
        val result = when {
            outcome.timedOut -> HomeRead.Refused(Failure(
                "sflow home did not answer within ${invocation.timeoutMillis / 1000} seconds. The last result stays on screen; refresh to try again."
            ))
            outcome.outputTooLarge -> HomeRead.Refused(Failure("sflow home printed more than 32 MiB, which this plugin does not read."))
            else -> app.parser.parse(outcome.stdout.ifBlank { outcome.stderr }, outcome.exitCode)
        }
        lastReadMillis = System.currentTimeMillis()
        _state.update { previous ->
            when (result) {
                is HomeRead.Ready -> HomeViewState(
                    home = result.home, notice = ready.notice, installation = installation,
                    projectRoot = root, readAt = Instant.now()
                )
                is HomeRead.Refused -> previous.copy(
                    loading = false, failure = result.failure, setup = null, notice = ready.notice,
                    installation = installation, projectRoot = root, readAt = Instant.now()
                )
            }
        }
        watch(root, (result as? HomeRead.Ready)?.home?.repositoryPath?.let { Path.of(it) })
    }

    /** Re-reads on the optional timer, only while the panel is visible. */
    private suspend fun timer() {
        while (true) {
            val seconds = SflowSettings.get().state.refreshIntervalSeconds
            delay(if (seconds > 0) seconds * 1000L else IDLE_POLL_MILLIS)
            if (seconds > 0 && panelVisible()) refresh()
        }
    }

    private suspend fun panelVisible(): Boolean = withContext(Dispatchers.EDT) {
        ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.isVisible == true
    }

    /** The nearest ancestor of the project folder holding `.git` (a directory, or a worktree's file). */
    private fun projectRoot(): Path? {
        val base = project.guessProjectDir()?.toNioPath() ?: return null
        return generateSequence(base) { it.parent }.firstOrNull { Files.exists(it.resolve(".git")) } ?: base
    }

    private fun watch(projectRoot: Path?, homeRepository: Path?) {
        val directories = listOfNotNull(projectRoot, homeRepository).distinct().map { it.resolve("singularity") }
        val workspaceFile = activeWorkspaceFile()
        // Virtual file events carry system-independent paths.
        watchedPrefixes = directories.map { FileUtil.toSystemIndependentName(it.toString()) + "/" }
        activeWorkspaceFile = FileUtil.toSystemIndependentName(workspaceFile.toString())
        val fileSystem = LocalFileSystem.getInstance()
        // Events reach listeners only for files the virtual file system has loaded, so load them once.
        (directories + workspaceFile).forEach { fileSystem.refreshAndFindFileByNioFile(it) }
        watches = fileSystem.replaceWatchedRoots(
            watches,
            directories.map { it.toString() },
            listOfNotNull(workspaceFile.parent?.toString())
        )
    }

    override fun dispose() {
        LocalFileSystem.getInstance().removeWatchedRoots(watches)
    }

    companion object {
        const val TOOL_WINDOW_ID = "Singularity Flow"
        const val DEBOUNCE_MILLIS = 750L
        private const val IDLE_POLL_MILLIS = 30_000L

        fun get(project: Project): SflowHomeService = project.service()

        /** The same file `activeWorkspaceFile()` in src/workspace-context.mjs reads. */
        fun activeWorkspaceFile(): Path {
            val override = EnvironmentUtil.getEnvironmentMap()["SINGULARITY_FLOW_ACTIVE_WORKSPACE"]
                ?: System.getenv("SINGULARITY_FLOW_ACTIVE_WORKSPACE")
            return if (!override.isNullOrBlank()) Path.of(override).toAbsolutePath()
            else Path.of(System.getProperty("user.home"), ".singularity-flow", "active-workspace.json")
        }
    }
}
