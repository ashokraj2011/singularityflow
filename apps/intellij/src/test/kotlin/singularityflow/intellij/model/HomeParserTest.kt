package singularityflow.intellij.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import singularityflow.intellij.Fixtures

class HomeParserTest {
    private val parser = Fixtures.parser

    @Test
    fun `blank machine reads as a home with only setup actions`() {
        val home = Fixtures.home("blank")
        assertNull(home.activeWork)
        assertEquals("home.no-workspace-selected", home.why.first().code)
        assertEquals("Your work", Fixtures.messages.label(home.messageId!!, home.slots))
        assertTrue(home.next.isNotEmpty())
        assertEquals(1, home.next.count { it.primary })
        assertTrue(home.next.all { it.fallback != null })
        assertTrue(home.healthy)
    }

    @Test
    fun `an active Story leads, with its rail and continue action`() {
        val home = Fixtures.home("active-story")
        val work = requireNotNull(home.activeWork)
        assertEquals("FIX-1", work.id)
        assertEquals("Fix the login error", work.title)
        assertEquals(1, work.rail.count { it.state == "current" })
        assertEquals("home:work.continue", work.actionId)
        val primary = requireNotNull(home.primary)
        assertEquals("singularity-flow resume FIX-1", primary.fallback?.command)
        assertEquals(Confirmation.NONE, primary.confirmation)
        assertEquals("<MACHINE>/payments", home.repositoryPath)
        assertEquals("payments", home.context.workspaceLabel)
        assertEquals("FIX-1", home.context.activeWorkId)
        assertEquals("1", home.slots["active"])
    }

    @Test
    fun `a refusal plan becomes a failure with its steps`() {
        val read = parser.parse(Fixtures.text("/fixtures/home/unknown-workspace.json"), exitCode = 1)
        val failure = (read as HomeRead.Refused).failure
        assertTrue(failure.headline.isNotBlank())
        assertTrue(failure.steps.isNotEmpty())
        assertTrue(failure.steps.all { it.command?.startsWith("singularity-flow ") == true })
    }

    @Test
    fun `a v2 refusal is shown in the engine's words`() {
        val read = parser.parse(
            """{"schemaVersion":2,"resultType":"sflow-result","outcome":{"status":"refused","messageId":"gateway.home","slots":{}},
               "why":[{"code":"home.no-workspace-selected","slots":{}}],"next":[{"id":"x","label":"Diagnose","fallback":{"command":"singularity-flow workspace doctor","copyable":true}}]}""",
            exitCode = 1
        )
        val failure = (read as HomeRead.Refused).failure
        assertEquals("Your work", failure.headline)
        assertEquals("home.no-workspace-selected", failure.code)
        assertEquals(listOf(FailureStep("Diagnose", "singularity-flow workspace doctor", true)), failure.steps)
    }

    @Test
    fun `a successful envelope with a non-zero exit is still a failure`() {
        val read = parser.parse(Fixtures.text("/fixtures/home/blank.json"), exitCode = 1)
        assertTrue(read is HomeRead.Refused)
    }

    @Test
    fun `a v1 command result shows its rendered headline`() {
        val read = parser.parse(
            """{"schemaVersion":1,"operation":{"id":"home"},"outcome":{"status":"failed","messageId":"x"},
               "rendered":{"headline":"Something failed"},"why":[{"code":"a.b"}],"next":[{"label":"Retry","command":"singularity-flow home"}]}""",
            exitCode = 1
        )
        val failure = (read as HomeRead.Refused).failure
        assertEquals("Something failed", failure.headline)
        assertEquals(listOf(FailureStep("Retry", "singularity-flow home", false)), failure.steps)
    }

    @Test
    fun `plain text output shows the CLI's own error line`() {
        val read = parser.parse("noise\nSingularity Flow error: No workspace.\ntrailer", exitCode = 1)
        assertEquals("Singularity Flow error: No workspace.", (read as HomeRead.Refused).failure.headline)
    }

    @Test
    fun `an unknown result schema asks for matching versions`() {
        val read = parser.parse("""{"schemaVersion":3}""", exitCode = 0)
        assertTrue((read as HomeRead.Refused).failure.headline.contains("schema 3"))
    }
}
