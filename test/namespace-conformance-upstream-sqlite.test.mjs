import test from 'node:test';import {namespaceConformanceUpstreamCase} from './helpers/namespace-conformance-upstream-case.mjs';
test('sqlite: linked conformance reuses one exact upstream decision',t=>namespaceConformanceUpstreamCase(t,'sqlite'));
