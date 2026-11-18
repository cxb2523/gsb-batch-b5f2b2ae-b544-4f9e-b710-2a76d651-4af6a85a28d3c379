/**
 * Bundles the local stop-convergence tests with esbuild (already a devDependency
 * via vite) into test-dist/ and runs them with Node's built-in test runner.
 *
 * Why bundle: the library sources use extensionless relative TypeScript imports
 * (ESM + tsc style) which Node cannot resolve directly. esbuild resolves and
 * type-strips them in one step with no extra test-framework dependency.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { rmSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'test-dist')

rmSync(outDir, { recursive: true, force: true })

const entryPoints = readdirSync(here)
  .filter(name => name.endsWith('.test.mjs'))
  .map(name => join(here, name))

await build({
  entryPoints,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outdir: outDir,
  // Keep node's built-in test/assert modules external; bundle app code + deps.
  packages: 'bundle',
  logLevel: 'info',
})

const args = ['--test', ...entryPoints.map(file =>
  join(outDir, file.slice(here.length + 1).replace(/\.mjs$/, '.js')))]

execFileSync(process.execPath, args, { stdio: 'inherit', cwd: root })
