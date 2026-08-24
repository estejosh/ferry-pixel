// Full event pipeline as testable units: raw channel file event ->
// typed ChannelEvent -> task state machine -> OfficeAction[] -> HookPayload[].
// I/O (watching, sending) lives in watcher.ts/emitter.ts; this module is pure.

import type { HookPayload } from './emitter'
import { mapOfficeActions } from './map'
import { TaskStateMachine } from './state'
import { parseChannelEvent } from './types'
import type { ChannelEvent as RawChannelEvent } from './watcher'

/**
 * Fold one raw watcher event through the state machine and map the surfaced
 * office actions to hook payloads. Returns null when the event is unusable
 * (unparseable) or produced no office intents.
 */
export function pipeEvent(
  raw: RawChannelEvent,
  state: TaskStateMachine,
  sessionIdPrefix: string,
): HookPayload[] | null {
  const typed = parseChannelEvent(raw.kind, raw.taskId, raw.data)
  if (!typed) return null
  const actions = state.apply(typed)
  if (actions.length === 0) return null
  return mapOfficeActions(actions, raw.dir, { sessionIdPrefix })
}
