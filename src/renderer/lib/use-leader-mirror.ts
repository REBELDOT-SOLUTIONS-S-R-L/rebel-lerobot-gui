import { SO_ARM_MOTORS } from '@shared/devices'
import { retarget, type TickRange } from '@shared/normalize'
import { useEffect, useRef, useState } from 'react'
import { api } from './api'

/**
 * A real leader arm driving the virtual follower.
 *
 * `lerobot-teleoperate` does this for two real arms and does it better; it has
 * no device for the virtual one, so when that is the follower the mirroring
 * happens here. It is the same conversion either way: read the leader
 * normalized, write the follower unnormalized, so two arms with different
 * calibrated ranges still describe the same pose (`@shared/normalize`).
 *
 * Positions arrive on the same notification channel as everything else, tagged
 * with which arm they came from — the sidecar's serial bus and the simulation
 * are open at once here, which is the whole point.
 */
export interface LeaderMirrorOptions {
  leaderUid: string | null
  followerUid: string | null
  engaged: boolean
  /** Calibrated tick ranges from each arm's open snapshot. */
  leaderRanges: Record<string, TickRange>
  followerRanges: Record<string, TickRange>
}

export interface LeaderMirrorState {
  /** Leader readings forwarded so far — the sign that it is actually working. */
  frames: number
  error: string | null
}

export function useLeaderMirror(opts: LeaderMirrorOptions): LeaderMirrorState {
  const { leaderUid, followerUid, engaged, leaderRanges, followerRanges } = opts
  const [state, setState] = useState<LeaderMirrorState>({ frames: 0, error: null })

  const leaderRef = useRef(leaderRanges)
  leaderRef.current = leaderRanges
  const followerRef = useRef(followerRanges)
  followerRef.current = followerRanges

  useEffect(() => {
    if (!engaged || !leaderUid || !followerUid) {
      setState({ frames: 0, error: null })
      return
    }
    let writing = false
    let forwarded = 0

    return api.bridge.onNotification((frame) => {
      if (frame.type !== 'positions') return
      // Untagged frames come from the sidecar's serial bus, which here is the
      // leader; the simulation tags its own so they are not fed back in.
      if (frame.source === 'virtual') return
      if (writing) return

      const positions = frame.positions as Record<string, number>
      const goals: Record<string, number> = {}
      for (const spec of SO_ARM_MOTORS) {
        const ticks = positions[spec.name]
        const from = leaderRef.current[spec.name]
        const to = followerRef.current[spec.name]
        if (typeof ticks !== 'number' || !from || !to) continue
        goals[spec.name] = retarget(spec.normMode, ticks, from, to)
      }
      if (Object.keys(goals).length === 0) return

      writing = true
      void api.motor
        .moveMany(followerUid, goals)
        .then((res) => {
          forwarded += 1
          setState({ frames: forwarded, error: res.ok ? null : res.error })
        })
        .finally(() => {
          writing = false
        })
    })
    // Ranges are read through refs: they change as the snapshots refresh, and
    // resubscribing for that would drop leader frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, leaderUid, followerUid])

  return state
}

/** Calibrated ranges out of a bus snapshot, in the shape the conversion wants. */
export function rangesOf(
  motors: readonly { name: string; rangeMin: number | null; rangeMax: number | null; driveMode: number | null }[]
): Record<string, TickRange> {
  const ranges: Record<string, TickRange> = {}
  for (const motor of motors) {
    if (motor.rangeMin === null || motor.rangeMax === null) continue
    ranges[motor.name] = {
      min: motor.rangeMin,
      max: motor.rangeMax,
      driveMode: motor.driveMode
    }
  }
  return ranges
}
