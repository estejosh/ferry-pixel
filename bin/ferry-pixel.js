#!/usr/bin/env node
// Launcher so `npm i -g .` exposes a working `ferry-pixel` binary that runs
// the TypeScript CLI through tsx (shipped as a regular dependency).
import { register } from 'tsx/esm/api'

register()

await import(new URL('../src/cli.ts', import.meta.url).href)
