import { useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { Button, TextInput } from './ui'

type Mode = 'directory' | 'openFile' | 'saveFile'

/**
 * Text field plus a native browse dialog. Paths stay editable by hand because
 * users often paste them from a terminal.
 */
export function PathPicker({
  value,
  onChange,
  mode = 'directory',
  title,
  filters,
  placeholder,
  disabled,
  onReveal
}: {
  value: string
  onChange: (path: string) => void
  mode?: Mode
  title?: string
  filters?: { name: string; extensions: string[] }[]
  placeholder?: string
  disabled?: boolean
  /** Show a "Reveal" button that opens the OS file manager at this path. */
  onReveal?: boolean
}): ReactNode {
  const [revealError, setRevealError] = useState<string | null>(null)

  const browse = async (): Promise<void> => {
    const opts = { title, defaultPath: value || undefined, filters }
    const res =
      mode === 'directory'
        ? await api.dialog.openDirectory(opts)
        : mode === 'openFile'
          ? await api.dialog.openFile(opts)
          : await api.dialog.saveFile(opts)
    if (res.ok && res.value) onChange(res.value)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <TextInput
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.value)}
          className="flex-1 font-mono text-xs"
          spellCheck={false}
        />
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void browse()}>
          Browse…
        </Button>
        {onReveal && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || !value}
            onClick={() => {
              setRevealError(null)
              void api.shell.showPath(value).then((res) => {
                if (!res.ok) setRevealError(res.error)
              })
            }}
          >
            Reveal
          </Button>
        )}
      </div>
      {revealError && <span className="text-xs text-ink-600">{revealError}</span>}
    </div>
  )
}
