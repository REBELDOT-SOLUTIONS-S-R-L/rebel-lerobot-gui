import type { CameraBinding } from '@shared/types'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { Spinner } from './ui'

/**
 * A camera's live feed, while `active`.
 *
 * The sidecar opens the camera once and shares it: the preview and the rig's
 * recording read the same connection, so showing the feed never fights the
 * dataset for the device. Frames are small and slow — for aiming, not for
 * judging image quality, which the recording keeps at full size.
 */
export function useCameraFeed(
  id: string,
  binding: CameraBinding | null,
  active: boolean
): { src: string | null; error: string | null; opening: boolean } {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  // By value: the profile is re-read whenever anything in the store changes.
  const key = binding && active ? JSON.stringify(binding) : null

  useEffect(() => {
    setSrc(null)
    setError(null)
    if (!key) return
    const wanted = JSON.parse(key) as CameraBinding
    let cancelled = false
    setOpening(true)
    const offFrame = api.camera.onFrame((frame) => {
      if (cancelled || frame.preview !== id) return
      setOpening(false)
      setError(null)
      setSrc(`data:image/jpeg;base64,${frame.jpeg}`)
    })
    const offError = api.camera.onError((problem) => {
      if (cancelled || problem.preview !== id) return
      setOpening(false)
      setSrc(null)
      setError(problem.message)
    })
    void api.camera.preview(id, wanted).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setOpening(false)
        setError(res.error)
      }
    })
    return () => {
      cancelled = true
      offFrame()
      offError()
      setOpening(false)
      void api.camera.preview(id, null)
    }
  }, [id, key])

  return { src, error, opening }
}

export function CameraFeed({
  id,
  binding,
  label,
  className = ''
}: {
  id: string
  binding: CameraBinding
  label: string
  className?: string
}): ReactNode {
  const { src, error, opening } = useCameraFeed(id, binding, true)
  return (
    <figure className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <div
        className="relative overflow-hidden rounded-lg bg-plate"
        style={{ aspectRatio: `${binding.width || 4} / ${binding.height || 3}` }}
      >
        {src && <img src={src} alt={`${label} camera`} className="absolute inset-0 h-full w-full object-cover" />}
        {!src && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 px-3 text-center text-xs text-ink-500">
            {error ? (
              <span className="text-danger-400">{error}</span>
            ) : (
              <>
                {opening && <Spinner className="h-3 w-3" />}
                Opening {binding.key}…
              </>
            )}
          </div>
        )}
      </div>
      <figcaption className="truncate text-[11px] text-ink-500">
        {label} · <span className="font-mono">{binding.key}</span> · {binding.width}×{binding.height}
      </figcaption>
    </figure>
  )
}
