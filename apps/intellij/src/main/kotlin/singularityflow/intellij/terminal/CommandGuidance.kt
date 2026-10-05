package singularityflow.intellij.terminal

import java.util.Base64

/**
 * A port of the engine's command trust boundary (src/safe-command-guidance.mjs).
 *
 * A command in a CLI result crossed a process boundary, so it is checked again before the plugin
 * types or runs it: only an sflow command, no shell syntax, no credential-shaped arguments. Quoting
 * follows the engine exactly. test/.../CommandGuidanceTest replays the engine's own answers from
 * fixtures/command-guidance.json, which scripts/generate-intellij-resources.mjs writes.
 * The engine also requires a registered top-level command; the plugin leaves that to the CLI, which
 * refuses an unknown command without acting.
 */
object CommandGuidance {

    /** A validated command: its arguments without the `sflow` program, and whether it is literal. */
    data class Validated(val argv: List<String>, val copyable: Boolean)

    enum class Platform { POSIX, POWERSHELL }

    private const val MAX_LENGTH = 2_000
    private val SAFE_EXECUTABLE = Regex("^(?:singularity-flow|sflow)(?:\\s|$)")
    private val SECRET_SHAPE = Regex(
        "(?:--(?:token|secret|password|credential|authorization|cookie|api[-_]?key|private[-_]?key|selection[-_]?receipt)\\b|://[^\\s/@:]+:[^\\s/@]+@)",
        RegexOption.IGNORE_CASE
    )
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")
    private const val FORBIDDEN = ";&|`$()*?![]{}#~"
    private const val PLACEHOLDER = "<[A-Za-z][A-Za-z0-9 ._/|-]*>"
    private val PLACEHOLDERS = Regex("(?<![A-Za-z0-9._/-])$PLACEHOLDER(?![A-Za-z0-9._/-])")
    private val PLACEHOLDER_ASSIGNMENTS = Regex(
        "(?<![A-Za-z0-9._/-])$PLACEHOLDER=[A-Za-z0-9._/-]+(?:\\|[A-Za-z0-9._/-]+)+(?![A-Za-z0-9._/-])"
    )
    private val OPTIONAL_GROUPS = Regex(
        "\\[--[a-z0-9][a-z0-9-]*(?:\\s+(?:$PLACEHOLDER|[A-Za-z0-9._/-]+|\\.\\.\\.))*\\]",
        RegexOption.IGNORE_CASE
    )
    private val LEGACY_PLACEHOLDERS = Regex(
        "(?<![A-Za-z0-9._/-])(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|WORK-ID|GOAL-ID|BOOTSTRAP-ID|CFP-ID|PLAN-HASH|PREDICATE-ID|CONFIGURED-COMMAND-ID|PROPOSAL-FILE|FILE|URL|PATH|PHASE|TYPE|TEXT|ID|SHA|SHA256|REVISION|PROFILE|SLICE|LEVEL|ASSURANCE|VERSION|STATUS|SOURCE|ENV|SECONDS|BYTES)(?![A-Za-z0-9._/-])"
    )
    private val ELLIPSES = Regex("\\.{3}|…")

    fun validate(value: String): Validated? {
        val original = value.trim()
        if (original.isEmpty() || original.length > MAX_LENGTH || CONTROL.containsMatchIn(original)) return null
        if (!SAFE_EXECUTABLE.containsMatchIn(original) || SECRET_SHAPE.containsMatchIn(original)) return null
        val optional = OPTIONAL_GROUPS.replace(original, " OPTIONAL ")
        val assignments = PLACEHOLDER_ASSIGNMENTS.replace(optional, " VALUE ")
        val placeholders = PLACEHOLDERS.replace(assignments, " VALUE ")
        val legacy = LEGACY_PLACEHOLDERS.replace(placeholders, " VALUE ")
        val scrubbed = ELLIPSES.replace(legacy, " MORE ")
        val displayOnly = optional != original || assignments != optional || placeholders != assignments
            || legacy != placeholders || scrubbed != legacy
        if (hasForbiddenShellSyntax(scrubbed) || scrubbed.any { it in "<>[]" }) return null
        val tokens = tokenize(original) ?: return null
        if (tokens.isEmpty() || tokens[0] !in setOf("singularity-flow", "sflow")) return null
        val top = tokens.getOrNull(1) ?: return null
        if (top.startsWith("-") && top !in setOf("--help", "--version", "-h", "-v")) return null
        return Validated(tokens.drop(1), copyable = !displayOnly)
    }

