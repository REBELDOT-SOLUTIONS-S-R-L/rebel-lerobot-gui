import type { PromptInfo, RunKind } from '@shared/types'

/**
 * `lerobot-find-port`, `lerobot-calibrate` and `lerobot-setup-motors` block on
 * bare `input()`. The prompts are printed WITHOUT a trailing newline, so match
 * on substrings of the accumulated tail rather than on whole lines.
 *
 * Each rule turns a raw prompt into something a user can act on from the GUI.
 */
interface PromptRule {
  kinds: RunKind[]
  match: RegExp
  build: (m: RegExpMatchArray) => Omit<PromptInfo, 'raw'>
}

const CONTINUE = { label: 'Continue', send: '\r', primary: true }

const RULES: PromptRule[] = [
  {
    // so_follower.py:111-118 — offers to reuse the existing calibration file.
    kinds: ['calibrate'],
    match: /type\s+'c'\s+and\s+press\s+ENTER\s+to\s+run\s+calibration/i,
    build: () => ({
      title: 'A calibration file already exists',
      detail: 'Recalibrate from scratch, or keep the existing file for this device id and continue.',
      choices: [
        { label: 'Recalibrate', send: 'c\r', primary: true },
        { label: 'Keep existing file', send: '\r' }
      ]
    })
  },
  {
    kinds: ['calibrate'],
    match: /Move\s+(.+?)\s+to\s+the\s+middle\s+of\s+its\s+range\s+of\s+motion/i,
    build: () => ({
      title: 'Move the arm to its middle position',
      detail:
        'Put every joint roughly in the centre of its travel, then continue. This becomes the homing offset.',
      choices: [CONTINUE]
    })
  },
  {
    kinds: ['calibrate'],
    match: /Move\s+all\s+joints\s+except\s+'([^']+)'\s+sequentially\s+through\s+their\s+entire\s+ranges/i,
    build: (m) => ({
      title: 'Sweep every joint through its full range',
      detail:
        `Move each joint slowly to both extremes — all of them except '${m[1]}', which is a full-turn ` +
        'joint and is recorded as the whole encoder span. Continue when done.',
      choices: [{ label: 'Done sweeping', send: '\r', primary: true }]
    })
  },
  {
    // so_follower.py:171-175 — the gripper -> shoulder_pan wizard.
    kinds: ['setup-motors'],
    match: /Connect\s+the\s+controller\s+board\s+to\s+the\s+'([^']+)'\s+motor\s+only\s+and\s+press\s+enter/i,
    build: (m) => ({
      title: `Connect only the '${m[1]}' motor`,
      detail:
        `Plug the 3-pin cable from the controller board into the '${m[1]}' motor and nothing else — ` +
        'it must not be daisy-chained to another motor yet. Check the power supply is still connected, ' +
        'then continue.',
      choices: [CONTINUE]
    })
  },
  {
    kinds: ['calibrate', 'setup-motors', 'teleoperate', 'record', 'replay', 'infer'],
    match: /Remove\s+the\s+USB\s+cable\s+from\s+your\s+MotorsBus\s+and\s+press\s+Enter/i,
    build: () => ({
      title: 'Unplug the USB cable',
      detail:
        'Disconnect the arm you want to identify, then continue. The port that disappears is its port.',
      choices: [CONTINUE]
    })
  }
]

/**
 * Generic fallback so an unrecognised `input()` cannot hang the UI silently.
 * Only consulted for the kinds we know are interactive.
 */
const GENERIC = /(press\s+enter[^\n]*|\?\s*$|:\s*$)/i

export function detectPrompt(kind: RunKind, tail: string): PromptInfo | null {
  for (const rule of RULES) {
    if (!rule.kinds.includes(kind)) continue
    const m = rule.match.exec(tail)
    if (m) return { raw: m[0], ...rule.build(m) }
  }

  if (kind !== 'calibrate' && kind !== 'setup-motors') return null
  const lastLine = tail.split(/\r?\n/).filter((l) => l.trim().length > 0).pop() ?? ''
  if (lastLine.length > 0 && lastLine.length < 300 && GENERIC.test(lastLine)) {
    return {
      raw: lastLine,
      title: 'LeRobot is waiting for input',
      detail: lastLine.trim(),
      choices: [CONTINUE]
    }
  }
  return null
}

const ESC = '\u001B'
// CSI sequences (colours, and the cursor-up moves the live tables use).
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
// OSC sequences, terminated by BEL or ST.
const OSC_RE = new RegExp(`${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`, 'g')
// Two-character escapes such as ESC( or ESC=.
const SHORT_RE = new RegExp(`${ESC}[@-Z\\\\-_()#=>]`, 'g')

/** Strip ANSI so prompt matching and log copying are not defeated by escapes. */
export function stripAnsi(input: string): string {
  return input.replace(OSC_RE, '').replace(CSI_RE, '').replace(SHORT_RE, '')
}
