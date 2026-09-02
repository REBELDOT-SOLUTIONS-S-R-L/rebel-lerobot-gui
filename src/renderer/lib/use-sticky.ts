import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { PanelSelections } from './panel-selections'

/**
 * `useState`, but the value outlives the component.
 *
 * Held in the app store, which is the only thing in the renderer that survives a
 * panel being unmounted. `initial` runs while the store has nothing for the key,
 * so a panel opened for the first time still gets its defaults — including ones
 * computed from settings that are not loaded yet.
 */
export function useSticky<K extends keyof PanelSelections>(
  key: K,
  initial: () => PanelSelections[K]
): [PanelSelections[K], Dispatch<SetStateAction<PanelSelections[K]>>] {
  const setSticky = useAppStore((s) => s.setSticky)
  const stored = useAppStore((s) => s.sticky[key])
  // `in` rather than a null check: `null` is a real value for the keys that hold
  // a selection, and means "nothing selected" rather than "never set".
  const held = useAppStore((s) => key in s.sticky)

  // One default per mount, and only used until the first change lands.
  const fallback = useRef<PanelSelections[K] | undefined>(undefined)
  if (fallback.current === undefined) fallback.current = initial()
  const value = held ? (stored as PanelSelections[K]) : fallback.current

  const set = useCallback<Dispatch<SetStateAction<PanelSelections[K]>>>(
    (next) => {
      // Read through the store rather than the closure, so an updater called
      // twice in one tick sees the first result.
      const state = useAppStore.getState().sticky
      const current = (key in state ? state[key] : fallback.current) as PanelSelections[K]
      setSticky(
        key,
        typeof next === 'function'
          ? (next as (prev: PanelSelections[K]) => PanelSelections[K])(current)
          : next
      )
    },
    [key, setSticky]
  )

  return [value, set]
}
