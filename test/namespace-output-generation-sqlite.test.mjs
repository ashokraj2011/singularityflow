import test from 'node:test';import {namespaceOutputGenerationCase} from './helpers/namespace-output-generation-case.mjs';
test('SQLite output survives two actual Code generations, independent witnesses, Release and shared-only takeover',{timeout:180000},t=>namespaceOutputGenerationCase(t,'sqlite'));
