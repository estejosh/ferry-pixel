import { homedir } from 'node:os'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ServerTarget {
  port: number
  pid: number
  token: string
  debugLog?: string
  startedAt?: number
  servesSpa?: boolean
  protocol?: number
}

export type HookEventName =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd'

export interface HookPayload {
  hook_event_name: HookEventName
  session_id: string
  source?: string
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  notification_type?: string
  message?: string
  reason?: string
  transcript_path?: string
}

export type OfficeActionType = 'spawn' | 'activate' | 'wait' | 'finish' | 'despawn'

export interface OfficeAction {
  action: OfficeActionType
  sessionKey: string
  toolName?: string
  detail?: string
}

export const HOOK_PATH = '/api/hooks/claude'
export const SEND_TIMEOUT_MS = 2000
export const MAX_BODY_BYTES = 65536

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function isValidServerTarget(value: unknown): value is ServerTarget {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  const port = t.port
  const pid = t.pid
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof t.token === 'string' &&
    t.token.length > 0
  )
}

function defaultRegistryDir(): string {
  return join(homedir(), '.pixel-agents', 'servers')
}

function legacyRegistryFile(): string {
  return join(homedir(), '.pixel-agents', 'server.json')
}

export async function readRegistryEntry(file: string): Promise<ServerTarget | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (isValidServerTarget(parsed) && isLivePid(parsed.pid)) return parsed
  } catch {}
  return null
}

export async function discoverServers(
  registryDir: string = defaultRegistryDir(),
): Promise<ServerTarget[]> {
  const found: ServerTarget[] = []
  try {
    for (const name of await readdir(registryDir)) {
      if (!name.endsWith('.json')) continue
      const entry = await readRegistryEntry(join(registryDir, name))
      if (entry) found.push(entry)
    }
  } catch {}
  if (found.length > 0) return found
  const legacy = await readRegistryEntry(legacyRegistryFile())
  return legacy ? [legacy] : []
}

export function payloadBody(payload: HookPayload): string | null {
  const body = JSON.stringify(payload)
  return Buffer.byteLength(body) <= MAX_BODY_BYTES ? body : null
}

export async function sendToUrl(url: string, token: string, payload: HookPayload): Promise<boolean> {
  const body = payloadBody(payload)
  if (!body) return false
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    return res.ok
  } catch {}
  return false
}

export async function sendEvent(server: ServerTarget, payload: HookPayload): Promise<boolean> {
  return sendToUrl(`http://127.0.0.1:${server.port}${HOOK_PATH}`, server.token, payload)
}

export interface UrlOverride {
  url: string
  token: string
}

export function parseServerUrl(raw: string): UrlOverride {
  const u = new URL(raw)
  const token = decodeURIComponent(u.username || '')
  u.username = ''
  u.password = ''
  return { url: u.toString(), token }
}

export async function fanOut(servers: ServerTarget[], payload: HookPayload): Promise<number> {
  if (servers.length === 0) return 0
  const results = await Promise.all(servers.map(server => sendEvent(server, payload)))
  return results.filter(Boolean).length
}

export async function emitPayloads(
  payloads: HookPayload[],
  servers: ServerTarget[],
): Promise<number> {
  let ok = 0
  for (const payload of payloads) {
    ok += await fanOut(servers, payload)
  }
  return ok
}

export function channelCwd(channelsRoot: string, sessionKey: string): string {
  return join(channelsRoot, sessionKey)
}

export function mapOfficeAction(action: OfficeAction, channelsRoot: string): HookPayload[] {
  const session_id = action.sessionKey
  switch (action.action) {
    case 'spawn':
      return [
        { hook_event_name: 'SessionStart', session_id, source: 'startup', cwd: channelCwd(channelsRoot, session_id) },
        {
          hook_event_name: 'PreToolUse',
          session_id,
          tool_name: action.toolName ?? 'Task',
          tool_input: { command: action.detail ?? `resume ${session_id}` },
        },
      ]
    case 'activate':
      return [
        {
          hook_event_name: 'PreToolUse',
          session_id,
          tool_name: action.toolName ?? 'Bash',
          tool_input: { command: action.detail ?? 'work on task' },
        },
      ]
    case 'wait':
      return [
        {
          hook_event_name: 'Notification',
          session_id,
          notification_type: 'idle_prompt',
          message: action.detail ?? 'Waiting for input',
        },
      ]
    case 'finish':
      return [{ hook_event_name: 'Stop', session_id }]
    case 'despawn':
      return [
        { hook_event_name: 'Stop', session_id, reason: 'exit' },
        { hook_event_name: 'SessionEnd', session_id, reason: 'exit' },
      ]
    default:
      return []
  }
}
