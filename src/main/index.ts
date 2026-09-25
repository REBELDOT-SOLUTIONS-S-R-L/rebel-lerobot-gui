import { BrowserWindow, app, protocol, net, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bridge } from './bridge/bridge-client'
import { registerIpc } from './ipc'
import { assetsDir, defaultCalibrationDir, isMac } from './paths'
import { runner } from './runner/process-runner'
import { isSafeName, thumbnailsDir } from './stores/demos'
import { settings } from './stores/settings'

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1560,
    height: 1000,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#0b0f16',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Keep external links out of the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * `arm://` serves the arm renders, logos and 3D scenes from the assets folder. A
 * custom scheme keeps the renderer free of `file://` access while working
 * identically in dev and once packaged (where assets live under
 * `process.resourcesPath`).
 */
function registerAssetProtocol(): void {
  protocol.handle('arm', async (request) => {
    const url = new URL(request.url)
    // For a `standard` scheme the first segment parses as the URL *host*, so
    // `arm://so101-robot.png` has it in the host and `arm://logo/mark.png` has
    // `logo` there with the rest in the path. Recombine both before validating.
    const raw = decodeURIComponent(url.host + (url.pathname === '/' ? '' : url.pathname))
    const segments = raw.split('/').filter((part) => part.length > 0)
    // Refuse anything that tries to climb out of the assets directory.
    // `@` is allowed because the brand exports are named `...@3x.png`; the set is
    // otherwise deliberately narrow, and `..` is rejected below.
    const safe = segments.length > 0 && segments.every((part) => /^[A-Za-z0-9._@-]+$/.test(part))
    if (!safe || segments.includes('..')) {
      console.error(`[arm] rejected asset request '${request.url}' -> '${raw}'`)
      return new Response('Invalid asset name', { status: 400 })
    }
    const file = join(assetsDir(), ...segments)
    if (!existsSync(file)) {
      console.error(`[arm] missing asset ${file}`)
      return new Response('Not found', { status: 404 })
    }
    const response = await net.fetch(pathToFileURL(file).toString())
    // `<img src>` needs no CORS, but the 3D view fetches its scene manifest and
    // its .glb, and those are cross-origin from the renderer (http:// in dev,
    // file:// once packaged). The scheme only ever reads inside `assets`.
    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    if (file.endsWith('.glb')) headers.set('Content-Type', 'model/gltf-binary')
    return new Response(response.body, { status: response.status, headers })
  })
}

/**
 * `thumb://` serves demo card images out of the app's own data directory.
 *
 * Separate from `arm://` because it reads somewhere else entirely: `arm://` is
 * read-only app content, while this is user data the app copies in at runtime.
 * Keeping the two scopes apart means a bug in one cannot reach the other's
 * directory.
 */
function registerThumbnailProtocol(): void {
  protocol.handle('thumb', async (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.host + (url.pathname === '/' ? '' : url.pathname))
    // Only ever names this app generated (`<uid>-<stamp>.<ext>`), so anything
    // with a separator or a dot-dot in it is a bug or an edited demos.json.
    if (!isSafeName(name)) {
      console.error(`[thumb] rejected '${request.url}'`)
      return new Response('Invalid thumbnail name', { status: 400 })
    }
    const file = join(thumbnailsDir(), name)
    if (!existsSync(file)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'arm',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  },
  {
    scheme: 'thumb',
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
])

app.whenReady().then(() => {
  registerAssetProtocol()
  registerThumbnailProtocol()
  registerIpc()

  // Make the default calibration directory real so the file dialogs can open it
  // and `--robot.calibration_dir` never points somewhere that does not exist.
  const dir = settings().get().defaultCalibrationDir || defaultCalibrationDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error(`[main] could not create ${dir}:`, err)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

/**
 * Shut hardware down deliberately: SIGINT any running lerobot process so it
 * disconnects the motors itself, and ask the bridge to close the bus so nothing
 * is left torqued.
 */
let cleanedUp = false
app.on('before-quit', (event) => {
  if (cleanedUp) return
  event.preventDefault()
  cleanedUp = true
  runner.stopAll()
  void bridge.shutdown().finally(() => {
    setTimeout(() => app.quit(), 300)
  })
})
