import test from 'node:test';import {namespaceCodeReworkCase} from './helpers/namespace-code-rework-case.mjs';
test('filesystem: a human-approved release repair creates a separately tested Code successor and retains every original generation',t=>namespaceCodeReworkCase(t,'filesystem'));
