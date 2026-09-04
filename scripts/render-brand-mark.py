#!/usr/bin/env python3
"""Render the Fabula brand mark: a spool of story, modelled and lit rather than drawn.

The Instrumenta marks are sculptural — depth, material, a transparent canvas — and the suite's
route to one without a modelling package is the LearnChess rook's: build real geometry, light it
in linear space, rasterise it. Fabula's mark is a spool whose barrel is wound with thread and
whose loose end escapes toward the ground: the story being unwound and rewound. The spool is a
surface of revolution; the escaping thread is a tube swept along a curve, which a lathe cannot
make, so it is its own solid — in ivory, the thread of the tale against the book-cloth spool.

Usage:
    python3 scripts/render-brand-mark.py [--out DIR] [--size N] [--supersample N]

Writes fabula-mark-<size>.png for the standard sizes plus fabula-app-art.png at 1024, all RGBA
with a transparent canvas.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

Vec3 = tuple[float, float, float]


def from_hex(value: int) -> Vec3:
    """sRGB hex to linear light; lighting in gamma space flattens every midtone."""
    channels = ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)
    return tuple(
        (channel / 255.0 / 12.92)
        if channel / 255.0 <= 0.04045
        else (((channel / 255.0) + 0.055) / 1.055) ** 2.4
        for channel in channels
    )


@dataclass
class Material:
    deep: Vec3
    accent: Vec3
    highlight: Vec3
    rim: Vec3


# Book-cloth terracotta for the spool, manuscript ivory for the thread.
CLOTH = Material(
    deep=from_hex(0x4A241A),
    accent=from_hex(0xD97757),
    highlight=from_hex(0xF5D5C0),
    rim=from_hex(0xF0A380),
)
THREAD = Material(
    deep=from_hex(0x6B5238),
    accent=from_hex(0xEBD9BE),
    highlight=from_hex(0xFFF6E4),
    rim=from_hex(0xFFE9C9),
)


def sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def scale(a: Vec3, k: float) -> Vec3:
    return (a[0] * k, a[1] * k, a[2] * k)


def add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def mix(a: Vec3, b: Vec3, t: float) -> Vec3:
    t = max(0.0, min(1.0, t))
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def normalise(a: Vec3) -> Vec3:
    length = math.sqrt(dot(a, a))
    return (0.0, 0.0, 0.0) if length == 0 else scale(a, 1.0 / length)


@dataclass
class Mesh:
    vertices: list[Vec3]
    normals: list[Vec3]
    faces: list[tuple[int, int, int]]


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

SEGMENTS = 168
WINDINGS = 7
MARK_TOP = 0.81


def spool_profile() -> list[tuple[float, float]]:
    """(radius, height) from the foot upward.

    Two flanges with a wound barrel between them. The winding is the point of the object, so it
    is geometry, not texture: the barrel radius ripples with the cord, and the light does the
    rest. Flange edges carry a small chamfer so they catch a line of key light the way a real
    turned edge does.
    """
    points: list[tuple[float, float]] = [
        (0.000, 0.000),
        (0.430, 0.000),
        (0.462, 0.018),
        (0.468, 0.052),
        (0.448, 0.086),
        (0.372, 0.104),
        (0.290, 0.112),
    ]
    # The wound barrel: |sin| ripples read as parallel cords at any size.
    barrel_bottom, barrel_top = 0.112, 0.698
    steps = 110
    for step in range(1, steps + 1):
        t = step / steps
        height = barrel_bottom + (barrel_top - barrel_bottom) * t
        cord = abs(math.sin(math.pi * t * WINDINGS)) ** 0.7
        # The middle of the barrel bulges a little: a full spool, not an empty one.
        fullness = 1.0 + 0.10 * math.sin(math.pi * t)
        points.append((0.252 * fullness + 0.024 * cord, height))
    points.extend(
        [
            (0.290, 0.706),
            (0.372, 0.714),
            (0.448, 0.732),
            (0.468, 0.766),
            (0.462, 0.792),
            (0.430, MARK_TOP),
            (0.000, MARK_TOP),
        ]
    )
    return points


def revolve(profile: list[tuple[float, float]]) -> Mesh:
    mesh = Mesh(vertices=[], normals=[], faces=[])
    rings: list[list[int]] = []
    for radius, height in profile:
        ring: list[int] = []
        if radius == 0.0:
            index = len(mesh.vertices)
            mesh.vertices.append((0.0, height, 0.0))
            mesh.normals.append((0.0, 0.0, 0.0))
            ring = [index] * SEGMENTS
        else:
            for segment in range(SEGMENTS):
                angle = 2.0 * math.pi * segment / SEGMENTS
                ring.append(len(mesh.vertices))
                mesh.vertices.append((radius * math.cos(angle), height, radius * math.sin(angle)))
                mesh.normals.append((0.0, 0.0, 0.0))
        rings.append(ring)
    for lower, upper in zip(rings, rings[1:]):
        for segment in range(SEGMENTS):
            nxt = (segment + 1) % SEGMENTS
            a, b, c, d = lower[segment], lower[nxt], upper[nxt], upper[segment]
            if a != b:
                mesh.faces.append((a, c, b))
            if c != d:
                mesh.faces.append((a, d, c))
    return mesh


def thread_path(t: float) -> Vec3:
    """The escaping thread: half a turn around the barrel, then out and down to the ground.

    The wrap keeps it visually attached to the spool; the fall gives the mark its story — the
    tale leaving the reel. It lands beside the foot and finishes with a small lift, an ink
    stroke's finishing flick.
    """
    if t < 0.42:
        u = t / 0.42
        angle = math.pi * (0.55 - 1.05 * u)
        radius = 0.286 + 0.012 * u
        height = 0.42 - 0.10 * u
        return (radius * math.cos(angle), height, radius * math.sin(angle))
    u = (t - 0.42) / 0.58
    # A cubic arc from the barrel's edge out past the flange and down.
    p0 = thread_path(0.4199)
    p1 = (0.62, 0.30, -0.34)
    p2 = (0.86, 0.02, -0.10)
    p3 = (0.98, 0.075, 0.16)
    s = 1.0 - u
    return (
        s * s * s * p0[0] + 3 * s * s * u * p1[0] + 3 * s * u * u * p2[0] + u * u * u * p3[0],
        s * s * s * p0[1] + 3 * s * s * u * p1[1] + 3 * s * u * u * p2[1] + u * u * u * p3[1],
        s * s * s * p0[2] + 3 * s * s * u * p1[2] + 3 * s * u * u * p2[2] + u * u * u * p3[2],
    )


def sweep_tube(radius: float, samples: int, sides: int) -> Mesh:
    """A tube along the thread path, framed by parallel transport so it never twists."""
    mesh = Mesh(vertices=[], normals=[], faces=[])
    centres = [thread_path(i / (samples - 1)) for i in range(samples)]
    tangents = []
    for i in range(samples):
        ahead = centres[min(i + 1, samples - 1)]
        behind = centres[max(i - 1, 0)]
        tangents.append(normalise(sub(ahead, behind)))
    normal = normalise(cross(tangents[0], (0.0, 1.0, 0.0)))
    if dot(normal, normal) < 1e-6:
        normal = (1.0, 0.0, 0.0)
    rings: list[list[int]] = []
    for i in range(samples):
        # Re-project the frame so it follows the curve without spinning.
        normal = normalise(sub(normal, scale(tangents[i], dot(normal, tangents[i]))))
        binormal = cross(tangents[i], normal)
        taper = radius * (1.0 - 0.55 * max(0.0, (i / (samples - 1)) - 0.85) / 0.15)
        ring = []
        for side in range(sides):
            angle = 2.0 * math.pi * side / sides
            offset = add(scale(normal, math.cos(angle) * taper), scale(binormal, math.sin(angle) * taper))
            ring.append(len(mesh.vertices))
            mesh.vertices.append(add(centres[i], offset))
            mesh.normals.append((0.0, 0.0, 0.0))
        rings.append(ring)
    for lower, upper in zip(rings, rings[1:]):
        for side in range(sides):
            nxt = (side + 1) % sides
            a, b, c, d = lower[side], lower[nxt], upper[nxt], upper[side]
            mesh.faces.append((a, c, b))
            mesh.faces.append((a, d, c))
    # Cap the loose end.
    tip = len(mesh.vertices)
    mesh.vertices.append(centres[-1])
    mesh.normals.append((0.0, 0.0, 0.0))
    for side in range(sides):
        mesh.faces.append((tip, rings[-1][side], rings[-1][(side + 1) % sides]))
    return mesh


def smooth_normals(mesh: Mesh) -> None:
    accumulated: list[Vec3] = [(0.0, 0.0, 0.0)] * len(mesh.vertices)
    for a, b, c in mesh.faces:
        va, vb, vc = mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]
        face = cross(sub(vb, va), sub(vc, va))
        for index in (a, b, c):
            accumulated[index] = add(accumulated[index], face)
    mesh.normals = [normalise(normal) or (0.0, 1.0, 0.0) for normal in accumulated]


# ---------------------------------------------------------------------------
# Camera and shading
# ---------------------------------------------------------------------------

EYE: Vec3 = (1.05, 0.86, 2.95)
TARGET: Vec3 = (0.06, 0.40, 0.0)
UP: Vec3 = (0.0, 1.0, 0.0)
FOV_DEGREES = 27.0

KEY_LIGHT: Vec3 = (-0.38, 0.58, 0.72)
FILL_LIGHT: Vec3 = (0.82, 0.12, 0.38)
RIM_LIGHT: Vec3 = (-0.30, 0.42, -0.86)


def view_basis() -> tuple[Vec3, Vec3, Vec3]:
    forward = normalise(sub(TARGET, EYE))
    right = normalise(cross(forward, UP))
    up = cross(right, forward)
    return right, up, forward


def shade(normal: Vec3, position: Vec3, material: Material) -> Vec3:
    """Three lights, one hue per material, hemispherical ambient — the suite's lighting."""
    view = normalise(sub(EYE, position))
    key = normalise(KEY_LIGHT)
    fill = normalise(FILL_LIGHT)
    rim = normalise(RIM_LIGHT)

    key_diffuse = max(0.0, dot(normal, key))
    fill_diffuse = max(0.0, dot(normal, fill))
    rim_term = max(0.0, dot(normal, rim)) * (1.0 - max(0.0, dot(normal, view))) ** 1.4
    half = normalise(add(key, view))
    specular = max(0.0, dot(normal, half)) ** 34.0

    height = max(0.0, min(1.0, position[1] / MARK_TOP))
    base = mix(material.deep, material.accent, 0.30 + 0.70 * height)
    sky = 0.5 + 0.5 * normal[1]
    ambient = scale(material.deep, 0.40 + 1.5 * sky * sky)

    lit = add(ambient, scale(base, 1.55 * key_diffuse + 0.28 * fill_diffuse))
    lit = add(lit, scale(material.rim, 0.90 * rim_term))
    lit = add(lit, scale(material.highlight, 1.10 * specular))
    return tuple(max(0.0, min(1.0, channel)) for channel in lit)


