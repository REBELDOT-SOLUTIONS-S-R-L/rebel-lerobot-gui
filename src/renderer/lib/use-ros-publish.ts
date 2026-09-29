import type { TickRange } from '@shared/normalize'
import {
  DEFAULT_ROSBRIDGE_URL,
  rosNamespace,
  type RosConnectionState,
  type RosSessionMode
} from '@shared/ros'
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { useAppStore } from '../store/useAppStore'
import { api } from './api'
import { useSticky } from './use-sticky'

/**
 * Publishing a panel's arms to ROS 2 while it drives them.
 *
 * The switch is a choice, so it is sticky per panel; publishing is not, so it
 * only happens while `active` — the same condition the window's control border
 * follows. The main process does the actual publishing from the frames it
 * already sees; all a panel adds is which arms, what it is doing with them, and
 * the calibrated ranges that turn ticks into angles.
 */

const KEYS = {
  configure: 'configure.ros',
  view3d: 'view3d.ros',
  teleoperate: 'teleoperate.ros',
  replay: 'replay.ros'
} as const

export type RosPanel = keyof typeof KEYS

export interface RosDevice {
  uid: string | null
  ranges: Record<string, TickRange>
}

export interface RosPublishState {
  enabled: boolean
  setEnabled: Dispatch<SetStateAction<boolean>>
  /** Attached right now: enabled, and the panel is driving. */
  publishing: boolean
  /** `/namespace` of each arm this panel would publish. */
  namespaces: string[]
  url: string
  connection: RosConnectionState
  /** Why attaching or connecting failed. */
  error: string | null
  /** joint_states per second, summed over this panel's arms. */
  rate: number
}

export function useRosPublish(opts: {
  panel: RosPanel
  active: boolean
  mode: RosSessionMode
  devices: RosDevice[]
}): RosPublishState {
  const { panel, active, mode } = opts
  const [enabled, setEnabled] = useSticky(KEYS[panel], () => false)
  const profiles = useAppStore((s) => s.profiles)
  const status = useAppStore((s) => s.rosStatus)
  const url = useAppStore((s) => s.settings?.rosbridgeUrl || DEFAULT_ROSBRIDGE_URL)
  const [attachError, setAttachError] = useState<string | null>(null)

  const devices = opts.devices.filter((d): d is { uid: string; ranges: Record<string, TickRange> } => !!d.uid)
  const uidsKey = devices.map((d) => d.uid).join('|')
  // By value: a snapshot that updates every frame must not re-send its ranges.
  const detailsKey = JSON.stringify([mode, devices])
  const publishing = enabled && active && devices.length > 0

  // Attach for as long as this panel is publishing these arms.
  useEffect(() => {
    if (!publishing) {
      setAttachError(null)
      return
    }
    const uids = uidsKey.split('|')
    return () => {
      for (const uid of uids) void api.ros.detach(uid)
    }
  }, [publishing, uidsKey])

  // Attaching again with new ranges or a new mode updates the session in place.
  useEffect(() => {
    if (!publishing) return
    const [currentMode, list] = JSON.parse(detailsKey) as [RosSessionMode, typeof devices]
    let cancelled = false
    void Promise.all(list.map((d) => api.ros.attach({ uid: d.uid, mode: currentMode, ranges: d.ranges }))).then(
      (results) => {
        if (cancelled) return
        const failed = results.find((r) => !r.ok)
        setAttachError(failed && !failed.ok ? failed.error : null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [publishing, detailsKey])

  const namespaces = useMemo(
    () =>
      uidsKey
        .split('|')
        .filter(Boolean)
        .map((uid) => profiles.find((p) => p.uid === uid))
        .filter((p) => !!p)
        .map((p) => `/${rosNamespace(p.id)}`),
    [uidsKey, profiles]
  )

  const mine = status?.sessions.filter((s) => uidsKey.split('|').includes(s.uid)) ?? []
  return {
    enabled,
    setEnabled,
    publishing,
    namespaces,
    url,
    connection: publishing ? (status?.state ?? 'connecting') : 'idle',
    error: attachError ?? (publishing ? (status?.error ?? null) : null),
    rate: mine.reduce((sum, s) => sum + s.rate, 0)
  }
}
