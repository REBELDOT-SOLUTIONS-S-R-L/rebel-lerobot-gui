import type { Demo } from '@shared/demos'
import { THUMBNAIL_DIM, deviceLabels, missingDeviceUids } from '@shared/demos'
import type { DeviceProfile, RunStatus } from '@shared/types'
import type { ReactNode } from 'react'
import { Badge, Spinner } from './ui'

/**
 * One demo, as a tile in the Demos grid.
 *
 * The thumbnail is a background rather than an image element: the card's size is
 * set by the grid, and a photo of any shape has to fill it without changing the
 * layout. A fixed dark overlay sits over it so the title and device names stay
 * readable whatever was chosen.
 */
export function DemoCard({
  demo,
  devices,
  status,
  onOpen
}: {
  demo: Demo
  devices: readonly DeviceProfile[]
  /** Status of this demo's run, or null when it has never been started. */
  status: RunStatus | null
  onOpen: () => void
}): ReactNode {
  const labels = deviceLabels(demo, devices)
  const missing = missingDeviceUids(demo, devices).length
  const busy = status === 'running' || status === 'starting' || status === 'paused'

  return (
    <button
      type="button"
      onClick={onOpen}
      title={demo.description || demo.name}
      className="group relative flex h-44 flex-col justify-end overflow-hidden rounded-xl border border-shell-700 bg-shell-850 p-3.5 text-left transition-colors hover:border-accent-500 focus:border-accent-500 focus:outline-none"
    >
      {demo.thumbnail && (
        <>
          <img
            src={`thumb://${encodeURIComponent(demo.thumbnail)}`}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
          {/* The thumbnail reads at 30%; the gradient adds a little more weight
              under the text, where the title and device names actually sit. */}
          <span
            className="absolute inset-0 bg-black"
            style={{ opacity: THUMBNAIL_DIM }}
            aria-hidden
          />
          <span
            className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent"
            aria-hidden
          />
        </>
      )}

      <div className="absolute top-3 right-3 flex flex-wrap justify-end gap-1.5">
        {busy && (
          <Badge tone={status === 'paused' ? 'warn' : 'live'}>
            {status !== 'paused' && <Spinner className="h-2.5 w-2.5" />}
            {status === 'paused' ? 'suspended' : 'running'}
          </Badge>
        )}
        {!busy && status === 'failed' && <Badge tone="error">failed</Badge>}
        {missing > 0 && <Badge tone="warn">{missing} device{missing === 1 ? '' : 's'} missing</Badge>}
      </div>

      <div className="relative min-w-0">
        <h3
          className={`truncate text-sm font-semibold ${demo.thumbnail ? 'text-white' : 'text-ink-100'}`}
        >
          {demo.name}
        </h3>
        {demo.description && (
          <p
            className={`mt-0.5 line-clamp-2 text-xs leading-snug ${
              demo.thumbnail ? 'text-white/70' : 'text-ink-500'
            }`}
          >
            {demo.description}
          </p>
        )}
        <p
          className={`mt-1.5 truncate font-mono text-[11px] ${
            demo.thumbnail ? 'text-white/60' : 'text-ink-600'
          }`}
        >
          {labels.length ? labels.join(' · ') : 'no devices'}
        </p>
      </div>
    </button>
  )
}

/** The tile that opens an empty form. Always last in the grid. */
export function AddDemoCard({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Create a new demo"
      className="flex h-44 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-shell-600 text-ink-500 transition-colors hover:border-accent-500 hover:text-accent-400 focus:border-accent-500 focus:outline-none"
    >
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" strokeLinecap="round" />
      </svg>
      <span className="text-xs font-medium">Add new demo</span>
    </button>
  )
}
