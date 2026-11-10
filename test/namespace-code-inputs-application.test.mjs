import test from 'node:test';import {namespaceCodeInputCase} from './helpers/namespace-code-input-case.mjs';
test('application: downstream Code evidence survives authoring, publication, independent approval and shared-only replay',t=>namespaceCodeInputCase(t,'application'));
