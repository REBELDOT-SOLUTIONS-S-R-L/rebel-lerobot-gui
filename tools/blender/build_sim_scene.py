"""
Build the 3D scene the app's "3D View" panel renders, using Blender.

Blender is the authoring tool: this script runs inside it, assembles the arm from
the URDF and its STL parts, rigs it so one node per joint is all the viewer has
to rotate, adds the surface and the lighting, and exports a glTF binary plus a
small JSON manifest describing what it built.

    blender --background --python tools/blender/build_sim_scene.py -- --model SO101

Both models are built by `npm run build:sim`. The outputs are committed, so the
app never needs Blender at run time — only when the URDFs or the look change.

Why the rig looks the way it does
---------------------------------
URDF places a child link at `parent * origin * R(axis, q)`: the joint rotation
happens *after* the fixed origin offset. A glTF node has a single TRS, so the two
cannot share one node, and each joint becomes a pair:

    link__<parent>  ->  origin__<joint>  ->  joint__<joint>  ->  link__<child>
                        (fixed offset)      (rotates, identity at rest)

The viewer therefore only ever writes `joint__<name>.quaternion`, from the axis
in the manifest. Nothing else in the hierarchy moves.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector

# --------------------------------------------------------------------------- #
# Look of the scene. These constants build the Blender lamps *and* are written
# to the manifest, so the .blend you can open and the viewer agree.
# --------------------------------------------------------------------------- #

#: Even, shadowless fill — the "ambient lighting" the scene is lit with.
#: Intensities are the viewer's (three.js multipliers); `build_lighting` scales
#: them into Blender's own units so the .blend and the app agree.
AMBIENT = {"color": "#ffffff", "intensity": 0.8}
#: Sky/ground tint on top of the fill, so up-facing surfaces read as up-facing.
HEMISPHERE = {"sky": "#eaf2ff", "ground": "#4a4a52", "intensity": 0.6}
#: One soft key, only to give the parts an edge. Direction points *at* the arm.
KEY_LIGHT = {"color": "#fff6e8", "intensity": 1.4, "direction": [-0.45, -1.0, -0.55]}

#: The surface. Grey enough to sit under either app theme; the viewer nudges it.
GROUND = {"size": 1.1, "color": "#8d939c", "light": "#c9ced6", "dark": "#2c333e"}

#: Per-mesh triangle ceiling. The STLs are print-quality (up to 54k triangles a
#: part); a GUI viewport does not need that, and the download does not want it.
TRIANGLE_BUDGET = 5000
#: Weld radius, in metres. STL stores every triangle's corners separately, so
#: welding first both shrinks the file and lets the decimator see real topology.
WELD_DISTANCE = 1e-5
#: Faces meeting at a sharper angle than this keep a hard edge when smoothed.
SMOOTH_ANGLE = math.radians(35)

#: Share of the arm's full reach the default camera frames. See `build_camera`.
FRAME_FRACTION = 0.75

MODELS = {
    "SO101": {"urdf": "assets/simulation/SO101/so101_new_calib.urdf", "out": "so101"},
    "SO100": {"urdf": "assets/simulation/SO100/so100.urdf", "out": "so100"},
}

#: Where the built scenes land, and the same path as the app's `arm://` root sees it.
ASSET_DIR = "simulation/generated"
OUT_DIR = f"assets/{ASSET_DIR}"


# --------------------------------------------------------------------------- #
# URDF
# --------------------------------------------------------------------------- #


@dataclass
class Visual:
    mesh: Path
    origin: Matrix
    material: str | None
    scale: Vector


@dataclass
class Link:
    name: str
    visuals: list[Visual] = field(default_factory=list)


@dataclass
class Joint:
    name: str
    type: str
    parent: str
    child: str
    origin: Matrix
    axis: Vector
    lower: float
    upper: float

    @property
    def movable(self) -> bool:
        return self.type in ("revolute", "continuous", "prismatic")


@dataclass
class Robot:
    name: str
    links: dict[str, Link]
    joints: list[Joint]
    materials: dict[str, tuple[float, float, float, float]]

    @property
    def root(self) -> str:
        children = {j.child for j in self.joints}
        roots = [name for name in self.links if name not in children]
        if len(roots) != 1:
            raise SystemExit(f"expected exactly one root link, found {roots}")
        return roots[0]

    def children_of(self, link: str) -> list[Joint]:
        return [j for j in self.joints if j.parent == link]


def _floats(text: str | None, default: tuple[float, ...]) -> tuple[float, ...]:
    if not text:
        return default
    return tuple(float(part) for part in text.split())


def _origin(node: ET.Element | None) -> Matrix:
    """URDF `<origin xyz rpy>` as a 4x4. `rpy` is fixed-axis roll-pitch-yaw, i.e.
    Rz(yaw) @ Ry(pitch) @ Rx(roll) — which is exactly Blender's 'XYZ' euler."""
    if node is None:
        return Matrix.Identity(4)
    xyz = _floats(node.get("xyz"), (0.0, 0.0, 0.0))
    rpy = _floats(node.get("rpy"), (0.0, 0.0, 0.0))
    return Matrix.Translation(Vector(xyz)) @ Euler(rpy, "XYZ").to_matrix().to_4x4()


