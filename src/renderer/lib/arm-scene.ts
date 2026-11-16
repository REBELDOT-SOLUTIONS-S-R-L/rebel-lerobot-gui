import { assetUrl } from '@shared/assets'
import type { ArmModel } from '@shared/devices'
import { BASE_YAW, SIM_MANIFESTS, type SimManifest } from '@shared/sim'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * The WebGL side of the 3D view.
 *
 * Deliberately not a React component: three.js owns a canvas, a render loop and
 * a disposable object graph, none of which fit rendering-as-a-function. The
 * panel creates one of these, calls `setPose` as readings arrive and `dispose`
 * on unmount; everything else is in here.
 *
 * The scene comes from Blender (`tools/blender/build_sim_scene.py`) as a glb
 * plus a manifest. Posing it means writing one quaternion per joint onto the
 * node the manifest names — the rig has no other moving parts.
 */

/** Seconds for a joint to cover most of the way to a new reading. */
const SMOOTHING_TAU = 0.07

/** How far in and out of the framed volume the user may zoom. */
const ZOOM_RANGE = [0.45, 3.2] as const

export type SceneTheme = 'light' | 'dark'

/**
 * Read a model's scene manifest.
 *
 * Both this and the glb come over the app's own `arm://` scheme, which serves the
 * assets folder in dev and out of `process.resourcesPath` once packaged.
 */
export async function loadSimManifest(model: ArmModel): Promise<SimManifest> {
  const url = assetUrl(SIM_MANIFESTS[model])
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return (await response.json()) as SimManifest
}

interface Joint {
  name: string
  node: THREE.Object3D
  axis: THREE.Vector3
  /** Rotation the node had at rest, which joint angles are applied on top of. */
  rest: THREE.Quaternion
  current: number
  target: number
}

/** One arm in the scene. */
interface Arm {
  manifest: SimManifest
  /** Holds the glb, and is what a pair layout turns and moves. */
  group: THREE.Group
  model: THREE.Object3D
  joints: Joint[]
}

/**
 * How the arms stand.
 *
 * `single` is the arm as the build script framed it. `pair` is a bimanual
 * station: both arms turned to reach the same way (+X, by `BASE_YAW`), the first
 * on the operator's left and the second on the right, seen from behind them —
 * so left on screen is the left arm, as it is at the bench.
 */
export type SceneLayout = 'single' | 'pair'

/**
 * Where a pair is looked at from: behind and above, a little off to the right
 * so an arm reaching away still shows its shape. Left stays on the left.
 */
const PAIR_VIEW = {
  direction: new THREE.Vector3(-1, 0.7, 0.42).normalize(),
  target: new THREE.Vector3(0.12, 0.1, 0)
}

