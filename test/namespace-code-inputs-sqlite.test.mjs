import test from 'node:test';import {namespaceCodeInputCase} from './helpers/namespace-code-input-case.mjs';
test('sqlite: downstream Code evidence survives authoring, publication, independent approval and shared-only replay',t=>namespaceCodeInputCase(t,'sqlite'));
