#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  discoverServers,
  emitPayloads,
  mapOfficeAction,
  parseServerUrl,
  sendToUrl,
  type HookPayload,
  type OfficeAction,
  type ServerTarget,
} from './emitter'
import { watch, type ChannelEvent } from './watcher'
import { tryLoadShared } from './shared'

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
  --dry-run         print OfficeActions and hook payloads instead of sending
  --help            show this help
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

const DETAIL_FIELDS = ['title', 'task', 'summary', 'description', 'name', 'command'] as const

function detailOf(ev: ChannelEvent): string | undefined {
  for (const field of DETAIL_FIELDS) {
    const value = ev.data[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function actionForEvent(ev: ChannelEvent): OfficeAction | null {
  switch (ev.kind) {
    case 'order':
      return { action: 'spawn', sessionKey: ev.sessionKey, detail: detailOf(ev) }
    case 'claim':
      return { action: 'activate', sessionKey: ev.sessionKey, detail: detailOf(ev) }
    case 'review':
      return { action: 'wait', sessionKey: ev.sessionKey, detail: detailOf(ev) }
    case 'result':
      return { action: 'despawn', sessionKey: ev.sessionKey }
    default:
      return null
  }
}

async function deliver(
  action: OfficeAction,
  channelsRoot: string,
  opts: CliOptions,
  servers: ServerTarget[] | null,
): Promise<void> {
  const payloads: HookPayload[] = mapOfficeAction(action, channelsRoot)
  if (opts.dryRun) {
    console.log(`[dry-run] action=${action.action} session=${action.sessionKey}`)
    for (const payload of payloads) console.log(JSON.stringify(payload))
    return
  }
  let ok = 0
  if (opts.server) {
    const override = parseServerUrl(opts.server)
    for (const payload of payloads) {
      if (await sendToUrl(override.url, override.token, payload)) ok++
    }
  } else if (servers) {
    ok = await emitPayloads(payloads, servers)
  }
  console.log(
    `sent ${ok}/${payloads.length * Math.max((servers?.length ?? 0), 1)} payloads for ${action.action} ${action.sessionKey}`,
  )
}

function onEvent(ev: ChannelEvent, opts: CliOptions, servers: ServerTarget[] | null): void {
  const action = actionForEvent(ev)
  if (!action) return
  console.log(`${ev.kind} ${ev.file} agent=${ev.sessionKey} task=${ev.taskId}`)
  void deliver(action, ev.dir, opts, servers).catch(() => {})
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
    console.log('dry-run: events will be printed, not sent')
  }

  const handle = watch(dirs, ev => onEvent(ev, opts, servers))
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
