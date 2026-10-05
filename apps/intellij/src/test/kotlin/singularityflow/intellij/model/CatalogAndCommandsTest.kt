package singularityflow.intellij.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import singularityflow.intellij.Fixtures

class CatalogAndCommandsTest {
    @Test
    fun `fill keeps an unfilled slot visible`() {
        assertEquals("3 file(s) of {total}", MessageCatalog.fill("{count} file(s) of {total}", mapOf("count" to "3")))
    }

    @Test
    fun `a known code renders its sentence and an unknown one renders as itself`() {
        assertEquals("Your work", Fixtures.messages.label("gateway.home"))
        assertEquals("no.such-code", Fixtures.messages.label("no.such-code"))
    }

    @Test
    fun `templates match exactly, and a placeholder never stands for an option`() {
        val commands = Fixtures.commands
        assertEquals("read", commands.classify(listOf("story", "return", "FIX-1")))
        assertEquals("mutation", commands.classify(listOf("resume", "FIX-1")))
        assertNull(commands.classify(listOf("story", "return", "--all")))
        assertNull(commands.classify(listOf("story", "return")))
        assertNull(commands.classify(listOf("status", "FIX-1")))
        assertEquals("read", commands.classify(listOf("status")))
    }
}
