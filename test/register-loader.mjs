// Test-only ESM resolve hook: redirect any `import ... from 'tone'` to the
// instrumented fake in test/fake-tone.mjs. Register with:
//   node --import ./test/register-loader.mjs --test test/*.test.mjs
import { registerHooks } from 'node:module'

const fakeToneUrl = new URL('./fake-tone.mjs', import.meta.url).href

registerHooks({
  resolve (specifier, context, nextResolve) {
    if (specifier === 'tone') {
      // Import the fake as its own module namespace; both `import Tone from
      // 'tone'` and `import * as Tone from 'tone'` then resolve correctly.
      return nextResolve(fakeToneUrl, { ...context, importAttributes: context.importAttributes })
    }
    return nextResolve(specifier, context)
  },
  load (url, context, nextLoad) {
    // The project package has no "type": "module", but src/components/noise.js
    // is ESM syntax. Label it explicitly so Node parses it without a warning.
    if (url.endsWith('/src/components/noise.js')) {
      return nextLoad(url, { ...context, format: 'module' })
    }
    return nextLoad(url, context)
  }
})
