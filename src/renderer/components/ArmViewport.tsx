import type { ArmModel } from '@shared/devices'
import type { SimManifest } from '@shared/sim'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessage } from '../lib/api'
import { ArmScene, loadSimManifest } from '../lib/arm-scene'
import { useResolvedTheme } from '../lib/theme'
import { Button, Notice } from './ui'

/**
 * A model of one arm, posed from joint angles.
 *
 * Owns the WebGL canvas and the scene behind it (`ArmScene`), and nothing else:
 * whatever decides what pose to show — motor readings in the 3D View panel, the
 * inverse-kinematics loop in Teleoperate — passes it in. Shared between the two
 * because a keyboard or a gamepad is unusable without something to watch, and
 * the arm's own model is the thing to watch.
 */
export function ArmViewport({
  model,
  pose,
  className = '',
  placeholder,
  onManifest
}: {
  model: ArmModel | null
  /** Joint angles in radians, keyed by motor name. */
  pose: Record<string, number>
  className?: string
  /** Shown over the canvas while there is nothing to draw. */
  placeholder?: ReactNode
  /** The loaded scene description, which callers need to convert readings. */
  onManifest?: (manifest: SimManifest | null) => void
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sceneRef = useRef<ArmScene | null>(null)
  const [manifest, setManifest] = useState<SimManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const theme = useResolvedTheme()
  // Held rather than depended on: an inline callback would otherwise reload the
  // scene on every render of the parent.
  const report = useRef(onManifest)
  report.current = onManifest

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      sceneRef.current = new ArmScene(canvas)
    } catch (err) {
      setError(
        `This window could not start WebGL, so the 3D view cannot be drawn. ${errorMessage(err)}`
      )
      return
    }
    const scene = sceneRef.current
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  // Keyed on the model rather than the device: two arms of the same model share
  // one scene, and switching between them should not reload it.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !model) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void loadSimManifest(model)
      .then(async (loaded) => {
        if (cancelled) return
        await scene.load(loaded)
        if (cancelled) return
        setManifest(loaded)
        report.current?.(loaded)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setManifest(null)
        report.current?.(null)
        setError(
          `Could not load the ${model} scene. Rebuild it with \`npm run build:sim\`. ${errorMessage(err)}`
        )
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [model])

  useEffect(() => sceneRef.current?.setTheme(theme), [theme, manifest])

  // `immediate` on the first pose after a load, so the arm does not visibly
  // swing in from the URDF's rest position.
  const posedOnce = useRef(false)
  useEffect(() => {
    posedOnce.current = false
  }, [manifest])
  useEffect(() => {
    if (!manifest) return
    sceneRef.current?.setPose(pose, { immediate: !posedOnce.current })
    posedOnce.current = true
  }, [manifest, pose])

  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-plate">
        <canvas ref={canvasRef} className="absolute inset-0 block" />
        {manifest && !error && (
          <Button
            size="sm"
            variant="ghost"
            className="absolute top-2 right-2 bg-shell-900/70"
            title="Back to the default camera framing."
            onClick={() => sceneRef.current?.resetView()}
          >
            Reset view
          </Button>
        )}
        {(loading || !model) && (
          <div className="absolute inset-0 flex items-center justify-center bg-plate/80 px-6 text-center text-sm text-ink-500">
            {loading ? `Loading the ${model} model…` : placeholder}
          </div>
        )}
      </div>
    </div>
  )
}
