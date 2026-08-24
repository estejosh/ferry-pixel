// Pure mapper: office-level intents (src/types.ts OfficeAction[]) ->
// pixel-agents hook payloads (see ../PROTOCOL.md).
//
// Wire contract per action type:
//   spawn-character   -> SessionStart{source,cwd} + confirming PreToolUse
//                        (SessionStart only STAGES a pending session; the
//                        PreToolUse is the confirmation that spawns the agent)
//   set-active-typing -> PreToolUse  (toolStart -> agentStatus active)
//   speech-bubble     -> PreToolUse  (status text becomes the tool bubble)
//   flag-review       -> Notification{notification_type:'idle_prompt'}
//                        (turnEnd awaitingInput -> waiting)
//   emote-accept      -> PostToolUse (clears the tool bubble; verdict echoed
//   emote-reject         in tool_input, which dispatch ignores but logs show)
//   despawn           -> Stop{reason:exit} + SessionEnd{reason:exit}
//
// Identity rules (PROTOCOL.md §4): display name/label = basename(cwd), so the
// character's name tag and Area matching derive from
// `<channelRoot>/<AgentName>`. Unknown agents never throw: the label falls
// back to the taskId. session_id is stable per channel+task so re-spawns
// (rework) reuse the same pixel character.

import { join } from 'node:path'
import type { HookPayload } from './emitter'
import { sanitizeToken, type OfficeAction } from './types'

export interface MapOptions {
  /** Prepended to every session id so equal taskIds in different channels cannot collide. */
  sessionIdPrefix?: string
}

export function sessionIdFor(taskId: string, prefix = ''): string {
  return sanitizeToken(prefix ? `${prefix}-${taskId}` : taskId, 'task')
}

/** cwd basename = office name tag; falls back to the task id for unknown agents. */
export function labelOf(action: OfficeAction): string {
  const raw = 'label' in action && action.label ? action.label : action.agent
  return sanitizeToken(raw ?? action.taskId, 'task')
}

export function mapOfficeAction(
  action: OfficeAction,
  channelRoot: string,
  opts: MapOptions = {},
): HookPayload[] {
  const session_id = sessionIdFor((action as { taskId?: string }).taskId ?? '', opts.sessionIdPrefix ?? '')

  switch (action.type) {
    case 'spawn-character':
      return [
        {
          hook_event_name: 'SessionStart',
          session_id,
          source: 'startup',
          cwd: join(channelRoot, labelOf(action)),
        },
        {
          hook_event_name: 'PreToolUse',
          session_id,
          tool_name: 'Task',
          tool_input: { command: `start ${action.taskId}` },
        },
      ]

    case 'set-active-typing':
      return [
        {
          hook_event_name: 'PreToolUse',
          session_id,
          tool_name: 'Bash',
          tool_input: { command: `work on ${action.taskId}` },
        },
      ]

    case 'speech-bubble':
      return [
        {
          hook_event_name: 'PreToolUse',
          session_id,
          tool_name: 'Bash',
          tool_input: { command: action.text },
        },
      ]

    case 'flag-review': {
      const message =
        action.reason === 'unclaimed-result'
          ? `${action.taskId} finished but nobody claimed it - needs review`
          : action.reason === 'unknown-task'
            ? `review for unknown task ${action.taskId}`
            : `${action.taskId} ready for review`
      return [
        {
          hook_event_name: 'Notification',
          session_id,
          notification_type: 'idle_prompt',
          message,
        },
      ]
    }

    case 'emote-accept':
      return [
        {
          hook_event_name: 'PostToolUse',
          session_id,
          tool_input: { command: `${action.taskId} accepted` },
        },
      ]

    case 'emote-reject':
      return [
        {
          hook_event_name: 'PostToolUse',
          session_id,
          tool_input: { command: `${action.taskId} rejected - rework` },
        },
      ]

    case 'despawn':
      return [
        { hook_event_name: 'Stop', session_id, reason: 'exit' },
        { hook_event_name: 'SessionEnd', session_id, reason: 'exit' },
      ]

    default:
      // Unknown intent (e.g. from a dynamically loaded shared module): drop it.
      return []
  }
}

export function mapOfficeActions(
  actions: readonly OfficeAction[],
  channelRoot: string,
  opts: MapOptions = {},
): HookPayload[] {
  return actions.flatMap(action => mapOfficeAction(action, channelRoot, opts))
}
