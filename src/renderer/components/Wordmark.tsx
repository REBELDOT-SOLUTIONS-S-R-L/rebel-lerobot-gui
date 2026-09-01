import { assetUrl } from '@shared/assets'
import { LOGO_ON_DARK, LOGO_ON_LIGHT, TAGLINE_ON_DARK, TAGLINE_ON_LIGHT } from '@shared/branding'
import type { ReactNode } from 'react'

/**
 * The RebelDot mark, in whichever ink reads against its background.
 *
 * Both exports are rendered and CSS hides one, rather than picking in JS from
 * the resolved theme: that way the mark is correct inside a themed subtree too
 * (the arm diagram pins itself dark), and it swaps with no re-render.
 */
export function Wordmark({
  tagline = false,
  className = 'h-5 w-auto'
}: {
  /** Use the full lock-up with the tagline instead of the bare wordmark. */
  tagline?: boolean
  className?: string
}): ReactNode {
  const [onDark, onLight] = tagline
    ? [TAGLINE_ON_DARK, TAGLINE_ON_LIGHT]
    : [LOGO_ON_DARK, LOGO_ON_LIGHT]

  return (
    <span role="img" aria-label="RebelDot" className="inline-flex shrink-0">
      <img src={assetUrl(onDark)} alt="" className={`logo-on-dark ${className}`} draggable={false} />
      <img src={assetUrl(onLight)} alt="" className={`logo-on-light ${className}`} draggable={false} />
    </span>
  )
}