def to_srgb(linear: float) -> int:
    value = 1.055 * (linear ** (1.0 / 2.2)) - 0.055 if linear > 0.0031308 else linear * 12.92
    return max(0, min(255, round(value * 255)))


# ---------------------------------------------------------------------------
# Rasteriser
# ---------------------------------------------------------------------------


def render(parts: list[tuple[Mesh, Material]], resolution: int) -> Image.Image:
    right, up, forward = view_basis()
    focal = 1.0 / math.tan(math.radians(FOV_DEGREES) * 0.5)
    half = resolution * 0.5

    colour = bytearray(resolution * resolution * 3)
    alpha = bytearray(resolution * resolution)
    depth_buffer = [math.inf] * (resolution * resolution)

    for mesh, material in parts:
        projected: list[tuple[float, float, float] | None] = []
        for vertex in mesh.vertices:
            offset = sub(vertex, EYE)
            depth = dot(offset, forward)
            if depth <= 1e-4:
                projected.append(None)
                continue
            x = dot(offset, right) / depth * focal
            y = dot(offset, up) / depth * focal
            projected.append((half + x * half, half - y * half, depth))

        for a, b, c in mesh.faces:
            pa, pb, pc = projected[a], projected[b], projected[c]
            if pa is None or pb is None or pc is None:
                continue
            va, vb, vc = mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]
            if dot(cross(sub(vb, va), sub(vc, va)), sub(EYE, va)) <= 0.0:
                continue
            area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
            if area == 0.0:
                continue
            min_x = max(0, int(math.floor(min(pa[0], pb[0], pc[0]))))
            max_x = min(resolution - 1, int(math.ceil(max(pa[0], pb[0], pc[0]))))
            min_y = max(0, int(math.floor(min(pa[1], pb[1], pc[1]))))
            max_y = min(resolution - 1, int(math.ceil(max(pa[1], pb[1], pc[1]))))
            if min_x > max_x or min_y > max_y:
                continue
            inverse_area = 1.0 / area
            for py in range(min_y, max_y + 1):
                sample_y = py + 0.5
                for px in range(min_x, max_x + 1):
                    sample_x = px + 0.5
                    weight_c = (
                        (pb[0] - pa[0]) * (sample_y - pa[1]) - (pb[1] - pa[1]) * (sample_x - pa[0])
                    ) * inverse_area
                    weight_a = (
                        (pc[0] - pb[0]) * (sample_y - pb[1]) - (pc[1] - pb[1]) * (sample_x - pb[0])
                    ) * inverse_area
                    weight_b = 1.0 - weight_c - weight_a
                    if weight_a < 0.0 or weight_b < 0.0 or weight_c < 0.0:
                        continue
                    depth = weight_a * pa[2] + weight_b * pb[2] + weight_c * pc[2]
                    index = py * resolution + px
                    if depth >= depth_buffer[index]:
                        continue
                    depth_buffer[index] = depth
                    normal = normalise(
                        add(
                            add(scale(mesh.normals[a], weight_a), scale(mesh.normals[b], weight_b)),
                            scale(mesh.normals[c], weight_c),
                        )
                    )
                    position = add(
                        add(scale(mesh.vertices[a], weight_a), scale(mesh.vertices[b], weight_b)),
                        scale(mesh.vertices[c], weight_c),
                    )
                    shaded = shade(normal, position, material)
                    colour[index * 3] = to_srgb(shaded[0])
                    colour[index * 3 + 1] = to_srgb(shaded[1])
                    colour[index * 3 + 2] = to_srgb(shaded[2])
                    alpha[index] = 255

    rgb = Image.frombytes("RGB", (resolution, resolution), bytes(colour))
    mask = Image.frombytes("L", (resolution, resolution), bytes(alpha))
    rgb.putalpha(mask)
    return rgb


