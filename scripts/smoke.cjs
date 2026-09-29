/**
 * Headless smoke test: `npm run smoke` (after `npm run build`).
 *
 * Boots the real main process, checks the window and preload bridge come up,
 * exercises the IPC handlers that work without hardware, and exits non-zero on
 * any failure. Useful for confirming a build on each OS before packaging.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

/** Kept in step with `VIRTUAL_UID` in src/shared/virtual.ts. */
const VIRTUAL_UID = 'virtual-arm'

// Load the app's main bundle at module scope, exactly as Electron would for the
// real entry point: it calls protocol.registerSchemesAsPrivileged, which must
// happen before `app` is ready.
let mainLoadError = null
try {
  require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
} catch (err) {
  mainLoadError = err
}

/**
 * The venv the checks below borrowed, to be put back at the end.
 *
 * Restored in `finish` rather than as soon as the bridge checks are done: the
 * renderer probe asks which panel the app opens on, and that depends on whether
 * an environment is configured.
 */
let restoreVenv
const results = []
const record = (name, ok, extra) => {
  results.push({ name, ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  :: ${extra}` : ''}`)
}

/** Call a registered ipcMain.handle channel directly, with no renderer. */
async function callIpc(channel, ...args) {
  const handlers = ipcMain._invokeHandlers
  const fn = handlers && handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for '${channel}'`)
  return fn({ sender: null }, ...args)
}

app.whenReady().then(async () => {
  if (mainLoadError) {
    record('main bundle loads', false, mainLoadError.message)
    return await finish()
  }
  record('main bundle loads', true)

  // Let the main bundle's own whenReady handler register IPC and open a window.
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const windows = BrowserWindow.getAllWindows()
  record('window created', windows.length === 1, `count=${windows.length}`)

  // --- IPC that needs no Python environment -------------------------------
  try {
    const info = await callIpc('app:info')
    record('app:info responds', info.ok === true, JSON.stringify(info.value))
    record(
      'node-pty loaded (record episode keys need it)',
      info.value.ptyAvailable === true,
      info.value.ptyError || ''
    )
  } catch (err) {
    record('app:info responds', false, err.message)
  }

  try {
    const settings = await callIpc('settings:get')
    record('settings:get responds', settings.ok === true)
  } catch (err) {
    record('settings:get responds', false, err.message)
  }

  try {
    const profiles = await callIpc('profiles:list')
    record('profiles:list responds', profiles.ok === true, `count=${(profiles.value || []).length}`)
    const virtual = (profiles.value || []).find((p) => p.uid === VIRTUAL_UID)
    record(
      'the virtual arm is offered before anything is configured',
      !!virtual && virtual.role === 'robot' && virtual.port === '',
      virtual ? `${virtual.id} ${virtual.model}` : 'not listed'
    )
  } catch (err) {
    record('profiles:list responds', false, err.message)
  }

  // --- the virtual arm ----------------------------------------------------
  // Its whole point is working with no serial port, no LeRobot and no Python, so
  // these run before any environment is configured and must still pass.
  try {
    const opened = await callIpc('bus:connect', VIRTUAL_UID)
    const snapshot = opened.ok ? opened.value : null
    record(
      'bus:connect drives the virtual arm with no environment',
      !!snapshot && snapshot.simulated === true && snapshot.motors.length === 6,
      snapshot ? `source=${snapshot.source} motors=${snapshot.motors.length}` : opened.error
    )

    const centres = {}
    for (const motor of (snapshot && snapshot.motors) || []) {
      centres[motor.name] = Math.round((motor.rangeMin + motor.rangeMax) / 2)
    }
    record(
      'the virtual arm powers up calibrated, at the middle of every range',
      Object.keys(centres).length === 6 &&
        (snapshot.motors || []).every((m) => m.online && m.position === centres[m.name]),
      (snapshot.motors || []).map((m) => `${m.name}=${m.position}`).join(' ')
    )

    const goals = {}
    for (const [name, centre] of Object.entries(centres)) goals[name] = centre + 100
    const written = await callIpc('motor:moveMany', VIRTUAL_UID, goals)
    record(
      'motor:moveMany writes a whole pose to the virtual arm',
      written.ok === true && (written.value.written || []).length === 6,
      written.ok ? written.value.written.join(',') : written.error
    )

    // The simulation travels to a goal rather than jumping to it, so give it a
    // moment and then check it actually moved.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const after = await callIpc('bus:refresh', VIRTUAL_UID)
    const moved = after.ok
      ? after.value.motors.filter((m) => m.position !== centres[m.name]).length
      : 0
    record('the virtual arm travels towards the goals it is given', moved === 6, `moved=${moved}`)

    const reset = await callIpc('virtual:reset')
    const back = await callIpc('bus:refresh', VIRTUAL_UID)
    record(
      'virtual:reset puts it back to the middle of every range',
      reset.ok === true &&
        back.ok === true &&
        back.value.motors.every((m) => m.position === centres[m.name]),
      reset.ok ? '' : reset.error
    )

    const refused = await callIpc('profiles:save', {
      uid: VIRTUAL_UID,
      id: 'virtual_arm',
      role: 'robot',
      model: 'SO101',
      port: '/dev/null',
      calibrationDir: '/tmp',
      cameras: []
    })
    record(
      'the virtual arm cannot be edited or deleted',
      refused.ok === false && (await callIpc('profiles:delete', VIRTUAL_UID)).ok === false,
      refused.error
    )
  } catch (err) {
    record('virtual arm checks', false, err.message)
  }

  // --- ROS 2 over rosbridge ----------------------------------------------
  // A stand-in rosbridge: just enough websocket server to accept the app's
  // client and collect what it sends, so the whole path — Electron's own
  // WebSocket, the publisher, the virtual arm's stream — runs for real.
  {
    const fake = await startFakeRosbridge()
    const saved = (await callIpc('settings:get')).value.rosbridgeUrl
    try {
      await callIpc('settings:set', { rosbridgeUrl: fake.url })
      const probe = await callIpc('ros:test', fake.url)
      record('ros:test reaches rosbridge', probe.ok === true && probe.value === true, probe.error)

      const snap = (await callIpc('bus:connect', VIRTUAL_UID)).value
      const ranges = {}
      for (const m of snap.motors) ranges[m.name] = { min: m.rangeMin, max: m.rangeMax }
      await callIpc('bus:streamStart', VIRTUAL_UID, 30)
      const attached = await callIpc('ros:attach', { uid: VIRTUAL_UID, mode: 'control', ranges })
      record('ros:attach starts a session', attached.ok === true, attached.error)

      // Commands made while the socket is still connecting are dropped, by design.
      await new Promise((resolve) => setTimeout(resolve, 800))
      await callIpc('motor:moveMany', VIRTUAL_UID, { elbow_flex: 2300 })
      await new Promise((resolve) => setTimeout(resolve, 800))

      const frames = fake.frames
      const published = (topic) => frames.filter((f) => f.op === 'publish' && f.topic === topic)
      const advertised = frames.filter((f) => f.op === 'advertise').map((f) => f.topic)
      record(
        'every topic is advertised under the device namespace',
        ['joint_states', 'joint_command', 'robot_description', 'diagnostics', 'session'].every((t) =>
          advertised.includes(`/virtual_arm/${t}`)
        ),
        advertised.join(', ')
      )
      const states = published('/virtual_arm/joint_states')
      const first = states[0] && states[0].msg
      record(
        'joint_states streams all six joints in radians',
        states.length >= 20 && first.name.length === 6 && first.position.every((v) => Math.abs(v) < 7),
        `messages=${states.length}`
      )
      record('joint_command follows the goals written', published('/virtual_arm/joint_command').length >= 1)
      const description = published('/virtual_arm/robot_description')[0]
      record(
        'robot_description carries the URDF with resolvable meshes',
        !!description && description.msg.data.includes('<robot') && description.msg.data.includes('file://')
      )
      record('diagnostics go out once a second', published('/virtual_arm/diagnostics').length >= 1)

      await callIpc('ros:detach', VIRTUAL_UID)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const sessions = published('/virtual_arm/session').map((f) => JSON.parse(f.msg.data).active)
      const status = (await callIpc('ros:status')).value
      record(
        'ros:detach ends the session',
        sessions.join() === 'true,false' && status.sessions.length === 0,
        `session=${sessions.join()}`
      )
    } catch (err) {
      record('ROS 2 checks', false, err.message)
    } finally {
      await callIpc('bus:streamStop', VIRTUAL_UID)
      await callIpc('settings:set', { rosbridgeUrl: saved })
      fake.close()
    }
  }

  try {
    const discovered = await callIpc('datasets:discover')
    record('datasets:discover responds', discovered.ok === true, `found=${(discovered.value || []).length}`)
  } catch (err) {
    record('datasets:discover responds', false, err.message)
  }

  // --- demos ---------------------------------------------------------------
  // A demo is created, started for real and cleaned up: it is the one feature
  // that spawns a shell, so the round trip is worth exercising headlessly.
  try {
    const listed = await callIpc('demos:list')
    record('demos:list responds', listed.ok === true, `count=${(listed.value || []).length}`)

    const uid = `d-smoke-${Date.now().toString(36)}`
    const saved = await callIpc('demos:save', {
      uid,
      name: `Smoke ${uid}`,
      deviceUids: [VIRTUAL_UID],
      script: 'echo "demo-smoke-ok"',
      description: 'Created by the smoke test.',
      thumbnail: null
    })
    record('demos:save stores a demo', saved.ok === true, saved.error)

    const nameless = await callIpc('demos:save', {
      uid: `${uid}-bad`,
      name: '   ',
      deviceUids: [],
      script: 'echo nope',
      description: '',
      thumbnail: null
    })
    record(
      'demos:save refuses a demo with no name',
      nameless.ok === false && typeof nameless.error === 'string',
      nameless.error
    )

    const started = await callIpc('demos:start', uid)
    record('demos:start spawns the script', started.ok === true, started.error || started.value?.runId)

    if (started.ok) {
      const runId = started.value.runId
      // The script is a single echo, so it is finished almost immediately; poll
      // rather than sleeping a fixed amount, which would be slower and flakier.
      let status = null
      for (let i = 0; i < 40 && status !== 'exited' && status !== 'failed'; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
        status = (await callIpc('run:get', runId)).value?.status ?? null
      }
      const log = (await callIpc('run:log', runId)).value || ''
      record('a demo runs to completion', status === 'exited', `status=${status}`)
      record('demo output reaches the console log', log.includes('demo-smoke-ok'), log.trim().slice(0, 80))
    }

    const deleted = await callIpc('demos:delete', uid)
    record(
      'demos:delete removes it again',
      deleted.ok === true && !(deleted.value || []).some((d) => d.uid === uid)
    )
  } catch (err) {
    record('demo checks', false, err.message)
  }

  // A command preview must fail *gracefully* with no environment configured,
  // rather than throwing across the IPC boundary.
  try {
    const preview = await callIpc('commands:preview', 'calibrate', { uid: 'missing' })
    record(
      'commands:preview fails gracefully without a venv',
      preview.ok === false && typeof preview.error === 'string',
      preview.error
    )
  } catch (err) {
    record('commands:preview fails gracefully without a venv', false, `threw: ${err.message}`)
  }

  // --- Python bridge (optional) -------------------------------------------
  // Point SMOKE_VENV at a virtualenv to exercise the sidecar and the capability
  // probe. Any venv with pyserial is enough for ports.list; LeRobot itself is
  // only needed for the motor calls.
  const smokeVenv = process.env.SMOKE_VENV
  if (smokeVenv) {
    try {
      const before = await callIpc('settings:get')
      restoreVenv = before.ok ? before.value.venvPath : null
      const saved = await callIpc('settings:set', { venvPath: smokeVenv })
      record('settings:set accepts a venv path', saved.ok === true, smokeVenv)

      const caps = await callIpc('lerobot:capabilities', true)
      record('lerobot:capabilities probes the venv', caps.ok === true, JSON.stringify({
        python: caps.value && caps.value.pythonVersion,
        lerobot: caps.value && caps.value.lerobotVersion,
        pyserial: caps.value && caps.value.hasPyserial,
        scripts: caps.value && caps.value.scripts.length
      }))

      const ensured = await callIpc('bridge:ensure')
      record('bridge starts inside the venv', ensured.ok === true, JSON.stringify(ensured.value || ensured.error))

      const ports = await callIpc('ports:list')
      record(
        'ports:list returns serial ports through the bridge',
        ports.ok === true && Array.isArray(ports.value),
        ports.ok ? `${ports.value.length} ports` : ports.error
      )

      const stopped = await callIpc('bridge:stop')
      record('bridge stops cleanly', stopped.ok === true)
    } catch (err) {
      record('python bridge checks', false, err.message)
    }
  } else {
    console.log('SKIP  python bridge checks (set SMOKE_VENV=<venv path> to run them)')
  }

  // --- interactive run plumbing -------------------------------------------
  // Drives a stand-in that prints the same prompts `lerobot-calibrate` does,
  // verifying the pty, unbuffered output, prompt detection and the reply path —
  // the mechanism the whole calibration flow depends on. Needs any python3.
  const fakePython = process.env.SMOKE_PYTHON || 'python3'
  const FAKE_CALIBRATE = [
    'import sys',
    'print("Move SO101Follower to the middle of its range of motion and press ENTER....", end="", flush=True)',
    'input()',
    'print()',
    'print("Move all joints except \'wrist_roll\' sequentially through their entire ranges of motion.")',
    'print("Recording positions. Press ENTER to stop...", end="", flush=True)',
    'input()',
    'print()',
    'print("Calibration saved to /tmp/smoke-fake.json")'
  ].join('\n')

  async function waitForPrompt(runId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await callIpc('run:get', runId)
      const info = res.ok ? res.value : null
      if (info && info.prompt) return info.prompt
      if (info && (info.status === 'exited' || info.status === 'failed')) return null
      await new Promise((r) => setTimeout(r, 120))
    }
    return null
  }

  async function waitForExit(runId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await callIpc('run:get', runId)
      const info = res.ok ? res.value : null
      if (info && (info.status === 'exited' || info.status === 'failed')) return info
      await new Promise((r) => setTimeout(r, 120))
    }
    return null
  }

  try {
    const started = await callIpc('run:startSpec', 'calibrate', {
      file: fakePython,
      args: ['-c', FAKE_CALIBRATE],
      display: `${fakePython} -c '<fake calibrate>'`
    })
    if (!started.ok) {
      record('interactive run starts', false, started.error)
    } else {
      const runId = started.value.runId
      record('interactive run starts', true, runId)

      const first = await waitForPrompt(runId, 12000)
      record(
        'detects the middle-of-range prompt printed without a newline',
        !!first && /middle position/i.test(first.title),
        first ? first.title : 'no prompt seen'
      )
      if (first) await callIpc('run:respond', runId, first.choices[0].send)

      const second = await waitForPrompt(runId, 12000)
      record(
        'detects the range-sweep prompt and names the full-turn joint',
        !!second && /wrist_roll/.test(second.detail),
        second ? second.title : 'no prompt seen'
      )
      if (second) await callIpc('run:respond', runId, second.choices[0].send)

      const finished = await waitForExit(runId, 12000)
      record('interactive run completes after both replies',
        !!finished && finished.status === 'exited' && finished.exitCode === 0,
        finished ? `${finished.status} code=${finished.exitCode}` : 'never exited')

      const log = await callIpc('run:log', runId)
      record('output is captured and ANSI-stripped',
        log.ok && /Calibration saved to/.test(log.value),
        log.ok ? log.value.trim().split('\n').pop() : log.error)
    }
  } catch (err) {
    record('interactive run plumbing', false, err.message)
  }

  // --- renderer ------------------------------------------------------------
  if (windows.length > 0) {
    // Attach a console listener and reload, so renderer errors are visible here
    // rather than only in devtools.
    const consoleLines = []
    windows[0].webContents.on('console-message', (event) => {
      const level = typeof event === 'object' && event !== null ? event.level : undefined
      const message = typeof event === 'object' && event !== null ? event.message : undefined
      consoleLines.push(`[${level ?? '?'}] ${message ?? ''}`)
    })
    windows[0].webContents.reload()
    await new Promise((resolve) => setTimeout(resolve, 2500))

    try {
      const probe = await windows[0].webContents.executeJavaScript(`(() => ({
        hasApi: typeof window.lerobotGui === 'object' && window.lerobotGui !== null,
        apiKeys: Object.keys(window.lerobotGui || {}),
        title: (document.querySelector('h1') || {}).textContent || null,
        tabs: Array.from(document.querySelectorAll('nav button')).map((b) => b.textContent.trim()),
        // Settings and About sit at the right of the header rather than in the
        // workflow nav, so they are collected separately.
        headerTabs: Array.from(document.querySelectorAll('header button')).map((b) =>
          b.textContent.trim()
        ),
        panelHeadings: Array.from(document.querySelectorAll('h2')).map((h) => h.textContent.trim())
      }))()`)
      record('preload bridge exposed', probe.hasApi === true, probe.apiKeys.join(','))
      record('renderer mounted', probe.title === 'LeRobot Control', `title=${probe.title}`)
      record(
        'six workflow tabs in the nav',
        probe.tabs.length === 6 &&
          probe.tabs.includes('Configure') &&
          probe.tabs.includes('3D View') &&
          probe.tabs.includes('Infer') &&
          probe.tabs.includes('Demos'),
        probe.tabs.join(' | ')
      )
      record(
        'Settings and About in the header',
        probe.headerTabs.includes('Settings') && probe.headerTabs.includes('About'),
        probe.headerTabs.join(' | ')
      )
      // With no environment configured the app should open on Settings; with one,
      // it should go straight to Configure.
      const onSettings = probe.panelHeadings.some((h) => /Python interpreter/i.test(h))
      const onConfigure = probe.panelHeadings.some((h) => /^Device$/i.test(h))
      record(
        smokeVenv ? 'lands on Configure when an environment is set' : 'lands on Settings with no environment',
        smokeVenv ? onConfigure : onSettings,
        probe.panelHeadings.join(' | ')
      )
      // The 3D view fetches its scene over `arm://`, which is cross-origin from
      // the renderer — a protocol that only serves <img> would fail silently.
      // The scenes, plus the URDFs the inverse-kinematics solver reads its joint
      // origins out of — keyboard and gamepad teleoperation cannot work without
      // them, and a protocol that only served <img> would fail silently.
      const scenes = await windows[0].webContents.executeJavaScript(`(async () => {
        const out = {}
        for (const name of [
          'simulation/generated/so100.json',
          'simulation/generated/so101.json',
          'simulation/generated/so100.glb',
          'simulation/generated/so101.glb',
          'simulation/SO100/so100.urdf',
          'simulation/SO101/so101_new_calib.urdf'
        ]) {
          try {
            const res = await fetch('arm://' + name)
            out[name] = res.ok ? (await res.arrayBuffer()).byteLength : 'HTTP ' + res.status
          } catch (err) {
            out[name] = 'threw: ' + err.message
          }
        }
        return out
      })()`)
      // A card thumbnail is an <img src="thumb://...">, so it is governed by the
      // page's img-src CSP as well as by the protocol handler. A CSP that
      // forgets the scheme blocks the image with nothing but a console warning,
      // which is exactly the failure this catches.
      try {
        const thumbDir = path.join(app.getPath('userData'), 'demo-thumbnails')
        fs.mkdirSync(thumbDir, { recursive: true })
        const thumbName = `d-smoke-thumb-${Date.now().toString(36)}.png`
        fs.copyFileSync(path.join(__dirname, '..', 'assets', 'so101-robot.png'), path.join(thumbDir, thumbName))

        const loaded = await windows[0].webContents.executeJavaScript(`(() => new Promise((resolve) => {
          const img = new Image()
          img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
          img.onerror = () => resolve({ ok: false })
          setTimeout(() => resolve({ ok: false, timedOut: true }), 4000)
          img.src = 'thumb://${thumbName}'
        }))()`)
        record(
          'thumb:// thumbnails load in the renderer',
          loaded.ok === true && loaded.w > 0,
          loaded.ok ? `${loaded.w}x${loaded.h}` : `blocked${loaded.timedOut ? ' (timed out)' : ''}`
        )
        fs.rmSync(path.join(thumbDir, thumbName), { force: true })
      } catch (err) {
        record('thumb:// thumbnails load in the renderer', false, err.message)
      }

      const sceneSizes = Object.values(scenes)
      record(
        'arm:// serves the 3D scenes and URDFs to fetch()',
        sceneSizes.length === 6 && sceneSizes.every((v) => typeof v === 'number' && v > 0),
        Object.entries(scenes)
          .map(([k, v]) => `${k.split('/').pop()}=${v}`)
          .join(' ')
      )

      const noisy = consoleLines.filter((l) => /error|warn/i.test(l))
      record('no renderer console errors', noisy.length === 0, noisy.slice(0, 6).join(' ;; '))
    } catch (err) {
      record('renderer probe', false, err.message)
    }
    if (consoleLines.length > 0) {
      console.log('\n--- renderer console ---')
      consoleLines.slice(0, 25).forEach((l) => console.log(l))
    }
  }

  await finish()
})

/**
 * The smallest websocket server that will talk to a browser-style client:
 * the handshake, and unmasking the text frames it sends. Nothing is sent back.
 */
function startFakeRosbridge() {
  const http = require('node:http')
  const crypto = require('node:crypto')
  const frames = []
  const sockets = []
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    sockets.push(socket)
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (buffer.length < offset + 4 + length) return
        const mask = buffer.subarray(offset, offset + 4)
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        buffer = buffer.subarray(offset + 4 + length)
        if (opcode === 1) frames.push(JSON.parse(payload.toString('utf8')))
        if (opcode === 8) socket.end()
      }
    })
    socket.on('error', () => undefined)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        frames,
        close: () => {
          for (const s of sockets) s.destroy()
          server.close()
        }
      })
    })
  })
}

async function finish() {
  // Never leave the user's configured environment pointing at a test venv.
  if (restoreVenv !== undefined) {
    await callIpc('settings:set', { venvPath: restoreVenv })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}
