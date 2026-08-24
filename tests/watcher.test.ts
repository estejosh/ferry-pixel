import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watch, type ChannelEvent } from '../src/watcher'

const handles: Array<{ close(): Promise<void> }> = []

afterAll(async () => {
  await Promise.all(handles.map(h => h.close().catch(() => {})))
})

function nextEvent(events: ChannelEvent[], kind: string): Promise<ChannelEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${kind}`)), 5000)
    const check = (): void => {
      const found = events.find(e => e.kind === kind)
      if (found) {
        clearTimeout(timer)
        resolve(found)
      } else {
        setTimeout(check, 25)
      }
    }
    check()
  })
}

describe('watch', () => {
  it('parses task files into tolerant channel events with agent-name session keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferry-pixel-watch-'))
    try {
      const tasksDir = join(dir, 'tasks', '42')
      await mkdir(tasksDir, { recursive: true })

      const events: ChannelEvent[] = []
      handles.push(watch([dir], ev => events.push(ev)))

      await writeFile(join(tasksDir, 'order.json'), JSON.stringify({ agent: 'Pixel Prime', title: 'ship it' }))
      await writeFile(join(dir, 'tasks', '42', 'claim-01.marker'), '')
      await writeFile(join(dir, 'tasks', '42', 'review.json'), '{ broken json')
      await writeFile(join(dir, 'tasks', '42', 'result.json'), JSON.stringify({ ok: true }))

      const order = await nextEvent(events, 'order')
      expect(order.taskId).toBe('42')
      expect(order.sessionKey).toBe('Pixel-Prime')
      expect(order.data).toMatchObject({ agent: 'Pixel Prime' })

      const claim = await nextEvent(events, 'claim')
      expect(claim.kind).toBe('claim')

      const review = await nextEvent(events, 'review')
      expect(review.sessionKey).toBe('42')
      expect(review.data).toEqual({})

      const result = await nextEvent(events, 'result')
      expect(result.sessionKey).toBe('42')
      expect(result.data).toMatchObject({ ok: true })

      await writeFile(join(tasksDir, 'unrelated.txt'), 'nope')
      await new Promise(r => setTimeout(r, 600))
      expect(events.find(e => e.file.endsWith('unrelated.txt'))).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
