package singularityflow.intellij.cli

import java.nio.file.Path

/**
 * The only processes the plugin ever starts. Every command an action names runs in the developer's
 * terminal instead; the plugin itself never runs git or anything that can change state.
 */
sealed interface SflowInvocation {
    val timeoutMillis: Long

    fun command(node: Path, entry: Path?): List<String>

    data object NodeVersion : SflowInvocation {
        override val timeoutMillis = 10_000L
        override fun command(node: Path, entry: Path?) = listOf(node.toString(), "--version")
    }

    data object CliVersion : SflowInvocation {
        override val timeoutMillis = 10_000L
        override fun command(node: Path, entry: Path?) =
            listOf(node.toString(), requireNotNull(entry).toString(), "--version")
    }

    data class Home(val workspace: String?) : SflowInvocation {
        override val timeoutMillis = 120_000L
        override fun command(node: Path, entry: Path?) = listOf(node.toString(), requireNotNull(entry).toString(), "home", "--json") +
            (workspace?.trim()?.takeIf { it.isNotEmpty() }?.let { listOf("--workspace", it) } ?: emptyList())
    }

    companion object {
        /** Added to every invocation: plain output, and no network access for a read. */
        val ENVIRONMENT: Map<String, String> = mapOf("NO_COLOR" to "1", "SINGULARITY_FLOW_NO_NETWORK" to "1")
    }
}
