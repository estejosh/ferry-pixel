#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import {
  discoverServers,
  parseServerUrl,
  sendAll,
  sendToUrl,
  type HookPayload,
  type ServerTarget,
} from './emitter'
import { pipeEvent } from './pipeline'
import { TaskStateMachine } from './state'
import { tryLoadShared } from './shared'
import { watch, type ChannelEvent as RawChannelEvent } from './watcher'

interface CliOptions {
  channels: string[]
  server?: string
  registry?: string
  dryRun: boolean
  help: boolean
}

const HELP = `ferry-pixel — inject ferry channel activity into Pixel Agents offices

Usage:
  ferry-pixel --channel <dir> [--channel <dir> ...] [options]

Options:
  --channel <dir>   channel directory to watch (repeatable)
  --server <url>    override discovery; http://<token>@127.0.0.1:<port> embeds the token
  --registry <dir>  alternate ~/.pixel-agents/servers registry dir
  --dry-run         print hook payloads instead of sending
  --help            show this help

Pipeline: channel file -> ChannelEvent -> task state machine (office actions)
-> hook mapper (src/map.ts) -> POST /api/hooks/claude on every discovered
pixel-agents server. See ../PROTOCOL.md for the wire protocol.
`

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      channel: { type: 'string', multiple: true },
      server: { type: 'string' },
      registry: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  return {
    channels: values.channel ?? [],
    server: values.server,
    registry: values.registry,
    dryRun: values['dry-run'] ?? false,
    help: values.help ?? false,
  }
}

/**
 * Full pipeline for one raw watcher event:
 * raw file event -> typed ChannelEvent -> state.transition() -> OfficeAction[]
 * -> map.ts -> HookPayload[].
 * Returns null when the event is unusable or produced no office intents.
 */
async function deliver(
  payloads: HookPayload[],
  opts: CliOptions,
  servers: ServerTarget[] | null,
): Promise<void> {
  if (payloads.length === 0) return
  if (opts.dryRun) {
    for (const payload of payloads) console.log(JSON.stringify(payload))
    return
  }
  let ok = 0
  let total = payloads.length
  if (opts.server) {
    const override = parseServerUrl(opts.server)
    total = payloads.length
    for (const payload of payloads) {
      if (await sendToUrl(override.url, override.token, payload)) ok++
    }
  } else if (servers && servers.length > 0) {
    ok = await sendAll(payloads, servers)
    total = payloads.length * servers.length
  } else {
    console.error('ferry-pixel: no pixel-agents server discovered; skipping send')
    return
  }
  console.log(`sent ${ok}/${total} payloads`)
}

function onEvent(
  raw: RawChannelEvent,
  opts: CliOptions,
  servers: ServerTarget[] | null,
  state: TaskStateMachine,
): void {
  const sessionIdPrefix = sanitizePrefix(basename(raw.dir))
  const payloads = pipeEvent(raw, state, sessionIdPrefix)
  if (!payloads || payloads.length === 0) return
  console.log(`${raw.kind} ${raw.file} task=${raw.taskId}`)
  void deliver(payloads, opts, servers).catch(() => {})
}

function sanitizePrefix(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || 'channel'
}

function usableDirs(channels: string[]): string[] {
  const dirs: string[] = []
  for (const channel of channels) {
    const dir = resolve(channel)
    try {
      if (statSync(dir).isDirectory()) dirs.push(dir)
      else console.error(`warning: not a directory, skipping: ${dir}`)
    } catch {
      console.error(`warning: cannot read channel dir, skipping: ${dir}`)
    }
  }
  return dirs
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }
  const dirs = usableDirs(opts.channels)
  if (dirs.length === 0) {
    console.error('error: at least one readable --channel <dir> is required')
    process.exitCode = 2
    return
  }

  const shared = await tryLoadShared()
  const sharedNames = Object.keys(shared)
  if (sharedNames.length > 0) console.log(`ferry-pixel: loaded shared modules (${sharedNames.join(', ')})`)

  let servers: ServerTarget[] | null = null
  if (!opts.dryRun && !opts.server) {
    servers = await discoverServers(opts.registry)
  }

  console.log(`ferry-pixel watching ${dirs.length} channel(s):`)
  for (const dir of dirs) console.log(`  ${dir}`)
  if (!opts.dryRun) {
    if (opts.server) {
      const parsed = new URL(opts.server)
      console.log(`server override: ${parsed.host}${parsed.pathname}`)
    } else {
      console.log(`discovered pixel-agents servers: ${servers?.length ?? 0}`)
    }
  } else {
    console.log('dry-run: hook payloads will be printed, not sent')
  }

  const state = new TaskStateMachine()
  const handle = watch(dirs, ev => onEvent(ev, opts, servers, state))
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error(`ferry-pixel: fatal: ${(err as Error).message}`)
  process.exitCode = 1
})
