import { COMMON_FPS, COMMON_RESOLUTIONS } from '@shared/devices'
import type { CameraBinding, CameraInfo } from '@shared/types'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { Button, Field, Notice, Select, Spinner, TextInput } from './ui'

/**
 * Camera bindings for a device.
 *
 * The keys chosen here become the observation names in a recorded dataset
 * (`observation.images.<key>`), so a policy trained on `front`/`wrist` must be
 * replayed with the same keys — the UI says so rather than letting people find
 * out at inference time.
 */
export function CameraSelect({
  cameras,
  onChange,
  disabled
}: {
  cameras: CameraBinding[]
  onChange: (next: CameraBinding[]) => void
  disabled?: boolean
}): ReactNode {
  const [available, setAvailable] = useState<CameraInfo[]>([])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<Record<string, string>>({})
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [previewBusy, setPreviewBusy] = useState<string | null>(null)

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setError(null)
    const res = await api.cameras.list(true)
    if (res.ok) {
      setAvailable(res.value.cameras)
      setWarnings(res.value.errors ?? {})
    } else {
      setError(res.error)
    }
    setScanning(false)
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  const update = (index: number, patch: Partial<CameraBinding>): void => {
    onChange(cameras.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const add = (): void => {
    const suggestion = available[cameras.length] ?? available[0]
    const profile = suggestion?.defaultStreamProfile
    onChange([
      ...cameras,
      {
        key: nextKey(cameras),
        type: suggestion?.type === 'RealSense' ? 'intelrealsense' : 'opencv',
        identifier: suggestion?.id ?? '0',
        // Default to 640x480@30 rather than the sensor's native mode: a 1080p
        // stream is usually what pushes the control loop past its budget.
        width: profile?.width && profile.width <= 1280 ? profile.width : 640,
        height: profile?.height && profile.height <= 720 ? profile.height : 480,
        fps: 30
      }
    ])
  }

  const preview = async (cam: CameraBinding): Promise<void> => {
    setPreviewBusy(cam.key)
    const res = await api.cameras.snapshot({
      type: cam.type,
      identifier: cam.identifier,
      width: cam.width,
      height: cam.height,
      fps: cam.fps
    })
    if (res.ok) {
      setPreviews((p) => ({ ...p, [cam.key]: `data:image/jpeg;base64,${res.value.jpegBase64}` }))
    } else {
      setError(res.error)
    }
    setPreviewBusy(null)
  }

  const deviceOptions = available.map((c) => ({
    value: c.id,
    label: `${c.id} — ${c.name}${
      c.defaultStreamProfile?.width
        ? ` (${c.defaultStreamProfile.width}x${c.defaultStreamProfile.height})`
        : ''
    }`
  }))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-300">
          Cameras {cameras.length > 0 && <span className="text-ink-600">({cameras.length})</span>}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={scanning} onClick={() => void scan()}>
            {scanning ? <Spinner /> : 'Rescan'}
          </Button>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={add}>
            Add camera
          </Button>
        </div>
      </div>

      {error && (
        <Notice tone="error" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {warnings.realsense && (
        <Notice tone="warn" title="RealSense cameras were not enumerated">
          {warnings.realsense}
        </Notice>
      )}

      {cameras.length === 0 && (
        <p className="rounded-lg border border-dashed border-shell-700 px-3 py-4 text-center text-xs text-ink-600">
          No cameras configured. Teleoperation works without them; recording a dataset for training
          usually does not.
        </p>
      )}

      {cameras.map((cam, index) => (
        <div key={index} className="rounded-lg border border-shell-700 bg-shell-900 p-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Name (dataset key)" hint="Becomes observation.images.<name>">
              <TextInput
                value={cam.key}
                disabled={disabled}
                spellCheck={false}
                onChange={(e) => update(index, { key: e.currentTarget.value.replace(/[^\w]/g, '') })}
              />
            </Field>
            <Field label="Type">
              <Select
                value={cam.type}
                disabled={disabled}
                onChange={(v) => update(index, { type: v as CameraBinding['type'] })}
                options={[
                  { value: 'opencv', label: 'OpenCV (USB / built-in)' },
                  { value: 'intelrealsense', label: 'Intel RealSense' }
                ]}
              />
            </Field>
            <Field
              label={cam.type === 'intelrealsense' ? 'Serial number' : 'Index or path'}
              className="lg:col-span-2"
              hint={
                cam.type === 'opencv'
                  ? 'Index on macOS/Windows, /dev/videoN on Linux. These can change after a reboot.'
                  : undefined
              }
            >
              <div className="flex gap-2">
                {deviceOptions.length > 0 && (
                  <Select
                    value={deviceOptions.some((o) => o.value === cam.identifier) ? cam.identifier : null}
                    disabled={disabled}
                    onChange={(v) => update(index, { identifier: v })}
                    options={deviceOptions}
                    placeholder="Detected cameras…"
                    className="flex-1"
                  />
                )}
                <TextInput
                  value={cam.identifier}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(e) => update(index, { identifier: e.currentTarget.value })}
                  className="w-28 font-mono text-xs"
                />
              </div>
            </Field>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Resolution" className="w-40">
              <Select
                value={`${cam.width}x${cam.height}`}
                disabled={disabled}
                onChange={(v) => {
                  const [w, h] = String(v).split('x').map(Number)
                  update(index, { width: w, height: h })
                }}
                options={COMMON_RESOLUTIONS.map((r) => ({
                  value: `${r.width}x${r.height}`,
                  label: `${r.width} × ${r.height}`
                }))}
              />
            </Field>
            <Field label="FPS" className="w-24">
              <Select
                value={cam.fps}
                disabled={disabled}
                onChange={(v) => update(index, { fps: Number(v) })}
                options={COMMON_FPS.map((f) => ({ value: f, label: String(f) }))}
              />
            </Field>
            {cam.type === 'intelrealsense' && (
              <label className="flex items-center gap-2 pb-1.5 text-xs text-ink-300">
                <input
                  type="checkbox"
                  checked={!!cam.useDepth}
                  disabled={disabled}
                  onChange={(e) => update(index, { useDepth: e.currentTarget.checked })}
                />
                Record depth
              </label>
            )}
            <div className="ml-auto flex items-center gap-2 pb-1">
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || previewBusy === cam.key}
                onClick={() => void preview(cam)}
              >
                {previewBusy === cam.key ? <Spinner /> : 'Test'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(cameras.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          </div>

          {previews[cam.key] && (
            <img
              src={previews[cam.key]}
              alt={`Preview from ${cam.key}`}
              className="mt-3 max-h-40 rounded border border-shell-700"
            />
          )}
        </div>
      ))}
    </div>
  )
}

function nextKey(existing: CameraBinding[]): string {
  const preferred = ['front', 'wrist', 'top', 'side', 'overhead']
  const used = new Set(existing.map((c) => c.key))
  return preferred.find((k) => !used.has(k)) ?? `cam${existing.length + 1}`
}
