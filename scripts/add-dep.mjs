#!/usr/bin/env node
// Serialised `npm install` for parallel agents: takes a lock dir so two installs never overlap.
// Usage: npm run add-dep -- <pkg...> [--dev]
import { mkdirSync, rmdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const LOCK = new URL('../node_modules/.ghost-npm.lock', import.meta.url).pathname
const args = process.argv.slice(2)
const dev = args.includes('--dev')
const pkgs = args.filter((a) => a !== '--dev')
if (!pkgs.length) {
  console.error('usage: npm run add-dep -- <pkg...> [--dev]')
  process.exit(1)
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const started = Date.now()
for (;;) {
  try {
    mkdirSync(LOCK)
    break
  } catch {
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > 10 * 60_000) rmdirSync(LOCK) // stale
    } catch {}
    if (Date.now() - started > 15 * 60_000) throw new Error('timed out waiting for npm lock')
    sleep(1500)
  }
}
try {
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', dev ? '--save-dev' : '--save', ...pkgs], { stdio: 'inherit' })
  process.exitCode = r.status ?? 1
} finally {
  rmdirSync(LOCK)
}