def frame(rendered: Image.Image, margin: float) -> Image.Image:
    """Centre with equal clear space; the camera composes, this frames."""
    box = rendered.getchannel("A").getbbox()
    if box is None:
        return rendered
    edge = rendered.width
    piece = rendered.crop(box)
    available = edge * (1.0 - 2.0 * margin)
    factor = min(available / piece.width, available / piece.height)
    resized = piece.resize(
        (max(1, round(piece.width * factor)), max(1, round(piece.height * factor))),
        Image.LANCZOS,
    )
    canvas = Image.new("RGBA", (edge, edge), (0, 0, 0, 0))
    canvas.paste(resized, ((edge - resized.width) // 2, (edge - resized.height) // 2))
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "brand")
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--supersample", type=int, default=3)
    args = parser.parse_args()

    spool = revolve(spool_profile())
    smooth_normals(spool)
    thread = sweep_tube(0.026, 150, 12)
    smooth_normals(thread)

    print(f"spool: {len(spool.faces)} faces · thread: {len(thread.faces)} faces")
    big = render([(spool, CLOTH), (thread, THREAD)], args.size * args.supersample)
    big = frame(big, 0.09)

    args.out.mkdir(parents=True, exist_ok=True)
    art = big.resize((args.size, args.size), Image.LANCZOS)
    art.save(args.out / "fabula-app-art.png")
    for size in (512, 256, 128, 64, 32):
        art.resize((size, size), Image.LANCZOS).save(args.out / f"fabula-mark-{size}.png")
    print(f"wrote {args.out}/fabula-app-art.png and standard sizes")


if __name__ == "__main__":
    main()
