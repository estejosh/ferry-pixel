import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseChannelEvent,
  parseReviewVerdict,
  type ChannelEvent,
} from '../src/types'
import {
  TASK_PHASES,
  TaskStateMachine,
  transition,
} from '../src/state'

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'channel-A')

function ev(partial: Partial<ChannelEvent> & { type: ChannelEvent['type']; taskId: string }): ChannelEvent {
  return parseChannelEvent(partial.type, partial.taskId, partial as Record<string, unknown>)!
}

const ORDER1 = ev({ type: 'order', taskId: 't-100', agent: 'alpha', title: 'ship it', machine: 'fixture-box' })
const CLAIM1 = ev({ type: 'claim', taskId: 't-100', agent: 'alpha' })
const RESULT1 = ev({ type: 'result', taskId: 't-100', agent: 'alpha', ok: true })
const REVIEW_ACCEPT = ev({ type: 'review', taskId: 't-100', reviewer: 'bravo', verdict: 'accepted' })

describe('transition happy path', () => {
  it('ISSUED -> CLAIMED -> WORKING -> RESULTED -> REVIEWED with office intents', () => {
    const afterOrder = transition(undefined, ORDER1)
    expect(afterOrder.state).toEqual({ phase: 'ISSUED', agent: 'alpha', title: 'ship it' })
    expect(afterOrder.actions).toEqual([
      { type: 'spawn-character', taskId: 't-100', agent: 'alpha', label: 'alpha' },
      { type: 'speech-bubble', taskId: 't-100', agent: 'alpha', text: 'New order: ship it' },
    ])

    const afterClaim = transition(afterOrder.state, CLAIM1)
    expect(afterClaim.state).toEqual({ phase: 'CLAIMED', agent: 'alpha' })
    expect(afterClaim.actions.map(a => a.type)).toEqual([
      'spawn-character',
      'set-active-typing',
      'speech-bubble',
    ])
    expect(afterClaim.actions[1]).toEqual({ type: 'set-active-typing', taskId: 't-100', agent: 'alpha' })

    const afterResult = transition(afterClaim.state, RESULT1)
    expect(afterResult.state.phase).toBe('RESULTED')
    expect(afterResult.actions.map(a => a.type)).toEqual(['speech-bubble', 'flag-review'])
    expect(afterResult.actions[1]).toMatchObject({ type: 'flag-review', taskId: 't-100', agent: 'alpha' })

    const afterReview = transition(afterResult.state, REVIEW_ACCEPT)
    expect(afterReview.state).toEqual({ phase: 'REVIEWED', verdict: 'accepted', agent: 'alpha' })
    expect(afterReview.actions.map(a => a.type)).toEqual(['emote-accept', 'despawn'])
  })
})

