#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { reportCliFailure } from '../src/cli-failure.mjs';

const argv = ['agent', ...process.argv.slice(2)];
main(['agent', ...process.argv.slice(2)]).catch((error) => reportCliFailure(error, argv));
