import type { ArmModel, DeviceRole } from '@shared/devices'
import { autoCalBody, autoCalSummary, autoCalTitle, autoCalTone } from '@shared/autocal'
import { motionBody, motionTitle, motionTone } from '@shared/motion'
import type {
  AutoCalFrame,
  BusSnapshot,
  DeviceProfile,
  MotionTestFrame,
  RunInfo
} from '@shared/types'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArmDiagram } from '../components/ArmDiagram'
import { ConsolePane } from '../components/ConsolePane'
import { MotorEditor } from '../components/MotorEditor'
import { PathPicker } from '../components/PathPicker'
import { SplitLayout } from '../components/SplitLayout'
import { PortSelect } from '../components/PortSelect'
import { TransportBar } from '../components/TransportBar'
import {
  Badge,
  Button,
  Divider,
  Field,
  Notice,
  Panel,
  Select,
  Spinner,
  TextInput
} from '../components/ui'
import { api } from '../lib/api'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/** Seconds of warning before a motion test starts driving the arm. */
const MOTION_COUNTDOWN_S = 5

/**
 * Configure: the arm view with motor indicators, plus the device profile that
 * every other panel selects from.
 *
 * A profile is (name, role, model, port, calibration folder). LeRobot addresses
 * calibration as `<calibration_dir>/<id>.json`, so choosing a folder and a name
 * here is exactly the same thing as choosing where the calibration file lives.
 */
