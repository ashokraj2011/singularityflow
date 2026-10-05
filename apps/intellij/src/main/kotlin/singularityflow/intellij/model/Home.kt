package singularityflow.intellij.model

/** How strongly the CLI says an action must be confirmed, least to most strict (src/gateway/policy.mjs). */
enum class Confirmation {
    NONE, HOST_CONFIRM, EXACT_CONFIRM, CEREMONY, EXPLICIT_ONLY,

    /** A value this build does not know. Treated as the strictest level. */
    UNKNOWN;

    companion object {
        fun of(value: String?): Confirmation = when (value) {
            "none" -> NONE
            "host-confirm" -> HOST_CONFIRM
            "exact-confirm" -> EXACT_CONFIRM
            "ceremony" -> CEREMONY
            "explicit-only" -> EXPLICIT_ONLY
            else -> UNKNOWN
        }
    }
}

/** The command a client without the gateway runs instead of an action's session-bound handle. */
data class Fallback(val command: String, val copyable: Boolean)

data class NextAction(
    val id: String,
    val label: String,
    val rank: Int,
    val kind: String?,
    val reasonCode: String?,
    val confirmation: Confirmation,
    val primary: Boolean,
    val fallback: Fallback?
) {
    val ceremony: Boolean get() = kind == "ceremony" || confirmation == Confirmation.CEREMONY
}

/** A message or reason code with the values it names. */
data class Reason(val code: String, val slots: Map<String, String>)

data class RailStep(val id: String?, val label: String, val state: String?)

data class WorkCard(
    val id: String,
    val kind: String?,
    val title: String?,
    val phase: String?,
    val status: String?,
    val group: String?,
    val rail: List<RailStep>,
    val actionId: String?
)

data class AttentionItem(
    val id: String,
    val kind: String?,
    val title: String,
    val workId: String?,
    val phase: String?,
    val reasonCode: String?,
    val actionId: String?
)

data class RecentWork(val id: String, val title: String?, val phase: String?, val status: String?, val group: String?)

data class HomeContext(
    val workspaceId: String?,
    val workspaceLabel: String?,
    val repositoryId: String?,
    val branch: String?,
    val activeWorkId: String?
)

/** Everything the panel renders from one `sflow home --json`. */
data class Home(
    val messageId: String?,
    val slots: Map<String, String>,
    val why: List<Reason>,
    val warnings: List<Reason>,
    val next: List<NextAction>,
    val repositoryPath: String?,
    val context: HomeContext,
    val activeWork: WorkCard?,
    val needsUser: List<AttentionItem>,
    val worthChecking: List<AttentionItem>,
    val recent: List<RecentWork>,
    val healthy: Boolean,
    val subjectRevision: String?
) {
    val primary: NextAction? get() = next.firstOrNull { it.primary }

    fun action(id: String?): NextAction? = if (id == null) null else next.firstOrNull { it.id == id }
}

/** A step the CLI offered with a refusal: label plus the command, when it has one. */
data class FailureStep(val label: String, val command: String?, val copyable: Boolean)

/** A read that did not produce a home, in words the panel shows as they are. */
data class Failure(
    val headline: String,
    val code: String? = null,
    val reasons: List<String> = emptyList(),
    val steps: List<FailureStep> = emptyList()
)

sealed interface HomeRead {
    data class Ready(val home: Home) : HomeRead
    data class Refused(val failure: Failure) : HomeRead
}
