/**
 * `story adjudicate` with no item: the table every card shows, in a person's own terminal, for a host
 * with no card (IntelliJ, Copilot CLI without experimental mode, a plain shell). The forms and their
 * words are the cards' own (`runDecisions`), asked here one field at a time, so a person meets the same
 * question wherever they work; the write is the same `--answers --expect` one, so each answer keeps its
 * own reason and a list that changed records nothing. With no terminal it asks nothing and names the
 * command: a chat turn is refused this form, and nothing an agent starts is ever asked.
 */
import { stdin as processInput, stdout as processOutput } from 'node:process';

import { SingularityFlowError } from '../util.mjs';
import { runDecisions } from '../../plugin/extensions/decisions/decisions.mjs';
import { lineReader } from './decisions.mjs';

export const adjudicationTableCommand = (workId) => `singularity-flow story adjudicate --work-id ${workId}`;

/**
 * One card form as questions. A choice is a number from its list and nothing is chosen for the person: a
 * bare Enter asks again. Input ending is a cancel, so nothing is recorded.
 */
export function terminalForms({ next, write }) {
  const say = (line) => write(`${line}\n`);
  const question = async (words) => { write(words); return next(); };
  return async function ask(form) {
    say('');
    say(form.message);
    const content = {};
    for (const [name, field] of Object.entries(form.requestedSchema.properties)) {
      if (!field.enum) {
        // What they typed last time stays with a bare Enter, so a re-ask never makes them type it again.
        const line = await question(`${field.title}${field.default ? ` [Enter keeps: ${field.default}]` : ''}: `);
        if (line === null) return { action: 'cancel' };
        if (line.trim() || field.default) content[name] = line.trim() || field.default;
        continue;
      }
      say(field.title);
      field.enum.forEach((entry, index) => say(`  ${index + 1}) ${entry}`));
      for (;;) {
        const line = await question(`Choose 1-${field.enum.length}: `);
        if (line === null) return { action: 'cancel' };
        const chosen = field.enum[Number(line.trim()) - 1];
        if (line.trim() && chosen) { content[name] = chosen; break; }
        say(`Type a number from 1 to ${field.enum.length}.`);
      }
    }
    return { action: 'accept', content };
  };
}

/** A person at their own terminal answers the table; anything else is told the command, and nothing is asked. */
export async function runAdjudicationTable({ workId, json, read, record, input = processInput, output = processOutput }) {
  const { personTerminal } = await import('../presence/person-records.mjs');
  const terminal = personTerminal();
  const reason = json ? 'it was asked for JSON' : !terminal.person ? terminal.reason : output.isTTY ? null : 'this command has no terminal to show the table in';
  if (reason) {
    const command = adjudicationTableCommand(workId);
    throw new SingularityFlowError(`A person answers this table in their own terminal, and here ${reason}. Nothing was asked or recorded. Run it there: ${command}`,
      { code: 'ADJUDICATION_TERMINAL_REQUIRED', details: { nextAction: { command, label: `Run in your own terminal: ${command}` } } });
  }
  const reader = lineReader(input);
  try {
    const result = await runDecisions({
      read,
      show: (text) => output.write(`${String(text).replaceAll('**', '')}\n`),
      ask: terminalForms({ next: reader.next, write: (text) => output.write(text) }),
      record
    });
    // `next` repeats what `message` says first; what it adds is the step after this table.
    const after = typeof result.next === 'string' ? result.next.replace(/^(?:All decided\.|Some items still need a decision\.)\s*/u, '') : '';
    output.write(`\n${result.message}${after ? `\n${after}` : ''}\n`);
    return result;
  } finally { reader.close(); }
}
