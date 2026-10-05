package singularityflow.intellij.cli

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions

class CliLocatorTest {
    private val root: Path = Files.createTempDirectory("sflow-locator")

    @After
    fun cleanUp() {
        root.toFile().deleteRecursively()
    }

    /** An npm global prefix with Node and the CLI installed the way npm installs them. */
    private fun prefix(name: String, packageName: String = "singularity-flow"): Path {
        val prefix = root.resolve(name)
        val entry = prefix.resolve(CliLocator.GLOBAL_ENTRY)
        Files.createDirectories(entry.parent)
        Files.writeString(entry, "#!/usr/bin/env node\n")
        Files.writeString(entry.parent.parent.resolve("package.json"), """{"name": "$packageName", "version": "0.9.0"}""")
        val node = prefix.resolve("bin/node")
        Files.createDirectories(node.parent)
        Files.writeString(node, "")
        Files.setPosixFilePermissions(node, PosixFilePermissions.fromString("rwxr-xr-x"))
        Files.createSymbolicLink(prefix.resolve("bin/sflow"), entry)
        return prefix
    }

    private fun locator(
        path: Map<String, Path> = emptyMap(),
        environment: Map<String, String> = emptyMap(),
        nodeVersion: String? = "v22.14.0",
        cliVersion: String? = "0.9.0",
        builtFor: CliLocator.Version = CliLocator.Version(0, 9, 0)
    ) = CliLocator(environment, { path[it] }, root.resolve("home"), windows = false, probe = { command ->
        if (command.size == 2) nodeVersion else cliVersion
    }, builtFor = builtFor, systemLocations = false)

    private fun ready(detection: Detection): Installation = (detection as? Detection.Ready)?.installation
        ?: throw AssertionError("expected Ready, got $detection")

    @Test
    fun `follows the sflow symlink on PATH to the entry and uses the Node beside it`() {
        val prefix = prefix("brew")
        val installation = ready(runBlocking { locator(path = mapOf("sflow" to prefix.resolve("bin/sflow"))).locate(null, null) })
        assertEquals(prefix.resolve(CliLocator.GLOBAL_ENTRY).toRealPath(), installation.entry)
        assertEquals(prefix.resolve("bin/node").toRealPath(), installation.node.toRealPath())
        assertEquals("0.9.0", installation.cliVersion)
    }

    @Test
    fun `settings win over the environment and PATH`() {
        val onPath = prefix("path")
        val configured = prefix("configured")
        val detection = runBlocking {
            locator(path = mapOf("sflow" to onPath.resolve("bin/sflow")),
                environment = mapOf("SINGULARITY_FLOW_CLI" to onPath.resolve(CliLocator.GLOBAL_ENTRY).toString()))
                .locate(configured.resolve("bin/node").toString(), configured.resolve("bin/sflow").toString())
        }
        val installation = ready(detection)
        assertEquals(configured.resolve(CliLocator.GLOBAL_ENTRY).toRealPath(), installation.entry)
        assertEquals(configured.resolve("bin/node"), installation.node)
    }

    @Test
    fun `the environment variable wins over PATH`() {
        val onPath = prefix("path")
        val fromEnvironment = prefix("environment")
        val installation = ready(runBlocking {
            locator(path = mapOf("sflow" to onPath.resolve("bin/sflow")),
                environment = mapOf("SINGULARITY_FLOW_CLI" to fromEnvironment.resolve(CliLocator.GLOBAL_ENTRY).toString()))
                .locate(null, null)
        })
        assertEquals(fromEnvironment.resolve(CliLocator.GLOBAL_ENTRY).toRealPath(), installation.entry)
    }

    @Test
    fun `a package with another name is not accepted`() {
        val impostor = prefix("impostor", packageName = "something-else")
        val detection = runBlocking { locator(path = mapOf("sflow" to impostor.resolve("bin/sflow"))).locate(null, null) }
        val problem = detection as Detection.Problem
        assertEquals(Detection.Kind.CLI_MISSING, problem.kind)
        assertTrue(problem.searched.any { it.contains("impostor") })
    }

    @Test
    fun `an old Node is refused with its version`() {
        val prefix = prefix("brew")
        val problem = runBlocking {
            locator(path = mapOf("sflow" to prefix.resolve("bin/sflow")), nodeVersion = "v18.19.0").locate(null, null)
        } as Detection.Problem
        assertEquals(Detection.Kind.NODE_TOO_OLD, problem.kind)
        assertTrue(problem.message.contains("v18.19.0"))
    }

    @Test
    fun `an old or broken CLI is refused`() {
        val prefix = prefix("brew")
        val sflow = mapOf("sflow" to prefix.resolve("bin/sflow"))
        assertEquals(Detection.Kind.CLI_TOO_OLD,
            (runBlocking { locator(path = sflow, cliVersion = "0.8.9").locate(null, null) } as Detection.Problem).kind)
        assertEquals(Detection.Kind.CLI_BROKEN,
            (runBlocking { locator(path = sflow, cliVersion = null).locate(null, null) } as Detection.Problem).kind)
        assertEquals(Detection.Kind.CLI_BROKEN,
            (runBlocking { locator(path = sflow, cliVersion = "unknown").locate(null, null) } as Detection.Problem).kind)
    }

    @Test
    fun `a different minor version is a notice, not a problem`() {
        val prefix = prefix("brew")
        val sflow = mapOf("sflow" to prefix.resolve("bin/sflow"))
        val same = runBlocking { locator(path = sflow, cliVersion = "0.9.4").locate(null, null) } as Detection.Ready
        assertNull(same.notice)
        val newer = runBlocking { locator(path = sflow, cliVersion = "0.10.0").locate(null, null) } as Detection.Ready
        assertNotNull(newer.notice)
    }

    @Test
    fun `nothing found lists every place searched`() {
        val problem = runBlocking { locator().locate(null, null) } as Detection.Problem
        assertEquals(Detection.Kind.CLI_MISSING, problem.kind)
        assertTrue(problem.searched.any { it.contains(".npm-global") })
    }
}
