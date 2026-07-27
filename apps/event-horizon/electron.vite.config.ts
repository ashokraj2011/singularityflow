import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Singularity Flow's host build for Event Horizon.
 *
 * The upstream tool lives in a pinned submodule at `vendor/event-horizon` and
 * is never edited here — that is the whole point of this arrangement. Only the
 * main entry and the renderer entry are ours; the preload is upstream's,
 * verbatim.
 *
 * The preload and renderer are built into *our* out/ because
 * `openEventHorizonWindow()` resolves them relative to the running __dirname.
 * Bundling upstream's source into our build and then pointing at upstream's
 * out/ would load two different copies.
 */
const upstream = resolve(__dirname, '../../vendor/event-horizon')

/**
 * An array rather than an object, because order decides the match and the
 * subpaths must be tried before their prefixes — `event-horizon/renderer`
 * points at a *file*, so a bare prefix match would turn
 * `event-horizon/renderer/style.css` into `.../index.ts/style.css`.
 */
const alias = [
  {
    find: 'event-horizon/renderer/style.css',
    replacement: resolve(upstream, 'src/renderer/src/styles/index.css')
  },
  {
    find: 'event-horizon/providers/singularity-flow',
    replacement: resolve(upstream, 'src/main/providers/singularityFlow.ts')
  },
  { find: 'event-horizon/renderer', replacement: resolve(upstream, 'src/renderer/src/index.ts') },
  { find: 'event-horizon/core', replacement: resolve(upstream, 'src/main/core.ts') },
  { find: '@shared', replacement: resolve(upstream, 'src/shared') },
  { find: '@renderer', replacement: resolve(upstream, 'src/renderer/src') },
  { find: '@flow', replacement: resolve(__dirname, 'src/shared') }
]

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      // Upstream is consumed as source, so it must be bundled rather than
      // externalized — externalizeDepsPlugin is deliberately absent.
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: ['electron', /^node:/]
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(upstream, 'src/preload/index.ts') },
        external: ['electron', /^node:/]
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
