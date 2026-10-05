package singularityflow.intellij.model

/**
 * The CLI's wording for message and reason codes, generated from src/gateway/messages.mjs into
 * resources/sflow/messages.json by scripts/generate-intellij-resources.mjs.
 */
class MessageCatalog(private val messages: Map<String, Pair<String, String?>>) {

    /** The sentence for a code. An unknown code renders as itself, as the CLI's `message()` does. */
    fun label(code: String, slots: Map<String, String> = emptyMap()): String =
        messages[code]?.first?.let { fill(it, slots) } ?: code

    fun detail(code: String, slots: Map<String, String> = emptyMap()): String? =
        messages[code]?.second?.let { fill(it, slots) }

    companion object {
        private val SLOT = Regex("\\{([a-zA-Z][a-zA-Z0-9]*)\\}")

        /** Same rule as `fill()`: an unfilled slot keeps its braces rather than vanishing. */
        fun fill(template: String, slots: Map<String, String>): String =
            SLOT.replace(template) { match -> slots[match.groupValues[1]] ?: match.value }

        fun parse(text: String): MessageCatalog {
            val entries = (Json.parse(text).field("messages") as? Json.Obj)?.fields ?: emptyMap()
            return MessageCatalog(entries.mapNotNull { (code, value) ->
                value.string("label")?.let { code to (it to value.string("detail")) }
            }.toMap())
        }

        fun load(): MessageCatalog = parse(resource("/sflow/messages.json"))
    }
}

internal fun resource(path: String): String =
    MessageCatalog::class.java.getResourceAsStream(path)?.use { it.readBytes().toString(Charsets.UTF_8) }
        ?: error("Missing plugin resource $path")
