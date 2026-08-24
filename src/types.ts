// Typed channel events parsed from ferry channel file shapes:
//   tasks/<taskId>/order.json | *claim* | *result* | *review*
// Loaded dynamically by src/shared.ts (`tryLoadShared`), so this module must
// stay dependency-free and side-effect-free.

export type ChannelEventType = 'order' | 'claim' | 'result' | 'review'

export interface ChannelEventBase {
  taskId: string
  /** host that produced the event, when the channel file records one */
  machine?: string
}

export interface OrderEvent extends ChannelEventBase {
  type: 'order'
  agent?: string
  title?: string
}

export interface ClaimEvent extends ChannelEventBase {
  type: 'claim'
  agent: string
}

export interface ResultEvent extends ChannelEventBase {
  type: 'result'
  agent?: string
  ok?: boolean
}

export interface ReviewEvent extends ChannelEventBase {
  type: 'review'
  agent?: string
  reviewer?: string
  verdict: ReviewVerdict
}

export type ChannelEvent = OrderEvent | ClaimEvent | ResultEvent | ReviewEvent

export type ReviewVerdict = 'accepted' | 'rejected' | 'pending'

// ---- office-level intents -------------------------------------------------

export type OfficeActionType =
  | 'spawn-character'
  | 'set-active-typing'
  | 'speech-bubble'
  | 'flag-review'
  | 'emote-accept'
  | 'emote-reject'
  | 'despawn'

export type FlagReason = 'unclaimed-result' | 'unknown-task'

interface OfficeActionBase {
  taskId: string
  agent?: string
}

export interface SpawnCharacterAction extends OfficeActionBase {
  type: 'spawn-character'
  label: string
}

export interface SetActiveTypingAction extends OfficeActionBase {
  type: 'set-active-typing'
}

export interface SpeechBubbleAction extends OfficeActionBase {
  type: 'speech-bubble'
  text: string
}

export interface FlagReviewAction extends OfficeActionBase {
  type: 'flag-review'
  reason?: FlagReason
}

export interface EmoteAcceptAction extends OfficeActionBase {
  type: 'emote-accept'
}

export interface EmoteRejectAction extends OfficeActionBase {
  type: 'emote-reject'
}

export interface DespawnAction extends OfficeActionBase {
  type: 'despawn'
}

export type OfficeAction =
  | SpawnCharacterAction
  | SetActiveTypingAction
  | SpeechBubbleAction
  | FlagReviewAction
  | EmoteAcceptAction
  | EmoteRejectAction
  | DespawnAction

// ---- tolerant parsing -----------------------------------------------------

const AGENT_FIELDS = ['agent', 'agentName', 'agent_name', 'assignee', 'owner'] as const
const MACHINE_FIELDS = ['machine', 'host', 'hostname', 'node'] as const
const TITLE_FIELDS = ['title', 'task', 'summary', 'description'] as const
const VERDICT_FIELDS = ['verdict', 'decision', 'status', 'outcome'] as const

function pickString(
  data: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = data[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return undefined
}

/** Same charset rules as watcher.sanitizeKey, kept local so types.ts stays standalone. */
export function sanitizeToken(input: string, fallback = 'agent'): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || fallback
}

function agentOf(data: Record<string, unknown>): string | undefined {
  const raw = pickString(data, AGENT_FIELDS)
  return raw ? sanitizeToken(raw) : undefined
}

function machineOf(data: Record<string, unknown>): string | undefined {
  const raw = pickString(data, MACHINE_FIELDS)
  return raw ? sanitizeToken(raw, 'host') : undefined
}

export function parseReviewVerdict(data: Record<string, unknown>): ReviewVerdict {
  for (const field of VERDICT_FIELDS) {
    const value = data[field]
    if (typeof value !== 'string') continue
    const v = value.toLowerCase()
    if (/accept|approv|pass|good/.test(v)) return 'accepted'
    if (/reject|deny|fail|bad|rework/.test(v)) return 'rejected'
  }
  for (const key of ['accepted', 'approved', 'ok']) {
    if (data[key] === true) return 'accepted'
    if (data[key] === false) return 'rejected'
  }
  return 'pending'
}

/**
 * Build a typed ChannelEvent from a classified channel file.
 * Mirrors watcher.classifyChannelPath kinds. Returns null for unusable input
 * rather than throwing (tolerant, like watcher.readTolerantJson).
 */
export function parseChannelEvent(
  kind: ChannelEventType,
  taskId: string,
  data: Record<string, unknown>,
): ChannelEvent | null {
  const id = sanitizeToken(taskId, 'task')
  if (!id) return null
  switch (kind) {
    case 'order':
      return {
        type: 'order',
        taskId: id,
        agent: agentOf(data),
        machine: machineOf(data),
        title: pickString(data, TITLE_FIELDS),
      }
    case 'claim': {
      const agent = agentOf(data) ?? sanitizeToken(taskId, 'task')
      return { type: 'claim', taskId: id, agent, machine: machineOf(data) }
    }
    case 'result': {
      const okRaw = data['ok']
      return {
        type: 'result',
        taskId: id,
        agent: agentOf(data),
        machine: machineOf(data),
        ok: typeof okRaw === 'boolean' ? okRaw : undefined,
      }
    }
    case 'review': {
      const reviewerRaw = pickString(data, ['reviewer', 'reviewed_by'])
      return {
        type: 'review',
        taskId: id,
        agent: agentOf(data),
        reviewer: reviewerRaw ? sanitizeToken(reviewerRaw, 'reviewer') : undefined,
        machine: machineOf(data),
        verdict: parseReviewVerdict(data),
      }
    }
    default:
      return null
  }
}
