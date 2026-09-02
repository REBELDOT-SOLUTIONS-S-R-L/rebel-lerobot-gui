import type { ArmModel } from '@shared/devices'
import type { JointReading } from '@shared/sim'
import type { EeController } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from './api'
import { loadArmKinematics, type ArmKinematics } from './arm-kinematics'
import { useEeDrive, type EeDriveState } from './use-ee-drive'
import { useSticky } from './use-sticky'

/**
 * Flying an arm from the panel you are already looking at.
 *
 * Teleoperate is where a session gets set up — which arms, cameras, whether to
 * record. But Configure has the motor table and the diagram on screen, and the
 * 3D view has the model, and both are places you want to nudge a joint and watch
 * what happens without changing tabs. So the same control loop is offered there,
 * behind a Start Control button: pick the keyboard or a gamepad, start, drive.
 *
 * Only the pieces those two panels do not already have: the model's kinematics,
 * whether control is engaged, and the Escape key. The arm itself is whatever the
 * panel already had open.
 */

export const EE_CONTROLLERS: { value: EeController; label: string }[] = [
  { value: 'keyboard', label: 'Keyboard' },
  { value: 'gamepad', label: 'Gamepad' }
]

export interface ArmControl {
  controller: EeController
  setController: (next: EeController) => void
  engaged: boolean
  start: () => void
  stop: () => void
  /** Meters, tool pose and warnings from the running loop. */
  drive: EeDriveState
  speed: number
  setSpeed: (next: number) => void
  /** The kinematics are loaded, so control can start. */
  ready: boolean
  /** Why it cannot; null when there is nothing wrong. */
  error: string | null
}

/** Which panel is asking, so its choices come back when you return to it. */
const KEYS = {
  configure: { controller: 'configure.controller', speed: 'configure.speed' },
  view3d: { controller: 'view3d.controller', speed: 'view3d.speed' }
} as const

export function useArmControl(opts: {
  uid: string | null
  model: ArmModel | null
  /** False disengages and loads nothing — the arm is not one this can drive. */
  available: boolean
  /** Calibrated ranges and the last positions read, from the panel's snapshot. */
  readings: Record<string, JointReading>
  panel: keyof typeof KEYS
}): ArmControl {
  const { uid, model, available, readings, panel } = opts
  // The controller and the speed are choices; being engaged is not — coming back
  // to a tab must never find it already flying an arm.
  const [controller, setController] = useSticky(KEYS[panel].controller, () => 'keyboard')
  const [speed, setSpeed] = useSticky(KEYS[panel].speed, () => 1)
  const [engaged, setEngaged] = useState(false)
  const [kinematics, setKinematics] = useState<ArmKinematics | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!available || !model) {
      setKinematics(null)
      return
    }
    let cancelled = false
    setError(null)
    void loadArmKinematics(model)
      .then((loaded) => !cancelled && setKinematics(loaded))
      .catch((err: unknown) => {
        if (cancelled) return
        setKinematics(null)
        setError(
          `Could not read the ${model} kinematics out of the assets folder, so the tool cannot be ` +
            `solved for. ${errorMessage(err)}`
        )
      })
    return () => {
      cancelled = true
    }
  }, [available, model])

  // Changing arm, or losing the one being driven, has to hand control back.
  useEffect(() => setEngaged(false), [uid, available])

  const stop = useCallback(() => setEngaged(false), [])
  const start = useCallback(() => setEngaged(true), [])

  useEscapeToStop(engaged, stop)

  const drive = useEeDrive({
    uid,
    controller,
    engaged: engaged && available,
    kinematics,
    readings,
    speed
  })

  return {
    controller,
    setController,
    engaged: engaged && available,
    start,
    stop,
    drive,
    speed,
    setSpeed,
    ready: kinematics !== null,
    error
  }
}

/**
 * Escape gives up control of the arm.
 *
 * The one gesture that means "stop" wherever the app is driving something, and
 * the one a hand already on the keys can reach without looking. Deliberately not
 * one of the driving keys, so it cannot be hit by accident mid-flight, and
 * ignored while a field has the keyboard — Escape there means "leave this field".
 */
export function useEscapeToStop(active: boolean, stop: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Escape') return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return
      }
      event.preventDefault()
      stop()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, stop])
}
