import test from 'node:test';
import {namespaceUpstreamInitialCodeCase,namespaceUpstreamSuccessorCodeCase} from './helpers/namespace-upstream-code-return-case.mjs';
test('application: first Code authenticates the upstream return and original replacement approvals',t=>namespaceUpstreamInitialCodeCase(t,'application'));
test('application: successor Code revalidates an upstream plan return with fresh tests',t=>namespaceUpstreamSuccessorCodeCase(t,'application'));
test('application: direct upstream Code return retains original evidence and completes release',t=>namespaceUpstreamSuccessorCodeCase(t,'application',{direct:true}));
