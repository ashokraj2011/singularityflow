/** Package the canonical updater and its Node-built-in-only closure; no checkout is needed to run it. */
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installerProcess } from '../runtime/install.mjs';
import { isMainModule } from '../runtime/updater/entry.mjs';
import { UPDATER_FILES } from '../runtime/updater/files.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
export const STANDALONE_UPDATER_FILES = UPDATER_FILES;

async function portableModes(archive) {
  // Windows ZIP writers do not set Unix executable bits. Set them on our own bounded archive so a
  // package built on either OS still has a clickable Mac launcher after extraction.
  const bytes = await readFile(archive), end = bytes.length - 22;
  if (bytes.length > 20 * 1024 * 1024 || end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) {
    throw new Error('The updater ZIP writer returned an unsupported archive.');
  }
  let cursor = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('The updater ZIP directory is invalid.');
    const length = bytes.readUInt16LE(cursor + 28), name = bytes.toString('utf8', cursor + 46, cursor + 46 + length).replaceAll('\\', '/');
    const encoded = Buffer.from(name, 'utf8'), local = bytes.readUInt32LE(cursor + 42);
    if (encoded.length !== length || local + 30 + length > bytes.length
      || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 26) !== length) {
      throw new Error('The updater ZIP filename metadata is invalid.');
    }
    // .NET Framework's ZIP writer uses backslashes. ZIP paths must use forward slashes in both
    // directories, even when the archive is built on Windows and extracted on Mac.
    encoded.copy(bytes, cursor + 46); encoded.copy(bytes, local + 30);
    const mode = name.endsWith('/') ? 0o40755 : /\.(sh|command)$/u.test(name) ? 0o100755 : 0o100644;
    bytes[cursor + 5] = 3; // Unix creator: extraction honors the high-word mode on Mac.
    bytes.writeUInt32LE((mode * 65536) >>> 0, cursor + 38);
    cursor += 46 + length + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  await writeFile(archive, bytes);
}

export async function buildPackageUpdater({ source = repository, outDirectory = path.join(repository, 'dist'),
  execute = installerProcess } = {}) {
  outDirectory = path.resolve(outDirectory);
  await mkdir(outDirectory, { recursive: true });
  const target = path.join(outDirectory, 'SFlow-Updater.zip');
  const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Updater ZIP target is redirected; preserved.');
  const temporary = await mkdtemp(path.join(outDirectory, '.updater-build-'));
  const folder = path.join(temporary, 'SFlow-Updater');
  try {
    await mkdir(folder);
    for (const relative of STANDALONE_UPDATER_FILES) {
      const input = path.join(source, relative), output = path.join(folder, relative);
      const info = await lstat(input);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Updater input is not an ordinary file: ' + relative);
      await mkdir(path.dirname(output), { recursive: true });
      if (relative === 'update-sflow.sh' || relative === 'update-sflow.ps1') {
        const text = await readFile(input, 'utf8');
        if (text.split('runtime/update.mjs').length !== 2) throw new Error('Updater launcher entry contract changed: ' + relative);
        await writeFile(output, text.replace('runtime/update.mjs', 'update-sflow.mjs'));
      } else await copyFile(input, output);
      await chmod(output, relative.endsWith('.sh') ? 0o755 : 0o644);
    }
    await writeFile(path.join(folder, 'update-sflow.mjs'),
      "import { main } from './runtime/update.mjs';\nawait main({ reinstall: true });\n");
    for (const name of ['README.md', 'Update SFlow.command', 'Update SFlow.cmd']) {
      await copyFile(path.join(source, 'distribution/package-updater', name), path.join(folder, name));
      await chmod(path.join(folder, name), name.endsWith('.command') ? 0o755 : 0o644);
    }
    const archive = path.join(temporary, 'SFlow-Updater.zip');
    if (process.platform === 'win32') {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      await execute(powershell, ['-NoLogo', '-NoProfile', '-Command',
        "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:SFLOW_UPDATER_BUILD_FOLDER,$env:SFLOW_UPDATER_BUILD_ZIP,[IO.Compression.CompressionLevel]::Optimal,$true)"],
      { cwd: temporary, env: { ...process.env, SFLOW_UPDATER_BUILD_FOLDER: folder, SFLOW_UPDATER_BUILD_ZIP: archive }, timeoutMs: 60000 });
    } else {
      await execute('/usr/bin/zip', ['-X', '-q', '-r', archive, 'SFlow-Updater'], { cwd: temporary, timeoutMs: 60000 });
    }
    await portableModes(archive);
    await rename(archive, target);
    return { archive: target, folderName: 'SFlow-Updater', files: STANDALONE_UPDATER_FILES.length + 4 };
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
if (await isMainModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--out-dir')) throw new Error('Usage: node scripts/build-package-updater.mjs [--out-dir DIRECTORY]');
    console.log((await buildPackageUpdater({ outDirectory: args[1] || undefined })).archive);
  } catch (error) { console.error('Updater packaging failed: ' + error.message); process.exitCode = 1; }
}
