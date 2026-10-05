package singularityflow.intellij.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import singularityflow.intellij.cli.SflowInvocation
import java.nio.file.Path

class TerminalTest {
    private fun request(program: Program, mode: LaunchMode = LaunchMode.RUN) =
        TerminalRequest(listOf("story", "return", "FIX-1"), mode, Path.of("/work/my repo"), "Return", program)

    @Test
    fun `shells are recognised by name`() {
        assertEquals(ShellKind.POSIX, ShellKind.of("/bin/zsh", windows = false))
        assertEquals(ShellKind.POSIX, ShellKind.of("/opt/homebrew/bin/fish", windows = false))
        assertEquals(ShellKind.POWERSHELL, ShellKind.of("C:\\Program Files\\PowerShell\\7\\pwsh.exe", windows = true))
        assertEquals(ShellKind.COMMAND_PROMPT, ShellKind.of("C:\\Windows\\System32\\cmd.exe", windows = true))
        assertEquals(ShellKind.UNSUPPORTED, ShellKind.of("/usr/local/bin/nu", windows = false))
        assertEquals(ShellKind.POWERSHELL, ShellKind.of(null, windows = true))
        assertEquals(ShellKind.POSIX, ShellKind.of(null, windows = false))
    }

    @Test
    fun `the program is the bare name when PATH finds it, else Node and the entry`() {
        assertEquals("'singularity-flow' 'story' 'return' 'FIX-1'",
            TerminalCommandBuilder.render(request(Program.OnPath), ShellKind.POSIX))
        val explicit = Program.Explicit(Path.of("/opt/homebrew/bin/node"), Path.of("/opt/homebrew/lib/node_modules/singularity-flow/bin/singularity-flow.mjs"))
        assertEquals("'/opt/homebrew/bin/node' '/opt/homebrew/lib/node_modules/singularity-flow/bin/singularity-flow.mjs' 'story' 'return' 'FIX-1'",
            TerminalCommandBuilder.render(request(explicit), ShellKind.POSIX))
        assertEquals("& 'singularity-flow' 'story' 'return' 'FIX-1'",
            TerminalCommandBuilder.render(request(Program.OnPath), ShellKind.POWERSHELL))
        assertNull(TerminalCommandBuilder.render(request(Program.OnPath), ShellKind.UNSUPPORTED))
    }

    @Test
    fun `the clipboard form changes directory first`() {
        assertEquals("'cd' '--' '/work/my repo' && 'singularity-flow' 'story' 'return' 'FIX-1'",
            TerminalCommandBuilder.renderWithDirectory(request(Program.OnPath), windows = false))
    }

    @Test
    fun `the plugin starts only version checks and home`() {
        val node = Path.of("/n/node")
        val entry = Path.of("/e/singularity-flow.mjs")
        assertEquals(listOf("/n/node", "--version"), SflowInvocation.NodeVersion.command(node, null))
        assertEquals(listOf("/n/node", "/e/singularity-flow.mjs", "--version"), SflowInvocation.CliVersion.command(node, entry))
        assertEquals(listOf("/n/node", "/e/singularity-flow.mjs", "home", "--json"), SflowInvocation.Home(null).command(node, entry))
        assertEquals(listOf("/n/node", "/e/singularity-flow.mjs", "home", "--json", "--workspace", "payments"),
            SflowInvocation.Home(" payments ").command(node, entry))
        assertEquals(listOf("/n/node", "/e/singularity-flow.mjs", "home", "--json"), SflowInvocation.Home("  ").command(node, entry))
        assertEquals(mapOf("NO_COLOR" to "1", "SINGULARITY_FLOW_NO_NETWORK" to "1"), SflowInvocation.ENVIRONMENT)
    }
}
