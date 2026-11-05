/**
 * Which files are private without anyone setting anything up, and which are shared settings whose
 * values are worth reading (docs/SPEC-ENVIRONMENT-FILES-v2.md). Names only: nothing here opens a file.
 */
// Windows reads `.env.`, `.env ` and `.env::$DATA` as `.env`, so they are the same name here.
const baseName = (file) => String(file ?? '').replaceAll('\\', '/').split('/').at(-1).replace(/:.*$/u, '').replace(/[. ]+$/u, '');

/** The rule that makes a file always local, or null. A template is how a team shares what such a file needs. */
export function alwaysLocalName(file) {
  const name = baseName(file);
  if (/^\.env\.(?:.+\.)?(?:example|sample|template|tmpl|dist|defaults|schema)$/iu.test(name)) return null;
  if (/^\.env$/iu.test(name)) return '.env';
  if (/^\.env\../iu.test(name)) return '.env.*';
  if (/^application-local\.(?:ya?ml|properties)$/iu.test(name)) return 'application-local.*';
  if (/\.local\.(?:ya?ml|json|properties|toml|ini)$/iu.test(name)) return '*.local.*';
  return null;
}

/** Whether a file is shared settings. JSON is mostly data, so only settings files by name. */
export function configShapedPath(file) {
  const name = baseName(file).toLowerCase();
  if (/\.(?:ya?ml|properties|toml|ini|cfg|conf|env)$/u.test(name) || /^\.env(?:rc|\..+)?$/u.test(name)) return true;
  return /\.json$/u.test(name)
    && /^(?:appsettings|application|config|configuration|settings|secrets|credentials|local\.settings)(?:[.-].*)?\.json$|[.-](?:config|settings)\.json$/u.test(name);
}

/** What the clone's `.git/info/exclude` holds so Git never offers an always-local file. Later lines win. */
export const ALWAYS_LOCAL_EXCLUDE_COMMENT = '# Singularity Flow: always-local files';
export const ALWAYS_LOCAL_EXCLUDES = Object.freeze(['.env', '.env.*', '!.env.d', ...['example', 'sample', 'template', 'tmpl', 'dist', 'defaults', 'schema'].flatMap((kind) => [`!.env.${kind}`, `!.env.*.${kind}`]),
  'application-local.yml', 'application-local.yaml', 'application-local.properties',
  '*.local.yml', '*.local.yaml', '*.local.json', '*.local.properties', '*.local.toml', '*.local.ini']);
