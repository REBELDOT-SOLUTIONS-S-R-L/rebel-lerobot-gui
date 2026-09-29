import { ABOUT } from '@shared/branding'
import { PYTHON_RANGE } from '@shared/devices'
import { DEFAULT_ROSBRIDGE_URL, ROS_TOPICS, type RosTopicKey } from '@shared/ros'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Panel } from '../components/ui'
import { Wordmark } from '../components/Wordmark'
import { api } from '../lib/api'

/**
 * What the app is, how to use it, who made it and how to reach them.
 *
 * One scrolling page with a jump bar rather than sub-tabs: it is read top to
 * bottom the first time and searched with the eye after that, and both want
 * everything on the page at once.
 *
 * Links go out through the shell rather than navigating the window: this is an
 * app, not a browser, and a renderer that can follow arbitrary URLs is a
 * liability the rest of the app avoids.
 */

const SECTIONS = [
  { id: 'description', label: 'Description' },
  { id: 'how-to', label: 'How to' },
  { id: 'development', label: 'Development' },
  { id: 'contact', label: 'Contact' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function AboutPanel(): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const [current, setCurrent] = useState<SectionId>('description')

  // The jump bar marks the section being read: the last one whose top has
  // scrolled up past the bar.
  useEffect(() => {
    const root = scroller.current
    if (!root) return
    const onScroll = (): void => {
      const top = root.getBoundingClientRect().top + 72
      let active: SectionId = SECTIONS[0].id
      for (const { id } of SECTIONS) {
        const el = root.querySelector(`#about-${id}`)
        if (el && el.getBoundingClientRect().top <= top) active = id
      }
      // The last section may be too short to reach the bar; the bottom of the
      // page is where it is being read.
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) active = SECTIONS[SECTIONS.length - 1].id
      setCurrent(active)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [])

  const jump = (id: SectionId): void => {
    scroller.current?.querySelector(`#about-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4 pb-6">
        <nav
          aria-label="About sections"
          className="sticky top-0 z-10 -mb-1 flex flex-wrap gap-1 rounded-xl border border-shell-700 bg-shell-900/95 p-1 backdrop-blur"
        >
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-current={current === section.id ? 'true' : undefined}
              onClick={() => jump(section.id)}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                current === section.id
                  ? 'bg-shell-800 font-semibold text-ink-100'
                  : 'text-ink-500 hover:bg-shell-850 hover:text-ink-300'
              }`}
            >
              {section.label}
            </button>
          ))}
        </nav>

        <Description />
        <HowTo />
        <Development />
        <Contact />

        <footer className="flex justify-center pt-4 pb-2">
          <LogoLink className="h-12 w-auto" />
        </footer>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Description                                                         *
 * ------------------------------------------------------------------ */

function Description(): ReactNode {
  return (
    <Section id="description">
      <Panel title={ABOUT.product} description={ABOUT.tagline}>
        <div className="flex flex-col gap-4">
          <LogoLink className="h-11 w-auto" />
          <Prose>
            <p>
              {ABOUT.product} is a desktop app for the SO-100 and SO-101 robot arms that{' '}
              <ExternalLink url={ABOUT.inspiredBy.url}>LeRobot</ExternalLink> drives. It wraps
              LeRobot’s command-line tools in one window, so an arm’s port, name and calibration are
              entered once and reused everywhere instead of being retyped into long commands.
            </p>
            <p>{ABOUT.purpose}</p>
          </Prose>
          <ul className="grid grid-cols-1 gap-2 text-sm text-ink-300 sm:grid-cols-2">
            <Feature title="Set up">
              Picks a supported Python, creates an environment and installs LeRobot for you.
            </Feature>
            <Feature title="Configure">
              A device profile per arm, a live view of every motor, IDs and limits written straight
              to the motors, and guided calibration.
            </Feature>
            <Feature title="Drive">
              Teleoperate from a leader arm, the keyboard or a gamepad, and record datasets while
              you do.
            </Feature>
            <Feature title="Replay and infer">
              Play recorded episodes back, and run trained policies on the arm.
            </Feature>
            <Feature title="Try it without hardware">
              A virtual arm that needs no port, no calibration and no Python.
            </Feature>
            <Feature title="Connect other tools">
              Publishes joint states, commands and motor health to ROS 2 for visualizers,
              simulators and digital twins.
            </Feature>
          </ul>
          <Prose>
            <p>
              Every run shows the exact <code>lerobot-*</code> command it will execute, with a copy
              button, and streams its output into a real terminal. LeRobot’s interactive prompts
              become buttons.
            </p>
          </Prose>
        </div>
      </Panel>
    </Section>
  )
}

/* ------------------------------------------------------------------ *
 * How to                                                              *
 * ------------------------------------------------------------------ */

const TOPIC_NOTES: Record<RosTopicKey, string> = {
  jointStates: 'Every joint’s angle in the URDF’s radians, at the stream rate (about 30 Hz).',
  jointCommand: 'The goal positions the app writes to the arm, in the same units.',
  robotDescription: 'The arm’s URDF, sent once, with its meshes as file:// paths.',
  diagnostics: 'Temperature, voltage, load, current and faults for each motor, once a second.',
  session: 'JSON saying what is driving the arm (control, teleoperate, replay…), and when it stops.'
}

function HowTo(): ReactNode {
  return (
    <Section id="how-to">
      <Panel title="How to" description="A short guide to the app, in the order you will need it.">
        <div className="flex flex-col gap-6">
          <Topic title="1. Set up the app and the environment">
            <Prose>
              <p>
                Nothing that talks to LeRobot works until a Python environment is set up, so on first
                launch the app opens <b>Settings</b>.
              </p>
            </Prose>
            <Steps>
              <li>
                Under <b>Python interpreter</b>, pick Python {PYTHON_RANGE}. Other versions are listed
                but flagged, because LeRobot does not run on them.
              </li>
              <li>
                Under <b>Environment</b>, choose a folder and press <b>Create environment here</b>, or
                point at an existing venv or conda env and press <b>Use this environment</b>.
              </li>
              <li>
                Under <b>Install LeRobot</b>, keep the default extras (<code>core_scripts,feetech</code>)
                and press <b>Install LeRobot</b>. Add <code>smolvla</code>, <code>pi</code> or{' '}
                <code>diffusion</code> for those policies.
              </li>
              <li>
                Check <b>Environment status</b>: it lists which LeRobot commands and Python modules the
                environment actually has.
              </li>
            </Steps>
            <Prose>
              <p>
                Also in Settings: the theme (or use the sun/moon button in the header), the default{' '}
                <b>calibration</b> and <b>dataset</b> folders the other tabs start from, and the ROS 2
                address. Column dividers in each tab can be dragged, and their widths are remembered.
                On Linux, a serial port that refuses to open usually needs{' '}
                <code>sudo usermod -aG dialout $USER</code> and a new login.
              </p>
            </Prose>
          </Topic>

          <Topic title="2. What the tabs do">
            <Terms>
              <Term name="Configure">
                Device profiles, the arm view with a card per motor, motor IDs and travel limits,
                calibration, motor setup, bus scan, motion test and auto-calibration.
              </Term>
              <Term name="3D View">The follower’s own 3D model, posed from what its motors report.</Term>
              <Term name="Teleoperate">
                Drive a follower from a leader arm, the keyboard or a gamepad, and record a dataset.
              </Term>
              <Term name="Replay">Play a recorded episode back on an arm.</Term>
              <Term name="Infer">Run a trained policy on an arm.</Term>
              <Term name="Demos">Saved scripts, one card each, run with one press.</Term>
              <Term name="Settings">Python, environment, LeRobot install, folders, theme and ROS 2.</Term>
              <Term name="About">This page.</Term>
            </Terms>
          </Topic>

          <Topic title="3. Device profiles">
            <Prose>
              <p>
                A profile is one physical arm. Create them in <b>Configure</b>: add a follower arm or a
                leader arm, fill in <b>Device details</b> and press <b>Save device</b>.
              </p>
            </Prose>
            <Terms>
              <Term name="Name">
                Passed to LeRobot as <code>--robot.id</code> or <code>--teleop.id</code>, and names the
                calibration file <code>&lt;calibration folder&gt;/&lt;name&gt;.json</code>. It is also
                the arm’s ROS 2 namespace.
              </Term>
              <Term name="Type">Follower (the arm that moves) or leader (the arm you move by hand).</Term>
              <Term name="Model">SO-100 or SO-101. Decides the motor table and the 3D model.</Term>
              <Term name="Serial port">Where the arm’s motor board is plugged in.</Term>
              <Term name="Calibration folder">
                Where its calibration file lives. <b>Browse for a calibration file…</b> fills in the
                folder and the name from an existing file.
              </Term>
            </Terms>
          </Topic>

          <Topic title="4. Choosing devices">
            <Prose>
              <p>
                Each tab has its own device pickers in its <b>Device</b> section: a follower wherever an
                arm is driven, and a leader where one drives it. Only arms of the right type are offered,
                and <b>virtual_arm</b> is always first in the follower list. Each tab remembers its
                choice while you visit other tabs, and deleting a profile clears it everywhere.
              </p>
            </Prose>
          </Topic>

          <Topic title="5. Calibrate an arm">
            <Steps>
              <li>
                New motors need IDs first. In Configure, press <b>Set up motor IDs…</b> and connect one
                motor at a time as it asks.
              </li>
              <li>
                Select the arm and press <b>Start calibration</b>. LeRobot’s prompts appear as buttons:
                move the arm to the middle of its range and continue, then sweep every joint through
                its full range and continue.
              </li>
              <li>
                The result is saved as <code>&lt;calibration folder&gt;/&lt;name&gt;.json</code>, where
                every other tab and LeRobot will find it.
              </li>
            </Steps>
            <Prose>
              <p>
                There is also <b>Auto-calibration</b>: press <b>CONNECT</b>, then{' '}
                <b>Auto-calibration</b>, pose the arm mid-travel and press <b>Continue</b>. The app
                drives each joint into its own end stops, writes the limits to the motors, and can save
                them to the calibration file. On a follower, <b>Test motion</b> then drives every joint
                through its range after a five-second warning, to check the result. Both can be stopped
                at any time.
              </p>
            </Prose>
          </Topic>

          <Topic title="6. Run something">
            <Terms>
              <Term name="Teleoperate">
                Pick the <b>Robot (follower)</b> and the <b>Leader (teleop)</b>, optionally cameras and <b>Record</b> with
                a dataset, then press <b>Start teleoperation</b> (or <b>Start recording</b>). While
                recording, click the output and use <Kbd>→</Kbd> to keep an episode, <Kbd>←</Kbd> to
                redo it and <Kbd>Esc</Kbd> to finish.
              </Term>
              <Term name="Keyboard / gamepad">
                In Teleoperate, set the controller to Keyboard or Gamepad and press{' '}
                <b>Start driving</b>. <Kbd>W</Kbd>
                <Kbd>A</Kbd>
                <Kbd>S</Kbd>
                <Kbd>D</Kbd> and <Kbd>R</Kbd>/<Kbd>F</Kbd> move the tool, <Kbd>I</Kbd>
                <Kbd>J</Kbd>
                <Kbd>K</Kbd>
                <Kbd>L</Kbd> and <Kbd>U</Kbd>/<Kbd>O</Kbd> turn it, <Kbd>,</Kbd>/<Kbd>.</Kbd> open
                and close the jaws, <Kbd>Shift</Kbd> slows down and <Kbd>0</Kbd> centres every joint.
              </Term>
              <Term name="Replay">
                Pick the arm, a dataset folder and an episode, then press <b>Start replay</b>.
              </Term>
              <Term name="Infer">
                Pick the follower, a <b>policy path or model id</b>, the task and the cameras the policy
                expects, then press <b>Start policy</b>.
              </Term>
              <Term name="Demos">
                Press <b>Add new demo</b>, give it a name, the devices it uses and a script (it runs in
                this machine’s shell, with the environment on PATH), and save. Press its card, then{' '}
                <b>Start</b>.
              </Term>
            </Terms>
            <Prose>
              <p>
                Runs are controlled from their transport bar: <b>Stop</b> asks LeRobot to finish
                cleanly, so motors are released and a recording is saved; <b>Force quit</b> does not.{' '}
                <b>Pause</b> is available on macOS and Linux.
              </p>
            </Prose>
          </Topic>

          <Topic title="7. Try it with the virtual arm">
            <Prose>
              <p>
                <b>virtual_arm</b> is a simulated SO-101 follower that is always there. It needs no
                port, no calibration and no Python environment, so it works on a fresh install.
              </p>
            </Prose>
            <Steps>
              <li>
                In <b>Configure</b> or <b>3D View</b>, select it, choose Keyboard or Gamepad, and press{' '}
                <b>Start Control</b>.
              </li>
              <li>
                In <b>Teleoperate</b>, pick it as the follower and press <b>Start driving</b>. With a
                real leader as the controller, the leader drives it, which checks a leader and its
                calibration with nothing else plugged in.
              </li>
              <li>
                In <b>Replay</b>, pick it and replay an episode onto it (reading the dataset needs the
                environment).
              </li>
            </Steps>
            <Prose>
              <p>
                <b>Reset the simulation</b> in Configure puts it back to the middle of every range.
              </p>
            </Prose>
          </Topic>

          <Topic title="8. While an arm is live">
            <Prose>
              <p>
                Whenever something is driving an arm (calibration, teleoperation, replay, inference, a
                demo or control from the app) a green border goes round the window. The other tabs are
                locked until you stop, so the Stop button is always on screen; the theme can still be
                changed. <Kbd>Esc</Kbd> stops control the app is doing itself.
              </p>
            </Prose>
          </Topic>

          <Topic title="9. Publish to ROS 2">
            <Steps>
              <li>
                Start rosbridge wherever ROS 2 runs:{' '}
                <code>ros2 launch rosbridge_server rosbridge_websocket_launch.xml</code>.
              </li>
              <li>
                In <b>Settings → ROS 2</b>, enter its address (default <code>{DEFAULT_ROSBRIDGE_URL}</code>
                ), press <b>Save</b> and <b>Test connection</b>.
              </li>
              <li>
                Turn on <b>Publish to ROS 2</b> beside the start button: Start Control in Configure and
                3D View, Start driving in Teleoperate, Start replay on the virtual arm, or the{' '}
                <b>ROS 2</b> chip beside Test motion. It publishes only while the arm is being driven,
                and the header shows <b>ROS 2 · N msg/s</b>.
              </li>
            </Steps>
            <Prose>
              <p>
                Topics are under the device’s name, made ROS-safe (<code>my-follower</code> →{' '}
                <code>/my_follower</code>):
              </p>
            </Prose>
            <div className="overflow-x-auto rounded-lg border border-shell-700">
              <table className="w-full text-left text-xs">
                <thead className="bg-shell-900 text-ink-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Topic</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">What</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-shell-700">
                  {(Object.keys(ROS_TOPICS) as RosTopicKey[]).map((key) => (
                    <tr key={key}>
                      <td className="px-3 py-2 font-mono whitespace-nowrap text-ink-100">
                        /&lt;name&gt;/{ROS_TOPICS[key].name}
                      </td>
                      <td className="px-3 py-2 font-mono whitespace-nowrap text-ink-300">
                        {ROS_TOPICS[key].type.replace('/msg/', '/')}
                        {ROS_TOPICS[key].latch ? ' (latched)' : ''}
                      </td>
                      <td className="px-3 py-2 leading-relaxed text-ink-300">{TOPIC_NOTES[key]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Prose>
              <p>
                LeRobot commands (teleoperation from a leader, recording, replay onto a real arm,
                inference and demos) hold the serial port themselves, so they do not publish yet.
              </p>
            </Prose>
          </Topic>
        </div>
      </Panel>
    </Section>
  )
}

/* ------------------------------------------------------------------ *
 * Development                                                         *
 * ------------------------------------------------------------------ */

function Development(): ReactNode {
  return (
    <Section id="development">
      <Panel title="Development" description="Who built it, with what, and how it fits together.">
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Row label="Developed by">
              {ABOUT.contributors.map((p) => p.name).join(', ')}, {ABOUT.author}
            </Row>
            <Row label="Built">{ABOUT.built}</Row>
            <Row label="Built with">
              <ExternalLink url={ABOUT.builtWith.url}>{ABOUT.builtWith.name}</ExternalLink>
              <p className="mt-0.5 text-xs text-ink-500">{ABOUT.builtWith.detail}</p>
            </Row>
            <Row label="Written by">
              <ExternalLink url={ABOUT.writtenBy.url}>{ABOUT.writtenBy.name}</ExternalLink>
              <p className="mt-0.5 text-xs text-ink-500">{ABOUT.writtenBy.detail}</p>
            </Row>
            <Row label="Inspired by">
              <ExternalLink url={ABOUT.inspiredBy.url}>{ABOUT.inspiredBy.name}</ExternalLink>
              <p className="mt-0.5 text-xs text-ink-500">{ABOUT.inspiredBy.detail}</p>
            </Row>
            <Row label="Licence">{ABOUT.licence}</Row>
          </dl>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-ink-600 uppercase">Tech stack</h3>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
              {ABOUT.stack.map((group) => (
                <div key={group.area} className="contents">
                  <dt className="text-sm text-ink-500">{group.area}</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {group.items.map((item) => (
                      <span
                        key={item}
                        className="rounded-full border border-shell-600 bg-shell-800 px-2 py-0.5 text-[11px] font-medium text-ink-300"
                      >
                        {item}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-ink-600 uppercase">How it works</h3>
            <Prose>
              <p>
                The Electron main process owns everything that touches the machine, and the React
                interface talks to it over a typed bridge. It reaches the arms in two ways:
              </p>
            </Prose>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink-300">
              <li>
                <b>LeRobot’s own commands</b> (calibrate, setup-motors, teleoperate, record, replay,
                rollout) run in a real terminal, so their live tables, prompts and recording keys work
                as they do in a shell.
              </li>
              <li>
                <b>A Python sidecar</b> inside the configured environment does what the commands cannot:
                live motor positions, ID and limit writes, torque, port and camera discovery, and
                reading episodes out of datasets.
              </li>
            </ul>
            <Prose>
              <p>
                Keyboard and gamepad driving, the virtual arm and ROS 2 publishing are the app’s own:
                the kinematics are solved in TypeScript over the same URDFs the 3D scenes are built from
                in Blender, and ROS 2 messages go out through rosbridge, so ROS need not be installed
                beside the app.
              </p>
            </Prose>
          </div>
        </div>
      </Panel>
    </Section>
  )
}

/* ------------------------------------------------------------------ *
 * Contact                                                             *
 * ------------------------------------------------------------------ */

function Contact(): ReactNode {
  return (
    <Section id="contact">
      <Panel title="Contact" description="Questions, bugs and ideas are welcome.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {ABOUT.contributors.map((person) => (
            <Card key={person.email} kicker="Developer" title={person.name}>
              <ExternalLink url={`mailto:${person.email}`}>{person.email}</ExternalLink>
            </Card>
          ))}
          <Card kicker="Company" title={ABOUT.company.name}>
            <p className="text-ink-300">{ABOUT.company.department}</p>
            <ExternalLink url={ABOUT.company.url}>{ABOUT.company.url.replace(/^https?:\/\//, '')}</ExternalLink>
          </Card>
        </div>
      </Panel>
    </Section>
  )
}

/* ------------------------------------------------------------------ *
 * Pieces                                                              *
 * ------------------------------------------------------------------ */

/** A jump target; the margin keeps its top clear of the sticky bar. */
function Section({ id, children }: { id: SectionId; children: ReactNode }): ReactNode {
  return (
    <section id={`about-${id}`} className="scroll-mt-14">
      {children}
    </section>
  )
}

function Topic({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
      {children}
    </div>
  )
}

function Prose({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-col gap-2 text-sm leading-relaxed text-ink-300">{children}</div>
}

function Steps({ children }: { children: ReactNode }): ReactNode {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink-300 marker:text-ink-600">
      {children}
    </ol>
  )
}

function Terms({ children }: { children: ReactNode }): ReactNode {
  return (
    <dl className="grid grid-cols-1 gap-x-5 gap-y-2 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">{children}</dl>
  )
}

function Term({ name, children }: { name: string; children: ReactNode }): ReactNode {
  return (
    <>
      <dt className="font-medium text-ink-100">{name}</dt>
      <dd className="leading-relaxed text-ink-300">{children}</dd>
    </>
  )
}

function Feature({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <li className="rounded-lg border border-shell-700 bg-shell-900 px-3 py-2.5">
      <p className="text-sm font-medium text-ink-100">{title}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{children}</p>
    </li>
  )
}

function Card({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-shell-700 bg-shell-900 px-4 py-3 text-sm">
      <p className="text-[11px] font-semibold tracking-wide text-ink-600 uppercase">{kicker}</p>
      <p className="font-semibold text-ink-100">{title}</p>
      {children}
    </div>
  )
}

function Kbd({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="mx-px inline-block min-w-[1.4em] rounded border border-shell-600 border-b-2 bg-shell-800 px-1 text-center font-mono text-[11px] text-ink-100">
      {children}
    </kbd>
  )
}

/** The RebelDot lock-up, opening the company's website. */
function LogoLink({ className }: { className: string }): ReactNode {
  const site = ABOUT.company.url.replace(/^https?:\/\//, '')
  return (
    <button
      type="button"
      title={`Open ${site}`}
      aria-label={`${ABOUT.company.name} — open ${site}`}
      onClick={() => void api.shell.openExternal(ABOUT.company.url)}
      className="self-start rounded-md opacity-100 transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-500"
    >
      <Wordmark tagline className={className} />
    </button>
  )
}

function ExternalLink({ url, children }: { url: string; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      className="self-start text-left text-accent-400 underline-offset-2 hover:underline"
      onClick={() => void api.shell.openExternal(url)}
    >
      {children}
    </button>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <>
      <dt className="text-xs font-semibold tracking-wide text-ink-600 uppercase sm:pt-0.5">{label}</dt>
      <dd className="text-sm text-ink-100">{children}</dd>
    </>
  )
}
