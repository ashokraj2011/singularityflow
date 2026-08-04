import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSkillPolicy, formatSkillAudit } from './skill-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const json = process.argv.includes('--json');
const result = await auditSkillPolicy(root, { write });
console.log(json ? JSON.stringify(result, null, 2) : formatSkillAudit(result));
if (result.errors.length) process.exitCode = 1;
