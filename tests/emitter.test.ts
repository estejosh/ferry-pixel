import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverServers,
  fanOut,
  payloadBody,
  sendEvent,
  type HookPayload,
} from '../src/emitter'
import { mapOfficeAction } from '../src/map'

interface CapturedPost {
  url: string
  auth: string | null
  body: unknown
}

let captured: CapturedPost[] = []
const servers: http.Server[] = []

async function startCapture(): Promise<number> {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        captured.push({
          url: req.url ?? '',
          auth: req.headers.authorization ?? null,
          body: raw ? JSON.parse(raw) : null,
        })
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
    })
    servers.push(srv)
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port))
  })
}

beforeAll(async () => {
  await startCapture()
})

afterAll(async () => {
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))))
})

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-pixel-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function registryEntry(port: number, pid: number): string {
  return JSON.stringify({ port, pid, token: 'test-token-abc', protocol: 1, startedAt: Date.now() })
}

describe('discoverServers', () => {
  it('returns only live well-formed entries and skips dead or malformed ones', async () => {
    await withTempDir(async dir => {
      const capturePort = (servers[0]!.address() as AddressInfo).port
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, '111-3100.json'), registryEntry(capturePort, process.pid))
      await writeFile(join(dir, '222-3200.json'), registryEntry(3999, 999999999))
      await writeFile(join(dir, '333-broken.json'), '{not json')
      await writeFile(join(dir, '444-incomplete.json'), JSON.stringify({ port: 4000 }))
      await writeFile(join(dir, 'notes.txt'), 'ignore me')

      const found = await discoverServers(dir)

      expect(found).toHaveLength(1)
      expect(found[0]!.port).toBe(capturePort)
      expect(found[0]!.pid).toBe(process.pid)
    })
  })

  it('falls back to the legacy single-server file when the glob dir is empty', async () => {
    await withTempDir(async emptyDir => {
      const savedHome = process.env.HOME
      process.env.HOME = emptyDir
      try {
        await mkdir(join(emptyDir, '.pixel-agents', 'servers'), { recursive: true })
        const legacyPort = (servers[0]!.address() as AddressInfo).port
        await writeFile(
          join(emptyDir, '.pixel-agents', 'server.json'),
          registryEntry(legacyPort, process.pid),
        )
        const found = await discoverServers()
        expect(found).toHaveLength(1)
        expect(found[0]!.port).toBe(legacyPort)
      } finally {
        if (savedHome !== undefined) process.env.HOME = savedHome
      }
    })
  })

  it('is a silent success when no server exists at all', async () => {
    await withTempDir(async emptyDir => {
      const savedHome = process.env.HOME
      process.env.HOME = emptyDir
      try {
        await mkdir(join(emptyDir, '.pixel-agents', 'servers'), { recursive: true })
        expect(await discoverServers()).toEqual([])
        expect(await fanOut([], { hook_event_name: 'Stop', session_id: 'x' })).toBe(0)
      } finally {
        if (savedHome !== undefined) process.env.HOME = savedHome
      }
    })
  })

  it('swallows connection errors when the office is not running', async () => {
    const delivered = await sendEvent(
      { port: 1, pid: 1, token: 'whatever' },
      { hook_event_name: 'Stop', session_id: 'x' },
    )
    expect(delivered).toBe(false)
  })
})

describe('sendEvent over HTTP', () => {
  it('POSTs to /api/hooks/claude with bearer auth and the payload verbatim', async () => {
    const entry = await withTempDir(async dir => {
      const capturePort = (servers[0]!.address() as AddressInfo).port
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'a.json'), registryEntry(capturePort, process.pid))
      return (await discoverServers(dir))[0]!
    })

    captured = []
    const payloads: HookPayload[] = mapOfficeAction(
      { type: 'spawn-character', taskId: 't-http', agent: 'Pixel', label: 'Pixel' },
      '/tmp/channels',
    )
    for (const payload of payloads) {
      expect(await sendEvent(entry!, payload)).toBe(true)
    }

    expect(captured).toHaveLength(2)
    expect(captured[0]!.url).toBe('/api/hooks/claude')
    expect(captured[0]!.auth).toBe('Bearer test-token-abc')
    expect(captured[0]!.body).toMatchObject({
      hook_event_name: 'SessionStart',
      session_id: 't-http',
      cwd: join('/tmp/channels', 'Pixel'),
    })
    expect(captured[1]!.body).toMatchObject({ hook_event_name: 'PreToolUse', session_id: 't-http' })
    expect(JSON.stringify(captured.map(c => c.body))).not.toContain('test-token-abc')
  })

  it('fanOut counts one success per live server', async () => {
    await startCapture()
    const secondPort = (servers[servers.length - 1]!.address() as AddressInfo).port

    await withTempDir(async dir => {
      await mkdir(dir, { recursive: true })
      const firstPort = (servers[0]!.address() as AddressInfo).port
      await writeFile(join(dir, 'one.json'), registryEntry(firstPort, process.pid))
      await writeFile(join(dir, 'two.json'), registryEntry(secondPort, process.pid))
      const found = await discoverServers(dir)

      captured = []
      const ok = await fanOut(found, { hook_event_name: 'Stop', session_id: 'Pixel' })
      expect(ok).toBe(2)
      expect(captured).toHaveLength(2)
    })
  })

  it('refuses oversized bodies instead of posting them', async () => {
    const huge: HookPayload = {
      hook_event_name: 'Notification',
      session_id: 'Pixel',
      message: 'x'.repeat(70_000),
    }
    expect(payloadBody(huge)).toBeNull()

    captured = []
    const entry = { port: (servers[0]!.address() as AddressInfo).port, pid: process.pid, token: 't' }
    expect(await sendEvent(entry, huge)).toBe(false)
    expect(captured).toHaveLength(0)
  })
})
