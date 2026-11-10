import test from 'node:test';
import {namespaceUpstreamInitialCodeCase,namespaceUpstreamSuccessorCodeCase} from './helpers/namespace-upstream-code-return-case.mjs';
test('first Code execution authenticates an upstream return and original replacement approvals',{timeout:120000},t=>namespaceUpstreamInitialCodeCase(t,'filesystem'));
test('Code successor authenticates an upstream return to its plan and executes fresh tests',{timeout:120000},t=>namespaceUpstreamSuccessorCodeCase(t,'filesystem'));
test('a direct upstream Code return preserves approved evidence and completes release',{timeout:120000},t=>namespaceUpstreamSuccessorCodeCase(t,'filesystem',{direct:true}));
