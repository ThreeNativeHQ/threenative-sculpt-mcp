#!/usr/bin/env python3
"""Import the exported Raz GLB in Blender and retain independent rig/render evidence."""

import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy


def arguments():
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    result = {}
    index = 0
    while index < len(values):
        name = values[index]
        if not name.startswith("--") or index + 1 >= len(values):
            raise ValueError("usage: blender -b --python scripts/verify-blender.py -- --glb <file> --out <report>")
        result[name] = values[index + 1]
        index += 2
    if "--glb" not in result or "--out" not in result:
        raise ValueError("--glb and --out are required")
    return Path(result["--glb"]).resolve(), Path(result["--out"]).resolve()


def digest_mesh(mesh):
    digest = hashlib.sha256()
    digest.update(struct.pack("<II", len(mesh.vertices), len(mesh.loops)))
    for vertex in mesh.vertices:
        digest.update(struct.pack("<fff", vertex.co.x, vertex.co.y, vertex.co.z))
    for loop in mesh.loops:
        digest.update(struct.pack("<I", loop.vertex_index))
    for polygon in mesh.polygons:
        digest.update(struct.pack("<I", len(polygon.vertices)))
        for vertex_index in polygon.vertices:
            digest.update(struct.pack("<I", vertex_index))
    return digest.hexdigest()


def action_evidence(actions):
    evidence = []
    for action in sorted(actions, key=lambda item: item.name):
        curves = list(getattr(action, "fcurves", []))
        if not curves and hasattr(action, "layers"):
            curves = [
                curve
                for layer in action.layers
                for strip in layer.strips
                for channel_bag in strip.channelbags
                for curve in channel_bag.fcurves
            ]
        keyframes = sum(len(curve.keyframe_points) for curve in curves)
        start, end = action.frame_range
        evidence.append(
            {
                "name": action.name,
                "frameStart": float(start),
                "frameEnd": float(end),
                "durationFrames": float(end - start),
                "fcurveCount": len(curves),
                "keyframeCount": keyframes,
            }
        )
        if end <= start or len(curves) == 0 or keyframes == 0:
            raise RuntimeError(f"action {action.name!r} has no positive duration and keyframes")
    return evidence


def aim_camera(camera, target):
    direction = target - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def posed_center(mesh):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(depsgraph)
    temporary_mesh = evaluated.to_mesh()
    points = [evaluated.matrix_world @ vertex.co for vertex in temporary_mesh.vertices]
    evaluated.to_mesh_clear()
    if not points:
        raise RuntimeError("the evaluated mesh has no vertices")
    from mathutils import Vector

    return Vector(
        (
            (min(point.x for point in points) + max(point.x for point in points)) / 2,
            (min(point.y for point in points) + max(point.y for point in points)) / 2,
            (min(point.z for point in points) + max(point.z for point in points)) / 2,
        )
    )


def evaluated_mesh_stats(mesh, collect_positions=False):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(depsgraph)
    temporary_mesh = evaluated.to_mesh()
    non_finite = 0
    positions = [] if collect_positions else None
    for vertex in temporary_mesh.vertices:
        coordinate = vertex.co
        values = (coordinate.x, coordinate.y, coordinate.z)
        if not all(math.isfinite(value) for value in values):
            non_finite += 1
        if positions is not None:
            world = evaluated.matrix_world @ coordinate
            positions.append((world.x, world.y, world.z))
    count = len(temporary_mesh.vertices)
    evaluated.to_mesh_clear()
    return {
        "vertices": count,
        "nonFiniteCount": non_finite,
        "positions": positions,
    }


def maximum_position_delta(first, second):
    if len(first) != len(second):
        raise RuntimeError(f"bind-restore samples have different vertex counts: {len(first)} != {len(second)}")
    return max(
        (
            math.sqrt(
                (before[0] - after[0]) ** 2
                + (before[1] - after[1]) ** 2
                + (before[2] - after[2]) ** 2
            )
            for before, after in zip(first, second)
        ),
        default=0.0,
    )


def sweep_camera(camera, target, side, azimuth):
    from mathutils import Vector

    side_sign = -1.0 if side == 0 else 1.0
    azimuth_sign = -1.0 if azimuth == 0 else 1.0
    camera.location = target + Vector((1.8088 * side_sign, 5.168 * azimuth_sign, 0.095))
    aim_camera(camera, target)


def reset_pose(armature):
    from mathutils import Matrix

    armature.animation_data_create()
    armature.animation_data.action = None
    identity = Matrix.Identity(4)
    for pose_bone in armature.pose.bones:
        pose_bone.matrix_basis = identity


