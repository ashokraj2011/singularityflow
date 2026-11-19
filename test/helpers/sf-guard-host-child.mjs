// The CLI as the VS Code extension host starts it (pipes, no terminal, no agent marker), with SF Guard's signer
// replaced in this process by a software key: never ssh-keygen, sc_auth, Touch ID or the Keychain. Only the signer is
// replaced; whether the process may take a touch is the CLI's own check. For tests only (sf-guard-card-selftest).
//   node sf-guard-host-child.mjs <PRIVATE-KEY.jwk.json> <singularity-flow arguments...>
import { readFileSync } from 'node:fs';

import { main } from '../../src/cli.mjs';
import { approveFromCard } from '../../src/commands/approve.mjs';
import { setPersonStepPresenceDependencies } from '../../src/presence/person-steps.mjs';
import { statementText } from '../../src/presence/statement.mjs';
import { parseArgs } from '../../src/util.mjs';
import { softwarePresenceKey } from './presence-keys.mjs';

const [file, ...argv] = process.argv.slice(2);
const key = softwarePresenceKey({ privateJwk: JSON.parse(readFileSync(file, 'utf8')) });
const presence = {
  signerAvailability: () => ({ available: true, reason: null }),
  holdsKey: async (keyId) => keyId === key.keyId,
  sign: async ({ statement, card }) => {
    process.stderr.write(`${JSON.stringify({ stubSigned: { keyId: key.keyId, card: typeof card === 'string' ? card.length : null } })}\n`);
    return { signature: key.sign(statementText(statement)), userVerification: false };
  },
  argv: ['node', 'singularity-flow', ...argv]
};
setPersonStepPresenceDependencies(presence);
try {
  const { positionals, options } = parseArgs(argv);
  // `approve` takes its signer as an argument, never from the process's person-step readers.
  if (positionals[0] === 'approve') await approveFromCard(positionals, options, { presence });
  else await main(argv);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: { code: error?.code ?? null, message: error?.message ?? String(error) } })}\n`);
  process.exitCode = 1;
}
