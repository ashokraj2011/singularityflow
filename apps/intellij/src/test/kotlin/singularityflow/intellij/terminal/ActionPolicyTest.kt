package singularityflow.intellij.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import singularityflow.intellij.Fixtures
import singularityflow.intellij.model.Confirmation
import singularityflow.intellij.model.Fallback
import singularityflow.intellij.model.NextAction

class ActionPolicyTest {
    private val commands = Fixtures.commands

    private fun action(command: String?, copyable: Boolean = true, confirmation: Confirmation = Confirmation.NONE, kind: String = "read") =
        NextAction("id", "Label", 0, kind, null, confirmation, primary = false, fallback = command?.let { Fallback(it, copyable) })

    private fun mode(action: NextAction): LaunchMode? = (ActionPolicy.decide(action, commands) as? ActionDecision.Launch)?.mode

    @Test
    fun `continue is typed because resume switches the checkout`() {
        val home = Fixtures.home("active-story")
        assertEquals(LaunchMode.TYPE, mode(home.primary!!))
    }

    @Test
    fun `every home action decides, and only engine-classified reads run`() {
        val home = Fixtures.home("active-story")
        val decided = home.next.associate { it.fallback!!.command to mode(it) }
        assertEquals(LaunchMode.TYPE, decided["singularity-flow resume FIX-1"])
        assertEquals(LaunchMode.RUN, decided["singularity-flow status"])
        assertEquals(LaunchMode.RUN, decided["singularity-flow workspace list --table"])
        assertEquals(LaunchMode.RUN, decided["singularity-flow workspace impact"])
        assertEquals(LaunchMode.TYPE, decided["singularity-flow start <WORK-ID>"])
    }

    @Test
    fun `a read with a placeholder is typed`() {
        assertEquals(LaunchMode.TYPE, mode(action("singularity-flow story return <WORK-ID>", copyable = false)))
        assertEquals(LaunchMode.RUN, mode(action("singularity-flow story return FIX-1")))
    }

    @Test
    fun `a ceremony or any confirmation is typed even for a read`() {
        assertEquals(LaunchMode.TYPE, mode(action("singularity-flow fault show FLT-1", kind = "ceremony", confirmation = Confirmation.CEREMONY)))
        assertEquals(LaunchMode.TYPE, mode(action("singularity-flow status", confirmation = Confirmation.HOST_CONFIRM)))
        assertEquals(LaunchMode.TYPE, mode(action("singularity-flow status", confirmation = Confirmation.UNKNOWN)))
    }

    @Test
    fun `a command outside the templates is typed, even if it looks harmless`() {
        assertEquals(LaunchMode.TYPE, mode(action("singularity-flow doctor --json")))
        assertEquals(LaunchMode.TYPE, mode(action("singularity-flow status --extra")))
    }

    @Test
    fun `an unsafe or missing command is unavailable`() {
        assertTrue(ActionPolicy.decide(action("singularity-flow status; rm -rf ~"), commands) is ActionDecision.Unavailable)
        assertTrue(ActionPolicy.decide(action("rm -rf ~"), commands) is ActionDecision.Unavailable)
        assertTrue(ActionPolicy.decide(action(null), commands) is ActionDecision.Unavailable)
    }

    @Test
    fun `the sflow alias runs like the full name`() {
        assertEquals(LaunchMode.RUN, mode(action("sflow status")))
    }
}
