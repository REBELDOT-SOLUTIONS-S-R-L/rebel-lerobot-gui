import { actionColumnMotors, unnormalizeTicks, type TickRange } from '@shared/normalize'
import type { EpisodeActions } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

/**
 * Replaying a recorded episode onto the virtual arm.
 *
 * `lerobot-replay` is the right tool for a real follower and this does not
 * replace it; it cannot drive the virtual arm, because there is no LeRobot
 * device behind it. So the episode is read through LeRobot's own dataset class
 * (in the sidecar, `dataset.episode`) and stepped through here at the rate it
 * was recorded at, writing each frame's action as goal positions.
 *
 * A recorded action is in normalized units — degrees for the body joints,
 * percent of travel for the jaws — so it means the same pose on any arm whose
 * calibration is known, which is exactly what `unnormalizeTicks` undoes.
 */
export type ReplayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'finished' | 'error'

export interface EpisodeReplayState {
  status: ReplayStatus
  /** Frames played, out of the episode's length. */
  frame: number
  total: number
  /** Frames actually read; below `total` when the episode was truncated. */
  loaded: number
  /** Rate the episode is being played at. */
  fps: number
  error: string | null
  /** The episode is longer than one request returns; only the start plays. */
  truncated: boolean
}

const IDLE: EpisodeReplayState = {
  status: 'idle',
  frame: 0,
  total: 0,
  loaded: 0,
  fps: 0,
  error: null,
  truncated: false
}

export interface EpisodeReplayControls extends EpisodeReplayState {
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
}

export function useEpisodeReplay(opts: {
  /** The arm to replay onto. */
  uid: string | null
  root: string
  repoId: string
  episode: number
  /** Calibrated tick ranges from the arm's open snapshot. */
  ranges: Record<string, TickRange>
}): EpisodeReplayControls {
  const [state, setState] = useState<EpisodeReplayState>(IDLE)
  const episodeRef = useRef<EpisodeActions | null>(null)
  const cursor = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const rangesRef = useRef(opts.ranges)
  rangesRef.current = opts.ranges

  const stopTimer = useCallback((): void => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }, [])

  const play = useCallback(
    (uid: string, actions: EpisodeActions): void => {
      stopTimer()
      const columns = actionColumnMotors(actions.columns)
      let writing = false
      timer.current = setInterval(
        () => {
          if (writing) return
          const row = actions.frames[cursor.current]
          if (!row) {
            stopTimer()
            setState((prev) => ({ ...prev, status: 'finished' }))
            return
          }
          const goals: Record<string, number> = {}
          for (const [index, motor] of columns) {
            const range = rangesRef.current[motor.name]
            const value = row[index]
            if (!range || typeof value !== 'number') continue
            goals[motor.name] = unnormalizeTicks(motor.normMode, value, range)
          }
          const at = cursor.current
          cursor.current = at + 1
          if (Object.keys(goals).length === 0) {
            setState((prev) => ({ ...prev, frame: at + 1 }))
            return
          }
          writing = true
          void api.motor
            .moveMany(uid, goals)
            .then((res) => {
              setState((prev) => ({
                ...prev,
                frame: at + 1,
                error: res.ok ? prev.error : res.error
              }))
            })
            .finally(() => {
              writing = false
            })
        },
        1000 / Math.max(1, actions.fps)
      )
    },
    [stopTimer]
  )

  const start = useCallback(async (): Promise<void> => {
    const uid = opts.uid
    if (!uid) return
    stopTimer()
    cursor.current = 0
    setState({ ...IDLE, status: 'loading' })

    const res = await api.datasets.episode({
      root: opts.root,
      repoId: opts.repoId,
      episode: opts.episode
    })
    if (!res.ok) {
      setState({ ...IDLE, status: 'error', error: res.error })
      return
    }
    episodeRef.current = res.value
    setState({
      status: 'playing',
      frame: 0,
      total: res.value.totalFrames,
      loaded: res.value.frames.length,
      fps: res.value.fps,
      error: null,
      truncated: res.value.truncated
    })
    play(uid, res.value)
  }, [opts.uid, opts.root, opts.repoId, opts.episode, play, stopTimer])

  const pause = useCallback((): void => {
    stopTimer()
    setState((prev) => (prev.status === 'playing' ? { ...prev, status: 'paused' } : prev))
  }, [stopTimer])

  const resume = useCallback((): void => {
    const actions = episodeRef.current
    if (!actions || !opts.uid) return
    setState((prev) => (prev.status === 'paused' ? { ...prev, status: 'playing' } : prev))
    play(opts.uid, actions)
  }, [opts.uid, play])

  const stop = useCallback((): void => {
    stopTimer()
    cursor.current = 0
    setState(IDLE)
  }, [stopTimer])

  // Nothing should keep writing to an arm once this panel is gone.
  useEffect(() => stopTimer, [stopTimer])

  return { ...state, start, pause, resume, stop }
}
