import { useEffect, useState } from 'react'

export type ResolvedTheme = 'light' | 'dark'

/**
 * The theme actually in force, read off `<html data-theme>`.
 *
 * App.tsx owns that attribute — it is where the `system` choice gets resolved
 * against the OS — so components that need a real colour value in JavaScript
 * (the terminal's palette, canvas work) watch the attribute rather than
 * re-deriving the choice and drifting out of step with the CSS.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(readTheme)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    setTheme(readTheme())
    return () => observer.disconnect()
  }, [])

  return theme
}

function readTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}