    private fun hasForbiddenShellSyntax(value: String): Boolean {
        var quote: Char? = null
        for (character in value) {
            when (quote) {
                '\'' -> if (character == '\'') quote = null
                '"' -> {
                    if (character == '"') quote = null
                    // Both POSIX shells and PowerShell interpolate at least one of these in double quotes.
                    else if (character in "$`!") return true
                }
                else -> when {
                    character == '\'' || character == '"' -> quote = character
                    character in FORBIDDEN -> return true
                }
            }
        }
        return false
    }

    /** POSIX-style word splitting with the engine's escape rules; null when a quote is left open. */
    fun tokenize(command: String): List<String>? {
        val tokens = ArrayList<String>()
        val current = StringBuilder()
        var quote: Char? = null
        var escaped = false
        var index = 0
        while (index < command.length) {
            val character = command[index]
            if (escaped) {
                current.append(character); escaped = false; index++; continue
            }
            if (character == '\\' && quote != '\'') {
                val next = command.getOrNull(index + 1)
                // A backslash escapes only where POSIX and Windows readings agree, so C:\work survives.
                val escapable = if (quote == '"') next == '"' || next == '\\'
                else next != null && (isWhitespace(next) || next == '"' || next == '\'' || next == '\\')
                if (escapable) escaped = true else current.append(character)
                index++
                continue
            }
            if (quote != null) {
                if (character == quote) quote = null else current.append(character)
                index++
                continue
            }
            when {
                character == '"' || character == '\'' -> quote = character
                isWhitespace(character) -> if (current.isNotEmpty()) {
                    tokens += current.toString(); current.setLength(0)
                }
                else -> current.append(character)
            }
            index++
        }
        if (escaped || quote != null) return null
        if (current.isNotEmpty()) tokens += current.toString()
        return tokens
    }

    /** JavaScript's `\s`, which the engine's tokenizer uses. */
    private fun isWhitespace(c: Char): Boolean = c == ' ' || c == '\t' || c == '\n' || c == '\r' ||
        c == '\u000B' || c == '\u000C' || c == '\u00A0' || c == '\u1680' || c in '\u2000'..'\u200A' ||
        c == '\u2028' || c == '\u2029' || c == '\u202F' || c == '\u205F' || c == '\u3000' || c == '\uFEFF'

    private fun quote(token: String, platform: Platform): String = when (platform) {
        Platform.POWERSHELL -> "'" + token.replace("'", "''") + "'"
        Platform.POSIX -> "'" + token.replace("'", "'\"'\"'") + "'"
    }

    /** One command line in which no argument is shell syntax: every word single-quoted. */
    fun render(argv: List<String>, platform: Platform): String {
        require(argv.isNotEmpty() && argv.all { it.isNotEmpty() && !CONTROL.containsMatchIn(it) }) {
            "Command arguments must be non-empty and contain no control characters."
        }
        val command = argv.joinToString(" ") { quote(it, platform) }
        return if (platform == Platform.POWERSHELL) "& $command" else command
    }

    fun renderChangeDirectory(directory: String, platform: Platform): String = when (platform) {
        Platform.POWERSHELL -> render(listOf("Set-Location", "-LiteralPath", directory), platform)
        Platform.POSIX -> render(listOf("cd", "--", directory), platform)
    }

    /** cmd.exe expands `%` and `!` even inside quotes, so the PowerShell form is passed encoded. */
    fun renderCommandPrompt(argv: List<String>): String {
        val encoded = Base64.getEncoder().encodeToString(render(argv, Platform.POWERSHELL).toByteArray(Charsets.UTF_16LE))
        return "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
    }
}
