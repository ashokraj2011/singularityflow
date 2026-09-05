#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { reportCliFailure } from '../src/cli-failure.mjs';

const argv = ['reset-all', ...process.argv.slice(2)];
main(['reset-all', ...process.argv.slice(2)]).catch((error) => reportCliFailure(error, argv));
