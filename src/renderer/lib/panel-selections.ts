import type {
  EeController,
  InferOptions,
  ReplayOptions,
  TeleoperateOptions
} from '@shared/types'

/**
 * State a panel keeps when you leave it.
 *
 * Only one panel is mounted at a time, so everything a panel holds in `useState`
 * is gone the moment another tab is opened — which is right for a live device
 * reading and wrong for the choices that led to it. This is the list of things
 * that survive: which arm is selected, which controller, which dataset, which
 * episode. Anything absent from here is deliberately transient.
 *
 * A single declaration rather than a slice per panel, so what persists can be
 * read in one place and a panel gaining a field is a one-line change. Keys are
 * `<panel>.<what>`.
 */
export interface PanelSelections {
  'configure.device': string | null
  'configure.motor': string | null
  'configure.controller': EeController
  'configure.speed': number
  'view3d.device': string | null
  'view3d.controller': EeController
  'view3d.speed': number
  'teleoperate.options': TeleoperateOptions
  'teleoperate.speed': number
  'replay.options': ReplayOptions
  'infer.options': InferOptions
  'settings.extras': string
  'settings.installFromSource': boolean
  /** Publish to ROS 2 while the panel drives an arm. */
  'configure.ros': boolean
  'view3d.ros': boolean
  'teleoperate.ros': boolean
  'replay.ros': boolean
}


/**
 * Where a selection names a device.
 *
 * Listed so a deleted profile can be forgotten wherever it was selected: a
 * sticky selection outlives the panel that made it, and can therefore outlive
 * the profile it points at. Keep in step with `PanelSelections` above.
 */
const DEVICE_SELECTIONS = ['configure.device', 'view3d.device'] as const

const DEVICE_FIELDS = {
  'teleoperate.options': [
    'robotUid',
    'leaderUid',
    'leftRobotUid',
    'rightRobotUid',
    'leftLeaderUid',
    'rightLeaderUid'
  ],
  'replay.options': ['robotUid'],
  'infer.options': ['robotUid']
} as const

/** Every selection of `uid`, cleared. Returns the same object when there were none. */
export function forgetDevice(
  sticky: Partial<PanelSelections>,
  uid: string
): Partial<PanelSelections> {
  let next = sticky
  const edit = (): Partial<PanelSelections> => (next === sticky ? { ...sticky } : next)

  for (const key of DEVICE_SELECTIONS) {
    if (sticky[key] === uid) {
      next = edit()
      next[key] = null
    }
  }
  for (const [key, fields] of Object.entries(DEVICE_FIELDS) as [
    keyof typeof DEVICE_FIELDS,
    readonly string[]
  ][]) {
    const options = sticky[key] as Record<string, unknown> | undefined
    if (!options) continue
    const stale = fields.filter((field) => options[field] === uid)
    if (stale.length === 0) continue
    next = edit()
    next[key] = { ...options, ...Object.fromEntries(stale.map((f) => [f, null])) } as never
  }
  return next
}
