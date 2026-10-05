package singularityflow.intellij.cli

import java.nio.file.Files
import java.nio.file.Path

data class Installation(val node: Path, val entry: Path, val nodeVersion: String, val cliVersion: String)

sealed interface Detection {
    /** Usable. [notice] names a version difference worth knowing about but not blocking. */
    data class Ready(val installation: Installation, val notice: String?) : Detection

    data class Problem(val kind: Kind, val message: String, val searched: List<String>) : Detection

    enum class Kind { NODE_MISSING, NODE_TOO_OLD, CLI_MISSING, CLI_TOO_OLD, CLI_BROKEN }
}

/**
 * Finds Node and the sflow CLI entry (`bin/singularity-flow.mjs`), then checks both versions.
 *
 * The plugin always starts `node <entry>` rather than the `sflow` launcher: npm's launcher is a
 * `#!/usr/bin/env node` script, which fails when an IDE started from the Dock has no Node on PATH.
 */
class CliLocator(
    private val environment: Map<String, String>,
    private val findInPath: (String) -> Path?,
    private val home: Path,
    private val windows: Boolean,
    /** Runs a version command and returns its trimmed stdout, or null when it failed. */
    private val probe: suspend (List<String>) -> String?,
    /** The CLI version this plugin was built and tested with: its own version (gradle.properties). */
    private val builtFor: Version? = MIN_CLI,
    /** Also search machine-wide install locations (/opt/homebrew, /usr/local, Program Files). */
    private val systemLocations: Boolean = true
) {
    suspend fun locate(nodeSetting: String?, cliSetting: String?): Detection {
        val searched = ArrayList<String>()
        val entry = entryCandidates(cliSetting).firstNotNullOfOrNull { candidate ->
            searched += "CLI: $candidate"
            acceptEntry(candidate)
        } ?: return Detection.Problem(Detection.Kind.CLI_MISSING,
            "The Singularity Flow CLI was not found. Install it, or set its path in Settings | Tools | Singularity Flow.", searched)

        val node = nodeCandidates(nodeSetting, entry).firstOrNull { candidate ->
            searched += "Node.js: $candidate"
            Files.isRegularFile(candidate) && Files.isExecutable(candidate)
        } ?: return Detection.Problem(Detection.Kind.NODE_MISSING,
            "Node.js $MIN_NODE_MAJOR or newer was not found. Install it, or set its path in Settings | Tools | Singularity Flow.", searched)

        val nodeVersion = probe(SflowInvocation.NodeVersion.command(node, null))
            ?: return Detection.Problem(Detection.Kind.NODE_MISSING, "$node did not report a version.", searched)
        val nodeMajor = Regex("^v?(\\d+)\\.").find(nodeVersion)?.groupValues?.get(1)?.toIntOrNull()
        if (nodeMajor == null || nodeMajor < MIN_NODE_MAJOR) {
            return Detection.Problem(Detection.Kind.NODE_TOO_OLD,
                "Singularity Flow needs Node.js $MIN_NODE_MAJOR or newer; $node is $nodeVersion.", searched)
        }

        val cliVersion = probe(SflowInvocation.CliVersion.command(node, entry))
            ?: return Detection.Problem(Detection.Kind.CLI_BROKEN, "$entry did not report a version when run with $node.", searched)
        val found = Version.parse(cliVersion) ?: return Detection.Problem(Detection.Kind.CLI_BROKEN,
            "$entry reported an unrecognised version: $cliVersion", searched)
        if (found < MIN_CLI) {
            return Detection.Problem(Detection.Kind.CLI_TOO_OLD,
                "This plugin needs Singularity Flow $MIN_CLI or newer; $entry is $found. Update the CLI.", searched)
        }
        val built = builtFor
        val notice = if (built != null && (built.major != found.major || built.minor != found.minor)) {
            "This plugin was built for Singularity Flow ${built.major}.${built.minor}; the CLI is $found. Update one of them if anything looks wrong."
        } else null
        return Detection.Ready(Installation(node, entry, nodeVersion, found.toString()), notice)
    }

    private fun entryCandidates(cliSetting: String?): Sequence<Path> = sequence {
        cliSetting?.trim()?.takeIf { it.isNotEmpty() }?.let { yield(Path.of(it)) }
        environment["SINGULARITY_FLOW_CLI"]?.trim()?.takeIf { it.isNotEmpty() }?.let { yield(Path.of(it)) }
        for (name in listOf("singularity-flow", "sflow")) findInPath(name)?.let { yield(it) }
        yieldAll(globalPrefixes().map { it.resolve(GLOBAL_ENTRY) })
    }

    /** Places npm installs global packages, newest nvm version first. */
    private fun globalPrefixes(): List<Path> = buildList {
        if (windows) {
            environment["APPDATA"]?.let { add(Path.of(it, "npm")) }
        } else {
            if (systemLocations) {
                add(Path.of("/opt/homebrew"))
                add(Path.of("/usr/local"))
            }
            add(home.resolve(".npm-global"))
            add(home.resolve(".volta/tools/image/packages/singularity-flow"))
            addAll(nvmVersions())
        }
    }.distinct()

    private fun nvmVersions(): List<Path> {
        val root = home.resolve(".nvm/versions/node")
        if (!Files.isDirectory(root)) return emptyList()
        return Files.list(root).use { stream ->
            stream.filter { Files.isDirectory(it) }.toList()
                .sortedByDescending { Version.parse(it.fileName.toString().removePrefix("v")) ?: Version(0, 0, 0) }
        }
    }

    /**
     * The CLI entry for a candidate: the entry itself, the npm symlink `sflow` resolved to it, or a
     * Windows `sflow.cmd` shim beside its `node_modules`. Accepted only when it is a `.mjs` inside a
     * package named `singularity-flow`.
     */
    private fun acceptEntry(candidate: Path): Path? {
        val resolved = try {
            if (windows && candidate.fileName.toString().lowercase().endsWith(".cmd")) {
                candidate.parent.resolve("node_modules/singularity-flow/bin/singularity-flow.mjs")
            } else candidate.toRealPath()
        } catch (_: Exception) {
            return null
        }
        if (!Files.isRegularFile(resolved) || !resolved.fileName.toString().endsWith(".mjs")) return null
        val manifest = resolved.parent?.parent?.resolve("package.json") ?: return null
        val text = try { Files.readString(manifest) } catch (_: Exception) { return null }
        return if (Regex("\"name\"\\s*:\\s*\"singularity-flow\"").containsMatchIn(text)) resolved else null
    }

    private fun nodeCandidates(nodeSetting: String?, entry: Path): Sequence<Path> = sequence {
        nodeSetting?.trim()?.takeIf { it.isNotEmpty() }?.let { yield(Path.of(it)) }
        // The Node that npm used to install this CLI: <prefix>/lib/node_modules/singularity-flow/bin/x.mjs.
        val prefix = entry.parent?.parent?.parent?.parent?.parent
        if (prefix != null) yield(prefix.resolve(if (windows) "node.exe" else "bin/node"))
        findInPath(if (windows) "node.exe" else "node")?.let { yield(it) }
        if (windows) {
            if (systemLocations) environment["ProgramFiles"]?.let { yield(Path.of(it, "nodejs", "node.exe")) }
        } else {
            if (systemLocations) {
                yield(Path.of("/opt/homebrew/bin/node"))
                yield(Path.of("/usr/local/bin/node"))
            }
            yield(home.resolve(".volta/bin/node"))
            yieldAll(nvmVersions().map { it.resolve("bin/node") })
        }
    }

    data class Version(val major: Int, val minor: Int, val patch: Int) : Comparable<Version> {
        override fun compareTo(other: Version) = compareValuesBy(this, other, Version::major, Version::minor, Version::patch)
        override fun toString() = "$major.$minor.$patch"

        companion object {
            fun parse(text: String): Version? {
                val match = Regex("(\\d+)\\.(\\d+)\\.(\\d+)").find(text.trim()) ?: return null
                val (major, minor, patch) = match.destructured
                return Version(major.toInt(), minor.toInt(), patch.toInt())
            }
        }
    }

    companion object {
        const val MIN_NODE_MAJOR = 20
        val MIN_CLI = Version(0, 9, 0)
        const val GLOBAL_ENTRY = "lib/node_modules/singularity-flow/bin/singularity-flow.mjs"
    }
}