def parse_urdf(path: Path) -> Robot:
    root = ET.parse(path).getroot()
    base = path.parent

    materials: dict[str, tuple[float, float, float, float]] = {}
    for mat in root.findall("material"):
        name = mat.get("name")
        colour = mat.find("color")
        if name and colour is not None:
            rgba = _floats(colour.get("rgba"), (0.8, 0.8, 0.8, 1.0))
            materials[name] = (rgba + (1.0,))[:4]  # type: ignore[assignment]

    links: dict[str, Link] = {}
    for link_el in root.findall("link"):
        name = link_el.get("name")
        if not name:
            continue
        link = Link(name)
        for visual in link_el.findall("visual"):
            mesh_el = visual.find("geometry/mesh")
            if mesh_el is None:
                continue  # primitives are not used by these URDFs
            filename = mesh_el.get("filename") or ""
            # `package://` prefixes appear in ROS-flavoured URDFs; strip and
            # resolve relative to the URDF, which is how these ship.
            filename = filename.split("package://", 1)[-1]
            mat_el = visual.find("material")
            link.visuals.append(
                Visual(
                    mesh=(base / filename).resolve(),
                    origin=_origin(visual.find("origin")),
                    material=mat_el.get("name") if mat_el is not None else None,
                    scale=Vector(_floats(mesh_el.get("scale"), (1.0, 1.0, 1.0))),
                )
            )
        links[name] = link

    joints: list[Joint] = []
    for joint_el in root.findall("joint"):
        name, parent_el, child_el = (
            joint_el.get("name"),
            joint_el.find("parent"),
            joint_el.find("child"),
        )
        if not name or parent_el is None or child_el is None:
            continue
        limit = joint_el.find("limit")
        axis = Vector(_floats(joint_el.find("axis").get("xyz") if joint_el.find("axis") is not None else None, (0.0, 0.0, 1.0)))
        joints.append(
            Joint(
                name=name,
                type=joint_el.get("type", "fixed"),
                parent=parent_el.get("link", ""),
                child=child_el.get("link", ""),
                origin=_origin(joint_el.find("origin")),
                axis=axis if axis.length > 0 else Vector((0.0, 0.0, 1.0)),
                lower=float(limit.get("lower", 0.0)) if limit is not None else 0.0,
                upper=float(limit.get("upper", 0.0)) if limit is not None else 0.0,
            )
        )

    return Robot(root.get("name", "robot"), links, joints, materials)


# --------------------------------------------------------------------------- #
# Blender helpers
# --------------------------------------------------------------------------- #


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"


def call_filtered(op, **kwargs):
    """Run an operator with only the keywords this Blender actually has.

    The glTF exporter's option set moves between releases; dropping unknown keys
    keeps the script working instead of failing on a renamed flag. The property
    list comes from `get_rna_type()` rather than `bpy.types.<OP>.bl_rna`, which
    is empty for operators an add-on registers.
    """
    known = {prop.identifier for prop in op.get_rna_type().properties}
    unknown = sorted(set(kwargs) - known)
    if unknown:
        print(f"[build-sim] ignoring unsupported options: {', '.join(unknown)}")
    return op(**{k: v for k, v in kwargs.items() if k in known})