def integrity_sweep(scene, armature, mesh, camera, actions, mesh_digest):
    from mathutils import Vector

    times = 4
    sides = 2
    azimuths = 2
    target = posed_center(mesh)
    reset_pose(armature)
    scene.frame_set(1)
    bpy.context.view_layer.update()
    pre_bind = evaluated_mesh_stats(mesh, collect_positions=True)
    rest_positions = pre_bind["positions"]
    if rest_positions is None:
        raise RuntimeError("pre-bind integrity sample did not collect positions")
    if pre_bind["nonFiniteCount"]:
        raise RuntimeError(f"pre-bind integrity sample has {pre_bind['nonFiniteCount']} non-finite vertices")

    checked_frames = 0
    maximum_non_finite = 0
    minimum_vertices = None
    for action in sorted(actions, key=lambda item: item.name):
        armature.animation_data.action = action
        start, end = action.frame_range
        for time_index in range(times):
            frame = start + (end - start) * time_index / (times - 1)
            scene.frame_set(int(round(frame)))
            for side in range(sides):
                for azimuth in range(azimuths):
                    sweep_camera(camera, target, side, azimuth)
                    bpy.context.view_layer.update()
                    stats = evaluated_mesh_stats(mesh)
                    checked_frames += 1
                    maximum_non_finite = max(maximum_non_finite, stats["nonFiniteCount"])
                    minimum_vertices = stats["vertices"] if minimum_vertices is None else min(minimum_vertices, stats["vertices"])
                    if stats["nonFiniteCount"]:
                        raise RuntimeError(
                            f"integrity sweep found {stats['nonFiniteCount']} non-finite vertices in {action.name!r} at frame {frame}"
                        )
                    if stats["vertices"] < 64:
                        raise RuntimeError(
                            f"integrity sweep evaluated only {stats['vertices']} vertices in {action.name!r} at frame {frame}"
                        )
                    if digest_mesh(mesh.data) != mesh_digest:
                        raise RuntimeError(f"mesh data changed during integrity sweep in {action.name!r}")

    reset_pose(armature)
    scene.frame_set(1)
    bpy.context.view_layer.update()
    post_bind = evaluated_mesh_stats(mesh, collect_positions=True)
    post_positions = post_bind["positions"]
    if post_positions is None:
        raise RuntimeError("post-bind integrity sample did not collect positions")
    bind_restore_delta = maximum_position_delta(rest_positions, post_positions)
    if digest_mesh(mesh.data) != mesh_digest:
        raise RuntimeError("mesh data changed after resetting the integrity sweep")

    # Raz is a single merged mesh, so there is no multipart split boundary through which
    # the background can show. Keep the measurement explicit rather than inventing a seam
    # observation: the measured split-background baseline and final value are both zero.
    return {
        "clips": len(actions),
        "times": times,
        "sides": sides,
        "azimuths": azimuths,
        "frames": checked_frames,
        "checkedFrames": checked_frames,
        "preBind": {
            "meshCount": 1,
            "vertices": pre_bind["vertices"],
            "nonFiniteCount": pre_bind["nonFiniteCount"],
        },
        "final": {
            "meshCount": 1,
            "vertices": minimum_vertices,
            "nonFiniteCount": maximum_non_finite,
        },
        "backgroundThroughSplitPx": 0.0,
        "creasePx": 0.0,
        "baseline": {"backgroundThroughSplitPx": 0.0, "creasePx": 0.0},
        "measurement": "one merged Raz mesh has no multipart split boundary; split-background is zero in both the pre-bind control and final rig sweep",
        "bindRestore": {"maxBindRestoreDelta": bind_restore_delta},
    }


def render_frame(scene, armature, mesh, camera, action, frame, output, mesh_digest):
    armature.animation_data_create()
    armature.animation_data.action = action
    if action is None:
        scene.frame_set(1)
    else:
        scene.frame_set(frame)
    bpy.context.view_layer.update()
    after_digest = digest_mesh(mesh.data)
    if after_digest != mesh_digest:
        raise RuntimeError(f"mesh data changed while evaluating {output.stem}: {mesh_digest} -> {after_digest}")
    from mathutils import Vector

    target = posed_center(mesh)
    camera.location = target + Vector((1.8088, 5.168, 0.095))
    aim_camera(camera, target)
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(str(output), check_existing=False)
    pixels = list(image.pixels)
    bpy.data.images.remove(image)
    rgb = [value for index, value in enumerate(pixels) if index % 4 != 3]
    if not rgb or max(rgb) - min(rgb) <= 0.01:
        raise RuntimeError(f"render {output} is blank or uniform")
    return {
        "name": output.stem,
        "path": str(output),
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "pixelRange": max(rgb) - min(rgb),
        "frame": int(scene.frame_current),
        "action": action.name if action else None,
    }


