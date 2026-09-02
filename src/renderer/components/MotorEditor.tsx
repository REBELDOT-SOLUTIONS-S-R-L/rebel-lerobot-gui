import { MAX_MOTOR_ID, STS3215_MAX_TICK, checkMotorIdWrite } from '@shared/devices'
import type { BusSnapshot, MotorState } from '@shared/types'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { Badge, Button, Field, Notice, NumberInput, Spinner, Toggle } from './ui'

/**
 * Edit one motor's identity and travel limits.
 *
 * Motor IDs and limits live in the motor's EEPROM. Writing them requires torque
 * (and the Lock register) to be off, which the bridge handles, and changing an ID
 * invalidates the bus object, which the bridge rebuilds.
 *
 * The ID write is addressed at the ID this motor answers to today, so the rest of
 * the arm can stay wired up, and it opens the port itself when nothing is
 * connected — unlike the limits, which need a live session. A duplicate ID still
 * makes the bus unusable until one of the two is moved, so that write is refused
 * until it is explicitly forced.
 */
export function MotorEditor({
  uid,
  motor,
  snapshot,
  port,
  onChanged,
  disabled
}: {
  /** Which arm's motors these writes go to — the virtual one, or a real bus. */
  uid: string
  motor: MotorState | null
  snapshot: BusSnapshot
  /** Serial port from the device profile — an ID can be written without connecting. */
  port: string
  onChanged: () => void | Promise<void>
  disabled?: boolean
}): ReactNode {
  const [idDraft, setIdDraft] = useState('')
  const [minDraft, setMinDraft] = useState('')
  const [maxDraft, setMaxDraft] = useState('')
  const [sourceDraft, setSourceDraft] = useState('')
  const [force, setForce] = useState(false)
  const [busIds, setBusIds] = useState<number[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setIdDraft(motor ? String(motor.id) : '')
    setSourceDraft(motor ? String(motor.id) : '')
    setBusIds(null)
    setMinDraft(motor?.rangeMin !== null && motor?.rangeMin !== undefined ? String(motor.rangeMin) : '')
    setMaxDraft(motor?.rangeMax !== null && motor?.rangeMax !== undefined ? String(motor.rangeMax) : '')
    setForce(false)
    setError(null)
    setWarning(null)
    setNotice(null)
  }, [motor?.name, motor?.id, motor?.rangeMin, motor?.rangeMax])

  const takenIds = useMemo(
    () => new Map(snapshot.motors.filter((m) => m.name !== motor?.name).map((m) => [m.id, m.label])),
    [snapshot.motors, motor?.name]
  )

  const idNumber = Number(idDraft)
  const sourceNumber = Number(sourceDraft)
  const sourceValid = Number.isInteger(sourceNumber) && sourceNumber >= 0 && sourceNumber <= MAX_MOTOR_ID
  const idCheck = useMemo(
    () =>
      checkMotorIdWrite({
        toId: idNumber,
        fromId: sourceNumber,
        takenBy: takenIds.get(idNumber) ?? null
      }),
    [idNumber, sourceNumber, takenIds]
  )
  /** The source has to answer: every write waits for a status packet from it. */
  const sourceMissing = busIds !== null && sourceValid && !busIds.includes(sourceNumber)

  const minNumber = Number(minDraft)
  const maxNumber = Number(maxDraft)
  const limitsError = useMemo(() => {
    if (minDraft === '' || maxDraft === '') return null
    if (!Number.isInteger(minNumber) || !Number.isInteger(maxNumber)) return 'Limits must be whole numbers.'
    if (minNumber < 0 || maxNumber > STS3215_MAX_TICK) return `Limits must sit within 0…${STS3215_MAX_TICK}.`
    if (minNumber >= maxNumber) return 'Minimum must be below maximum.'
    return null
  }, [minDraft, maxDraft, minNumber, maxNumber])

  if (!motor) {
    return (
      <p className="rounded-lg border border-dashed border-shell-700 px-3 py-6 text-center text-xs text-ink-600">
        Select a motor on the diagram to view and edit it.
      </p>
    )
  }

  const live = snapshot.source === 'live'
  const limitsChanged =
    (minDraft !== '' && minNumber !== motor.rangeMin) || (maxDraft !== '' && maxNumber !== motor.rangeMax)

  const simulated = snapshot.simulated === true
  const idBlocked =
    simulated ||
    idDraft === '' ||
    sourceDraft === '' ||
    !sourceValid ||
    idCheck.invalid ||
    (idCheck.needsForce && !force) ||
    !port ||
    !!disabled

  const checkBus = async (): Promise<void> => {
    setBusy('Check bus')
    setError(null)
    const res = await api.bus.presentIds(port)
    if (res.ok) setBusIds(res.value.ids)
    else setError(res.error)
    setBusy(null)
  }

  const writeId = async (): Promise<void> => {
    setBusy('Motor ID')
    setError(null)
    setWarning(null)
    setNotice(null)
    const res = await api.motor.writeId({
      toId: idNumber,
      fromId: sourceNumber,
      motor: motor.name,
      port,
      force: idCheck.needsForce && force
    })
    if (!res.ok) {
      setError(res.error)
    } else {
      const r = res.value
      const notes = [...r.warnings]
      if (!live) {
        notes.push(
          'The calibration file still records the old ID — connect and re-check, or re-run calibration.'
        )
      }
      setNotice(
        `ID ${r.fromId} → ${r.toId}${r.verified ? ', confirmed on the bus' : ''}. ` +
          `Answering now: ${r.presentAfter.length ? r.presentAfter.join(', ') : 'nothing'}.`
      )
      if (notes.length) setWarning(notes.join(' '))
      setBusIds(r.presentAfter)
      setSourceDraft(String(r.toId))
      setForce(false)
      await onChanged()
    }
    setBusy(null)
  }

  const act = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(label)
    setError(null)
    setNotice(null)
    const res = await fn()
    if (res.ok) {
      setNotice(`${label} written to the motor.`)
      await onChanged()
    } else {
      setError(res.error ?? 'The write failed.')
    }
    setBusy(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink-100">{motor.label}</h3>
          <Badge tone={motor.online ? 'live' : 'neutral'}>{motor.online ? 'responding' : 'offline'}</Badge>
        </div>
        <span className="font-mono text-xs text-ink-600">{motor.name}</span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-600">Position</dt>
        <dd className="font-mono tabular-nums text-ink-100">
          {motor.position ?? '—'}
          <span className="ml-1 text-ink-600">ticks</span>
        </dd>
        <dt className="text-ink-600">Homing offset</dt>
        <dd className="font-mono tabular-nums text-ink-300">{motor.homingOffset ?? '—'}</dd>
        <dt className="text-ink-600">Model</dt>
        <dd className="font-mono text-ink-300">{motor.model}</dd>
        {motor.gearRatio && (
          <>
            <dt className="text-ink-600">Gear ratio</dt>
            <dd className="font-mono text-ink-300">{motor.gearRatio}</dd>
          </>
        )}
      </dl>

      {!live && (
        <Notice tone="warn">
          Not connected, so the readings above come from the calibration file and the limits cannot be
          written. A motor ID can still be written — the port is opened just for that write.
        </Notice>
      )}

      {simulated && (
        <Notice tone="info">
          This arm is simulated, so there is no EEPROM to rewrite and no bus to ping. Its travel
          limits are editable and take effect immediately.
        </Notice>
      )}

      {!simulated && (
        <>
        <Field
          label="Motor ID"
          error={idCheck.invalid && idDraft !== '' ? idCheck.reason : null}
          hint={
            port
              ? 'Sent to the motor answering at the left ID. The rest of the arm can stay connected.'
              : 'Select the device serial port first.'
          }
        >
          <div className="flex items-center gap-2">
            <NumberInput
              value={sourceDraft}
              min={0}
              max={MAX_MOTOR_ID}
              title="ID this motor answers to today"
              disabled={disabled || !port}
              onChange={(e) => setSourceDraft(e.currentTarget.value)}
            />
            <span className="text-ink-600">→</span>
            <NumberInput
              value={idDraft}
              min={0}
              max={MAX_MOTOR_ID}
              title="New ID to write"
              disabled={disabled || !port}
              onChange={(e) => setIdDraft(e.currentTarget.value)}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={idBlocked || busy !== null}
              onClick={() => void writeId()}
            >
              {busy === 'Motor ID' ? <Spinner /> : 'Write'}
            </Button>
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || !port || busy !== null}
            title="Ping every ID on the bus. Works without connecting the arm."
            onClick={() => void checkBus()}
          >
            {busy === 'Check bus' ? <Spinner /> : 'Check which IDs answer'}
          </Button>
          {busIds !== null && (
            <span className="font-mono text-xs text-ink-500">
              {busIds.length ? `answering: ${busIds.join(', ')}` : 'nothing answered'}
            </span>
          )}
        </div>

        {sourceMissing && (
          <Notice tone="warn" onClose={() => setBusIds(null)}>
            Nothing answers at ID {sourceNumber}, so a write to it cannot get a reply.{' '}
            {busIds && busIds.length > 0
              ? 'Write to one of the IDs that did answer instead:'
              : 'Check power and the cable to the first motor.'}
            {busIds && busIds.length > 0 && (
              <span className="mt-2 flex flex-wrap gap-1.5">
                {busIds.map((id) => (
                  <Button key={id} size="sm" variant="secondary" onClick={() => setSourceDraft(String(id))}>
                    use {id}
                  </Button>
                ))}
              </span>
            )}
          </Notice>
        )}

        {idCheck.needsForce && idDraft !== '' && (
          <div className="rounded-lg border border-warn-600/50 bg-warn-600/10 px-3 py-2.5">
            <p className="text-xs leading-relaxed text-warn-400">{idCheck.reason}</p>
            <div className="mt-2">
              <Toggle
                checked={force}
                onChange={setForce}
                disabled={disabled || !port}
                label="Force this write"
                hint={
                  idNumber === sourceNumber
                    ? 'Sends the ID the motor already has — harmless, and it proves the motor is listening.'
                    : 'Sends it anyway. Two motors answering to one ID makes the bus unusable until you move the other one too.'
                }
              />
            </div>
          </div>
        )}
        </>
      )}

      <Field
        label="Travel limits (encoder ticks)"
        error={limitsError}
        hint={
          motor.name === 'wrist_roll'
            ? 'Wrist roll is a full-turn joint — LeRobot calibration always stores the whole 0…4095 span for it.'
            : `Within 0…${STS3215_MAX_TICK}.`
        }
      >
        <div className="flex items-center gap-2">
          <NumberInput
            value={minDraft}
            min={0}
            max={STS3215_MAX_TICK}
            placeholder="min"
            disabled={disabled || !live}
            onChange={(e) => setMinDraft(e.currentTarget.value)}
          />
          <span className="text-ink-600">–</span>
          <NumberInput
            value={maxDraft}
            min={0}
            max={STS3215_MAX_TICK}
            placeholder="max"
            disabled={disabled || !live}
            onChange={(e) => setMaxDraft(e.currentTarget.value)}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={disabled || !live || !!limitsError || !limitsChanged || busy !== null}
            onClick={() =>
              void act('Limits', async () => {
                const res = await api.motor.setLimits(uid, motor.name, minNumber, maxNumber)
                return { ok: res.ok, error: res.ok ? undefined : res.error }
              })
            }
          >
            {busy === 'Limits' ? <Spinner /> : 'Write'}
          </Button>
        </div>
      </Field>

      {live && motor.position !== null && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || busy !== null}
            title="Set the minimum to the joint's current position."
            onClick={() => setMinDraft(String(motor.position))}
          >
            Min = current
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || busy !== null}
            title="Set the maximum to the joint's current position."
            onClick={() => setMaxDraft(String(motor.position))}
          >
            Max = current
          </Button>
        </div>
      )}

      {error && (
        <Notice tone="error" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {warning && (
        <Notice tone="warn" onClose={() => setWarning(null)}>
          {warning}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      )}
    </div>
  )
}
