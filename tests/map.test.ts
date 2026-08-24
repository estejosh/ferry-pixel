import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  labelOf,
  mapOfficeAction,
  mapOfficeActions,
  sessionIdFor,
} from '../src/map'
import type { OfficeAction } from '../src/types'

const ROOT = '/channels'

describe('sessionIdFor', () => {
  it('is stable per task and honors the channel prefix', () => {
    expect(sessionIdFor('t-1')).toBe('t-1')
    expect(sessionIdFor('t-1', 'channel-A')).toBe('channel-A-t-1')
    expect(sessionIdFor('weird id!', 'chan')).toBe('chan-weird-id')
  })
})

describe('mapOfficeAction', () => {
  it('spawn-character stages with SessionStart then confirms with PreToolUse', () => {
    const payloads = mapOfficeAction(
      { type: 'spawn-character', taskId: 't-1', agent: 'alpha', label: 'alpha' },
      ROOT,
    )
    expect(payloads.map(p => p.hook_event_name)).toEqual(['SessionStart', 'PreToolUse'])
    expect(payloads[0]).toEqual({
      hook_event_name: 'SessionStart',
      session_id: 't-1',
      source: 'startup',
      cwd: join(ROOT, 'alpha'),
    })
    expect(payloads[1]).toMatchObject({ session_id: 't-1', tool_name: 'Task' })
  })

  it('set-active-typing activates via PreToolUse Bash work-on', () => {
    const [payload] = mapOfficeAction({ type: 'set-active-typing', taskId: 't-2', agent: 'alpha' }, ROOT)
    expect(payload).toMatchObject({
      hook_event_name: 'PreToolUse',
      session_id: 't-2',
      tool_name: 'Bash',
      tool_input: { command: 'work on t-2' },
    })
  })

  it('speech-bubble carries the text as the tool command', () => {
    const [payload] = mapOfficeAction(
      { type: 'speech-bubble', taskId: 't-3', agent: 'alpha', text: 'New order: ship it' },
      ROOT,
    )
    expect(payload).toMatchObject({
      hook_event_name: 'PreToolUse',
      tool_input: { command: 'New order: ship it' },
    })
  })

  it('flag-review maps to Notification idle_prompt for every reason', () => {
    for (const [reason, message] of [
      ['unclaimed-result', 't-4 finished but nobody claimed it - needs review'],
      ['unknown-task', 'review for unknown task t-4'],
      [undefined, 't-4 ready for review'],
    ] as const) {
      const action: OfficeAction = { type: 'flag-review', taskId: 't-4', ...(reason ? { reason } : {}) }
      const [payload] = mapOfficeAction(action, ROOT)
      expect(payload).toMatchObject({
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message,
      })
    }
  })

  it('emote-accept and emote-reject clear the bubble via PostToolUse', () => {
    const accept = mapOfficeAction({ type: 'emote-accept', taskId: 't-5', agent: 'alpha' }, ROOT)
    const reject = mapOfficeAction({ type: 'emote-reject', taskId: 't-5', agent: 'alpha' }, ROOT)
    expect(accept.map(p => p.hook_event_name)).toEqual(['PostToolUse'])
    expect(reject.map(p => p.hook_event_name)).toEqual(['PostToolUse'])
    expect(JSON.stringify(accept)).toContain('accepted')
    expect(JSON.stringify(reject)).toContain('rejected')
  })

  it('despawn emits Stop{exit} then SessionEnd{exit}', () => {
    const payloads = mapOfficeAction({ type: 'despawn', taskId: 't-6', agent: 'alpha' }, ROOT)
    expect(payloads.map(p => p.hook_event_name)).toEqual(['Stop', 'SessionEnd'])
    expect(payloads.every(p => p.reason === 'exit')).toBe(true)
  })

  it('handles unknown agents gracefully by falling back to the taskId', () => {
    const action: OfficeAction = { type: 'spawn-character', taskId: 't-orphan', label: 't-orphan' }
    expect(labelOf(action)).toBe('t-orphan')
    const payloads = mapOfficeAction(action, ROOT)
    expect(payloads[0]).toMatchObject({ cwd: join(ROOT, 't-orphan'), session_id: 't-orphan' })
    // no throw, valid payloads even with a hostile label
    const weird = mapOfficeAction(
      { type: 'spawn-character', taskId: 'x', agent: '../..//evil name!' } as OfficeAction,
      ROOT,
    )
    expect(weird[0]!.cwd).toBe(join(ROOT, 'evil-name'))
  })

  it('drops unknown intents instead of throwing', () => {
    expect(mapOfficeAction({ type: 'teleport' } as unknown as OfficeAction, ROOT)).toEqual([])
  })

  it('applies the channel prefix to session ids but not to cwd', () => {
    const [ss] = mapOfficeAction(
      { type: 'spawn-character', taskId: 't-7', agent: 'alpha', label: 'alpha' },
      ROOT,
      { sessionIdPrefix: 'chan' },
    )
    expect(ss!.session_id).toBe('chan-t-7')
    expect(ss!.cwd).toBe(join(ROOT, 'alpha'))
  })

  it('mapOfficeActions preserves order across a full action burst', () => {
    const actions: OfficeAction[] = [
      { type: 'spawn-character', taskId: 't-8', agent: 'alpha', label: 'alpha' },
      { type: 'set-active-typing', taskId: 't-8', agent: 'alpha' },
      { type: 'speech-bubble', taskId: 't-8', agent: 'alpha', text: 'hello' },
      { type: 'flag-review', taskId: 't-8' },
      { type: 'emote-accept', taskId: 't-8', agent: 'alpha' },
      { type: 'despawn', taskId: 't-8', agent: 'alpha' },
    ]
    expect(mapOfficeActions(actions, ROOT).map(p => p.hook_event_name)).toEqual([
      'SessionStart',
      'PreToolUse',
      'PreToolUse',
      'PreToolUse',
      'Notification',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ])
  })
})
