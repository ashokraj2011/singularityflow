package singularityflow.intellij.status

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import singularityflow.intellij.Fixtures
import singularityflow.intellij.cli.Detection
import singularityflow.intellij.model.Failure
import singularityflow.intellij.refresh.SflowFileListener
import singularityflow.intellij.service.HomeViewState

class StatusAndRefreshTest {
    @Test
    fun `the status bar names the active Story and its phase`() {
        assertEquals("SFlow: FIX-1 · intake", StatusText.of(HomeViewState(home = Fixtures.home("active-story"))).text)
    }

    @Test
    fun `the status bar covers no workspace, setup and errors`() {
        assertEquals("SFlow: no workspace", StatusText.of(HomeViewState(home = Fixtures.home("blank"))).text)
        assertEquals("SFlow: setup", StatusText.of(HomeViewState(
            setup = Detection.Problem(Detection.Kind.CLI_MISSING, "missing", emptyList()))).text)
        assertEquals("SFlow: error", StatusText.of(HomeViewState(failure = Failure("broken"))).text)
        assertEquals("SFlow: error", StatusText.of(HomeViewState(home = Fixtures.home("active-story"), failure = Failure("broken"))).text)
        assertEquals("SFlow", StatusText.of(HomeViewState()).text)
    }

    @Test
    fun `file events under singularity and the workspace file refresh, git internals never do`() {
        val prefixes = listOf("/repo/singularity/")
        val workspace = "/home/me/.singularity-flow/active-workspace.json"
        assertTrue(SflowFileListener.relevant("/repo/singularity/work-items/FIX-1/state.yml", prefixes, workspace))
        assertTrue(SflowFileListener.relevant(workspace, prefixes, workspace))
        assertFalse(SflowFileListener.relevant("/repo/src/Main.kt", prefixes, workspace))
        assertFalse(SflowFileListener.relevant("/repo/singularity/.git/x", prefixes, workspace))
        assertFalse(SflowFileListener.relevant("/repo/.git/singularity-flow/dx/timings.jsonl", listOf("/repo/"), workspace))
    }
}
