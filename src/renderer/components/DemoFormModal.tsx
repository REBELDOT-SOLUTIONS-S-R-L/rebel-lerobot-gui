import type { Demo, DemoDraft } from '@shared/demos'
import { CARD_ASPECT, DEMO_NAME_MAX, THUMBNAIL_DIM, validateDemo } from '@shared/demos'
import type { DeviceProfile } from '@shared/types'
import { useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { Badge, Button, Field, Modal, Notice, Spinner, TextArea, TextInput } from './ui'

/**
 * Create or edit a demo.
 *
 * The same form serves both: the only difference is that an existing demo can
 * also be deleted, which is why `onDelete` is optional rather than there being
 * two components. Nothing is written until Save — including the thumbnail, which
 * is the one exception and is explained where it is picked.
 */
export function DemoFormModal({
  initial,
  devices,
  others,
  onSave,
  onDelete,
  onClose
}: {
  initial: DemoDraft
  devices: readonly DeviceProfile[]
  /** The other demos, so a duplicate name can be refused before saving. */
  others: readonly Demo[]
  onSave: (demo: DemoDraft) => Promise<string | null>
  onDelete?: () => Promise<void>
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<DemoDraft>(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const set = <K extends keyof DemoDraft>(key: K, value: DemoDraft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setError(null)
  }

  const toggleDevice = (uid: string): void => {
    setDraft((d) => ({
      ...d,
      deviceUids: d.deviceUids.includes(uid)
        ? d.deviceUids.filter((u) => u !== uid)
        : [...d.deviceUids, uid]
    }))
  }

  /**
   * Pick a thumbnail.
   *
   * This one write happens immediately rather than on Save: the file has to be
   * copied into the app's own storage before it can be previewed, since the
   * renderer cannot read an arbitrary path. Cancelling the form afterwards
   * leaves an unreferenced image behind, which the next save for this demo
   * cleans up — `saveThumbnail` drops every earlier file for the same uid.
   */
  const pickThumbnail = async (): Promise<void> => {
    setBusy(true)
    const res = await api.demos.pickThumbnail(draft.uid)
    if (!res.ok) setError(res.error)
    else if (res.value) set('thumbnail', res.value)
    setBusy(false)
  }

  const clearThumbnail = async (): Promise<void> => {
    const name = draft.thumbnail
    set('thumbnail', null)
    if (name) await api.demos.clearThumbnail(name)
  }

  const save = async (): Promise<void> => {
    const reason = validateDemo(draft, others)
    if (reason) {
      setError(reason)
      return
    }
    setBusy(true)
    const err = await onSave(draft)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  const remove = async (): Promise<void> => {
    if (!onDelete) return
    setBusy(true)
    await onDelete()
    setBusy(false)
    onClose()
  }

  return (
    <Modal
      title={onDelete ? `Edit ${initial.name}` : 'New demo'}
      subtitle="A shell script, the devices it needs, and how it looks on the grid"
      onClose={onClose}
      size="lg"
      footer={
        <>
          {onDelete && (
            <Button
              variant="danger"
              className="mr-auto"
              disabled={busy}
              onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
            >
              {confirmDelete ? 'Delete for good' : 'Delete demo'}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {confirmDelete && (
          <Notice tone="warn" onClose={() => setConfirmDelete(false)}>
            Deleting removes the demo, its script and its thumbnail. Press “Delete for good” again
            to confirm.
          </Notice>
        )}

        <Field label="Demo name" hint={`Up to ${DEMO_NAME_MAX} characters.`}>
          <TextInput
            value={draft.name}
            maxLength={DEMO_NAME_MAX}
            placeholder="Pick and place"
            onChange={(e) => set('name', e.currentTarget.value)}
          />
        </Field>

        <Field
          label="Devices"
          hint="Each one is exported to the script as DEMO_DEVICE_<n>_PORT and friends, plus DEMO_ROBOT_* and DEMO_LEADER_* for the first of each role."
        >
          {devices.length === 0 ? (
            <p className="text-xs text-ink-600">
              No device profiles yet — create one in Configure first, or leave this empty and put
              the ports in the script.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {devices.map((device) => {
                const on = draft.deviceUids.includes(device.uid)
                return (
                  <button
                    key={device.uid}
                    type="button"
                    onClick={() => toggleDevice(device.uid)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on
                        ? 'border-accent-500 bg-accent-600/15 text-accent-400'
                        : 'border-shell-600 text-ink-500 hover:border-shell-500 hover:text-ink-300'
                    }`}
                  >
                    {device.id}
                    <span className="ml-1.5 text-[10px] opacity-60">
                      {device.role === 'robot' ? 'follower' : 'leader'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </Field>

        <Field
          label="Script"
          hint="Runs in this machine's own shell. The venv is on PATH, so lerobot-* commands work without a full path."
        >
          <TextArea
            mono
            rows={12}
            value={draft.script}
            placeholder={'lerobot-teleoperate \\\n  --robot.type="$DEMO_ROBOT_TYPE" \\\n  --robot.port="$DEMO_ROBOT_PORT" \\\n  --robot.id="$DEMO_ROBOT_ID"'}
            onChange={(e) => set('script', e.currentTarget.value)}
          />
        </Field>

        <Field label="Description" hint="One or two lines, shown on the card.">
          <TextArea
            rows={2}
            value={draft.description}
            placeholder="What this demo shows, and anything to set up first."
            onChange={(e) => set('description', e.currentTarget.value)}
          />
        </Field>

        <Field label="Thumbnail" hint="Fills the card behind the text, dimmed so the text stays readable.">
          <div className="flex items-center gap-3">
            <div
              style={{ aspectRatio: CARD_ASPECT }}
              className="relative w-44 shrink-0 overflow-hidden rounded-lg border border-shell-600 bg-shell-950"
            >
              {draft.thumbnail ? (
                <>
                  <img
                    src={`thumb://${encodeURIComponent(draft.thumbnail)}`}
                    alt="Thumbnail preview"
                    className="h-full w-full object-cover"
                  />
                  <span
                    className="absolute inset-0 bg-black"
                    style={{ opacity: THUMBNAIL_DIM }}
                    aria-hidden
                  />
                </>
              ) : (
                <span className="flex h-full items-center justify-center text-[11px] text-ink-600">
                  none
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void pickThumbnail()}>
                {draft.thumbnail ? 'Replace…' : 'Choose image…'}
              </Button>
              {draft.thumbnail && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void clearThumbnail()}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        </Field>

        {draft.deviceUids.length > 0 && (
          <div className="rounded-lg border border-shell-700 bg-shell-850/60 px-3 py-2.5">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-ink-600">
              Available in the script
            </p>
            <div className="flex flex-wrap gap-1">
              {envNamesFor(draft, devices).map((name) => (
                <Badge key={name}>
                  <span className="font-mono">{name}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}

        {error && (
          <Notice tone="error" onClose={() => setError(null)}>
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}

/**
 * Variable names this selection will produce, so the user can see what to write
 * without starting the demo to find out.
 *
 * Names only — the values are the profiles' own and are already on screen in
 * Configure, and a port listed here would just go stale.
 */
function envNamesFor(draft: DemoDraft, devices: readonly DeviceProfile[]): string[] {
  const selected = draft.deviceUids
    .map((uid) => devices.find((d) => d.uid === uid))
    .filter((d): d is DeviceProfile => d !== undefined)

  const names = selected.map((_, i) => `DEMO_DEVICE_${i}_*`)
  if (selected.some((d) => d.role === 'robot')) names.push('DEMO_ROBOT_*')
  if (selected.some((d) => d.role === 'teleop')) names.push('DEMO_LEADER_*')
  names.push('DEMO_DEVICES')
  return names
}
