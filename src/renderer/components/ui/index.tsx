import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'

/* ------------------------------------------------------------------ *
 * Layout                                                              *
 * ------------------------------------------------------------------ */

export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
  bodyClassName = '',
  scrollBody = false,
  collapsible = false,
  defaultOpen = true
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Extra classes on the body, for a panel whose content has to fill it. */
  bodyClassName?: string
  /**
   * Let the panel body scroll on its own. Off by default so a panel sizes to its
   * content: stacked in a scrolling column, an internally-scrolling panel would
   * collapse and clip its own fields.
   */
  scrollBody?: boolean
  /** Turn the header into a toggle that folds the body away. */
  collapsible?: boolean
  defaultOpen?: boolean
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const shown = !collapsible || open

  const heading = (
    <>
      <h2 className="text-sm font-semibold tracking-wide text-ink-100">{title}</h2>
      {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{description}</p>}
    </>
  )

  return (
    <section
      className={`flex flex-col rounded-xl border border-shell-700 bg-shell-850 ${
        // A collapsed panel must not keep claiming its share of a flex column.
        scrollBody && shown ? 'min-h-0' : ''
      } ${scrollBody && !shown ? 'flex-none' : ''} ${className}`}
    >
      <header
        className={`flex shrink-0 items-start justify-between gap-3 px-4 py-3 ${
          shown ? 'border-b border-shell-700' : ''
        }`}
      >
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
          >
            <svg
              viewBox="0 0 16 16"
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500 transition-transform ${
                open ? 'rotate-90' : ''
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="min-w-0">{heading}</div>
          </button>
        ) : (
          <div className="min-w-0">{heading}</div>
        )}
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {shown && (
        <div
          className={`${scrollBody ? 'min-h-0 flex-1 overflow-y-auto p-4' : 'p-4'} ${bodyClassName}`}
        >
          {children}
        </div>
      )}
    </section>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  className = ''
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-medium text-ink-300">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-danger-400">{error}</span>
      ) : (
        hint && <span className="text-xs leading-relaxed text-ink-600">{hint}</span>
      )}
    </label>
  )
}

