/**
 * Headless smoke test: `npm run smoke` (after `npm run build`).
 *
 * Boots the real main process, checks the window and preload bridge come up,
 * exercises the IPC handlers that work without hardware, and exits non-zero on
 * any failure. Useful for confirming a build on each OS before packaging.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

// Load the app's main bundle at module scope, exactly as Electron would for the
// real entry point: it calls protocol.registerSchemesAsPrivileged, which must
// happen before `app` is ready.
let mainLoadError = null
try {
  require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
} catch (err) {
  mainLoadError = err
}

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
    return finish()
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
  } catch (err) {
    record('profiles:list responds', false, err.message)
  }

  try {
    const discovered = await callIpc('datasets:discover')
    record('datasets:discover responds', discovered.ok === true, `found=${(discovered.value || []).length}`)
  } catch (err) {
    record('datasets:discover responds', false, err.message)
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
  let previousVenv
  if (smokeVenv) {
    try {
      const before = await callIpc('settings:get')
      previousVenv = before.ok ? before.value.venvPath : null
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
    } finally {
      // Never leave the user's configured environment pointing at a test venv.
      if (previousVenv !== undefined) {
        await callIpc('settings:set', { venvPath: previousVenv })
      }
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
        'five workflow tabs in the nav',
        probe.tabs.length === 5 &&
          probe.tabs.includes('Configure') &&
          probe.tabs.includes('3D View') &&
          probe.tabs.includes('Infer'),
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
      const scenes = await windows[0].webContents.executeJavaScript(`(async () => {
        const out = {}
        for (const name of [
          'simulation/generated/so100.json',
          'simulation/generated/so101.json',
          'simulation/generated/so100.glb',
          'simulation/generated/so101.glb'
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
      const sceneSizes = Object.values(scenes)
      record(
        'arm:// serves the 3D scenes to fetch()',
        sceneSizes.length === 4 && sceneSizes.every((v) => typeof v === 'number' && v > 0),
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

  finish()
})

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}