export class ArmScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly observer: ResizeObserver
  private readonly timer = new THREE.Timer()
  private readonly spin = new THREE.Quaternion()
  /** Last size handed to the renderer, so a no-op resize is not acted on. */
  private size = { width: 0, height: 0 }

  private arms: (Arm | null)[] = []
  private layout: SceneLayout = 'single'
  /** Base-to-base distance of a pair, in metres. */
  private spacing = 0.3
  private ground: THREE.Mesh | null = null
  /** The camera has been moved by hand, so a new spacing must not snap it back. */
  private userMoved = false
  private theme: SceneTheme = 'dark'
  private dirty = true
  private disposed = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    // `preserveDrawingBuffer` because this renderer draws on demand: without it
    // the drawing buffer's contents are undefined after each composite, and any
    // frame where nothing changed can flash whatever the GPU last had there.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50)
    this.camera.position.set(0.6, 0.5, 0.75)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.enablePan = false
    // Stop the orbit at the horizon: below it you are looking up through the
    // surface the arm is standing on, which reads as a bug.
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03
    this.controls.addEventListener('change', () => (this.dirty = true))
    this.controls.addEventListener('start', () => (this.userMoved = true))

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(canvas.parentElement ?? canvas)
    this.resize()

    this.renderer.setAnimationLoop(() => this.tick())
  }

  /** Fetch and build one arm. Replaces whatever was loaded before. */
  async load(manifest: SimManifest): Promise<void> {
    await this.loadArms([manifest], 'single')
  }

  /**
   * Fetch and build several arms. A null slot leaves its place empty, so in a
   * pair the left arm stays on the left while the right one is still unchosen.
   */
  async loadArms(manifests: (SimManifest | null)[], layout: SceneLayout): Promise<void> {
    const loaded = await Promise.all(
      manifests.map((m) => (m ? new GLTFLoader().loadAsync(assetUrl(m.glb)) : Promise.resolve(null)))
    )
    if (this.disposed) return

    this.clear()
    this.layout = layout
    const first = manifests.find((m): m is SimManifest => m !== null) ?? null

    this.arms = loaded.map((gltf, index) => {
      const manifest = manifests[index]
      if (!gltf || !manifest) return null
      const group = new THREE.Group()
      group.add(gltf.scene)
      this.scene.add(group)

      gltf.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        if (object.name !== manifest.groundNode) {
          object.castShadow = true
          object.receiveShadow = true
        }
      })
      // One surface for the whole scene: the first arm's, kept at the origin
      // rather than moving with its arm.
      const ground = gltf.scene.getObjectByName(manifest.groundNode)
      if (ground instanceof THREE.Mesh) {
        if (!this.ground) {
          ground.receiveShadow = true
          this.ground = ground
          // `attach` keeps where it is in the world; the arms have not moved yet.
          this.scene.attach(ground)
        } else {
          ground.removeFromParent()
          disposeMesh(ground)
        }
      }

      const joints = manifest.joints.flatMap((joint) => {
        const node = gltf.scene.getObjectByName(joint.node)
        if (!node) {
          console.warn(`[3d] ${manifest.model}: no node '${joint.node}' for joint '${joint.name}'`)
          return []
        }
        return [
          {
            name: joint.name,
            node,
            axis: new THREE.Vector3(...joint.axis).normalize(),
            rest: node.quaternion.clone(),
            current: 0,
            target: 0
          }
        ]
      })
      return { manifest, group, model: gltf.scene, joints }
    })

    this.placeArms()
    if (first) this.addLights(first)
    this.applyTheme()
    this.userMoved = false
    this.resetView()
  }

  /**
   * Target angle per joint, in radians, for one arm (the first by default).
   *
   * Angles are eased rather than written straight through: the bus streams at
   * 10-30 Hz with a tick or two of jitter, and stepping to each reading makes a
   * still arm look like it is shivering.
   */
  setPose(pose: Record<string, number>, opts: { immediate?: boolean; arm?: number } = {}): void {
    const arm = this.arms[opts.arm ?? 0]
    if (!arm) return
    for (const joint of arm.joints) {
      const angle = pose[joint.name]
      if (typeof angle !== 'number' || Number.isNaN(angle)) continue
      joint.target = angle
      if (opts.immediate) joint.current = angle
    }
    this.dirty = true
  }

  /** Base-to-base distance of a pair, in metres. */
  setSpacing(metres: number): void {
    if (metres === this.spacing) return
    this.spacing = metres
    this.placeArms()
    // Keep both arms in frame, unless the camera has been placed by hand.
    if (this.layout === 'pair' && !this.userMoved) this.framePair()
    this.dirty = true
  }

  setTheme(theme: SceneTheme): void {
    this.theme = theme
    this.applyTheme()
  }

  /** Back to the default framing. */
  resetView(): void {
    this.userMoved = false
    if (this.layout === 'pair') {
      this.framePair()
      return
    }
    const camera = this.arms.find((a) => a)?.manifest.camera
    if (!camera) return
    this.camera.fov = camera.fov
    this.camera.position.set(...camera.position)
    this.controls.target.set(...camera.target)
    const distance = new THREE.Vector3(...camera.position).distanceTo(
      new THREE.Vector3(...camera.target)
    )
    this.controls.minDistance = distance * ZOOM_RANGE[0]
    this.controls.maxDistance = distance * ZOOM_RANGE[1]
    this.controls.update()
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }

  dispose(): void {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.observer.disconnect()
    this.timer.dispose()
    this.controls.dispose()
    this.clear()
    this.renderer.dispose()
  }

  /* -- internals ---------------------------------------------------- */

  /** Turn and space a pair; a single arm stands where the build script put it. */
  private placeArms(): void {
    this.arms.forEach((arm, index) => {
      if (!arm) return
      if (this.layout === 'single') {
        arm.group.position.set(0, 0, 0)
        arm.group.rotation.set(0, 0, 0)
        return
      }
      // glTF is Y-up; the URDF's +Y — the arm's left when it reaches along +X —
      // is glTF's -Z.
      const side = index === 0 ? -1 : 1
      arm.group.rotation.set(0, BASE_YAW[arm.manifest.model], 0)
      arm.group.position.set(0, 0, (side * this.spacing) / 2)
    })
    this.dirty = true
  }

  /** Frame a pair from behind, far enough out to see both at this spacing. */
  private framePair(): void {
    const radius = Math.max(...this.arms.map((a) => a?.manifest.camera.radius ?? 0.3))
    const fov = 38
    const halfWidth = this.spacing / 2 + radius * 1.4
    const aspect = Math.max(0.6, this.camera.aspect || 1.5)
    const vertical = (fov * Math.PI) / 360
    const distance = Math.max(
      radius * 2.6,
      halfWidth / (Math.tan(vertical) * aspect),
      (radius * 1.6) / Math.tan(vertical)
    )
    this.camera.fov = fov
    this.controls.target.copy(PAIR_VIEW.target)
    this.camera.position.copy(PAIR_VIEW.target).addScaledVector(PAIR_VIEW.direction, distance)
    this.controls.minDistance = distance * ZOOM_RANGE[0]
    this.controls.maxDistance = distance * ZOOM_RANGE[1]
    this.controls.update()
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }

  private addLights(manifest: SimManifest): void {
    const { ambient, hemisphere, key } = manifest.lighting

    this.scene.add(new THREE.AmbientLight(new THREE.Color(ambient.color), ambient.intensity))
    this.scene.add(
      new THREE.HemisphereLight(
        new THREE.Color(hemisphere.sky),
        new THREE.Color(hemisphere.ground),
        hemisphere.intensity
      )
    )

    const sun = new THREE.DirectionalLight(new THREE.Color(key.color), key.intensity)
    // The manifest gives the direction the light travels; put the lamp at the
    // other end of it, far enough out to clear the arm.
    const reach = manifest.ground.size
    sun.position.copy(new THREE.Vector3(...key.direction).normalize().multiplyScalar(-reach))
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.near = 0.01
    sun.shadow.camera.far = reach * 3
    const half = reach * 0.55
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half })
    sun.shadow.camera.updateProjectionMatrix()
    sun.shadow.bias = -0.0006
    this.scene.add(sun)
  }

  /**
   * Background and surface follow the app's theme.
   *
   * The background is read from the same `--color-plate` token the 2D arm view
   * uses, off the canvas itself — so it picks up whatever theme the subtree it
   * sits in is carrying, with no second copy of the palette here.
   */
  private applyTheme(): void {
    const token = getComputedStyle(this.canvas).getPropertyValue('--color-plate').trim()
    const fallback = this.theme === 'light' ? '#f2f5f9' : '#070a10'
    this.renderer.setClearColor(new THREE.Color(token || fallback))

    const ground = this.ground
    const manifest = this.arms.find((a) => a)?.manifest
    if (ground && manifest) {
      const colour = new THREE.Color(this.theme === 'light' ? manifest.ground.light : manifest.ground.dark)
      for (const material of Array.isArray(ground.material) ? ground.material : [ground.material]) {
        if ('color' in material) (material as THREE.MeshStandardMaterial).color.copy(colour)
      }
    }
    this.dirty = true
  }

  private resize(): void {
    const box = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect()
    const width = Math.max(1, Math.floor(box.width))
    const height = Math.max(1, Math.floor(box.height))
    // Resizing the drawing buffer can itself trip the observer; bailing out when
    // nothing changed is what stops that becoming a "ResizeObserver loop" error.
    if (width === this.size.width && height === this.size.height) return
    this.size = { width, height }
    // `updateStyle` on: the canvas gets an integer CSS size matching its drawing
    // buffer, so the scene maps 1:1 onto device pixels. A panel's height is often
    // fractional, and letting CSS stretch the buffer over it softens every edge.
    this.renderer.setSize(width, height, true)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    if (this.layout === 'pair' && !this.userMoved) this.framePair()
    this.dirty = true
  }

  private tick(): void {
    const dt = this.timer.update().getDelta()
    // 1 - e^(-dt/tau): frame-rate independent, so the easing looks the same
    // whether the display is running at 60 Hz or 120.
    const blend = 1 - Math.exp(-dt / SMOOTHING_TAU)

    for (const joint of this.arms.flatMap((arm) => arm?.joints ?? [])) {
      const delta = joint.target - joint.current
      if (Math.abs(delta) < 1e-5) {
        if (joint.current !== joint.target) {
          joint.current = joint.target
          this.writeJoint(joint)
          this.dirty = true
        }
        continue
      }
      joint.current += delta * blend
      this.writeJoint(joint)
      this.dirty = true
    }

    if (this.controls.enableDamping) this.controls.update()
    if (!this.dirty) return
    this.dirty = false
    this.renderer.render(this.scene, this.camera)
  }

  private writeJoint(joint: Joint): void {
    // Scratch quaternion rather than a fresh one per joint per frame.
    this.spin.setFromAxisAngle(joint.axis, joint.current)
    joint.node.quaternion.copy(joint.rest).multiply(this.spin)
  }

  private clear(): void {
    for (const child of [...this.scene.children]) {
      this.scene.remove(child)
      // Lights own GPU memory too: the key light's shadow map.
      if (child instanceof THREE.Light) child.dispose()
    }
    for (const arm of this.arms) {
      arm?.model.traverse((object) => {
        if (object instanceof THREE.Mesh) disposeMesh(object)
      })
    }
    if (this.ground) disposeMesh(this.ground)
    this.arms = []
    this.ground = null
  }
}

function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose()
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    material.dispose()
  }
}