export function ConfigurePanel(): ReactNode {
  const {
    profiles,
    settings,
    caps,
    saveProfile,
    removeProfile,
    runs,
    activeRunId,
    setActiveRun
  } = useAppStore(
    useShallow((s) => ({
      profiles: s.profiles,
      settings: s.settings,
      caps: s.caps,
      saveProfile: s.saveProfile,
      removeProfile: s.removeProfile,
      runs: s.runs,
      activeRunId: s.activeRunId,
      setActiveRun: s.setActiveRun
    })))

  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const [draft, setDraft] = useState<DeviceProfile | null>(null)
  const [snapshot, setSnapshot] = useState<BusSnapshot | null>(null)
  const [selectedMotor, setSelectedMotor] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [torqueOn, setTorqueOn] = useState(false)
  const [motion, setMotion] = useState<MotionTestFrame | null>(null)
  const [autocalArmed, setAutocalArmed] = useState(false)
  const [autocal, setAutocal] = useState<AutoCalFrame | null>(null)
  const [savingCal, setSavingCal] = useState(false)

  const run: RunInfo | null = useMemo(
    () => runs.find((r) => r.runId === activeRunId) ?? null,
    [runs, activeRunId]
  )
  const envReady = !!caps?.ok

  // Keep the draft in sync with the selected profile.
  useEffect(() => {
    const profile = profiles.find((p) => p.uid === selectedUid) ?? null
    setDraft(profile ? { ...profile } : null)
    setSnapshot(null)
    setSelectedMotor(null)
    setStreaming(false)
  }, [selectedUid, profiles])

  // Select the first profile once they load.
  useEffect(() => {
    if (!selectedUid && profiles.length > 0) setSelectedUid(profiles[0].uid)
  }, [profiles, selectedUid])

  /* -- live position stream ----------------------------------------- */

  useEffect(() => {
    if (!streaming) return
    const off = api.bridge.onNotification((frame) => {
      if (frame.type === 'streamError') {
        setActionError(String(frame.message ?? 'The position stream failed.'))
        // Transient read errors keep streaming; only a fatal one ends the thread.
        if (frame.fatal === true) setStreaming(false)
        return
      }
      if (frame.type !== 'positions') return
      const positions = frame.positions as Record<string, number>
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              motors: prev.motors.map((m) =>
                m.name in positions ? { ...m, position: positions[m.name], online: true } : m
              )
            }
          : prev
      )
    })
    return off
  }, [streaming])

  /* -- motion test -------------------------------------------------- */

  useEffect(() => {
    return api.bridge.onNotification((frame) => {
      if (frame.type !== 'motionTest') return
      setMotion(frame as unknown as MotionTestFrame)
    })
  }, [])

  useEffect(() => {
    return api.bridge.onNotification((frame) => {
      if (frame.type !== 'autoCalibration') return
      setAutocal(frame as unknown as AutoCalFrame)
    })
  }, [])

  const motionRunning =
    motion !== null && !['done', 'cancelled', 'error'].includes(motion.phase)
  const autocalRunning =
    autocal !== null && !['done', 'cancelled', 'error'].includes(autocal.phase)
  /** Either sequence has the arm; the bridge shares one thread between them. */
  const driving = motionRunning || autocalRunning

  const startAutocal = useCallback(async (): Promise<void> => {
    setActionError(null)
    setAutocalArmed(false)
    setAutocal({ phase: 'preparing' })
    const res = await api.autocal.start()
    if (!res.ok) {
      setAutocal(null)
      setActionError(res.error)
    }
  }, [])

  const stopAutocal = useCallback(async (): Promise<void> => {
    const res = await api.autocal.stop()
    if (!res.ok) setActionError(res.error)
  }, [])

  /**
   * Store what auto-calibration measured as LeRobot's own calibration file.
   *
   * Read back from the motors rather than from the discovered ranges, so the file
   * carries the ids, drive modes and homing offsets that are actually in EEPROM.
   */
  const saveCalibrationFile = useCallback(async (): Promise<void> => {
    if (!draft) return
    setSavingCal(true)
    setActionError(null)
    const read = await api.calibration.readFromMotors()
    if (!read.ok) {
      setActionError(read.error)
    } else {
      const written = await api.calibration.write(draft.uid, read.value)
      if (!written.ok) setActionError(written.error)
      else setAutocal(null)
    }
    setSavingCal(false)
    await refreshSnapshot()
  }, [draft])

  const startMotionTest = useCallback(async (): Promise<void> => {
    setActionError(null)
    // Show the countdown immediately: the first frame is a moment away, and this
    // is the point where a Cancel button has to already be on screen.
    setMotion({ phase: 'countdown', remaining: MOTION_COUNTDOWN_S })
    const res = await api.motion.start({ countdownS: MOTION_COUNTDOWN_S })
    if (!res.ok) {
      setMotion(null)
      setActionError(res.error)
    }
  }, [])

  const stopMotionTest = useCallback(async (): Promise<void> => {
    const res = await api.motion.stop()
    if (!res.ok) setActionError(res.error)
  }, [])

  // Nothing should be driving the arm once this panel is gone.
  useEffect(() => {
    return () => {
      void api.motion.stop()
      void api.autocal.stop()
    }
  }, [])

  // Stop the stream and release the bus when leaving the panel.
  useEffect(() => {
    return () => {
      void api.bus.streamStop()
      void api.bus.disconnect()
    }
  }, [])

  /* -- actions ------------------------------------------------------ */

  const connect = useCallback(async (): Promise<void> => {
    if (!draft) return
    setConnecting(true)
    setActionError(null)
    const res = await api.bus.connect(draft.uid)
    if (res.ok) {
      setSnapshot(res.value)
      if (res.value.source === 'live') {
        const started = await api.bus.streamStart(10)
        setStreaming(started.ok)
      } else {
        setStreaming(false)
      }
    } else {
      setActionError(res.error)
    }
    setConnecting(false)
  }, [draft])

  const loadOffline = useCallback(async (): Promise<void> => {
    if (!draft) return
    const res = await api.bus.offlineSnapshot(draft.uid)
    if (res.ok) setSnapshot(res.value)
    else setActionError(res.error)
  }, [draft])

  // Show the calibration-file view as soon as a profile is picked, so the diagram
  // is never empty just because the arm is unplugged. This reads a JSON file and
  // needs no Python environment, so it deliberately does not wait on envReady.
  useEffect(() => {
    if (draft && !snapshot) void loadOffline()
  }, [draft, snapshot, loadOffline])

  const disconnect = async (): Promise<void> => {
    await api.bus.streamStop()
    await api.bus.disconnect()
    setStreaming(false)
    await loadOffline()
  }

  const refreshSnapshot = async (): Promise<void> => {
    if (!draft) return
    const res = snapshot?.source === 'live' ? await api.bus.refresh(draft.uid) : await api.bus.offlineSnapshot(draft.uid)
    if (res.ok) setSnapshot(res.value)
  }

  const scanBus = async (): Promise<void> => {
    if (!draft) return
    setScanning(true)
    setScanResult(null)
    setActionError(null)
    const res = await api.bus.scan(draft.uid)
    if (res.ok) {
      const entries = Object.entries(res.value.found)
      setScanResult(
        entries.length === 0
          ? 'No motors answered on any baud rate. Check power and the cable to the first motor.'
          : entries.map(([baud, ids]) => `${baud} baud: motor IDs ${ids.join(', ')}`).join('\n')
      )
    } else {
      setActionError(res.error)
    }
    setScanning(false)
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    setSaveError(await saveProfile(draft))
  }

  const createProfile = async (role: DeviceRole): Promise<void> => {
    const base = role === 'robot' ? 'follower' : 'leader'
    const used = new Set(profiles.map((p) => p.id))
    let name = `my_${base}`
    for (let i = 2; used.has(name); i++) name = `my_${base}_${i}`

    const profile: DeviceProfile = {
      uid: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      id: name,
      role,
      model: 'SO101',
      port: '',
      calibrationDir: settings?.defaultCalibrationDir ?? '',
      cameras: []
    }
    const err = await saveProfile(profile)
    setSaveError(err)
    if (!err) setSelectedUid(profile.uid)
  }

  const startRun = async (kind: 'calibrate' | 'setup-motors'): Promise<void> => {
    if (!draft) return
    setActionError(null)
    // Calibration writes to the file we are displaying; release the bus first so
    // the CLI can open the port.
    await disconnect()
    const res = await api.runs.start(kind, { uid: draft.uid })
    if (res.ok) setActiveRun(res.value.runId)
    else setActionError(res.error)
  }

  // Reload the calibration file when a calibrate run finishes.
  useEffect(() => {
    if (run?.kind === 'calibrate' && run.status === 'exited') void loadOffline()
  }, [run?.kind, run?.status, loadOffline])

  const motor = snapshot?.motors.find((m) => m.name === selectedMotor) ?? null
  const calibrationPath = draft ? `${draft.calibrationDir}/${draft.id}.json`.replace(/\/+/g, '/') : ''

  return (
    <SplitLayout
      id="configure"
      defaultWidth={380}
      /* The arm view needs room for the render plus a callout gutter each side. */
      minMain={420}
      mainClassName="flex min-h-0 min-w-0 flex-1 flex-col"
      sideClassName="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1"
      main={
        <Panel
          className="min-h-0 flex-1"
          scrollBody
          title={draft ? `${draft.id} — ${draft.model} ${draft.role === 'robot' ? 'follower' : 'leader'}` : 'Arm view'}
          description={
            snapshot
              ? snapshot.source === 'live'
                ? `Live from ${snapshot.port}${snapshot.baudrate ? ` at ${snapshot.baudrate} baud` : ''}`
                : snapshot.source === 'calibration-file'
                  ? `From the calibration file — connect the arm for live positions`
                  : 'Factory defaults — this device has not been calibrated yet'
              : 'Select or create a device to begin'
          }
          actions={
            <div className="flex items-center gap-2">
              {draft?.role === 'robot' && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!envReady || snapshot?.source !== 'live' || motionRunning}
                  title={
                    snapshot?.source !== 'live'
                      ? 'Connect to the arm first — the test reads every joint before driving it.'
                      : 'Drive every joint through its recorded range, then return to this position.'
                  }
                  onClick={() => void startMotionTest()}
                >
                  {motionRunning ? <Spinner /> : 'Test motion'}
                </Button>
              )}
              {snapshot?.source === 'live' ? (
                <>
                  <Badge tone="live">{streaming ? 'reading positions' : 'connected'}</Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={motionRunning}
                    title={
                      motionRunning
                        ? 'The motion test is running — stop it before releasing the bus.'
                        : 'Close the serial port and go back to the calibration-file view.'
                    }
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!draft || !draft.port || connecting || !envReady}
                  title={
                    !envReady
                      ? 'Set up Python and install LeRobot in Settings first.'
                      : !draft?.port
                        ? 'Select this device’s serial port first.'
                        : 'Opens the bus and streams every motor position onto the diagram.'
                  }
                  onClick={() => void connect()}
                >
                  {connecting ? <Spinner /> : 'Read motor positions'}
                </Button>
              )}
            </div>
          }
        >
          {!draft ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm text-ink-500">No device selected.</p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void createProfile('robot')}>
                  Add a follower arm
                </Button>
                <Button variant="secondary" onClick={() => void createProfile('teleop')}>
                  Add a leader arm
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {!envReady && (
                <Notice tone="warn" title="Environment not ready">
                  Set up Python and install LeRobot in Settings before connecting to hardware.
                </Notice>
              )}
              {motion && (
                <Notice
                  tone={motionTone(motion)}
                  title={motionTitle(motion)}
                  onClose={() => setMotion(null)}
                  // No dismissing a banner that carries the only Stop button.
                  dismissible={!motionRunning}
                  actions={
                    motionRunning ? (
                      <Button size="sm" variant="secondary" onClick={() => void stopMotionTest()}>
                        {motion.phase === 'countdown' ? 'Cancel' : 'Stop'}
                      </Button>
                    ) : undefined
                  }
                >
                  {motionBody(motion)}
                </Notice>
              )}

              {autocalArmed && (
                <Notice
                  tone="warn"
                  title="Pose the arm before auto-calibration starts"
                  dismissible={false}
                  actions={
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => void startAutocal()}>
                        Continue
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setAutocalArmed(false)}>
                        Cancel
                      </Button>
                    </div>
                  }
                >
                  Move every joint by hand to roughly the middle of its travel, then press Continue. The arm
                  then takes over and drives each joint into its own end stops to measure them.
                </Notice>
              )}

              {autocal && (
                <Notice
                  tone={autoCalTone(autocal)}
                  title={autoCalTitle(autocal)}
                  onClose={() => setAutocal(null)}
                  dismissible={!autocalRunning}
                  actions={
                    autocalRunning ? (
                      <Button size="sm" variant="secondary" onClick={() => void stopAutocal()}>
                        Stop
                      </Button>
                    ) : autocal.phase === 'done' ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={savingCal}
                        title="Write these limits to this device's calibration file."
                        onClick={() => void saveCalibrationFile()}
                      >
                        {savingCal ? <Spinner /> : 'Save to calibration file'}
                      </Button>
                    ) : undefined
                  }
                >
                  {autoCalBody(autocal)}
                  {autocal.ranges && `\n${autoCalSummary(autocal.ranges)}`}
                </Notice>
              )}

              {snapshot?.warning && <Notice tone="warn">{snapshot.warning}</Notice>}
              {actionError && (
                <Notice tone="error" onClose={() => setActionError(null)}>
                  {actionError}
                </Notice>
              )}

              {snapshot && (
                <ArmDiagram
                  role={draft.role}
                  snapshot={snapshot}
                  selected={selectedMotor}
                  onSelect={setSelectedMotor}
                />
              )}
            </div>
          )}
        </Panel>
      }
      side={
        <>
          <Panel
            collapsible
            title="Device"
            actions={
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => void createProfile('robot')}>
                  + Follower
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void createProfile('teleop')}>
                  + Leader
                </Button>
              </div>
            }
          >
            <div className="flex flex-col gap-3">
              <Field label="Saved devices">
                <Select
                  value={selectedUid}
                  onChange={setSelectedUid}
                  placeholder="No devices yet"
                  options={profiles.map((p) => ({
                    value: p.uid,
                    label: `${p.id} — ${p.model} ${p.role === 'robot' ? 'follower' : 'leader'}`
                  }))}
                />
              </Field>
            </div>
          </Panel>

          {draft && (
            <Panel
              collapsible
              title="Device details"
              description={`${draft.model} ${draft.role === 'robot' ? 'follower' : 'leader'}`}
            >
              <div className="flex flex-col gap-3">
                <Field
                  label="Name"
                  hint="Used as LeRobot's --robot.id and as the calibration filename."
                  error={saveError}
                >
                  <TextInput
                    value={draft.id}
                    spellCheck={false}
                    onChange={(e) => setDraft({ ...draft, id: e.currentTarget.value })}
                  />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Type">
                    <Select
                      value={draft.role}
                      onChange={(v) => setDraft({ ...draft, role: v as DeviceRole })}
                      options={[
                        { value: 'robot', label: 'Robot (follower)' },
                        { value: 'teleop', label: 'Teleop (leader)' }
                      ]}
                    />
                  </Field>
                  <Field label="Model">
                    <Select
                      value={draft.model}
                      onChange={(v) => setDraft({ ...draft, model: v as ArmModel })}
                      options={[
                        { value: 'SO101', label: 'SO-101' },
                        { value: 'SO100', label: 'SO-100' }
                      ]}
                    />
                  </Field>
                </div>

                <Field label="Serial port">
                  <PortSelect
                    value={draft.port}
                    onChange={(port) => setDraft({ ...draft, port })}
                    onIdentify={() => {
                      void api.runs.findPort().then((res) => {
                        if (res.ok) setActiveRun(res.value.runId)
                        else setActionError(res.error)
                      })
                    }}
                  />
                </Field>

                <Field
                  label="Calibration folder"
                  hint={`Calibration is stored as ${draft.id}.json in this folder.`}
                >
                  <PathPicker
                    mode="directory"
                    title="Where should calibration files be saved?"
                    value={draft.calibrationDir}
                    onChange={(calibrationDir) => setDraft({ ...draft, calibrationDir })}
                    onReveal
                  />
                </Field>

                <Field label="…or open an existing calibration file">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void api.dialog
                        .openFile({
                          title: 'Select a calibration file',
                          defaultPath: draft.calibrationDir,
                          filters: [{ name: 'Calibration', extensions: ['json'] }]
                        })
                        .then(async (res) => {
                          if (!res.ok || !res.value) return
                          // A file path carries both halves of LeRobot's scheme:
                          // the folder becomes --calibration_dir, the stem the id.
                          const split = await api.calibration.split(res.value)
                          if (split.ok) {
                            setDraft({
                              ...draft,
                              calibrationDir: split.value.calibrationDir,
                              id: split.value.id
                            })
                          }
                        })
                    }}
                  >
                    Browse for a calibration file…
                  </Button>
                </Field>

                <div className="flex items-center gap-2">
                  <Button variant="primary" onClick={() => void saveDraft()}>
                    Save device
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void removeProfile(draft.uid).then(() => setSelectedUid(null))
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Panel>
          )}

          {draft && snapshot && (
            <Panel collapsible title="Motor">
              <MotorEditor
                motor={motor}
                snapshot={snapshot}
                port={draft.port}
                disabled={!envReady}
                onChanged={refreshSnapshot}
              />
            </Panel>
          )}

          {draft && (
            <Panel collapsible title="Calibration & motor setup">
              <div className="flex flex-col gap-3">
                <Field label="Calibration file">
                  <div className="rounded-md border border-shell-700 bg-shell-900 px-2.5 py-1.5 font-mono text-[11px] break-all text-ink-300">
                    {calibrationPath}
                  </div>
                </Field>

                <TransportBar
                  run={run?.kind === 'calibrate' ? run : null}
                  startLabel="Start calibration"
                  disabled={!envReady || !draft.port || !caps?.hasCalibrate || driving}
                  disabledReason={
                    driving
                      ? 'Wait for the arm to stop moving.'
                      : !draft.port
                      ? 'Select a serial port first.'
                      : !caps?.hasCalibrate
                        ? 'lerobot-calibrate is not installed in this environment.'
                        : null
                  }
                  onStart={() => startRun('calibrate')}
                />

                <p className="text-xs leading-relaxed text-ink-600">
                  Calibration records each joint's range of motion and its centre. Do it once per arm — and
                  again if you rebuild or re-gear a joint.
                </p>

                <Button
                  variant="secondary"
                  disabled={!envReady || snapshot?.source !== 'live' || driving || autocalArmed}
                  title={
                    snapshot?.source !== 'live'
                      ? 'Connect to the arm first — auto-calibration drives the joints itself.'
                      : 'Measure every joint by driving it into its end stops.'
                  }
                  onClick={() => setAutocalArmed(true)}
                >
                  {autocalRunning ? <Spinner /> : 'Auto-calibration'}
                </Button>

                <Divider label="Bus tools" />

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!envReady || !draft.port || scanning}
                    title="Probe every baud rate and report which motor IDs answer."
                    onClick={() => void scanBus()}
                  >
                    {scanning ? <Spinner /> : 'Scan bus'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!envReady || !draft.port || !caps?.hasSetupMotors}
                    title="Assign motor IDs one at a time, gripper first. Connect only one motor at a time."
                    onClick={() => void startRun('setup-motors')}
                  >
                    Set up motor IDs…
                  </Button>
                  {snapshot?.source === 'live' && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const next = !torqueOn
                          void api.motor.torque(next).then((res) => {
                            if (res.ok) setTorqueOn(next)
                            else setActionError(res.error)
                          })
                        }}
                      >
                        {torqueOn ? 'Disable torque' : 'Enable torque'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Writes LeRobot's recommended acceleration and return-delay settings to every motor."
                        onClick={() => {
                          void api.bus.configureMotors().then((res) => {
                            if (!res.ok) setActionError(res.error)
                          })
                        }}
                      >
                        Apply recommended settings
                      </Button>
                    </>
                  )}
                </div>

                {scanResult && (
                  <Notice tone="info" title="Bus scan" onClose={() => setScanResult(null)}>
                    {scanResult}
                  </Notice>
                )}

                {run?.kind === 'setup-motors' && (
                  <TransportBar
                    run={run}
                    startLabel="Restart motor setup"
                    onStart={() => startRun('setup-motors')}
                  />
                )}
              </div>
            </Panel>
          )}

          <ConsolePane run={run} className="shrink-0" heightClass="h-40" />
        </>
      }
    />
  )
}
