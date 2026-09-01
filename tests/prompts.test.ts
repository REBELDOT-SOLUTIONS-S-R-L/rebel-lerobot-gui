import { describe, expect, it } from 'vitest'
import { detectPrompt, stripAnsi } from '../src/main/runner/prompts'

const ESC = '\u001B'

/**
 * LeRobot's interactive prompts are printed with no trailing newline, so these
 * fixtures deliberately omit one — that is what the detector has to cope with.
 */
describe('detectPrompt', () => {
  it('recognises the reuse-or-recalibrate prompt and offers both paths', () => {
    const tail =
      "Press ENTER to use provided calibration file associated with the id my_arm, or type 'c' and press ENTER to run calibration: "
    const prompt = detectPrompt('calibrate', tail)
    expect(prompt).not.toBeNull()
    expect(prompt!.choices.map((c) => c.send)).toEqual(['c\r', '\r'])
    expect(prompt!.choices[0].label).toBe('Recalibrate')
  })

  it('recognises the middle-of-range prompt', () => {
    const prompt = detectPrompt(
      'calibrate',
      'Move SO101Follower to the middle of its range of motion and press ENTER....'
    )
    expect(prompt?.title).toMatch(/middle position/i)
    expect(prompt?.choices).toHaveLength(1)
  })

  it('names the excluded full-turn joint in the range sweep prompt', () => {
    const prompt = detectPrompt(
      'calibrate',
      "Move all joints except 'wrist_roll' sequentially through their entire ranges of motion.\nRecording positions. Press ENTER to stop..."
    )
    expect(prompt?.detail).toContain('wrist_roll')
  })

  it('names the motor to connect during the setup-motors wizard', () => {
    const prompt = detectPrompt(
      'setup-motors',
      "Connect the controller board to the 'gripper' motor only and press enter."
    )
    expect(prompt?.title).toContain('gripper')
  })

  it('does not invent prompts for non-interactive runs', () => {
    expect(detectPrompt('teleoperate', 'shoulder_pan | 12.4\nelbow_flex | -3.1')).toBeNull()
    expect(detectPrompt('replay', 'Replaying episode 0')).toBeNull()
  })

  it('falls back to a generic prompt for an unrecognised input() on interactive kinds', () => {
    const prompt = detectPrompt('calibrate', 'Some new question we have not seen yet, press enter')
    expect(prompt).not.toBeNull()
    expect(prompt!.choices[0].send).toBe('\r')
  })

  it('ignores ordinary output that merely ends in a colon on a long line', () => {
    // Long lines are log output, not prompts.
    const longLine = `INFO ${'x'.repeat(400)}:`
    expect(detectPrompt('calibrate', longLine)).toBeNull()
  })
})

describe('stripAnsi', () => {
  it('removes colour codes', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red')
  })

  it('removes the cursor-up moves the live tables use', () => {
    expect(stripAnsi(`${ESC}[3Ashoulder_pan`)).toBe('shoulder_pan')
  })

  it('removes OSC title sequences', () => {
    expect(stripAnsi(`${ESC}]0;a title\u0007done`)).toBe('done')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('Calibration saved to /tmp/x.json\n')).toBe('Calibration saved to /tmp/x.json\n')
  })

  it('lets a prompt survive stripping so detection still works', () => {
    const raw = `${ESC}[1mConnect the controller board to the 'gripper' motor only and press enter.${ESC}[0m`
    expect(detectPrompt('setup-motors', stripAnsi(raw))?.title).toContain('gripper')
  })
})
