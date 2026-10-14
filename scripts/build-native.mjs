#!/usr/bin/env node
// Builds the Rust napi addon (native/crates/ghost-node) and installs it as native/dist/ghost.node.
//
//   npm run build:native              release build
//   npm run build:native -- --debug   debug build (faster to compile; still opt-level 1)
//
// Uses CARGO_TARGET_DIR if set, else native/target/bindings. The addon is copied to a temp file
// and renamed into place, so a running Electron that has the old ghost.node mapped keeps working
// (overwriting a loaded, signed dylib in place gets the process killed on macOS).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nativeDir = join(root, 'native')
const args = process.argv.slice(2)
const debug = args.includes('--debug')
const unknown = args.filter((a) => a !== '--debug' && a !== '--release')
if (unknown.length) {
  console.error(`build-native: unknown argument(s): ${unknown.join(' ')}\nusage: build-native.mjs [--debug]`)
  process.exit(2)
}

const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(nativeDir, 'target', 'bindings')
const profile = debug ? 'debug' : 'release'
const cargoArgs = ['build', '-p', 'ghost-node', ...(debug ? [] : ['--release'])]

console.log(`build-native: cargo ${cargoArgs.join(' ')}  (${profile}, target ${targetDir})`)
const t0 = Date.now()
const res = spawnSync('cargo', cargoArgs, {
  cwd: nativeDir,
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: targetDir }
})
if (res.error) {
  console.error(`build-native: failed to run cargo: ${res.error.message}`)
  process.exit(1)
}
if (res.status !== 0) {
  console.error(`build-native: cargo exited with ${res.status ?? res.signal}`)
  process.exit(res.status || 1)
}

const libName = { darwin: 'libghost_node.dylib', win32: 'ghost_node.dll' }[process.platform] ?? 'libghost_node.so'
const built = join(targetDir, profile, libName)
if (!existsSync(built)) {
  console.error(`build-native: expected build output not found: ${built}`)
  process.exit(1)
}

const distDir = join(nativeDir, 'dist')
const dest = join(distDir, 'ghost.node')
const tmp = `${dest}.tmp-${process.pid}`
mkdirSync(distDir, { recursive: true })
try {
  copyFileSync(built, tmp)
  renameSync(tmp, dest)
} catch (e) {
  rmSync(tmp, { force: true })
  console.error(`build-native: failed to install ${dest}: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}

const mb = (statSync(dest).size / 1048576).toFixed(1)
console.log(`build-native: ${dest} (${mb} MB, ${profile}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
