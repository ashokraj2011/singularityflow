package singularityflow.intellij.cli

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

data class ProcessOutcome(
    /** Null when the process did not finish in time or was cancelled. */
    val exitCode: Int?,
    val stdout: String,
    val stderr: String,
    val timedOut: Boolean,
    val outputTooLarge: Boolean
)

/**
 * Runs one process off the UI thread with a time limit and an output cap. On timeout, cancellation
 * or project close the whole process tree is stopped, so no `node` is left behind.
 */
class ProcessRunner(private val start: (command: List<String>, directory: Path?) -> Process) {

    suspend fun run(command: List<String>, timeoutMillis: Long, directory: Path? = null): ProcessOutcome = withContext(Dispatchers.IO) {
        val process = start(command, directory)
        process.outputStream.close()
        val stdout = BoundedCollector(process.inputStream, MAX_STDOUT_BYTES)
        val stderr = BoundedCollector(process.errorStream, MAX_STDERR_BYTES)
        var finished = false
        try {
            finished = runInterruptible { process.waitFor(timeoutMillis, TimeUnit.MILLISECONDS) }
            if (!finished) stopTree(process)
            stdout.join()
            stderr.join()
            ProcessOutcome(
                exitCode = if (finished) process.exitValue() else null,
                stdout = stdout.text(),
                stderr = stderr.text(),
                timedOut = !finished,
                outputTooLarge = stdout.overflowed
            )
        } finally {
            if (!finished) withContext(NonCancellable) { stopTree(process) }
        }
    }

    /** Collects up to [limit] bytes and keeps draining past it, so a chatty child never blocks. */
    private class BoundedCollector(stream: InputStream, private val limit: Int) {
        private val buffer = ByteArrayOutputStream()
        @Volatile var overflowed = false
            private set
        private val reader = thread(isDaemon = true, name = "sflow-output") {
            val chunk = ByteArray(64 * 1024)
            stream.use { input ->
                while (true) {
                    val read = try { input.read(chunk) } catch (_: Exception) { -1 }
                    if (read < 0) break
                    synchronized(buffer) {
                        val room = limit - buffer.size()
                        if (room > 0) buffer.write(chunk, 0, minOf(read, room))
                        if (read > room) overflowed = true
                    }
                }
            }
        }

        fun join() = reader.join(JOIN_MILLIS)

        fun text(): String = synchronized(buffer) { buffer.toString(Charsets.UTF_8) }
    }

    companion object {
        const val MAX_STDOUT_BYTES = 32 * 1024 * 1024
        const val MAX_STDERR_BYTES = 1024 * 1024
        private const val JOIN_MILLIS = 2_000L

        fun stopTree(process: Process) {
            val children = try { process.toHandle().descendants().toList() } catch (_: Exception) { emptyList() }
            children.forEach { it.destroy() }
            process.destroy()
            if (!process.waitFor(2, TimeUnit.SECONDS)) {
                children.forEach { it.destroyForcibly() }
                process.destroyForcibly()
            }
        }
    }
}