export function Row({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={`flex flex-wrap items-end gap-3 ${className}`}>{children}</div>
}

export function Divider({ label }: { label?: string }): ReactNode {
  if (!label) return <hr className="my-4 border-shell-700" />
  return (
    <div className="my-4 flex items-center gap-3">
      <hr className="flex-1 border-shell-700" />
      <span className="text-[11px] font-semibold uppercase tracking-widest text-ink-600">{label}</span>
      <hr className="flex-1 border-shell-700" />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Controls                                                            *
 * ------------------------------------------------------------------ */

const INPUT_CLASS =
  'w-full rounded-md border border-shell-600 bg-shell-900 px-2.5 py-1.5 text-sm text-ink-100 ' +
  'placeholder:text-ink-600 transition-colors hover:border-shell-500 focus:border-accent-500 ' +
  'focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): ReactNode {
  const { className = '', ...rest } = props
  return <input {...rest} className={`${INPUT_CLASS} ${className}`} />
}

export function NumberInput(props: React.InputHTMLAttributes<HTMLInputElement>): ReactNode {
  const { className = '', ...rest } = props
  return <input type="number" {...rest} className={`${INPUT_CLASS} font-mono ${className}`} />
}

/**
 * Multi-line input. `mono` for anything the user expects to look like a file —
 * a script's indentation only reads correctly in a fixed-width face.
 */
export function TextArea({
  mono = false,
  className = '',
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }): ReactNode {
  return (
    <textarea
      {...rest}
      spellCheck={mono ? false : rest.spellCheck}
      className={`${INPUT_CLASS} resize-y leading-relaxed ${mono ? 'font-mono text-xs' : ''} ${className}`}
    />
  )
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className = ''
}: {
  value: T | null
  onChange: (value: T) => void
  options: { value: T; label: string; disabled?: boolean }[]
  placeholder?: string
  disabled?: boolean
  className?: string
}): ReactNode {
  return (
    <select
      value={value === null ? '' : String(value)}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value
        const match = options.find((o) => String(o.value) === raw)
        if (match) onChange(match.value)
      }}
      className={`${INPUT_CLASS} appearance-none bg-[length:12px] pr-7 ${className}`}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath fill='%237d8798' d='M1 1.5 6 6.5l5-5'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center'
      }}
    >
      {(placeholder || value === null) && (
        <option value="" disabled>
          {placeholder ?? 'Select…'}
        </option>
      )}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'live'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-500 text-shell-950 hover:bg-accent-400 font-semibold',
  secondary: 'bg-shell-700 text-ink-100 hover:bg-shell-600 border border-shell-600',
  ghost: 'bg-transparent text-ink-300 hover:bg-shell-700 hover:text-ink-100',
  danger: 'bg-danger-600 text-white hover:bg-danger-400 hover:text-shell-950 font-semibold',
  live: 'bg-live-600 text-shell-950 hover:bg-live-400 font-semibold'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}): ReactNode {
  const pad = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md ${pad} transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: ReactNode
  disabled?: boolean
}): ReactNode {
  const id = useId()
  return (
    <div className="flex items-start gap-2.5">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 h-4.5 w-8 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          checked ? 'border-accent-500 bg-accent-500' : 'border-shell-500 bg-shell-700'
        }`}
      >
        <span
          className={`block h-3.5 w-3.5 rounded-full bg-shell-950 transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm text-ink-100">
          {label}
        </label>
        {hint && <p className="text-xs leading-relaxed text-ink-600">{hint}</p>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Feedback                                                            *
 * ------------------------------------------------------------------ */

type NoticeTone = 'info' | 'warn' | 'error' | 'success'

const NOTICE_TONES: Record<NoticeTone, string> = {
  info: 'border-accent-600/50 bg-accent-600/10 text-accent-400',
  warn: 'border-warn-600/50 bg-warn-600/10 text-warn-400',
  error: 'border-danger-600/50 bg-danger-600/10 text-danger-400',
  success: 'border-live-600/50 bg-live-600/10 text-live-400'
}

/**
 * Every notice can be dismissed.
 *
 * `onClose` is the better wiring where the parent owns the state behind the
 * notice: clearing it means the very same message can be raised again later.
 * Without it the notice hides itself, and comes back on its own if the message
 * changes — which covers the notices rendered from derived state, where there is
 * no flag to clear.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  actions,
  onClose,
  dismissible = true
}: {
  tone?: NoticeTone
  title?: string
  children?: ReactNode
  actions?: ReactNode
  onClose?: () => void
  /**
   * Set false where dismissing would hide something the user still needs — a
   * banner carrying the Stop button for an arm that is currently moving.
   */
  dismissible?: boolean
}): ReactNode {
  const [dismissed, setDismissed] = useState(false)
  // Only a string body can be compared cheaply; element bodies are the static
  // explanatory notices, which should stay closed until the panel remounts.
  const body = typeof children === 'string' ? children : null

  useEffect(() => setDismissed(false), [tone, title, body])

  if (dismissed) return null

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs ${NOTICE_TONES[tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {title && <p className="font-semibold">{title}</p>}
          {children && (
            <div className={`leading-relaxed whitespace-pre-wrap ${title ? 'mt-1' : ''}`}>{children}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {dismissible && (
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => (onClose ? onClose() : setDismissed(true))}
            className="-mt-0.5 -mr-1 inline-flex h-5 w-5 items-center justify-center rounded opacity-60 transition-all hover:bg-shell-800 hover:opacity-100"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  children
}: {
  tone?: 'neutral' | 'live' | 'warn' | 'error' | 'accent'
  children: ReactNode
}): ReactNode {
  const tones = {
    neutral: 'border-shell-600 bg-shell-800 text-ink-300',
    live: 'border-live-600 bg-live-600/15 text-live-400',
    warn: 'border-warn-600 bg-warn-600/15 text-warn-400',
    error: 'border-danger-600 bg-danger-600/15 text-danger-400',
    accent: 'border-accent-600 bg-accent-600/15 text-accent-400'
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Spinner({ className = '' }: { className?: string }): ReactNode {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-hidden
    />
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-shell-700 p-6 text-center">
      <p className="text-sm font-medium text-ink-300">{title}</p>
      {children && <p className="max-w-md text-xs leading-relaxed text-ink-600">{children}</p>}
    </div>
  )
}

/** A read-only command preview with a copy button. */
export function CommandPreview({
  command,
  error
}: {
  command: string | null
  error?: string | null
}): ReactNode {
  if (error) {
    return (
      <Notice tone="warn" title="Command not ready">
        {error}
      </Notice>
    )
  }
  if (!command) return null
  return (
    <div className="rounded-lg border border-shell-700 bg-shell-900">
      <div className="flex items-center justify-between border-b border-shell-700 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-ink-600">
          Command to run
        </span>
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(command)}>
          Copy
        </Button>
      </div>
      <pre className="max-h-32 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-300">
        {command}
      </pre>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Modal                                                               *
 * ------------------------------------------------------------------ */

/**
 * A centred dialog over a dimmed backdrop.
 *
 * Deliberately not `<dialog showModal>`: the demo console inside one of these is
 * an xterm instance, and the top layer clips its canvas and steals the
 * keystrokes the terminal needs. This is a plain overlay with the same
 * behaviours added back — Escape closes, the backdrop closes, focus moves into
 * the panel, and the page behind does not scroll.
 *
 * `onClose` is what the close affordances call; a caller that must not be
 * dismissed casually (a run in progress, an unsaved edit) confirms inside it.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md'
}: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg'
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Capture, so Escape closes the dialog before anything inside it — the
    // terminal would otherwise swallow the key and forward it to the child.
    window.addEventListener('keydown', onKey, true)
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Only a press that both starts and ends on the backdrop closes, so a
        // drag that began inside the panel (selecting text) cannot dismiss it.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`flex max-h-full w-full ${
          size === 'lg' ? 'max-w-4xl' : 'max-w-2xl'
        } flex-col overflow-hidden rounded-xl border border-shell-700 bg-shell-900 shadow-2xl outline-none`}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-shell-700 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink-100">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-xs text-ink-600">{subtitle}</p>}
          </div>
          <button
            type="button"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-md p-1 text-ink-500 transition-colors hover:bg-shell-800 hover:text-ink-100"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-shell-700 bg-shell-950/50 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
