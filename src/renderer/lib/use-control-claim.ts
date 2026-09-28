import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/**
 * Tell the window an in-app loop is driving an arm, so it can show it.
 *
 * Runs are already visible to the store; loops that live inside a panel are
 * not, so each one claims control here while it is active. The claim is let go
 * when `active` turns false or the panel unmounts, so a tab switch can never
 * leave the indicator on.
 */
export function useControlClaim(key: string, active: boolean): void {
  const setControlClaim = useAppStore((s) => s.setControlClaim)
  useEffect(() => {
    if (!active) return
    setControlClaim(key, true)
    return () => setControlClaim(key, false)
  }, [key, active, setControlClaim])
}
