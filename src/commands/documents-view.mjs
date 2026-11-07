/** Command grammar and legacy rendering over the registered document reader. */
import {repoRoot} from '../git.mjs';
import {optionBoolean,optionString,requirePositional} from '../util.mjs';
import {withCommandObservability} from '../command-observability.mjs';
import {pathForDisplay} from './shared/path-for-display.mjs';
import {refuseNearMissDocumentOptions} from './shared/document-options.mjs';
import {documentTitle,documentPhasesLabel} from './shared/document-presentation.mjs';

export async function run(argv,{positionals,options}) {
  return withCommandObservability('documents',argv,options,()=>documentViewCommand(positionals,options));
}

export async function documentViewCommand(positionals,options,{root=repoRoot()}={}) {
  refuseNearMissDocumentOptions('view',options);
  const reference=requirePositional(positionals,2,'document ID, name or path');
  const {createGitQueryEngine}=await import('../engine-compatibility/git-query.mjs');
  const binding=createGitQueryEngine({root});
  await binding.engine.run('document.read',{reference,workId:optionString(options,'work-id')??null,includeDetached:optionBoolean(options,'all')});
  const {result,workflow}=binding.presentation();
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(documentTitle(result.record));
  if (['file', 'url'].includes(result.record.type)) console.log(`Used in: ${documentPhasesLabel(result.record, workflow.phaseOrder)}`);
  if (result.record.storage?.kind === 'local') console.log('Kept on this machine only; its bytes are not in the repository.');
  console.log(`Type: ${result.record.type}${result.record.mimeType ? ` (${result.record.mimeType})` : ''}`);
  if (result.record.url) console.log(`URL: ${result.record.url}`);
  else console.log(`Path: ${result.absolutePath ?? pathForDisplay(root, result.record.path)}`);
  if (result.rendition?.status === 'extracted') process.stdout.write(`\nText extracted from this file (the original is binary):\n\n${result.rendition.text}`);
  else if (result.binary) console.log('Binary document: use the path above in an image, PDF, Figma, or local viewer.');
  else if (result.content != null) process.stdout.write(`\n${result.content}`);
}