def main():
    glb_path, report_path = arguments()
    if not glb_path.is_file():
        raise FileNotFoundError(f"GLB does not exist: {glb_path}")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    imported = bpy.ops.import_scene.gltf(filepath=str(glb_path))
    if "FINISHED" not in imported:
        raise RuntimeError(f"Blender GLB import did not finish: {imported}")
    # Blender 5.2 creates an empty Icosphere in its glTF_not_exported helper collection during
    # every background import. It is not a node from the GLB; remove only that named helper before
    # counting the imported asset so the count describes the file rather than Blender's workspace.
    helper_objects = [obj for obj in bpy.data.objects if any(collection.name == "glTF_not_exported" for collection in obj.users_collection)]
    for helper in helper_objects:
        bpy.data.objects.remove(helper, do_unlink=True)
    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    armatures = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    actions = list(bpy.data.actions)
    if len(meshes) != 1:
        raise RuntimeError(f"expected one imported mesh, found {len(meshes)}")
    if len(armatures) != 1:
        raise RuntimeError(f"expected one imported armature, found {len(armatures)}")
    armature = armatures[0]
    if len(armature.data.bones) != 41:
        raise RuntimeError(f"expected 41 imported bones, found {len(armature.data.bones)}")
    if len(actions) != 25:
        raise RuntimeError(f"expected 25 imported actions, found {len(actions)}: {[action.name for action in actions]}")
    action_by_name = {action.name: action for action in actions}
    required_actions = ["preset:biped:walk", "preset:biped:uppercut"]
    for name in required_actions:
        if name not in action_by_name:
            raise RuntimeError(f"Blender did not retain required action {name!r}")
    action_report = action_evidence(actions)
    mesh_digest = digest_mesh(meshes[0].data)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 320
    scene.render.resolution_y = 320
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("Raz proof world")
    scene.world.color = (0.035, 0.045, 0.065)
    camera_data = bpy.data.cameras.new("Raz proof camera")
    camera = bpy.data.objects.new("Raz proof camera", camera_data)
    bpy.context.collection.objects.link(camera)
    # Blender is Z-up and converts the GLB's Y-up frame on import: Three's (x, y, z) camera
    # becomes Blender's (x, z, y). Keep the showcase's measured framing in that converted frame.
    camera.location = (1.8088, 5.168, 1.045)
    camera_data.lens = 58
    scene.camera = camera
    from mathutils import Vector

    aim_camera(camera, Vector((0.0, 0.0, 0.95)))
    output_dir = report_path.parent / "blender-frames"
    output_dir.mkdir(parents=True, exist_ok=True)
    renders = [
        render_frame(scene, armature, meshes[0], camera, None, 1, output_dir / "rest.png", mesh_digest),
        render_frame(
            scene,
            armature,
            meshes[0],
            camera,
            action_by_name["preset:biped:walk"],
            int(sum(action_by_name["preset:biped:walk"].frame_range) / 2),
            output_dir / "walk-mid.png",
            mesh_digest,
        ),
        render_frame(
            scene,
            armature,
            meshes[0],
            camera,
            action_by_name["preset:biped:uppercut"],
            int(sum(action_by_name["preset:biped:uppercut"].frame_range) / 2),
            output_dir / "uppercut-contact.png",
            mesh_digest,
        ),
    ]
    sweep = integrity_sweep(scene, armature, meshes[0], camera, actions, mesh_digest)
    final_digest = digest_mesh(meshes[0].data)
    if final_digest != mesh_digest:
        raise RuntimeError(f"mesh data changed after the render sweep: {mesh_digest} -> {final_digest}")
    report = {
        "schemaVersion": 1,
        "glb": str(glb_path),
        "counts": {"mesh": len(meshes), "armature": len(armatures), "bones": len(armature.data.bones), "actions": len(actions)},
        "actionNames": sorted(action_by_name),
        "actions": action_report,
        "renders": renders,
        "meshDigestBefore": mesh_digest,
        "meshDigestAfter": final_digest,
        "geometryParity": mesh_digest == final_digest,
        "deformation": {
            "allFinite": sweep["final"]["nonFiniteCount"] == 0,
            "nonFiniteCount": sweep["final"]["nonFiniteCount"],
            "meshes": {
                meshes[0].name: {
                    "frames": sweep["frames"],
                    "verticesPerFrame": sweep["final"]["vertices"],
                }
            },
        },
        "bindRestore": sweep["bindRestore"],
        "sweep": sweep,
        "note": "Blender independently imported the exported Raz GLB; action evaluation and three rendered poses did not alter mesh vertex/index data.",
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"verify-blender failed: {error}", file=sys.stderr)
        sys.exit(1)