def new_empty(name: str, parent: bpy.types.Object | None, matrix: Matrix) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.02
    bpy.context.collection.objects.link(obj)
    attach(obj, parent, matrix)
    return obj


def attach(obj: bpy.types.Object, parent: bpy.types.Object | None, matrix: Matrix) -> None:
    """Parent without Blender's implicit `parent_inverse`, so the object's local
    matrix is exactly the URDF transform and the exported node matches."""
    obj.parent = parent
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_basis = matrix


def hex_to_linear(value: str) -> tuple[float, float, float]:
    """sRGB hex to the linear floats Blender's colour sockets expect."""
    value = value.lstrip("#")
    srgb = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(  # type: ignore[return-value]
        c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb
    )


def material(name: str, rgba: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = rgba
    return mat


def import_stl(path: Path) -> bpy.types.Mesh:
    """Import one STL and return its (cleaned up, decimated) mesh data."""
    before = set(bpy.data.objects)
    if hasattr(bpy.ops.wm, "stl_import"):
        bpy.ops.wm.stl_import(filepath=str(path))
    else:  # Blender < 4.2
        bpy.ops.import_mesh.stl(filepath=str(path))
    imported = [obj for obj in bpy.data.objects if obj not in before]
    if len(imported) != 1:
        raise SystemExit(f"{path.name}: expected 1 object from the STL, got {len(imported)}")
    obj = imported[0]

    # STL arrives as loose triangles at the world origin: weld the duplicated
    # corners, then decimate to the budget, then smooth with hard edges kept.
    obj.modifiers.clear()
    weld = obj.modifiers.new("Weld", "WELD")
    weld.merge_threshold = WELD_DISTANCE

    triangles = triangle_count(obj.data)
    if triangles > TRIANGLE_BUDGET:
        decimate = obj.modifiers.new("Decimate", "DECIMATE")
        decimate.decimate_type = "COLLAPSE"
        decimate.ratio = TRIANGLE_BUDGET / triangles

    bpy.context.view_layer.objects.active = obj
    for modifier in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)

    obj.select_set(True)
    if hasattr(bpy.ops.object, "shade_smooth_by_angle"):
        bpy.ops.object.shade_smooth_by_angle(angle=SMOOTH_ANGLE)
    else:
        bpy.ops.object.shade_smooth()
    obj.select_set(False)

    mesh = obj.data
    mesh.name = path.stem
    # The importer's object was only a carrier; the parts reuse the mesh data.
    bpy.data.objects.remove(obj)
    return mesh


def triangle_count(mesh: bpy.types.Mesh) -> int:
    return sum(max(0, len(poly.vertices) - 2) for poly in mesh.polygons)


# --------------------------------------------------------------------------- #
# Scene assembly
# --------------------------------------------------------------------------- #


def build_robot(robot: Robot) -> tuple[bpy.types.Object, list[Joint]]:
    """Empties for the kinematic tree, meshes for the visuals. Returns the root
    object and the movable joints in the order they were walked."""
    meshes: dict[Path, bpy.types.Mesh] = {}
    materials = {
        name: material(name, rgba, roughness=0.45 if name == "sts3215" else 0.62)
        for name, rgba in robot.materials.items()
    }
    fallback = material("urdf_default", (0.72, 0.74, 0.78, 1.0), roughness=0.6)

    root = new_empty(f"robot__{robot.name}", None, Matrix.Identity(4))
    movable: list[Joint] = []

    def add_link(name: str, parent: bpy.types.Object) -> None:
        link_obj = new_empty(f"link__{name}", parent, Matrix.Identity(4))
        for index, visual in enumerate(robot.links[name].visuals):
            if visual.mesh not in meshes:
                meshes[visual.mesh] = import_stl(visual.mesh)
            part = bpy.data.objects.new(f"visual__{name}__{index}", meshes[visual.mesh])
            bpy.context.collection.objects.link(part)
            scale = Matrix.Diagonal(visual.scale.to_4d())
            attach(part, link_obj, visual.origin @ scale)
            assign_material(part, materials.get(visual.material or "", fallback))

        for joint in robot.children_of(name):
            origin_obj = new_empty(f"origin__{joint.name}", link_obj, joint.origin)
            if joint.movable:
                joint_obj = new_empty(f"joint__{joint.name}", origin_obj, Matrix.Identity(4))
                movable.append(joint)
            else:
                joint_obj = origin_obj
            add_link(joint.child, joint_obj)

    add_link(robot.root, root)
    return root, movable


