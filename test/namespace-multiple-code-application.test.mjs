import test from 'node:test';import {namespaceMultipleCodeCase} from './helpers/namespace-multiple-code-case.mjs';
test('application: multiple Code phases keep source, test and approval provenance through takeover',t=>namespaceMultipleCodeCase(t,'application'));
