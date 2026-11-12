import test from 'node:test';import {namespaceOutputGenerationCase} from './helpers/namespace-output-generation-case.mjs';
test('sqlite: a targeted Code return binds the fresh output and requires a new exact human witness',{timeout:600000},t=>namespaceOutputGenerationCase(t,'sqlite',{targeted:true}));
