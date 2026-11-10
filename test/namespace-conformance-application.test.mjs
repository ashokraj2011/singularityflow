import test from 'node:test';import {namespaceConformanceCase} from './helpers/namespace-conformance-case.mjs';
test('application: namespace release retains clause-bound original execution and completes independent review without another test run',t=>namespaceConformanceCase(t,'application'));
