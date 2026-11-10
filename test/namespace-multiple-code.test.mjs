import test from 'node:test';import {namespaceMultipleCodeCase} from './helpers/namespace-multiple-code-case.mjs';
test('three Code phases retain their own observed claims and original approvals without borrowing test runs',{timeout:120000},t=>namespaceMultipleCodeCase(t,'filesystem'));
test('multiple Code predecessors retain actual mixed visual acceptance and each source receipt',{timeout:120000},t=>namespaceMultipleCodeCase(t,'filesystem',{mixed:true}));
test('multiple repository-qualified Code predecessors retain each repository claim without cross-accounting',{timeout:120000},t=>namespaceMultipleCodeCase(t,'filesystem',{repositories:2}));
test('a prior approved removal cannot be carried after another Code phase recreates the deleted input',{timeout:120000},t=>namespaceMultipleCodeCase(t,'filesystem',{removal:true}));
