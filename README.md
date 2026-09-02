# LeRobot Control

A cross-platform desktop app (Electron + React) for managing and controlling
[LeRobot](https://github.com/huggingface/lerobot) SO-100 / SO-101 arms.

Built by the **RebelDot Physical AI department**. MIT licensed — clone it, use
it, change it; keep the copyright notice, and say where it came from.

- Six workflow panels: **Configure**, **3D View**, **Teleoperate**, **Replay**,
  **Infer**, **Settings** — plus an About tab.
- Guided setup of a Python environment and a LeRobot install, with the version
  window LeRobot actually supports enforced up front.
- An annotated arm view with live motor positions, and per-motor editing of IDs
  and travel limits straight to EEPROM.
- A **virtual arm** that needs no hardware, no serial port and no Python: try
  every panel, fly it from the keyboard, replay a recording onto it.
- **Keyboard and gamepad teleoperation**: the keys or sticks command where the
  tool goes and the app solves the joint angles, with no extra dependencies.
- **Write a motor ID** on a live chain without unplugging the other motors.
- **Test motion** and **auto-calibration** that drive the arm themselves, with a
  cancellable warning and a Stop button that cannot be dismissed mid-move.
- A **3D view** of the selected follower, built in Blender from the official
  URDFs and posed live from the motor readings.
- Every panel shows the exact `lerobot-*` command it will run, and streams its
  output into a real terminal — interactive prompts become buttons.
- Light and dark themes, resizable columns, and per-panel layout that persists.
- Runs on macOS, Windows and Linux; installers for all three build from one
  command each.

It wraps the LeRobot CLI in six panels — Configure, 3D View, Teleoperate,
Replay, Infer and Settings — so a port, device id and calibration path are
entered once and reused everywhere, instead of being retyped into ten-flag
commands.

## Quick start

```bash
npm install          # also rebuilds node-pty for Electron
npm run dev
```

On first launch the app opens **Settings**, because nothing works until a Python
environment with LeRobot is configured. From there:

1. Pick a **Python interpreter** — 3.12 or 3.13. Anything outside that window is
   listed but flagged: older releases cannot install LeRobot, and on 3.14 every
   `lerobot-*` command aborts in its argument parser with
   `TypeError: str | None is not callable` (draccus does not support 3.14 yet).
2. Choose an **environment folder** and either *Create environment here*, or
   point at an existing venv/conda env and *Use this environment*.
3. **Install LeRobot**. The default extras are `core_scripts,feetech`:
   `core_scripts` provides record/replay/teleoperate, `feetech` is the motor SDK
   the SO arms need.
4. Check **Environment status** — it lists which `lerobot-*` commands and Python
   modules the environment actually has.

Then open **Configure**, add a follower and a leader, pick their serial ports,
and calibrate.

To look around before any of that, pick **virtual_arm** in Configure. It is a
simulated SO-101 follower that is always there: it needs no port, no calibration
and no Python environment, and it can be flown from the keyboard or a gamepad in
Teleoperate and replayed onto in Replay.

## The panels

**Configure** — the annotated arm view. Each of the six motors gets an indicator
on the render and an information card in the gutter showing its ID, live
position, travel limits, homing offset and gear ratio. Select a motor to edit its
ID and limits (written to the motor's EEPROM), run calibration, assign motor IDs
with the setup wizard, or scan the bus to see which IDs actually answer.

Three things here go beyond driving the CLI:

- **Write a motor ID** without unplugging the rest of the chain, and without a
  bus session open — pick the port, the old ID and the new one. It refuses a
  write that would collide with another motor or is a no-op, and offers a
  *force* override for when you meant it. The source ID always has to answer a
  ping first: a write to an absent ID can only ever time out.
- **Test motion** drives every joint through its recorded range and back to
  where the arm started, after a five-second cancellable warning. It refuses to
  run on an uncalibrated arm, pairs `shoulder_lift` with `elbow_flex` so the arm
  folds away from the table instead of into it, and the Stop button is on a
  banner that cannot be dismissed while the arm is moving.
- **Auto-calibration** measures the ranges itself. Pose the arm mid-travel, press
  Continue, and it drives each joint into its own end stops — detecting a stop by
  the tick no longer moving towards the commanded position — then writes the
  limits to EEPROM and parks the arm at a home pose. Cancel at any point and the
  previous limits go back. The result can be saved straight to the device's
  LeRobot calibration file.

One device is not a profile at all. **virtual_arm** is a simulated SO-101
follower, offered wherever a follower is and fixed in every respect — the name
and model are not editable, there is no port to choose, and it starts already
calibrated, with the tick ranges its URDF's joint limits work out to. Its motors
travel towards a goal rather than jumping to it, and switching its torque off
leaves it where it stands, so it behaves like an arm rather than like a slider.
Nothing about it goes through LeRobot, which is why it works on a fresh install.

With it selected, *Device details* gains a **Controller** — keyboard or gamepad —
and **Start Control** appears beside the chip in the header. Fly the arm from
this screen and the motor table and the diagram follow it, without changing tabs.
<kbd>Esc</kbd> stops control, here and anywhere else the app is driving an arm.

Every other device here is a **profile**: name, type, model, serial port,
calibration folder. The name becomes LeRobot's `--robot.id` / `--teleop.id`, and calibration
is stored as `<calibration folder>/<name>.json` — which is exactly how LeRobot
addresses it, so no copying or syncing is involved. Browsing to an existing
calibration file fills in both halves.

**3D View** — the selected follower's own model, standing on a surface, posed
from what its motors are reporting. Connect the arm and it follows every reading;
without one it sits at the pose its calibration file describes. With the virtual
arm selected it also gets a **Controller** and a **Start Control** button, which
is the easiest place to learn the keys: what you press moves the thing on screen.

The scene is built offline in Blender from the URDF and STL parts in
`assets/simulation` and shipped as a glTF binary, so the app only loads a model
and writes one rotation per joint. Ticks become angles the way LeRobot does it —
`MotorsBus._normalize` in DEGREES mode reports `(ticks - mid) * 360 / 4095`, and
`RobotKinematics.forward_kinematics` feeds exactly that into the same URDF — so
the view and `lerobot-teleoperate` describe the same arm. The gripper is the one
exception: LeRobot drives it as 0–100 % of its own travel, so its calibrated
range is stretched over the jaw's instead.

Which *way* a joint turns, and where its zero sits, is not in the URDF or the
calibration file — it depends on how the servo is keyed in. Those facts are named
in [src/shared/sim.ts](src/shared/sim.ts) (`REVERSED_JOINTS`, `JOINT_OFFSETS`,
`CONTINUOUS_JOINTS`) and each is a one-line change. `wrist_roll` needs all three
kinds of help: LeRobot calls it the `full_turn_motor` and records 0–4095 for it
without ever measuring where it stops, so its zero is wherever the wrist was
during calibration, and the URDF's limits for it describe cable length rather
than anything the encoder knows.

**Teleoperate** — drive a follower three ways.

- **Leader arm**, single or bimanual, optionally with cameras and the Rerun
  dashboard: this is `lerobot-teleoperate`, and turning on *Record* switches the
  run to `lerobot-record`. While recording, click the output pane and use
  <kbd>→</kbd>/<kbd>n</kbd> to keep an episode, <kbd>←</kbd>/<kbd>r</kbd> to redo
  it, <kbd>Esc</kbd>/<kbd>q</kbd> to finish.
- **Keyboard** — <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> and
  <kbd>R</kbd>/<kbd>F</kbd> fly the tool around, <kbd>I</kbd><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd>
  and <kbd>U</kbd>/<kbd>O</kbd> turn it, <kbd>,</kbd>/<kbd>.</kbd> work the jaws.
  Hold <kbd>Shift</kbd> for a quarter speed, press <kbd>0</kbd> to return to the
  middle of every range.
- **Gamepad** — left stick and triggers for position, right stick and d-pad for
  orientation, bumpers for the jaws. Read through the browser's own Gamepad API,
  so any controller the OS recognises works with nothing to install.

<kbd>Esc</kbd> gives up control, in this panel and in the two below that offer
it.

The last two command the tool rather than the joints: six axes for where it is
and which way it points, plus the jaws. The arm has five joints below the
gripper, so holding an orientation *and* hitting a position is generally
impossible — the solver trades a radian of orientation against two centimetres of
position, which keeps the translation keys tracking to well under a millimetre
and gives the wrist up when the two conflict. The panel shows the tool's pose,
how far the last solve fell short, and which joints are against a stop. The arm's
own model is shown alongside, following the positions it actually reports.

Both work on a real follower and on the virtual one. A real leader can also drive
the virtual follower, which is a way to check a leader arm and its calibration
with nothing else plugged in.

**Replay** — play a recorded episode back on an arm. LeRobot addresses datasets
by `repo_id` rather than path, so the panel takes a dataset folder, derives the
id, and reads `meta/info.json` to offer a real episode list. On a real follower
this is `lerobot-replay`; on the virtual one the app steps through the episode
itself, with start/pause/stop and a frame counter, and shows the model following
it.

**Infer** — run a trained policy. The command shape follows the installed
LeRobot: newer builds use `lerobot-rollout`, older ones drive the policy through
`lerobot-record` (which additionally requires an `eval_` dataset prefix, added
automatically). The panel states which path it is taking.

**Settings** — appearance, Python discovery, venv creation, LeRobot install,
installed package list, and the default calibration/dataset folders.

**About** — who made this, and what it is for.

Every panel shows the exact command it will run, with a copy button, and streams
the process output into a real terminal pane. Each two-column panel has a
draggable divider that remembers its width per panel, and the whole app follows a
light or dark theme — set explicitly, or left on *system* to follow the OS while
it runs.

Each panel also keeps its own selections while you are on another tab — the arm,
the controller, the dataset, the episode, the policy. What was *read* from a
device is not kept: a snapshot, a stream, a console are re-established on the way
back in, and control of an arm is never left running by a panel you have left.
The list of what survives is one declaration in
[src/renderer/lib/panel-selections.ts](src/renderer/lib/panel-selections.ts);
anything absent from it is deliberately transient.

## How it talks to LeRobot

Two channels, deliberately separate:

- **CLI subprocesses** for the real workflows — `lerobot-calibrate`,
  `lerobot-setup-motors`, `lerobot-teleoperate`, `lerobot-record`,
  `lerobot-replay`, `lerobot-rollout`. These run in a pty, because LeRobot draws
  live tables with ANSI cursor moves, blocks on bare `input()` prompts (which the
  app surfaces as buttons), and reads recording keys from the terminal.
  **Stop** sends `SIGINT`, never a hard kill, so LeRobot disconnects the motors
  and finalizes the dataset itself. **Pause** is `SIGSTOP`/`SIGCONT`, and is
  therefore unavailable on Windows.

- **A Python sidecar** (`resources/bridge/lerobot_gui_bridge.py`) for what the
  CLI cannot express: live motor positions, per-motor ID/limit writes, torque
  control, serial-port and camera enumeration, and reading one episode's actions
  out of a dataset. It runs inside the configured venv and speaks
  newline-delimited JSON-RPC over stdio — stdout is protocol only, all logging
  goes to stderr.

Three things the app drives itself, because no LeRobot command can:
keyboard and gamepad teleoperation, teleoperating the virtual arm, and replaying
onto it. `lerobot-teleoperate` has no device for a simulated arm, and its
keyboard and gamepad teleoperators emit three-axis position deltas that nothing
in the shipped release converts into joint angles. So the forward and inverse
kinematics are in the app, in [src/shared/kinematics.ts](src/shared/kinematics.ts):
a few hundred lines of dependency-free arithmetic over the same URDFs the 3D view
is built from, rather than LeRobot's own `RobotKinematics`, which needs a
compiled solver (`placo`) that no lerobot extra installs.

The app probes the environment rather than assuming a LeRobot version, because
the CLI surface has changed across releases (`lerobot-rollout` is new; the
calibration subdirectory was renamed when the SO arms were consolidated).

## Development

```bash
npm run dev          # run with hot reload
npm run typecheck    # main/preload and renderer projects
npm run test         # unit tests (command builders, prompts, layout, datasets)
npm run build        # bundle main, preload and renderer into out/
npm run smoke        # boot the built app headless and check IPC + renderer
npm run verify       # typecheck + test + build + smoke
npm run build:sim    # rebuild the 3D scenes (needs Blender)
```

`build:sim` is only needed after editing the URDFs or
[tools/blender/build_sim_scene.py](tools/blender/build_sim_scene.py); the built
scenes are committed, so nobody else needs Blender installed. It looks for
Blender in the usual place for the platform — set `BLENDER` to override — and
takes `--model SO101` to build just one.

`npm run smoke` optionally exercises the Python sidecar:

```bash
SMOKE_VENV=/path/to/venv npm run smoke
```

Any venv with `pyserial` is enough to test port enumeration; LeRobot itself is
only needed for the motor calls.

The most valuable tests are in [tests/commands.test.ts](tests/commands.test.ts):
they pin the draccus flag nesting against the commands published in the LeRobot
docs. A wrong flag name is the easiest way to break this app and the one class of
bug catchable without hardware attached.

## Packaging and distribution

```bash
npm run pack         # unpacked app in dist/, for checking a build quickly
npm run dist:mac     # .dmg + .zip
npm run dist:win     # NSIS .exe installer
npm run dist:linux   # .AppImage + .deb
```

Everything lands in `dist/`. All three are configured in
[electron-builder.yml](electron-builder.yml) and need no arguments.

### Build each platform on that platform

There is no reliable cross-compile here, for two reasons: `node-pty` is a native
module that has to be rebuilt against the target's Electron ABI, and the macOS
and Windows installers want their own toolchains. `npm install` runs
`electron-builder install-app-deps` for you, which rebuilds `node-pty` for
*whichever* platform you are on.

So use one machine per platform, or the included GitHub Actions workflow
([.github/workflows/build.yml](.github/workflows/build.yml)) which runs the test
suite and builds installers on `macos-latest`, `windows-latest` and
`ubuntu-latest`, then uploads them as artifacts. Trigger it from the Actions tab
or push a `v*` tag. It builds unsigned; the workflow comments say which secrets
to add to change that.

If you would rather not use CI, electron-builder can sometimes reach across:
Windows targets build on macOS/Linux with [Wine](https://www.winehq.org)
installed, and Linux targets build on macOS through Docker. Both are slower and
neither rebuilds `node-pty` for the target, so treat them as a convenience, not a
release path.

### Prerequisites

| Platform | Needs |
| --- | --- |
| all | Node `^20.19` or `>=22.12`, and a C/C++ toolchain for `node-pty` |
| macOS | Xcode command line tools (`xcode-select --install`) |
| Windows | Visual Studio Build Tools with the "Desktop development with C++" workload |
| Linux | `build-essential`, plus `libx11-dev libxkbfile-dev` for `node-pty` |

### Signing

Unsigned builds work, and are what you get by default:

- **macOS** — Gatekeeper will refuse the first launch; right-click → *Open*, or
  `xattr -dr com.apple.quarantine "/Applications/LeRobot Control.app"`. To sign,
  set `CSC_LINK` and `CSC_KEY_PASSWORD` to a Developer ID certificate; to
  notarize as well, add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID` and set `mac.notarize: true`. Set
  `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing deliberately — worth doing
  on a machine that has unrelated certificates in its keychain, which
  electron-builder may otherwise pick up.
- **Windows** — SmartScreen will warn until the installer builds reputation.
  `CSC_LINK` / `CSC_KEY_PASSWORD` work the same way for an Authenticode
  certificate.

### Icons

The builds use Electron's default icon until you add artwork. Drop a 1024×1024
`build/icon.png` in and electron-builder derives the macOS and Windows formats
from it — see [build/README.md](build/README.md).

### What ends up in the package

The `.asar` contains only `out/`, `package.json`, the licence and the production
`node_modules`; the Python bridge and `assets/` ride alongside it as unpacked
resources, because the bridge is spawned as a real file and the assets are served
over the app's `arm://` scheme. `node-pty` is unpacked too, so its native binding
can be `dlopen`'d. `env/` — the Python environment the app builds, easily 1.5 GB
— is excluded explicitly; shipping it would be both enormous and useless, since
it is full of paths and binaries for the machine that made it.

One easy saving if installer size matters: `three`, `react` and `@xterm/*` are
`dependencies`, so electron-builder copies them into the package even though vite
has already bundled them into `out/renderer`. Only `node-pty` is genuinely needed
at runtime. Moving the rest to `devDependencies` takes about 28 MB off every
installer.

### What the app still needs on the user's machine

The installer does **not** bundle Python or LeRobot. On first launch the app opens
Settings and walks the user through picking an interpreter, creating an
environment and installing LeRobot — the same flow as the Quick start above. That
is deliberate: LeRobot pulls in torch, and which build of it you want depends on
the machine.

## Platform notes

- **Linux** — serial access usually needs permission. The app detects `EACCES`
  and shows the fix (`usermod -aG dialout $USER`, or `chmod 666` on the port).
- **macOS** — enumerating cameras triggers the camera permission prompt.
  RealSense support is unstable here; the app never lets a RealSense failure
  hide the OpenCV results.
- **Windows** — Pause is disabled, since there is no `SIGSTOP` equivalent. Use
  Stop instead.

## Layout

```
resources/bridge/lerobot_gui_bridge.py   Python sidecar (JSON-RPC over stdio)
src/shared/          motor tables, IPC types, diagram geometry, joint mapping,
                     forward/inverse kinematics, the control mappings, the
                     virtual arm's identity
src/main/            Electron main: IPC, process runner, bridge client, env setup
src/preload/         the typed contextBridge API
src/renderer/        React UI — components/ and panels/
assets/              SO-101 renders, brand marks, and the simulation models
assets/simulation/   URDFs and STL parts, plus the generated/ glTF scenes
tools/blender/       the script that builds those scenes, run inside Blender
scripts/             the smoke test and the Blender build wrapper
tests/               vitest suites (node environment — no DOM)
build/               electron-builder resources; drop icons here
calibration/         default calibration folder
samples/             default dataset folder
```

Motor indicator positions live in
[src/shared/motor-layout.ts](src/shared/motor-layout.ts) as normalized
coordinates, so nudging a dot is a one-line change. The 3D view's equivalent is
the scene manifest each model is built with: it names the glTF node and rotation
axis for every joint, so [src/shared/sim.ts](src/shared/sim.ts) never has to know
what the rig looks like.

What each key and stick does is a table in
[src/shared/teleop-input.ts](src/shared/teleop-input.ts), and the on-screen
legend is rendered from it — a remapped key cannot end up documented wrong. The
kinematic chain is read from the same URDF the 3D scene was built from, so
neither view can drift from the other.

## About

**LeRobot Control** was built to make LeRobot arms quicker to get running and
easier to live with: one place to prepare the Python environment, give each arm
an identity, calibrate it, and then teleoperate, record, replay and run policies
— without assembling command lines by hand.

- **Created by** RebelDot — Physical AI department
- **Contributors** Andrei Brumboiu &lt;andrei.brumboiu@rebeldot.com&gt;
- **Built** August – September 2026
- **Built with** [Claude Code](https://claude.com/claude-code), Anthropic's
  agentic coding tool — the app was written with it, start to finish
- **Inspired by** [LeRobot](https://github.com/huggingface/lerobot), Hugging
  Face's robotics library, which does the actual driving of the arms

The same credits are in the app's **About** tab.

## Licence

MIT — see [LICENSE](LICENSE). You are free to use, copy, modify and redistribute
this, including commercially. The one condition is attribution: keep the
copyright notice and the licence text with any copy or substantial portion.

If you publish a modified version, say so and link back to this repository, so
people can tell your changes from ours. That is a request rather than a licence
term, and it costs you a sentence.

Some things in this repository are not ours to license: the SO-ARM100 URDFs and
meshes under `assets/simulation/`, LeRobot itself, and the RebelDot wordmarks
under `assets/logo/`. [NOTICE](NOTICE) says which is which — read it before
publishing a build, and swap the wordmarks for your own.
