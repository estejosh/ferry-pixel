// Task lifecycle state machine for ferry-pixel channels.
// ISSUED -> CLAIMED -> WORKING -> RESULTED -> REVIEWED(accepted|rejected)
//
// `transition` is a pure reducer: (state, event) => { state, actions } with no
// I/O and no mutation of inputs. TaskStateMachine keeps one state per taskId
// and folds events through the reducer, surfacing office-level intents.

import type {
  ChannelEvent,
  OfficeAction,
  ReviewVerdict,
} from './types'

export const TASK_PHASES = ['ISSUED', 'CLAIMED', 'WORKING', 'RESULTED', 'REVIEWED'] as const

export type TaskPhase = (typeof TASK_PHASES)[number]

export type TaskState =
  | { phase: 'ISSUED'; agent?: string; title?: string }
  | { phase: 'CLAIMED'; agent: string }
  | { phase: 'WORKING'; agent: string }
  | { phase: 'RESULTED'; agent?: string }
  | { phase: 'REVIEWED'; verdict: ReviewVerdict; agent?: string }

export interface Transition {
  state: TaskState
  actions: OfficeAction[]
}

function ignored(state: TaskState): Transition {
  return { state, actions: [] }
}

/**
 * Fold one channel event into a task's state.
 *
 * Edge-case policy:
 * - duplicate claim while CLAIMED/WORKING/RESULTED: ignored (no actions).
 * - result without a prior order/claim: tolerated — implicit RESULTED plus a
 *   flag-review(reason=unclaimed-result) so the office still reacts.
 * - review of an unknown taskId: flagged via flag-review(reason=unknown-task);
 *   only concrete accepted/rejected verdicts move state to REVIEWED.
 */
export function transition(prev: TaskState | undefined, ev: ChannelEvent): Transition {
  switch (ev.type) {
    case 'order': {
      if (prev && prev.phase !== 'ISSUED') return ignored(prev)
      const next: TaskState = { phase: 'ISSUED', agent: ev.agent, title: ev.title }
      const actions: OfficeAction[] = [
        {
          type: 'spawn-character',
          taskId: ev.taskId,
          agent: ev.agent,
          label: ev.agent ?? ev.taskId,
        },
        {
          type: 'speech-bubble',
          taskId: ev.taskId,
          agent: ev.agent,
          text: ev.title ? `New order: ${ev.title}` : 'New order received',
        },
      ]
      return { state: next, actions }
    }

    case 'claim': {
      if (
        prev &&
        prev.phase !== 'ISSUED' &&
        !(prev.phase === 'REVIEWED' && prev.verdict === 'rejected')
      ) {
        return ignored(prev)
      }
      const next: TaskState = { phase: 'CLAIMED', agent: ev.agent }
      const actions: OfficeAction[] = [
        {
          type: 'spawn-character',
          taskId: ev.taskId,
          agent: ev.agent,
          label: ev.agent,
        },
        { type: 'set-active-typing', taskId: ev.taskId, agent: ev.agent },
        {
          type: 'speech-bubble',
          taskId: ev.taskId,
          agent: ev.agent,
          text: `${ev.agent} claimed ${ev.taskId}`,
        },
      ]
      return { state: next, actions }
    }

    case 'result': {
      if (prev?.phase === 'REVIEWED' && prev.verdict === 'accepted') return ignored(prev)
      const unclaimed =
        !prev || prev.phase === 'ISSUED'
      const next: TaskState = { phase: 'RESULTED', agent: prev?.agent ?? ev.agent }
      const actions: OfficeAction[] = [
        {
          type: 'speech-bubble',
          taskId: ev.taskId,
          agent: next.agent,
          text: ev.ok === false ? `${ev.taskId} failed` : `${ev.taskId} delivered`,
        },
        {
          type: 'flag-review',
          taskId: ev.taskId,
          agent: next.agent,
          ...(unclaimed ? ({ reason: 'unclaimed-result' } as const) : {}),
        },
      ]
      return { state: next, actions }
    }

    case 'review': {
      const agent = ev.agent ?? prev?.agent
      if (ev.verdict === 'pending') {
        const actions: OfficeAction[] = [
          { type: 'flag-review', taskId: ev.taskId, agent, reason: prev ? undefined : 'unknown-task' },
        ]
        return { state: prev ?? { phase: 'RESULTED' }, actions }
      }
      if (!prev) {
        const actions: OfficeAction[] = [
          { type: 'flag-review', taskId: ev.taskId, agent, reason: 'unknown-task' },
          { type: 'despawn', taskId: ev.taskId, agent },
        ]
        return {
          state: { phase: 'REVIEWED', verdict: ev.verdict, agent },
          actions,
        }
      }
      if (prev.phase === 'REVIEWED' && prev.verdict === 'accepted') return ignored(prev)
      if (ev.verdict === 'accepted') {
        return {
          state: { phase: 'REVIEWED', verdict: 'accepted', agent },
          actions: [
            { type: 'emote-accept', taskId: ev.taskId, agent },
            { type: 'despawn', taskId: ev.taskId, agent },
          ],
        }
      }
      return {
        state: { phase: 'REVIEWED', verdict: 'rejected', agent },
        actions: [{ type: 'emote-reject', taskId: ev.taskId, agent }],
      }
    }

    default:
      return ignored(
        prev ?? { phase: 'RESULTED' },
      )
    }
}

/** Keeps one TaskState per taskId; apply() returns the office-level intents. */
export class TaskStateMachine {
  private tasks = new Map<string, TaskState>()

  get(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
  }

  phaseOf(taskId: string): TaskPhase | undefined {
    return this.tasks.get(taskId)?.phase
  }

  apply(ev: ChannelEvent): OfficeAction[] {
    const { state, actions } = transition(this.tasks.get(ev.taskId), ev)
    this.tasks.set(ev.taskId, state)
    return actions
  }

  applyAll(events: readonly ChannelEvent[]): OfficeAction[] {
    return events.flatMap(ev => this.apply(ev))
  }

  snapshot(): Record<string, TaskState> {
    return Object.fromEntries(this.tasks)
  }
}
