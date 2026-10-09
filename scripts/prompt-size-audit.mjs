#!/usr/bin/env node
import { retainedPromptInventory } from '../src/retained-prompt-inventory.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--story-dir' || !args[1]) {
  console.error('Usage: node scripts/prompt-size-audit.mjs --story-dir <selected-Story-directory>');
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(await retainedPromptInventory(args[1]), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: { code: error.code ?? 'PROMPT_INVENTORY_FAILED', message: error.message } }));
    process.exitCode = 1;
  }
}
