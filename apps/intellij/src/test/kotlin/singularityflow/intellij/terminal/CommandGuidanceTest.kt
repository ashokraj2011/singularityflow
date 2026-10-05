package singularityflow.intellij.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import singularityflow.intellij.Fixtures
import singularityflow.intellij.model.Json
import singularityflow.intellij.model.array
import singularityflow.intellij.model.bool
import singularityflow.intellij.model.string

/** Replays the engine's own answers (fixtures/command-guidance.json) against the Kotlin port. */
class CommandGuidanceTest {
    private val fixture = Json.parse(Fixtures.text("/fixtures/command-guidance.json"))

    private fun strings(json: Json?): List<String> = (json as Json.Arr).items.map { (it as Json.Str).value }

    @Test
    fun `validation agrees with the engine for every case`() {
        val cases = fixture.array("validation")
        assertTrue(cases.size >= 20)
        for (case in cases) {
            val command = case.string("command")!!
            val validated = CommandGuidance.validate(command)
            if (case.bool("accepted") == true) {
                requireNotNull(validated) { "engine accepts, port rejects: $command" }
                assertEquals("argv of $command", strings((case as Json.Obj).fields["argv"]), validated.argv)
                assertEquals("copyable of $command", case.bool("copyable"), validated.copyable)
            } else {
                assertEquals("engine rejects, port accepts: $command", null, validated)
            }
        }
    }

    @Test
    fun `rendering agrees with the engine on POSIX, PowerShell and cmd`() {
        for (case in fixture.array("rendering")) {
            val argv = strings((case as Json.Obj).fields["argv"])
            assertEquals(case.string("posix"), CommandGuidance.render(argv, CommandGuidance.Platform.POSIX))
            assertEquals(case.string("powershell"), CommandGuidance.render(argv, CommandGuidance.Platform.POWERSHELL))
            assertEquals(case.string("commandPrompt"), CommandGuidance.renderCommandPrompt(argv))
        }
    }

    @Test
    fun `directory changes agree with the engine`() {
        for (case in fixture.array("changeDirectory")) {
            val directory = case.string("directory")!!
            assertEquals(case.string("posix"), CommandGuidance.renderChangeDirectory(directory, CommandGuidance.Platform.POSIX))
            assertEquals(case.string("powershell"), CommandGuidance.renderChangeDirectory(directory, CommandGuidance.Platform.POWERSHELL))
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `rendering refuses a control character`() {
        CommandGuidance.render(listOf("singularity-flow", "a\nb"), CommandGuidance.Platform.POSIX)
    }
}
