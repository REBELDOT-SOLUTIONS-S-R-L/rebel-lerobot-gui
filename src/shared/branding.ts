/**
 * Brand assets and the credits shown in the About panel.
 *
 * The logo filenames are RebelDot's own exports, kept verbatim so re-exporting
 * from the brand kit drops straight in; they are named once here rather than
 * spelled out at each use.
 *
 * Two pairs, each with a light-ink and a dark-ink export: the bare wordmark for
 * the menu bar, where there is only room for a mark, and the full lock-up with
 * the tagline for the About panel.
 */

/** Bare wordmark, white ink — for the dark theme. */
export const LOGO_ON_DARK = 'logo/rebeldot-logo-notagline-4.-white-rgb-900px-w-72ppi.png'

/** Bare wordmark, black ink — for the light theme. */
export const LOGO_ON_LIGHT = 'logo/rebeldot-logo-notagline-3.-black-rgb-900px-w-72ppi.png'

/** Full lock-up with the tagline, white ink — for the dark theme. */
export const TAGLINE_ON_DARK = 'logo/rebeldot-logo-tagline-white-yellow@3x.png'

/** Full lock-up with the tagline, black ink — for the light theme. */
export const TAGLINE_ON_LIGHT = 'logo/rebeldot-logo-tagline-black-yellow@3x.png'

export const ABOUT = {
  product: 'LeRobot Control',
  tagline: 'A GUI for setting up and operating LeRobot arms.',
  purpose:
    'Built to make LeRobot arms quicker to get running and easier to live with: one place to prepare the Python environment, give each arm an identity, calibrate it, and then teleoperate, record, replay and run policies — without assembling command lines by hand.',
  author: 'RebelDot — Physical AI department',
  contributors: [{ name: 'Andrei Brumboiu', email: 'andrei.brumboiu@rebeldot.com' }],
  /** Range the app was written over. */
  built: 'August – September 2026',
  builtWith: {
    name: 'Claude Code',
    detail: "Anthropic's agentic coding tool — the app was written with it, start to finish.",
    url: 'https://claude.com/claude-code'
  },
  inspiredBy: {
    name: 'LeRobot',
    detail: "Hugging Face's robotics library, which does the actual driving of the arms.",
    url: 'https://github.com/huggingface/lerobot'
  }
} as const
