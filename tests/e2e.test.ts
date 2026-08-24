import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverServers, sendAll } from '../src/emitter'
import { pipeEvent } from '../src/pipeline'
import { TaskStateMachine } from '../src/state'
import { watch, type WatchHandle } from '../src/watcher'

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'channel-A')
const REGISTRY_TOKEN = 'e2e-registry-token'

interface Captured {
  auth: string | null
  body: Record<string, unknown>
}

let captured: Captured[] = []
const servers: http.Server[] = []

function startCapture(): Promise<number> {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        captured.push({
          auth: req.headers.authorization ?? null,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
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

/**
 * Semantic markers on the wire, per PROTOCOL.md:
 *   spawn   = SessionStart            (stages the character)
 *   active  = PreToolUse              (confirmation/toolStart -> working at desk)
 *   bubble  = other PreToolUse        (status text bubble)
 *   flag    = Notification idle_prompt (waiting for review/input)
 *   emote   = PostToolUse             (bubble cleared, verdict reaction)
 *   despawn = SessionEnd exit         (character leaves; Stop precedes it)
 */
function markerOf(p: Record<string, unknown>): string | null {
  switch (p.hook_event_name) {
    case 'SessionStart':
      return 'spawn'
    case 'PreToolUse': {
      const cmd = String((p.tool_input as { command?: unknown } | undefined)?.command ?? '')
      return p.tool_name === 'Task' || cmd.startsWith('work on ') ? 'active' : 'bubble'
    }
    case 'Notification':
      return p.notification_type === 'idle_prompt' ? 'flag' : null
    case 'PostToolUse':
      return 'emote'
    case 'SessionEnd':
      return 'despawn'
    default:
      return null // Stop: part of despawn, covered by SessionEnd
  }
}

function markersFor(session_id: string): string[] {
  return captured
    .filter(c => c.body.session_id === session_id)
    .map(c => markerOf(c.body))
    .filter((m): m is string => m !== null)
}

async function writeNext(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents)
  await new Promise(r => setTimeout(r, 450)) // clear the 250ms watcher debounce
}

describe('end-to-end: fixture channel-A through the full pipeline', () => {
  it('delivers ordered lifecycle events (spawn->active->bubble->flag->emote->despawn) to the stub server', async () => {
    const work = await mkdtemp(join(tmpdir(), 'ferry-pixel-e2e-'))
    const channel = join(work, 'channel-A')
    const registryDir = join(work, 'registry')
    const handles: WatchHandle[] = []
    try {
      await mkdir(channel, { recursive: true })
      await mkdir(registryDir, { recursive: true })

      // stub pixel-agents server, discovered through a real registry entry
      const port = (servers[servers.length - 1]!.address() as AddressInfo).port
      await writeFile(
        join(registryDir, `${process.pid}-${port}.json`),
        JSON.stringify({ port, pid: process.pid, token: REGISTRY_TOKEN, protocol: 1 }),
      )
      const targets = await discoverServers(registryDir)
      expect(targets).toHaveLength(1)

      // full pipeline: watcher -> state.transition -> map -> sendAll
      const state = new TaskStateMachine()
      captured = []
      handles.push(
        watch([channel], async raw => {
          const payloads = pipeEvent(raw, state, 'channel-A')
          if (payloads && payloads.length > 0) await sendAll(payloads, targets)
        }),
      )
      await new Promise(r => setTimeout(r, 300)) // let chokidar settle

      const t1 = join(channel, 'tasks', 't-fixture1')
      const t2 = join(channel, 'tasks', 't-fixture2')

      // replay task 1 (accepted -> leaves) and task 2 (rejected -> rework, stays)
      await writeNext(join(t1, 'order.json'), '{ "agent": "alpha", "title": "draw the synthetic duck" }')
      await writeNext(join(t2, 'order.json'), '{ "agent": "bravo", "title": "polish the synthetic pond" }')
      await writeNext(join(t1, 'claim.json'), '{ "agent": "alpha" }')
      await writeNext(join(t2, 'claim-01.marker'), '{ "agent": "bravo" }')
      await writeNext(join(t1, 'result.json'), '{ "agent": "alpha", "ok": true }')
      await writeNext(join(t2, 'result.json'), '{ "agent": "bravo", "ok": false }')
      await writeNext(join(t1, 'review.json'), '{ "reviewer": "bravo", "verdict": "accepted" }')
      await writeNext(join(t2, 'review.json'), '{ "reviewer": "alpha", "verdict": "rejected" }')

      const s1 = 'channel-A-t-fixture1'
      const s2 = 'channel-A-t-fixture2'

      expect(markersFor(s1)).toEqual([
        'spawn', 'active', 'bubble', // order
        'spawn', 'active', 'active', 'bubble', // claim: re-spawn re-confirms, then works
        'bubble', 'flag', // result delivered -> ready for review
        'emote', 'despawn', // accepted -> waves goodbye and leaves
      ])

      expect(markersFor(s2)).toEqual([
        'spawn', 'active', 'bubble',
        'spawn', 'active', 'active', 'bubble',
        'bubble', 'flag', // ok:false -> flagged for review anyway
        'emote', // rejected -> rework, NO despawn
      ])
      expect(markersFor(s2)).not.toContain('despawn')

      // identity derives from cwd: <channel>/<AgentName>
      const firsts1 = captured.filter(c => c.body.session_id === s1)
      expect(firsts1[0]!.body).toMatchObject({
        hook_event_name: 'SessionStart',
        source: 'startup',
        cwd: join(channel, 'alpha'),
      })
      const firsts2 = captured.filter(c => c.body.session_id === s2)
      expect(firsts2[0]!.body).toMatchObject({ hook_event_name: 'SessionStart', cwd: join(channel, 'bravo') })

      // transport shape: bearer auth present, token never leaks into bodies
      expect(captured.length).toBeGreaterThan(0)
      expect(captured.every(c => c.auth === `Bearer ${REGISTRY_TOKEN}`)).toBe(true)
      expect(JSON.stringify(captured.map(c => c.body))).not.toContain(REGISTRY_TOKEN)
      // despawn wire order: Stop immediately precedes SessionEnd
      const stopIdx = captured.findIndex(c => c.body.hook_event_name === 'Stop' && c.body.session_id === s1)
      const endIdx = captured.findIndex(c => c.body.hook_event_name === 'SessionEnd' && c.body.session_id === s1)
      expect(stopIdx).toBeGreaterThan(-1)
      expect(endIdx).toBe(stopIdx + 1)
    } finally {
      await Promise.all(handles.map(h => h.close().catch(() => {})))
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }, 20000)
})
