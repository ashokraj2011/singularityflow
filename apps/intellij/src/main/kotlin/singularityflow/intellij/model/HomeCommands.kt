package singularityflow.intellij.model

/**
 * Every command a home action can fall back to, as classified by the engine's `resolveOperation`.
 * Generated into resources/sflow/home-commands.json by scripts/generate-intellij-resources.mjs.
 */
class HomeCommands(private val templates: List<Template>) {

    data class Template(val id: String, val argv: List<String>, val classification: String)

    /**
     * The classification of [argv] (without the `sflow` program), or null when no template matches.
     * A match is exact: same length, same literal tokens, and a placeholder such as `<WORK-ID>`
     * stands for one value, never for an option.
     */
    fun classify(argv: List<String>): String? = templates.firstOrNull { template ->
        template.argv.size == argv.size && template.argv.indices.all { index ->
            val token = template.argv[index]
            if (PLACEHOLDER.matches(token)) !argv[index].startsWith("-") else token == argv[index]
        }
    }?.classification

    companion object {
        private val PLACEHOLDER = Regex("<[A-Z][A-Z0-9-]*>")

        fun parse(text: String): HomeCommands = HomeCommands(Json.parse(text).array("templates").mapNotNull { entry ->
            val id = entry.string("id") ?: return@mapNotNull null
            val classification = entry.string("classification") ?: return@mapNotNull null
            val argv = entry.array("argv").map { (it as? Json.Str)?.value ?: return@mapNotNull null }
            Template(id, argv, classification)
        })

        fun load(): HomeCommands = parse(resource("/sflow/home-commands.json"))
    }
}
