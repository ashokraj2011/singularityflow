package singularityflow.intellij

import singularityflow.intellij.model.Home
import singularityflow.intellij.model.HomeCommands
import singularityflow.intellij.model.HomeParser
import singularityflow.intellij.model.HomeRead
import singularityflow.intellij.model.MessageCatalog

/** Test fixtures written by the Node side: test/intellij-home-contract.test.mjs and the resource generator. */
object Fixtures {
    val messages: MessageCatalog by lazy { MessageCatalog.load() }
    val commands: HomeCommands by lazy { HomeCommands.load() }
    val parser: HomeParser by lazy { HomeParser(messages) }

    fun text(path: String): String =
        Fixtures::class.java.getResourceAsStream(path)?.use { it.readBytes().toString(Charsets.UTF_8) }
            ?: error("Missing test fixture $path")

    /** A home fixture parsed exactly as the plugin parses a successful read. */
    fun home(name: String): Home {
        val read = parser.parse(text("/fixtures/home/$name.json"), exitCode = 0)
        return (read as? HomeRead.Ready)?.home ?: error("$name.json did not parse as a home: $read")
    }
}
