#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { reportCliFailure } from '../src/cli-failure.mjs';

const argv = ['inbox', ...process.argv.slice(2)];
main(['inbox', ...process.argv.slice(2)]).catch((error) => reportCliFailure(error, argv));
