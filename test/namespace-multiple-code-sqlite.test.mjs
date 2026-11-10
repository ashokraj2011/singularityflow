import test from 'node:test';import {namespaceMultipleCodeCase} from './helpers/namespace-multiple-code-case.mjs';
test('sqlite: multiple Code phases keep source, test and approval provenance through takeover',t=>namespaceMultipleCodeCase(t,'sqlite'));