def assign_material(obj: bpy.types.Object, mat: bpy.types.Material) -> None:
    """Bind the material to the object rather than to the mesh, so parts sharing
    one mesh (the five identical servo bodies) can still be coloured apart."""
    if not obj.material_slots:
        obj.data.materials.append(None)
    slot = obj.material_slots[0]
    slot.link = "OBJECT"
    slot.material = mat


def build_surface() -> bpy.types.Object:
    bpy.ops.mesh.primitive_plane_add(size=GROUND["size"], location=(0.0, 0.0, 0.0))
    plane = bpy.context.active_object
    plane.name = "ground"
    plane.data.name = "ground"
    assign_material(plane, material("ground", (*hex_to_linear(GROUND["color"]), 1.0), roughness=0.9))
    plane.select_set(False)
    return plane


def build_lighting() -> None:
    """Ambient fill in the world, plus one soft sun. Only the sun is a lamp: a
    world background is how Blender does ambient, and the manifest carries it
    across to the viewer, which has no world."""
    world = bpy.data.worlds.new("scene_world")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background:
        background.inputs["Color"].default_value = (*hex_to_linear(AMBIENT["color"]), 1.0)
        background.inputs["Strength"].default_value = AMBIENT["intensity"] / 2
    bpy.context.scene.world = world

    sun_data = bpy.data.lights.new("key", type="SUN")
    sun_data.energy = KEY_LIGHT["intensity"] * 2
    sun_data.angle = math.radians(18)  # soft shadow edge
    sun_data.color = hex_to_linear(KEY_LIGHT["color"])
    sun = bpy.data.objects.new("key_light", sun_data)
    bpy.context.collection.objects.link(sun)
    # Point the sun's -Z down the requested direction.
    direction = Vector(KEY_LIGHT["direction"]).normalized()
    sun.rotation_mode = "QUATERNION"
    sun.rotation_quaternion = direction.to_track_quat("-Z", "Y")


def bounds(root: bpy.types.Object) -> tuple[Vector, Vector]:
    bpy.context.view_layer.update()
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for obj in root.children_recursive:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector(min(a, b) for a, b in zip(lo, world))
            hi = Vector(max(a, b) for a, b in zip(hi, world))
    if lo.x == math.inf:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    return lo, hi