describe('transition edge cases', () => {
  it('ignores duplicate claims without emitting actions', () => {
    const first = transition(undefined, ORDER1)
    const claimed = transition(first.state, CLAIM1)
    const dupSameAgent = transition(claimed.state, ev({ type: 'claim', taskId: 't-100', agent: 'alpha' }))
    expect(dupSameAgent.actions).toEqual([])
    expect(dupSameAgent.state).toEqual(claimed.state)
    const dupOtherAgent = transition(claimed.state, ev({ type: 'claim', taskId: 't-100', agent: 'bravo' }))
    expect(dupOtherAgent.actions).toEqual([])
    expect(dupOtherAgent.state.agent).toBe('alpha')
  })

  it('tolerates result-without-order and flags unclaimed-result', () => {
    const stray = transition(undefined, RESULT1)
    expect(stray.state.phase).toBe('RESULTED')
    expect(stray.actions.length).toBeGreaterThan(0)
    expect(stray.actions.some(a => a.type === 'speech-bubble')).toBe(true)
    expect(stray.actions[1]).toMatchObject({ type: 'flag-review', reason: 'unclaimed-result' })
    // a later review still resolves normally
    const reviewed = transition(stray.state, REVIEW_ACCEPT)
    expect(reviewed.state.phase).toBe('REVIEWED')
    expect(reviewed.actions.map(a => a.type)).toEqual(['emote-accept', 'despawn'])
  })

  it('flags review-of-unknown id and still records the verdict', () => {
    const flagged = transition(undefined, REVIEW_ACCEPT)
    expect(flagged.actions[0]).toMatchObject({ type: 'flag-review', reason: 'unknown-task' })
    expect(flagged.state).toEqual({ phase: 'REVIEWED', verdict: 'accepted', agent: undefined })
    // pending verdict never enters REVIEWED
    const pending = transition(undefined, ev({ type: 'review', taskId: 't-x', verdict: 'pending' }))
    expect(TASK_PHASES).toContain('REVIEWED')
    expect(pending.state.phase).not.toBe('REVIEWED')
    expect(parseReviewVerdict({ verdict: 'REJECTED!' })).toBe('rejected')
    expect(parseReviewVerdict({})).toBe('pending')
  })

  it('rejects rework: emote-reject, no despawn, and terminal accepted state ignores further events', () => {
    const base = transition(transition(undefined, ORDER1).state, CLAIM1)
    const rejected = transition(base.state, ev({ type: 'review', taskId: 't-100', verdict: 'rejected' }))
    expect(rejected.state).toEqual({ phase: 'REVIEWED', verdict: 'rejected', agent: 'alpha' })
    expect(rejected.actions.map(a => a.type)).toEqual(['emote-reject'])
    // rejected tasks can be re-claimed (rework), then re-delivered
    const rework = transition(rejected.state, CLAIM1)
    expect(rework.state.phase).toBe('CLAIMED')
    expect(rework.actions.map(a => a.type)).toContain('set-active-typing')
    // accepted is terminal
    const done = transition(
      transition(rework.state, RESULT1).state,
      REVIEW_ACCEPT,
    )
    expect(done.actions.every(a => a.type !== 'emote-reject')).toBe(true)
    expect(transition(done.state, RESULT1).actions).toEqual([])
    expect(transition(done.state, REVIEW_ACCEPT).actions).toEqual([])
  })
})

describe('TaskStateMachine + fixture channel', () => {
  it('folds a full two-task fixture channel into expected phases', async () => {
    const root = FIXTURE_ROOT
    const read = (...p: string[]): Promise<Record<string, unknown>> =>
      readFile(join(root, ...p), 'utf8').then(JSON.parse)

    const machine = new TaskStateMachine()
    const t1: ChannelEvent[] = []
    for (const file of ['order.json', 'claim.json', 'result.json', 'review.json'] as const) {
      const kind = file.split('.')[0] as ChannelEvent['type']
      t1.push(parseChannelEvent(kind, 't-fixture1', await read('tasks', 't-fixture1', file))!)
    }
    const actions1 = machine.applyAll(t1)
    expect(actions1.filter(a => a.type === 'spawn-character')).toHaveLength(2)
    expect(machine.phaseOf('t-fixture1')).toBe('REVIEWED')

    const t2: ChannelEvent[] = []
    for (const file of ['order.json', 'claim-01.marker', 'result.json', 'review.json'] as const) {
      const kind = file.startsWith('claim') ? 'claim' : (file.split('.')[0] as ChannelEvent['type'])
      t2.push(parseChannelEvent(kind, 't-fixture2', await read('tasks', 't-fixture2', file))!)
    }
    const actions2 = machine.applyAll(t2)
    const snap = machine.snapshot()
    expect(Object.keys(snap).sort()).toEqual(['t-fixture1', 't-fixture2'])
    expect(snap['t-fixture2']).toMatchObject({ phase: 'REVIEWED', verdict: 'rejected' })
    expect(actions2.filter(a => a.type === 'emote-reject')).toHaveLength(1)
    expect(actions2.some(a => a.type === 'despawn')).toBe(false)
  })
})
