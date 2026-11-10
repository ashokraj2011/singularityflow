import test from 'node:test';
import {namespaceUpstreamInitialCodeCase,namespaceUpstreamSuccessorCodeCase} from './helpers/namespace-upstream-code-return-case.mjs';
test('sqlite: first Code authenticates the upstream return and original replacement approvals',t=>namespaceUpstreamInitialCodeCase(t,'sqlite'));
test('sqlite: successor Code revalidates an upstream plan return with fresh tests',t=>namespaceUpstreamSuccessorCodeCase(t,'sqlite'));
test('sqlite: direct upstream Code return retains original evidence and completes release',t=>namespaceUpstreamSuccessorCodeCase(t,'sqlite',{direct:true}));