def build_camera(lo: Vector, hi: Vector) -> dict:
    """A three-quarter view that frames the arm. Written to the manifest in glTF
    (Y-up) coordinates, which is what the viewer works in."""
    # Aim at the column above the base rather than at the bounding box centre:
    # the arm is stretched out at the URDF's zero pose, and framing that would
    # push the base — and the surface it stands on — off to one side.
    centre = Vector((0.0, 0.0, (lo.z + hi.z) / 2))
    corners = (Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z))
    reach = max(max((corner - centre).length for corner in corners), 0.05)
    # The URDF's zero pose has the arm stretched out flat, which is its widest.
    # A real reading folds it to roughly half that, so frame the working volume
    # rather than the rest pose — the viewer can orbit and zoom from there.
    radius = reach * FRAME_FRACTION
    fov = math.radians(38)
    distance = radius / math.tan(fov / 2) * 1.35
    azimuth, elevation = math.radians(38), math.radians(20)
    offset = Vector(
        (
            math.cos(elevation) * math.sin(azimuth),
            -math.cos(elevation) * math.cos(azimuth),
            math.sin(elevation),
        )
    ) * distance
    eye = centre + offset

    cam_data = bpy.data.cameras.new("view")
    cam_data.angle = fov
    cam = bpy.data.objects.new("view_camera", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = eye
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = (centre - eye).to_track_quat("-Z", "Y")
    bpy.context.scene.camera = cam

    return {
        "position": yup(eye),
        "target": yup(centre),
        "fov": round(math.degrees(fov), 3),
        "radius": round(radius, 5),
    }


def rest_angle(lower: float, upper: float) -> float:
    """The URDF angle a joint sitting at the middle of its travel is at.

    LeRobot's DEGREES normalisation reports `(ticks - mid) * 360 / 4095`, i.e. it
    calls the middle of the calibrated range zero — which is only the same as the
    URDF's zero when the URDF's limits straddle zero, as the SO-101's do. The
    SO-100 URDF measures from its assembled pose instead, so its limits are
    one-sided and mid-travel is the middle of them.
    """
    span = upper - lower
    if span <= 0:
        return 0.0
    return 0.0 if abs(lower + upper) <= 0.25 * span else (lower + upper) / 2


def yup(v: Vector) -> list[float]:
    """Blender Z-up to glTF Y-up, matching the exporter's own conversion."""
    return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #


def export(glb_path: Path) -> None:
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    call_filtered(
        bpy.ops.export_scene.gltf,
        filepath=str(glb_path),
        export_format="GLB",
        export_yup=True,
        use_selection=False,
        use_visible=True,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_texcoords=False,
        export_normals=True,
        export_extras=False,
        export_hierarchy_full_collections=False,
        export_optimize_animation_size=False,
    )


def manifest(
    model: str, robot: Robot, urdf: Path, root: bpy.types.Object, movable: list[Joint], camera: dict, glb: Path
) -> dict:
    triangles = sum(triangle_count(mesh) for mesh in bpy.data.meshes)
    return {
        "model": model,
        "robot": robot.name,
        "urdf": urdf.as_posix(),
        "glb": f"{ASSET_DIR}/{glb.name}",
        "generator": f"tools/blender/build_sim_scene.py on Blender {bpy.app.version_string}",
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "rootNode": root.name,
        "groundNode": "ground",
        "triangles": triangles,
        "joints": [
            {
                "name": joint.name,
                "node": f"joint__{joint.name}",
                # In glTF space: `export_yup` rewrites every node's transform as
                # C·T·C⁻¹, so a rotation about the URDF's local axis becomes a
                # rotation about C·axis. The viewer needs the converted one.
                "axis": yup(joint.axis.normalized()),
                "lower": round(joint.lower, 6),
                "upper": round(joint.upper, 6),
                "rest": round(rest_angle(joint.lower, joint.upper), 6),
            }
            for joint in movable
        ],
        "ground": {"light": GROUND["light"], "dark": GROUND["dark"], "size": GROUND["size"]},
        "lighting": {"ambient": AMBIENT, "hemisphere": HEMISPHERE, "key": KEY_LIGHT},
        "camera": camera,
    }


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="build_sim_scene")
    parser.add_argument("--model", choices=sorted(MODELS), action="append", help="repeatable; default: all")
    parser.add_argument("--repo", default=None, help="repository root (default: inferred)")
    parser.add_argument("--save-blend", action="store_true", help="also write the .blend next to the glb")
    args = parser.parse_args(argv)

    repo = Path(args.repo).resolve() if args.repo else Path(__file__).resolve().parents[2]
    for model in args.model or sorted(MODELS):
        spec = MODELS[model]
        urdf = repo / spec["urdf"]
        if not urdf.exists():
            raise SystemExit(f"{urdf} not found")

        print(f"[build-sim] {model}: {urdf.relative_to(repo)}")
        reset_scene()
        robot = parse_urdf(urdf)
        root, movable = build_robot(robot)
        build_surface()
        build_lighting()
        camera = build_camera(*bounds(root))

        glb = repo / OUT_DIR / f"{spec['out']}.glb"
        export(glb)
        meta = manifest(model, robot, Path(spec["urdf"]), root, movable, camera, glb)
        (repo / OUT_DIR / f"{spec['out']}.json").write_text(json.dumps(meta, indent=2) + "\n")
        if args.save_blend:
            bpy.ops.wm.save_as_mainfile(filepath=str(glb.with_suffix(".blend")))

        print(
            f"[build-sim] {model}: {len(movable)} joints, {meta['triangles']} triangles, "
            f"{glb.stat().st_size / 1e6:.2f} MB -> {glb.relative_to(repo)}"
        )


if __name__ == "__main__":
    main()
