/** Native executable fault-injection fixture. Never installed or imported by product code. */
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function gitTestWrapperEnvironment(directory, source = process.env) {
  const entries = Object.entries(source);
  const original = entries.find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  return { ...Object.fromEntries(entries.filter(([key]) => key.toLowerCase() !== 'path')),
    PATH: directory + path.delimiter + original };
}

export function realGitForTest() {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which',
    [process.platform === 'win32' ? 'git.exe' : 'git'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Test Git executable could not be located: ' + result.stderr);
  return result.stdout.trim().split(/\r?\n/u)[0];
}

export async function writeGitTestWrapper(directory, source) {
  await mkdir(directory, { recursive: true });
  if (process.platform !== 'win32') {
    const wrapper = path.join(directory, 'git');
    await writeFile(wrapper, source);
    await chmod(wrapper, 0o755);
    return wrapper;
  }
  // Production refuses .cmd/.bat Git launchers; exercise that same policy with a real PE bridge,
  // not a shell escape or a product-only test switch. Node receives exact quoted argv.
  const script = path.join(directory, 'git-wrapper.cjs');
  const program = path.join(directory, 'git-wrapper.cs');
  const executable = path.join(directory, 'git.exe');
  const encoded = value => Buffer.from(value).toString('base64');
  await writeFile(script, source);
  await writeFile(program, String.raw`using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
class GitTestWrapper {
  static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
  static string Quote(string value) {
    var output = new StringBuilder(); output.Append('"'); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      output.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
      output.Append(c); slashes = 0;
    }
    output.Append('\\', slashes * 2); output.Append('"'); return output.ToString();
  }
  static int Main(string[] args) {
    // Framework Process uses Console.InputEncoding for its stdin StreamWriter and AutoFlush
    // writes that encoding's preamble. Use a BOM-less encoding without changing a console code
    // page; all payload I/O below goes through raw BaseStream, never through the text writer.
    Console.InputEncoding = new UnicodeEncoding(false, false);
    var child = new Process();
    child.StartInfo.FileName = Decode("${encoded(process.execPath)}");
    child.StartInfo.Arguments = Quote(Decode("${encoded(script)}"));
    foreach (string arg in args) child.StartInfo.Arguments += " " + Quote(arg);
    child.StartInfo.UseShellExecute = false;
    child.StartInfo.CreateNoWindow = true;
    child.StartInfo.RedirectStandardInput = true;
    child.StartInfo.RedirectStandardOutput = true;
    child.StartInfo.RedirectStandardError = true;
    child.Start();
    var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
    var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
    Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream).ContinueWith(task => {
      try { child.StandardInput.Close(); } catch { }
    });
    child.WaitForExit(); Task.WaitAll(output, error); return child.ExitCode;
  }
}`);
  const system = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  let compiler;
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = path.join(system, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    try { await access(candidate); compiler = candidate; break; } catch { /* Try the other framework. */ }
  }
  if (!compiler) throw new Error('Native Windows Git fault-injection tests require the .NET Framework C# compiler.');
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/out:' + executable, program],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('Could not compile native Git test wrapper: ' + result.stdout + result.stderr);
  return executable;
}
