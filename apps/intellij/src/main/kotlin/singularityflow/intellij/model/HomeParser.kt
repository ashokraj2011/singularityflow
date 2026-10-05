package singularityflow.intellij.model

/**
 * Turns the stdout of `sflow home --json` into what the panel shows.
 *
 * It reads exactly the fields that test/intellij-home-contract.test.mjs pins; keep the two in step.
 * A failed read prints one JSON object on stdout and exits non-zero: an `sflow-refusal-plan`, a v1
 * `command-result`, or a v2 result whose outcome is refused or failed. Anything else is shown as text.
 */
class HomeParser(private val messages: MessageCatalog) {

    fun parse(stdout: String, exitCode: Int?): HomeRead {
        val json = try {
            Json.parse(stdout.trim())
        } catch (_: JsonException) {
            return HomeRead.Refused(plainTextFailure(stdout))
        }
        if (json.string("resultType") == "sflow-refusal-plan") return HomeRead.Refused(refusalPlan(json))
        return when (json.int("schemaVersion")) {
            2 -> resultV2(json, exitCode)
            1 -> HomeRead.Refused(commandResultV1(json))
            else -> HomeRead.Refused(Failure(
                headline = "This sflow returned a result this plugin cannot read (schema ${json.int("schemaVersion") ?: "missing"}). Update the plugin or sflow so their versions match."
            ))
        }
    }

    private fun resultV2(json: Json, exitCode: Int?): HomeRead {
        val outcome = json.field("outcome")
        val status = outcome.string("status")
        val messageId = outcome.string("messageId")
        val slots = outcome.slots("slots")
        val why = reasons(json.array("why"))
        val projection = json.field("data").field("homeProjection")
        if (status != "succeeded" || exitCode != 0 || projection == null) {
            return HomeRead.Refused(Failure(
                headline = messageId?.let { messages.label(it, slots) } ?: "sflow could not read your work.",
                code = why.firstOrNull()?.code,
                reasons = why.map { messages.label(it.code, it.slots) },
                steps = json.array("next").mapNotNull { entry ->
                    val fallback = fallback(entry.field("fallback")) ?: return@mapNotNull null
                    FailureStep(entry.string("label") ?: fallback.command, fallback.command, fallback.copyable)
                }
            ))
        }
        val next = json.array("next").take(MAX_ACTIONS).mapNotNull(::action)
        val context = projection.field("context")
        return HomeRead.Ready(Home(
            messageId = messageId,
            slots = slots,
            why = why,
            warnings = reasons(json.array("warnings")),
            next = next,
            repositoryPath = json.field("data").field("home").field("repository").string("path"),
            context = HomeContext(
                workspaceId = context.string("workspaceId"),
                workspaceLabel = context.string("workspaceLabel"),
                repositoryId = context.string("repositoryId"),
                branch = context.string("branch"),
                activeWorkId = context.string("activeWorkId")
            ),
            activeWork = workCard(projection.field("activeWork")),
            needsUser = projection.array("needsUser").take(MAX_ITEMS).mapNotNull(::attention),
            worthChecking = projection.array("worthChecking").take(MAX_ITEMS).mapNotNull(::attention),
            recent = projection.array("recent").take(MAX_ITEMS).mapNotNull { entry ->
                val id = entry.string("id") ?: return@mapNotNull null
                RecentWork(id, entry.string("title"), entry.string("phase"), entry.string("status"), entry.string("group"))
            },
            healthy = projection.field("health").string("status") != "degraded",
            subjectRevision = projection.string("subjectRevision")
        ))
    }

    private fun reasons(entries: List<Json>): List<Reason> = entries.take(MAX_ITEMS).mapNotNull { entry ->
        entry.string("code")?.let { Reason(it, entry.slots("slots")) }
    }

    private fun fallback(json: Json?): Fallback? {
        val command = json.string("command") ?: return null
        return Fallback(command, json.bool("copyable") == true)
    }

    private fun action(json: Json): NextAction? {
        val id = json.string("id") ?: return null
        return NextAction(
            id = id,
            label = json.string("label") ?: id,
            rank = json.int("rank") ?: Int.MAX_VALUE,
            kind = json.string("kind"),
            reasonCode = json.string("reasonCode"),
            confirmation = Confirmation.of(json.string("confirmation")),
            primary = json.string("emphasis") == "primary",
            fallback = fallback(json.field("fallback"))
        )
    }

    private fun workCard(json: Json?): WorkCard? {
        val id = json.string("id") ?: return null
        return WorkCard(
            id = id,
            kind = json.string("kind"),
            title = json.string("title"),
            phase = json.string("phase"),
            status = json.string("status"),
            group = json.string("group"),
            rail = json.array("rail").take(MAX_ITEMS).mapNotNull { step ->
                val label = step.string("label") ?: step.string("id") ?: return@mapNotNull null
                RailStep(step.string("id"), label, step.string("state"))
            },
            actionId = json.field("action").string("id")
        )
    }

    private fun attention(json: Json): AttentionItem? {
        val id = json.string("id") ?: return null
        return AttentionItem(
            id = id,
            kind = json.string("kind"),
            title = json.string("title") ?: id,
            workId = json.string("workId"),
            phase = json.string("phase"),
            reasonCode = json.string("reasonCode"),
            actionId = json.field("action").string("id")
        )
    }

    private fun refusalPlan(json: Json): Failure {
        val error = json.field("error")
        return Failure(
            headline = error.string("message") ?: "sflow refused the request.",
            code = error.string("code"),
            steps = json.field("remediationPlan").array("steps").take(MAX_ACTIONS).mapNotNull { step ->
                val label = step.string("label") ?: return@mapNotNull null
                FailureStep(label, step.string("command"), step.bool("copyable") == true)
            }
        )
    }

    private fun commandResultV1(json: Json): Failure {
        val outcome = json.field("outcome")
        val headline = json.field("rendered").string("headline")
            ?: outcome.string("messageId")?.let { messages.label(it, outcome.slots("slots")) }
            ?: "sflow could not read your work."
        return Failure(
            headline = headline,
            code = json.array("why").firstOrNull().string("code"),
            reasons = json.array("why").mapNotNull { it.string("code") }.map { messages.label(it, emptyMap()) },
            steps = json.array("next").take(MAX_ACTIONS).mapNotNull { entry ->
                val command = entry.string("command") ?: return@mapNotNull null
                FailureStep(entry.string("label") ?: command, command, copyable = false)
            }
        )
    }

    /** No JSON at all: the CLI crashed or printed text. Show its own last error line. */
    private fun plainTextFailure(stdout: String): Failure {
        val lines = stdout.lines().map { it.trim() }.filter { it.isNotEmpty() }
        val line = lines.lastOrNull { it.startsWith("Singularity Flow error:") } ?: lines.lastOrNull()
        return Failure(headline = line?.take(MAX_TEXT) ?: "sflow returned no output.")
    }

    companion object {
        const val MAX_ACTIONS = 20
        const val MAX_ITEMS = 20
        const val MAX_TEXT = 500
    }
}
