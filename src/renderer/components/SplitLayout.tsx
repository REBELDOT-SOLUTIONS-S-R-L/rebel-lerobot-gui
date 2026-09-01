import { clampSidebarWidth } from '@shared/layout'
import type { SplitPanelId } from '@shared/types'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/** Mirrors the main process's settings defaults, so a patch is always complete. */
const DEFAULT_WIDTHS: Record<SplitPanelId, number> = {
  configure: 380,
  view3d: 340,
  teleoperate: 420,
  replay: 420,
  infer: 420
}

/**
 * Two columns with a draggable divider between them.
 *
 * The width is per panel and persisted, so Configure's narrow device sidebar and
 * Teleoperate's wide console pane each keep their own setting. The limits live in
 * `clampSidebarWidth`, which runs on drag and on window resize alike — a width
 * stored from a larger window cannot squeeze the main column when the app is
 * later opened smaller.
 */
export function SplitLayout({
  id,
  defaultWidth = 420,
  minMain = 380,
  mainClassName = 'flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1',
  sideClassName = 'flex min-h-0 flex-col gap-4 overflow-hidden',
  main,
  side
}: {
  id: SplitPanelId
  defaultWidth?: number
  /** Floor for the left column, so dragging cannot collapse the real content. */
  minMain?: number
  mainClassName?: string
  sideClassName?: string
  main: ReactNode
  side: ReactNode
}): ReactNode {
  const { settings, saveSettings } = useAppStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings }))
  )
  const stored = settings?.sidebarWidths?.[id] ?? defaultWidth

  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [width, setWidth] = useState(stored)

  const clampWidth = useCallback(
    (next: number): number =>
      clampSidebarWidth({
        width: next,
        containerWidth: containerRef.current?.getBoundingClientRect().width ?? window.innerWidth,
        windowWidth: window.innerWidth,
        minMain
      }),
    [minMain]
  )

  useEffect(() => setWidth(clampWidth(stored)), [stored, clampWidth])

  useEffect(() => {
    const onResize = (): void => setWidth((w) => clampWidth(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampWidth])

  const commit = useCallback(
    (next: number): void => {
      setWidth(next)
      const widths = { ...DEFAULT_WIDTHS, ...settings?.sidebarWidths, [id]: next }
      void saveSettings({ sidebarWidths: widths })
    },
    [saveSettings, settings?.sidebarWidths, id]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) setWidth(clampWidth(rect.right - e.clientX))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    commit(width)
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      <div className={mainClassName}>{main}</div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side column"
        tabIndex={0}
        className="group relative w-4 shrink-0 cursor-col-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 16
          if (e.key === 'ArrowLeft') commit(clampWidth(width + step))
          else if (e.key === 'ArrowRight') commit(clampWidth(width - step))
          else return
          e.preventDefault()
        }}
      >
        <span
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-shell-700 transition-colors group-hover:bg-accent-500 group-focus-visible:bg-accent-500"
          aria-hidden
        />
      </div>

      <div style={{ width }} className={`shrink-0 ${sideClassName}`}>
        {side}
      </div>
    </div>
  )
}
