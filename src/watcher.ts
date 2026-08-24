import chokidar from 'chokidar'
import { readFile } from 'node:fs/promises'
import { basename, relative, sep } from 'node:path'

export type ChannelEventKind = 'order' | 'claim' | 'result' | 'review'

export interface ChannelEvent {
  kind: ChannelEventKind
  dir: string
  taskId: string
  sessionKey: string
  file: string
  data: Record<string, unknown>
}

export interface WatchHandle {
  close(): Promise<void>
}

export const DEBOUNCE_MS = 250

const NAME_FIELDS = ['agent', 'agentName', 'agent_name', 'assignee', 'owner', 'name'] as const

export function sanitizeKey(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || 'agent'
}

export function classifyChannelPath(relPath: string): { kind: ChannelEventKind; taskId: string } | null {
  const parts = relPath.split(sep)
  const ti = parts.indexOf('tasks')
  if (ti < 0 || parts.length !== ti + 3) return null
  const taskId = parts[ti + 1]
  if (!taskId) return null
  const file = parts[ti + 2]
  const lower = file.toLowerCase()
  if (/^order\.json$/i.test(file)) return { kind: 'order', taskId }
  if (lower.includes('claim')) return { kind: 'claim', taskId }
  if (lower.includes('result')) return { kind: 'result', taskId }
  if (lower.includes('review')) return { kind: 'review', taskId }
  return null
}

export async function readTolerantJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return {}
}

export function pickAgentName(data: Record<string, unknown>, fallback: string): string {
  for (const field of NAME_FIELDS) {
    const value = data[field]
    if (typeof value === 'string' && value.trim()) return sanitizeKey(value.trim())
  }
  return sanitizeKey(fallback)
}

function ownerDirOf(absFile: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const prefix = dir.endsWith(sep) ? dir : dir + sep
    if (absFile.startsWith(prefix) || absFile === dir) return dir
  }
  return null
}

async function buildEvent(
  absFile: string,
  dir: string,
): Promise<ChannelEvent | null> {
  const rel = relative(dir, absFile)
  const classified = classifyChannelPath(rel)
  if (!classified) return null
  const data = await readTolerantJson(absFile)
  return {
    kind: classified.kind,
    dir,
    taskId: classified.taskId,
    sessionKey: pickAgentName(data, basename(classified.taskId)),
    file: rel.split(sep).join('/'),
    data,
  }
}

export function watch(
  channelsDirs: string[],
  cb: (event: ChannelEvent) => void,
  debounceMs: number = DEBOUNCE_MS,
): WatchHandle {
  const timers = new Map<string, NodeJS.Timeout>()

  const schedule = (absFile: string) => {
    const existing = timers.get(absFile)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(absFile)
      const dir = ownerDirOf(absFile, channelsDirs)
      if (!dir) return
      buildEvent(absFile, dir)
        .then(event => {
          if (event) cb(event)
        })
        .catch(() => {})
    }, debounceMs)
    timers.set(absFile, timer)
  }

  const watcher = chokidar.watch(channelsDirs, {
    ignoreInitial: false,
    persistent: true,
  })
  void watcher.on('add', schedule)
  void watcher.on('change', schedule)
  void watcher.on('addDir', schedule)

  return {
    close: () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      return watcher.close()
    },
  }
}
