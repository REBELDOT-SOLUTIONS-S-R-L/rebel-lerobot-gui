import { ABOUT } from '@shared/branding'
import type { ReactNode } from 'react'
import { Panel } from '../components/ui'
import { Wordmark } from '../components/Wordmark'
import { api } from '../lib/api'

/**
 * Credits and intent.
 *
 * Links go out through the shell rather than navigating the window: this is an
 * app, not a browser, and a renderer that can follow arbitrary URLs is a
 * liability the rest of the app avoids.
 */
export function AboutPanel(): ReactNode {
  const open = (url: string): void => void api.shell.openExternal(url)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 pb-4">
        <Panel title={ABOUT.product} description={ABOUT.tagline}>
          <div className="flex flex-col gap-5">
            <Wordmark tagline className="h-11 w-auto" />

            <p className="text-sm leading-relaxed text-ink-300">{ABOUT.purpose}</p>

            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Row label="Created by">{ABOUT.author}</Row>

              <Row label="Contributors">
                <ul className="flex flex-col gap-0.5">
                  {ABOUT.contributors.map((person) => (
                    <li key={person.email}>
                      {person.name} —{' '}
                      <button
                        type="button"
                        className="text-accent-400 underline-offset-2 hover:underline"
                        onClick={() => open(`mailto:${person.email}`)}
                      >
                        {person.email}
                      </button>
                    </li>
                  ))}
                </ul>
              </Row>

              <Row label="Built">{ABOUT.built}</Row>

              <Row label="Built with">
                <button
                  type="button"
                  className="text-accent-400 underline-offset-2 hover:underline"
                  onClick={() => open(ABOUT.builtWith.url)}
                >
                  {ABOUT.builtWith.name}
                </button>
                <p className="mt-0.5 text-xs text-ink-500">{ABOUT.builtWith.detail}</p>
              </Row>

              <Row label="Inspired by">
                <button
                  type="button"
                  className="text-accent-400 underline-offset-2 hover:underline"
                  onClick={() => open(ABOUT.inspiredBy.url)}
                >
                  {ABOUT.inspiredBy.name}
                </button>
                <p className="mt-0.5 text-xs text-ink-500">{ABOUT.inspiredBy.detail}</p>
              </Row>
            </dl>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <>
      <dt className="text-xs font-semibold tracking-wide text-ink-600 uppercase sm:pt-0.5">
        {label}
      </dt>
      <dd className="text-sm text-ink-100">{children}</dd>
    </>
  )
}
