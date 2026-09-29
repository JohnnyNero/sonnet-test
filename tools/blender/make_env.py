"""
ENVIRONMENT ASSET KIT (modern noir heist) -> assets/env/*.glb + manifest.json

  python3 tools/blender/make_env.py                # build everything
  python3 tools/blender/make_env.py sofa_2 vault_door   # build a subset (manifest is merged)

Conventions: 1 unit = 1 m, Z up, model FRONT faces Blender -Y (=> +Z in glTF).
Origin = centre of footprint at floor level. Wall-mounted items: origin at wall
surface centre-bottom, protruding toward -Y. Ceiling items keep origin at floor with
geometry up at y 2.9..3.2. Named child pivots (empties) are animated by the engine.
All coordinates in the model code are in MODEL space (absolute); the helpers convert
to parent-local automatically.
"""
import bpy, bmesh, math, os, sys, json, random
from mathutils import Vector, Matrix, Euler

bpy.ops.wm.read_factory_settings(use_empty=True)  # must run before any material exists

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "assets", "env"))
os.makedirs(OUT, exist_ok=True)

# ------------------------------------------------------------------ helpers
_mats = {}
_made = []
_W = {}          # object -> absolute location
_cnt = [0]
PI = math.pi
D = math.radians


def lin(h):
    h = h.lstrip("#")
    return tuple((int(h[i:i + 2], 16) / 255.0) ** 2.2 for i in (0, 2, 4))


def mat(hexstr, rough=0.85, metal=0.0, name=None, emit=None, strength=0.0, alpha=1.0):
    key = (hexstr, rough, metal, name, emit, strength, alpha)
    if key in _mats:
        return _mats[key]
    nm = name or ("m_" + hexstr.lstrip("#") + "_r%d_m%d" % (rough * 100, metal * 100))
    m = bpy.data.materials.new(nm)
    m.use_nodes = True
    m.use_backface_culling = alpha >= 1.0
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*lin(hexstr), alpha)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        try:
            m.blend_method = "BLEND"
        except Exception:
            pass
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
        try:
            m.show_transparent_back = False
        except Exception:
            pass
    if emit:
        b.inputs["Emission Color"].default_value = (*lin(emit), 1)
        b.inputs["Emission Strength"].default_value = strength
    _mats[key] = m
    return m


def emit(name, hexc, strength=3.0):
    return mat(hexc, 0.5, 0.0, name=name, emit=hexc, strength=strength)


def _link(name, me, par, loc):
    if name is None:
        _cnt[0] += 1
        name = "_%d" % _cnt[0]
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if o.name != name:
        print("  !! name clash", name, "->", o.name)
    pw = _W[par] if par is not None else Vector((0, 0, 0))
    o.parent = par
    o.location = Vector(loc) - pw
    _W[o] = Vector(loc)
    _made.append(o)
    return o


def _finish(bm, name, par, loc, m, smooth=None, rot=None):
    if rot:
        bm.transform(Euler(rot, "XYZ").to_matrix().to_4x4())
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new("me")
    for f in bm.faces:
        f.smooth = False
    if smooth:
        ai = smooth[1] if isinstance(smooth, tuple) else 2
        for f in bm.faces:
            if smooth == "all" or abs(f.normal[ai]) < 0.98:
                f.smooth = True
    bm.to_mesh(me)
    bm.free()
    me.materials.append(m)
    return _link(name, me, par, loc)


def B(par, loc, size, m, name=None, bv=0.0, rot=None, seg=1):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    if bv:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bv, min(size) * 0.45),
                        offset_type="OFFSET", segments=seg, affect="EDGES")
    return _finish(bm, name, par, loc, m, rot=rot)


def S(par, xr, yr, zr, m, name=None, bv=0.0, rot=None, seg=1):
    """slab from ranges"""
    return B(par, ((xr[0] + xr[1]) / 2, (yr[0] + yr[1]) / 2, (zr[0] + zr[1]) / 2),
             (abs(xr[1] - xr[0]), abs(yr[1] - yr[0]), abs(zr[1] - zr[0])), m, name, bv, rot, seg)


def C(par, loc, r, h, m, name=None, v=12, ax="z", r2=None, smooth=False, sc=(1, 1, 1), rot=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=v, radius1=r,
                          radius2=r if r2 is None else r2, depth=h)
    if sc != (1, 1, 1):
        for vv in bm.verts:
            vv.co = Vector((vv.co.x * sc[0], vv.co.y * sc[1], vv.co.z * sc[2]))
    ai = 2
    if ax == "x":
        bm.transform(Euler((0, PI / 2, 0)).to_matrix().to_4x4())
        ai = 0
    elif ax == "y":
        bm.transform(Euler((PI / 2, 0, 0)).to_matrix().to_4x4())
        ai = 1
    return _finish(bm, name, par, loc, m, smooth=(("side", ai) if smooth else None), rot=rot)


def P(par, loc, r, m, name=None, sc=(1, 1, 1), seg=8, rings=6, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    for vv in bm.verts:
        vv.co = Vector((vv.co.x * sc[0], vv.co.y * sc[1], vv.co.z * sc[2]))
    return _finish(bm, name, par, loc, m, smooth="all", rot=rot)


def annulus(par, loc, r_out, r_in, h, m, name=None, v=24, smooth=False, ax="z"):
    bm = bmesh.new()
    n = v
    tz, bz = h / 2, -h / 2
    ring = []
    for z in (tz, bz):
        for r in (r_out, r_in):
            ring.append([bm.verts.new((math.cos(2 * PI * i / n) * r, math.sin(2 * PI * i / n) * r, z)) for i in range(n)])
    to, ti, bo, bi = ring
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((to[i], to[j], ti[j], ti[i]))        # top
        bm.faces.new((bi[i], bi[j], bo[j], bo[i]))        # bottom
        bm.faces.new((bo[i], bo[j], to[j], to[i]))        # outer
        bm.faces.new((ti[i], ti[j], bi[j], bi[i]))        # inner
    ai = 2
    if ax == "x":
        bm.transform(Euler((0, PI / 2, 0)).to_matrix().to_4x4())
        ai = 0
    elif ax == "y":
        bm.transform(Euler((PI / 2, 0, 0)).to_matrix().to_4x4())
        ai = 1
    return _finish(bm, name, par, loc, m, smooth=(("side", ai) if smooth else None))


def beam(par, p0, p1, w, d, m, name=None, bv=0.0):
    p0, p1 = Vector(p0), Vector(p1)
    dv = p1 - p0
    L = dv.length
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * w, v.co.y * d, v.co.z * L))
    q = Vector((0, 0, 1)).rotation_difference(dv.normalized())
    bm.transform(q.to_matrix().to_4x4())
    return _finish(bm, name, par, (p0 + p1) / 2, m)


def poly_xz(par, pts, y0, y1, m, name=None):
    """polygon in XZ plane (model coords) extruded from y0 to y1."""
    bm = bmesh.new()
    a = [bm.verts.new((x, y0, z)) for x, z in pts]
    b = [bm.verts.new((x, y1, z)) for x, z in pts]
    bm.faces.new(a)
    bm.faces.new(b[::-1])
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    return _finish(bm, name, par, (0, 0, 0), m)


def poly_yz(par, pts, x0, x1, m, name=None):
    bm = bmesh.new()
    a = [bm.verts.new((x0, y, z)) for y, z in pts]
    b = [bm.verts.new((x1, y, z)) for y, z in pts]
    bm.faces.new(a)
    bm.faces.new(b[::-1])
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    return _finish(bm, name, par, (0, 0, 0), m)


def pv(name, par, loc):
    o = bpy.data.objects.new(name, None)
    o.empty_display_type = "PLAIN_AXES"
    bpy.context.scene.collection.objects.link(o)
    pw = _W[par] if par is not None else Vector((0, 0, 0))
    o.parent = par
    o.location = Vector(loc) - pw
    _W[o] = Vector(loc)
    _made.append(o)
    return o


# ------------------------------------------------------------------ registry
MODELS = []       # dicts
EXCL = {}         # model -> object names excluded from footprint calc


def M(name, prio, mount, cat, fp, h=None, connects=None):
    def deco(fn):
        MODELS.append(dict(name=name, fn=fn, prio=prio, mount=mount, cat=cat, fp=fp, h=h, connects=connects))
        return fn
    return deco


def _descendants(o):
    out = []
    for c in o.children:
        out.append(c)
        out += _descendants(c)
    return out


def resolve_zfight(eps=0.0015):
    """Coplanar, overlapping, same-facing axis-aligned faces from different boxes z-fight (flicker as the camera moves).
    The larger/earlier box of each such pair gets its face pushed inward by `eps` so the detail box always wins."""
    recs = {}
    order = {o: i for i, o in enumerate(_made)}
    for o in _made:
        if o.type != "MESH":
            continue
        M = o.matrix_world
        R = M.to_3x3()
        vs = [M @ v.co for v in o.data.vertices]
        xs = [v.x for v in vs]; ys = [v.y for v in vs]; zs = [v.z for v in vs]
        vol = max(1e-9, (max(xs) - min(xs)) * (max(ys) - min(ys)) * (max(zs) - min(zs)))
        for pi, poly in enumerate(o.data.polygons):
            n = R @ poly.normal
            for a in range(3):
                if abs(abs(n[a]) - 1.0) < 1e-4:
                    sg = 1 if n[a] > 0 else -1
                    pts = [vs[i] for i in poly.vertices]
                    c = sum(q[a] for q in pts) / len(pts)
                    b1, b2 = [k for k in range(3) if k != a]
                    rect = (min(q[b1] for q in pts), max(q[b1] for q in pts), min(q[b2] for q in pts), max(q[b2] for q in pts))
                    recs.setdefault((a, sg, round(c / 1e-4)), []).append((o, pi, rect, vol, c))
    moved = set()
    fixes = 0
    for (a, sg, kc), lst in list(recs.items()):
        pool = list(lst) + list(recs.get((a, sg, kc + 1), [])) + list(recs.get((a, sg, kc - 1), []))
        for i, A in enumerate(lst):
            for B in pool:
                if A[0] is B[0] or abs(A[4] - B[4]) > 3e-5:
                    continue
                if min(A[2][1], B[2][1]) - max(A[2][0], B[2][0]) < 1e-4 or min(A[2][3], B[2][3]) - max(A[2][2], B[2][2]) < 1e-4:
                    continue
                # loser: bigger box; on a tie the earlier one
                if A[3] > B[3] * 1.0001 or (abs(A[3] - B[3]) <= B[3] * 1e-4 and order[A[0]] < order[B[0]]):
                    loser = A
                else:
                    continue
                key = (loser[0], loser[1])
                if key in moved:
                    continue
                moved.add(key)
                o = loser[0]
                d = Vector((0, 0, 0)); d[a] = -sg * eps
                ld = o.matrix_world.to_3x3().inverted() @ d
                for vi in o.data.polygons[loser[1]].vertices:
                    o.data.vertices[vi].co += ld
                fixes += 1
    if fixes:
        print("    z-fight: pushed %d faces" % fixes)


def export(spec):
    name = spec["name"]
    bpy.context.view_layer.update()
    resolve_zfight()
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for o in _made:
        o.select_set(True)
    path = os.path.join(OUT, name + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
        export_cameras=False, export_lights=False, export_animations=False, export_extras=False)
    root = _made[0]
    excl = set()
    for o in _made:
        if o.name in EXCL.get(name, ()):
            excl.add(o)
            excl.update(_descendants(o))
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    tris = 0
    emis = set()
    parts = []
    for o in _made:
        if o.type == "MESH":
            tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
            for mm in o.data.materials:
                if mm.name.startswith("emit_"):
                    emis.add(mm.name)
            if o in excl:
                continue
            for v in o.data.vertices:
                w = o.matrix_world @ v.co
                for i in range(3):
                    mn[i] = min(mn[i], w[i])
                    mx[i] = max(mx[i], w[i])
        if o is not root and not o.name.startswith("_"):
            parts.append(o.name)
    ent = dict(
        name=name, footprint=[round(mx.x - mn.x, 3), round(mx.y - mn.y, 3)],
        height=round(mx.z - mn.z, 3), zmin=round(mn.z, 3), zmax=round(mx.z, 3),
        cell=[max(1, math.ceil(round(mx.x - mn.x, 3) - 0.02)), max(1, math.ceil(round(mx.y - mn.y, 3) - 0.02))],
        priority=spec["prio"], mounts=spec["mount"], category=spec["cat"], parts=parts,
        emissive=sorted(emis), tris=tris, spec_footprint=list(spec["fp"][:2]), spec_height=spec["fp"][2])
    if spec.get("connects"):
        ent["connects"] = spec["connects"]
    print("  %-22s %5d tris %4d KB  fp %.2fx%.2f h %.2f  parts=%s" % (
        name, tris, os.path.getsize(path) // 1024, ent["footprint"][0], ent["footprint"][1], ent["height"], ",".join(parts)))
    for o in list(_made):
        bpy.data.objects.remove(o, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    _made.clear()
    _W.clear()
    _cnt[0] = 0
    return ent


# ------------------------------------------------------------------ palette
PLASTER = mat("#3a3c47", 0.9)
PLASTER_D = mat("#2a2b34", 0.9)
TRIM = mat("#5a5c68", 0.7)
BASEB = mat("#14151a", 0.6)
CHAR = mat("#191a1f", 0.7)
GRAPH = mat("#2a2c33", 0.65)
GRAPH_L = mat("#3c3f48", 0.6)
NAVY = mat("#1a2a4d", 0.8)
NAVY_L = mat("#223560", 0.75)
OX = mat("#6a1424", 0.85)
OX_D = mat("#450b17", 0.9)
OX_L = mat("#7a1c2e", 0.8)
WAL = mat("#63391f", 0.55)
WAL_D = mat("#361f10", 0.6)
WAL_L = mat("#875030", 0.5)
BRASS = mat("#d0a24a", 0.35, 0.9)
BRASS_D = mat("#8a6a2c", 0.4, 0.85)
GOLD = mat("#e8b530", 0.25, 1.0)
MARB_B = mat("#1c1d23", 0.25)
MARB_V = mat("#33353f", 0.3)
MARB_W = mat("#e4e2dc", 0.25)
MARB_WV = mat("#a6a4a0", 0.3)
STEEL = mat("#a5acb4", 0.42, 0.6)
STEEL_D = mat("#5d646d", 0.45, 0.6)
STEEL_B = mat("#262a31", 0.5, 0.6)
BLACK = mat("#0a0b0d", 0.6)
VOID = mat("#010102", 1.0)
CONC = mat("#66676c", 0.95)
CONC_D = mat("#44454a", 0.95)
CONC_L = mat("#7a7b80", 0.95)
WHITE = mat("#e6e6e2", 0.6)
CLOTH = mat("#c9c6bd", 0.95)
PAPER = mat("#d9d5c8", 0.9)
GLASS = mat("#a8ccdc", 0.05, 0.0, name="glass", alpha=0.25)
GLASS_D = mat("#20303a", 0.05, 0.0, name="glass_dark", alpha=0.35)
GREEN_D = mat("#1f3f2f", 0.5, 0.3)
LEATHER = mat("#2b1f1a", 0.6)
CARDB = mat("#93704a", 0.9)
CARDB_D = mat("#6f5236", 0.9)
YELLOW = mat("#d8b400", 0.6)
RED_P = mat("#b01818", 0.5)
E_LAMP = emit("emit_lamp", "#ffcc80", 2.2)
E_SCREEN = emit("emit_screen", "#3fd8ff", 1.5)
E_SCREEN_G = emit("emit_screen_green", "#3dff8f", 1.5)
E_SCREEN_T = emit("emit_screen_teal", "#20e0c0", 1.6)
E_LED_R = emit("emit_led_red", "#ff2a20", 3.0)
E_LED_G = emit("emit_led_green", "#30ff60", 3.0)
E_NEON_P = emit("emit_neon_pink", "#ff3fa8", 3.0)
E_NEON_B = emit("emit_neon_blue", "#3f8cff", 3.0)
E_LASER = emit("emit_laser", "#ff1010", 2.5)
E_MARK = emit("emit_marker_gold", "#ffc93a", 2.5)


def ring4(par, x0, x1, y0, y1, z0, z1, t, m, bv=0.0):
    """rectangular ring (4 slabs) outer ranges, thickness t (XY)"""
    S(par, (x0, x1), (y0, y0 + t), (z0, z1), m, bv=bv)
    S(par, (x0, x1), (y1 - t, y1), (z0, z1), m, bv=bv)
    S(par, (x0, x0 + t), (y0 + t, y1 - t), (z0, z1), m, bv=bv)
    S(par, (x1 - t, x1), (y0 + t, y1 - t), (z0, z1), m, bv=bv)


def fbox(par, face, u, w, z0, z1, m, off=0.5, depth=0.012):
    """box on a cell face. face 0 front(-Y) 1 right(+X) 2 back(+Y) 3 left(-X); u lateral centre"""
    zc, h, c = (z0 + z1) / 2, z1 - z0, off + depth / 2
    if face == 0:
        return B(par, (u, -c, zc), (w, depth, h), m)
    if face == 2:
        return B(par, (-u, c, zc), (w, depth, h), m)
    if face == 1:
        return B(par, (c, u, zc), (depth, w, h), m)
    return B(par, (-c, -u, zc), (depth, w, h), m)


# =================================================================== STRUCTURE
def _floor_slab(r, m, z0=-0.1, z1=0.0):
    S(r, (-.5, .5), (-.5, .5), (z0, z1), m)


@M("floor_marble", "P0", "floor", "structure", (1, 1, 0.1))
def floor_marble(r):
    _floor_slab(r, MARB_B)
    S(r, (-.5, .5), (-.5, -.494), (-0.006, 0.002), BASEB)     # tile seams
    S(r, (-.5, -.494), (-.494, .5), (-0.006, 0.002), BASEB)
    for i, (x, y, l, a, w) in enumerate(((-.12, .05, .8, 33, .014), (.2, -.2, .5, -58, .009), (.05, .3, .45, 71, .007),
                                          (-.3, -.3, .3, 15, .007), (.3, .25, .25, -20, .006))):
        h = 0.0024 + i * 0.0004                                   # distinct heights: overlapping veins must not be coplanar
        B(r, (x, y, h / 2), (l, w, h), MARB_V, rot=(0, 0, D(a)))


@M("floor_carpet", "P0", "floor", "structure", (1, 1, 0.1))
def floor_carpet(r):
    _floor_slab(r, OX_D)
    S(r, (-.5, .5), (-.5, .5), (-0.004, 0.0), OX_D)
    ring4(r, -.44, .44, -.44, .44, 0, 0.006, 0.035, OX_L)       # border band
    ring4(r, -.37, .37, -.37, .37, 0, 0.006, 0.01, BRASS_D)      # thread
    S(r, (-.33, .33), (-.33, .33), (0, 0.004), OX)               # field
    for i in (-1, 0, 1):
        B(r, (i * .16, 0, 0.005), (0.03, 0.03, 0.002), OX_L, rot=(0, 0, D(45)))


@M("floor_wood", "P0", "floor", "structure", (1, 1, 0.1))
def floor_wood(r):
    _floor_slab(r, WAL_D, -0.1, -0.006)
    tones = (WAL, WAL_L, WAL, WAL_D)
    k = 0
    for qx in (-1, 1):
        for qy in (-1, 1):
            xr = (.005, .495) if qx > 0 else (-.495, -.005)
            yr = (.005, .495) if qy > 0 else (-.495, -.005)
            for i in range(2):
                off = (i - 0.5) * 0.245
                if qx * qy > 0:      # planks run along X
                    c = qy * 0.25 + off
                    S(r, xr, (c - .118, c + .118), (-0.1, 0), tones[k % 4])
                else:                # planks run along Y
                    c = qx * 0.25 + off
                    S(r, (c - .118, c + .118), yr, (-0.1, 0), tones[k % 4])
                k += 1


@M("floor_concrete", "P0", "floor", "structure", (1, 1, 0.1))
def floor_concrete(r):
    _floor_slab(r, CONC_D)
    S(r, (-.495, .495), (-.495, .495), (-0.1, 0), CONC)
    S(r, (-.5, .5), (-.008, .008), (-0.004, 0.0005), CONC_D)      # expansion joints
    S(r, (-.008, .008), (-.5, .5), (-0.004, 0.0005), CONC_D)
    B(r, (-.25, -.25, 0.001), (0.3, 0.22, 0.002), mat("#6d6e73", 0.95), rot=(0, 0, D(20)))
    B(r, (.28, .22, 0.001), (0.22, 0.3, 0.002), mat("#5e5f64", 0.95), rot=(0, 0, D(-15)))


@M("floor_tile", "P0", "floor", "structure", (1, 1, 0.1))
def floor_tile(r):
    grout = mat("#15181a", 0.9)
    t1 = mat("#2e3b40", 0.3)
    t2 = mat("#243036", 0.3)
    S(r, (-.5, .5), (-.5, .5), (-0.1, -0.006), grout)
    n, g = 3, 0.012
    w = 1.0 / n
    for i in range(n):
        for j in range(n):
            x0, y0 = -.5 + i * w, -.5 + j * w
            S(r, (x0 + g, x0 + w - g), (y0 + g, y0 + w - g), (-0.1, 0), t1 if (i + j) % 2 else t2)


@M("floor_metal", "P0", "floor", "structure", (1, 1, 0.1))
def floor_metal(r):
    S(r, (-.5, .5), (-.5, .5), (-0.1, -0.05), BLACK)
    ring4(r, -.5, .5, -.5, .5, -0.06, 0, 0.04, STEEL_D)
    for i in range(8):
        y = -.5 + 0.04 + (i + .5) * (0.92 / 8)
        S(r, (-.46, .46), (y - .012, y + .012), (-0.06, 0), STEEL)
    for x in (-.25, 0, .25):
        S(r, (x - .012, x + .012), (-.46, .46), (-0.06, -0.02), STEEL_D)


@M("wall_plain", "P0", "floor", "structure", (1, 1, 3.2))
def wall_plain(r):
    S(r, (-.47, .47), (-.47, .47), (0.14, 3.02), PLASTER)
    S(r, (-.5, .5), (-.5, .5), (0, 0.14), BASEB, bv=0.008)
    S(r, (-.485, .485), (-.485, .485), (0.14, 0.17), TRIM)
    S(r, (-.49, .49), (-.49, .49), (1.0, 1.04), TRIM)
    S(r, (-.485, .485), (-.485, .485), (3.0, 3.06), TRIM)
    S(r, (-.5, .5), (-.5, .5), (3.06, 3.2), PLASTER_D, bv=0.01)
    S(r, (-.5, .5), (-.5, .5), (3.15, 3.2), TRIM)


@M("wall_panel", "P0", "floor", "structure", (1, 1, 3.2))
def wall_panel(r):
    S(r, (-.48, .48), (-.48, .48), (0.14, 3.02), WAL_D)
    S(r, (-.5, .5), (-.5, .5), (0, 0.14), BASEB, bv=0.008)
    S(r, (-.5, .5), (-.5, .5), (3.02, 3.2), WAL, bv=0.01)
    S(r, (-.49, .49), (-.49, .49), (0.14, 0.2), WAL)
    for f in range(4):
        for u in (-.24, .24):
            fbox(r, f, u, 0.4, 0.28, 2.9, WAL, off=0.48, depth=0.014)
    S(r, (-.5, .5), (-.5, .5), (1.05, 1.08), BRASS)            # brass strip ring
    S(r, (-.5, .5), (-.5, .5), (3.0, 3.03), BRASS_D)


@M("wall_glass", "P0", "floor", "structure", (1, 1, 3.2))
def wall_glass(r):
    S(r, (-.5, .5), (-.5, .5), (0, 0.05), STEEL_B)
    S(r, (-.5, .5), (-.5, .5), (3.0, 3.2), STEEL_B)
    S(r, (-.5, .5), (-.06, .06), (0.05, 0.1), BRASS_D)
    for x in (-.47, .47):
        S(r, (x - .03, x + .03), (-.07, .07), (0.05, 3.0), STEEL)
    S(r, (-.03, .03), (-.05, .05), (0.05, 3.0), STEEL)
    S(r, (-.5, .5), (-.04, .04), (1.55, 1.6), STEEL)
    S(r, (-.5, .5), (-.05, .05), (0.95, 1.0), STEEL_D)
    S(r, (-.44, .44), (-.012, .012), (0.1, 3.0), GLASS)


@M("wall_concrete", "P0", "floor", "structure", (1, 1, 3.2))
def wall_concrete(r):
    S(r, (-.5, .5), (-.5, .5), (0, 3.2), CONC)
    S(r, (-.5, .5), (-.5, .5), (0, 0.12), CONC_D)
    for z in (1.6,):
        S(r, (-.502, .502), (-.502, .502), (z - .008, z + .008), CONC_D)      # panel seam ring
    for f in (0, 2):
        for u in (-.25, .25):
            for z in (0.8, 2.4):
                fbox(r, f, u, 0.05, z - .025, z + .025, BLACK, off=0.5, depth=0.004)
    S(r, (-.5, .5), (-.5, .5), (3.1, 3.2), CONC_D)


@M("wall_tile", "P0", "floor", "structure", (1, 1, 3.2))
def wall_tile(r):
    tile = mat("#1d4a3a", 0.25)
    grout = mat("#b5b8ad", 0.8)
    S(r, (-.47, .47), (-.47, .47), (0.14, 3.02), PLASTER)
    S(r, (-.5, .5), (-.5, .5), (0, 0.14), BASEB, bv=0.008)
    S(r, (-.492, .492), (-.492, .492), (0.14, 1.6), tile)
    for i in range(1, 8):
        S(r, (-.496, .496), (-.496, .496), (0.14 + i * 0.1825 - 0.004, 0.14 + i * 0.1825 + 0.004), grout)
    S(r, (-.5, .5), (-.5, .5), (1.6, 1.64), BRASS_D)
    S(r, (-.5, .5), (-.5, .5), (3.06, 3.2), PLASTER_D, bv=0.01)
    S(r, (-.485, .485), (-.485, .485), (3.0, 3.06), TRIM)


@M("pillar_marble", "P0", "floor", "structure", (1, 1, 3.2))
def pillar_marble(r):
    S(r, (-.47, .47), (-.47, .47), (0, 0.28), MARB_W, bv=0.012)
    S(r, (-.4, .4), (-.4, .4), (0.28, 0.4), BRASS, bv=0.01)
    C(r, (0, 0, 1.6), 0.34, 2.4, MARB_B, v=16)
    for i in range(4):
        a = i * PI / 2 + PI / 5
        B(r, (math.cos(a) * 0.335, math.sin(a) * 0.335, 1.6 + 0.1 * i), (0.008, 0.07, 1.6), MARB_V, rot=(0, 0, a))
    S(r, (-.4, .4), (-.4, .4), (2.8, 2.92), BRASS, bv=0.01)
    S(r, (-.47, .47), (-.47, .47), (2.92, 3.2), MARB_W, bv=0.012)
    S(r, (-.49, .49), (-.49, .49), (3.1, 3.2), MARB_WV)


# ---- doors
def _wall_around_door(r, mat_wall, mat_jamb, top=2.6, half=0.475):
    S(r, (-.5, -half), (-.5, .5), (0, top), mat_jamb)
    S(r, (half, .5), (-.5, .5), (0, top), mat_jamb)
    S(r, (-.5, .5), (-.47, .47), (top, 3.0), mat_wall)
    S(r, (-.5, .5), (-.5, .5), (3.0, 3.2), PLASTER_D, bv=0.01)
    S(r, (-.5, .5), (-.5, .5), (3.15, 3.2), TRIM)
    S(r, (-.5, .5), (-.5, .5), (top, top + 0.04), TRIM)


@M("door_frame", "P0", "floor", "structure", (1, 1, 3.2))
def door_frame(r):
    _wall_around_door(r, PLASTER, WAL)
    S(r, (-.475, .475), (-.5, .5), (0, 0.015), BRASS)                   # threshold
    for s_ in (-1, 1):                                                   # brass inlay on jambs
        S(r, (-.4755, -.4745) if s_ < 0 else (.4745, .4755), (-.4, .4), (0.3, 2.5), BRASS_D)


@M("door_leaf", "P0", "floor", "structure", (0.95, 0.05, 2.6))
def door_leaf(r):
    S(r, (0.0, 0.95), (-.025, .025), (0, 2.6), WAL, bv=0.006)
    for y, s_ in ((-.028, -1), (.028, 1)):
        for (x0, x1, z0, z1) in ((0.12, 0.83, 0.15, 1.15), (0.12, 0.83, 1.3, 2.45)):
            S(r, (x0, x1), (y - .006, y + .006), (z0, z1), WAL_D)
        B(r, (0.85, y + s_ * .012, 1.0), (0.16, 0.018, 0.028), BRASS, bv=0.004)
        B(r, (0.85, y + s_ * .004, 1.0), (0.04, 0.02, 0.05), BRASS_D)
    for z in (0.3, 1.3, 2.3):
        C(r, (0.01, 0, z), 0.015, 0.16, BRASS, v=8, smooth=True)


@M("door_glass_frame", "P0", "floor", "structure", (1, 1, 3.2))
def door_glass_frame(r):
    S(r, (-.5, -.475), (-.5, .5), (0, 2.6), STEEL_D)
    S(r, (.475, .5), (-.5, .5), (0, 2.6), STEEL_D)
    S(r, (-.5, .5), (-.5, .5), (2.6, 3.2), STEEL_B)
    S(r, (-.5, .5), (-.5, -.46), (2.6, 2.65), STEEL)
    S(r, (-.5, .5), (.46, .5), (2.6, 2.65), STEEL)
    S(r, (-.44, .44), (-.012, .012), (2.7, 3.15), GLASS)
    S(r, (-.5, .5), (-.03, .03), (2.9, 2.93), STEEL)
    S(r, (-.475, .475), (-.5, .5), (0, 0.012), STEEL_D)


@M("door_glass_leaf", "P0", "floor", "structure", (0.95, 0.05, 2.6))
def door_glass_leaf(r):
    S(r, (0, 0.95), (-.025, .025), (0, 0.12), STEEL, bv=0.005)
    S(r, (0, 0.95), (-.025, .025), (2.48, 2.6), STEEL, bv=0.005)
    S(r, (0, 0.1), (-.025, .025), (0.12, 2.48), STEEL, bv=0.005)
    S(r, (0.85, 0.95), (-.025, .025), (0.12, 2.48), STEEL, bv=0.005)
    S(r, (0.1, 0.85), (-.008, .008), (0.12, 2.48), GLASS)
    for s in (-1, 1):
        C(r, (0.78, s * .06, 1.1), 0.014, 0.9, STEEL, v=8, smooth=True)
        B(r, (0.78, s * .04, 0.7), (0.02, 0.05, 0.02), STEEL)
        B(r, (0.78, s * .04, 1.5), (0.02, 0.05, 0.02), STEEL)
    for z in (0.3, 2.3):
        C(r, (0.0, 0, z), 0.016, 0.14, STEEL_D, v=8, smooth=True)


def _keypad(r, x, y, z):
    kp = pv("keypad", r, (x, y, z))
    S(kp, (x - .09, x + .09), (y - .04, y), (z - .13, z + .13), STEEL_B, bv=0.006)
    S(kp, (x - .07, x + .07), (y - .044, y - .04), (z + .01, z + .1), E_SCREEN)
    for i in range(3):
        for j in range(3):
            B(kp, (x - .04 + i * .04, y - .046, z - .015 - j * .04), (0.028, 0.012, 0.028), GRAPH_L)
    B(kp, (x + .05, y - .046, z + .115), (0.025, 0.012, 0.012), E_LED_R)
    return kp


@M("door_security_frame", "P0", "floor", "structure", (1, 1, 3.2))
def door_security_frame(r):
    EXCL["door_security_frame"] = {"keypad"}
    S(r, (-.5, -.475), (-.5, .5), (0, 2.6), STEEL_D)
    S(r, (.475, .5), (-.5, .5), (0, 2.6), STEEL_D)
    S(r, (-.5, .5), (-.5, .5), (2.6, 3.2), STEEL_B, bv=0.01)
    S(r, (-.5, .5), (-.5, -.46), (2.6, 2.7), STEEL_D)
    for i in range(6):                                             # hazard chevrons on header
        B(r, (-.4 + i * .16, -.502, 2.9), (0.09, 0.006, 0.2), YELLOW, rot=(0, 0, 0))
    B(r, (0, -.5, 3.08), (0.16, 0.03, 0.06), E_LED_R)              # status light
    S(r, (-.475, .475), (-.5, .5), (0, 0.02), STEEL)
    _keypad(r, 0.62, -0.5, 1.25)


@M("door_security_leaf", "P0", "floor", "structure", (0.95, 0.06, 2.6))
def door_security_leaf(r):
    S(r, (0, 0.95), (-.03, .03), (0, 2.6), STEEL_D, bv=0.008)
    for y in (-.032, .032):
        S(r, (0.08, 0.87), (y - .004, y + .004), (0.12, 2.48), STEEL)
        for z in (0.5, 1.0, 1.5, 2.0):
            S(r, (0.08, 0.87), (y - .006, y + .006), (z - .012, z + .012), STEEL_B)
    for i in range(4):
        B(r, (0.1 + i * 0.22, -.036, 0.06), (0.1, 0.006, 0.08), YELLOW)
    B(r, (0.83, -.05, 1.05), (0.04, 0.04, 0.3), STEEL_B, bv=0.004)
    C(r, (0.83, -.06, 1.05), 0.05, 0.02, STEEL, v=10, ax="y", smooth=True)
    for z in (0.3, 1.3, 2.3):
        C(r, (0.01, 0, z), 0.03, 0.18, STEEL_B, v=8, smooth=True)


@M("door_slide", "P0", "floor", "structure", (2, 1, 3.2))
def door_slide(r):
    S(r, (-1, 1), (-.5, .5), (2.65, 3.2), STEEL_B, bv=0.01)
    S(r, (-1, -.95), (-.5, .5), (0, 2.65), STEEL_D)
    S(r, (.95, 1), (-.5, .5), (0, 2.65), STEEL_D)
    S(r, (-.95, .95), (-.06, .06), (0, 0.015), STEEL_D)               # track
    S(r, (-.95, .95), (-.5, -.4), (2.55, 2.65), STEEL)
    B(r, (0, -.42, 2.6), (0.7, 0.03, 0.03), E_LED_G)                   # sensor
    for s, nm, yy in ((-1, "leafL", -.045), (1, "leafR", .045)):
        p = pv(nm, r, (s * .475, yy, 0))
        cx = s * .475
        S(p, (cx - .475, cx + .475), (yy - .02, yy + .02), (0.02, 0.1), STEEL)
        S(p, (cx - .475, cx + .475), (yy - .02, yy + .02), (2.5, 2.6), STEEL)
        S(p, (cx - .475, cx - .43), (yy - .02, yy + .02), (0.1, 2.5), STEEL)
        S(p, (cx + .43, cx + .475), (yy - .02, yy + .02), (0.1, 2.5), STEEL)
        S(p, (cx - .43, cx + .43), (yy - .006, yy + .006), (0.1, 2.5), GLASS)
        B(p, (cx - s * .44, yy - .03, 1.1), (0.02, 0.03, 0.4), STEEL_B)


@M("elevator_door", "P0", "floor", "structure", (2, 1, 3.2))
def elevator_door(r):
    brushed = mat("#8b929a", 0.35, 0.65)
    S(r, (-1, 1), (-.5, .5), (2.7, 3.2), STEEL_B, bv=0.01)
    S(r, (-1, -.9), (-.5, .5), (0, 2.7), STEEL_D, bv=0.008)
    S(r, (.9, 1), (-.5, .5), (0, 2.7), STEEL_D, bv=0.008)
    S(r, (-.9, .9), (.3, .5), (0, 2.7), VOID)                          # car shaft
    S(r, (-.9, .9), (-.3, .0), (0, 0.02), BRASS)                     # sill
    S(r, (-1, 1), (-.5, -.46), (2.7, 2.76), BRASS)
    B(r, (0, -.505, 2.95), (0.5, 0.02, 0.2), BLACK)
    B(r, (0, -.512, 2.95), (0.36, 0.01, 0.12), E_SCREEN)               # indicator
    for s, nm in ((-1, "leafL"), (1, "leafR")):
        p = pv(nm, r, (s * .45, -.15, 0))
        cx = s * .45
        S(p, (cx - .45, cx + .45), (-.19, -.11), (0.02, 2.7), brushed, bv=0.005)
        S(p, (cx - .36, cx + .36), (-.197, -.19), (0.3, 2.4), STEEL, bv=0.004)
        S(p, (cx - .01, cx + .01), (-.2, -.19), (0.3, 2.4), STEEL_B)


@M("vault_door", "P0", "floor", "structure", (3, 1.2, 3.2))
def vault_door(r):
    S(r, (-1.5, -1.15), (-.6, .6), (0, 3.2), STEEL_D, bv=0.02)
    S(r, (1.15, 1.5), (-.6, .6), (0, 3.2), STEEL_D, bv=0.02)
    S(r, (-1.15, 1.15), (-.6, .6), (2.75, 3.2), STEEL_D, bv=0.02)
    S(r, (-1.15, 1.15), (-.6, .6), (0, 0.45), STEEL_D, bv=0.02)
    S(r, (-1.15, 1.15), (.35, .6), (.45, 2.75), STEEL_B)               # back plate
    C(r, (0, .34, 1.6), 1.08, 0.06, VOID, v=32, ax="y")                # dark recess
    annulus(r, (0, .3, 1.6), 1.2, 1.06, 0.16, STEEL, v=32, ax="y")
    S(r, (-1.5, -1.15), (-.6, -.55), (0, 3.2), STEEL, bv=0.01)
    S(r, (1.15, 1.5), (-.6, -.55), (0, 3.2), STEEL, bv=0.01)
    S(r, (-1.15, 1.15), (-.6, -.55), (2.75, 3.2), STEEL, bv=0.01)
    S(r, (-1.15, 1.15), (-.6, -.55), (0, 0.45), STEEL, bv=0.01)
    for z in (0.3, 1.6, 2.9):
        C(r, (-1.2, -.52, z), 0.08, 0.22, BRASS, v=10, smooth=True)     # hinges
    B(r, (1.32, -.62, 2.7), (0.14, 0.05, 0.14), E_LED_R)
    B(r, (1.32, -.615, 2.4), (0.14, 0.03, 0.14), BLACK)
    slab = pv("slab", r, (-1.15, -.12, 1.55))
    C(slab, (0, -.12, 1.55), 1.06, 0.46, STEEL_D, v=32, ax="y", smooth=True)
    C(slab, (0, -.36, 1.55), 0.9, 0.06, STEEL, v=32, ax="y", smooth=True)
    C(slab, (0, -.4, 1.55), 0.3, 0.06, STEEL_B, v=20, ax="y", smooth=True)
    for i in range(12):
        a = i * PI / 6
        C(slab, (math.cos(a) * 0.98, -.4, 1.55 + math.sin(a) * 0.98), 0.055, 0.06, BRASS, v=8, ax="y", smooth=True)
    for i in range(12):
        a = i * PI / 6 + PI / 12
        C(slab, (math.cos(a) * 0.62, -.4, 1.55 + math.sin(a) * 0.62), 0.03, 0.04, BRASS_D, v=6, ax="y")
    wh = pv("wheel", slab, (0, -.46, 1.55))
    C(wh, (0, -.5, 1.55), 0.09, 0.14, BRASS, v=12, ax="y", smooth=True)
    for i in range(6):
        a = i * PI / 3
        beam(wh, (math.cos(a) * 0.05, -.5, 1.55 + math.sin(a) * 0.05), (math.cos(a) * 0.44, -.5, 1.55 + math.sin(a) * 0.44), 0.05, 0.05, BRASS)
        C(wh, (math.cos(a) * 0.48, -.5, 1.55 + math.sin(a) * 0.48), 0.05, 0.1, BRASS_D, v=8, ax="y", smooth=True)
    annulus(wh, (0, -.5, 1.55), 0.44, 0.4, 0.05, BRASS, v=24, ax="y")



# =================================================================== GALA / LOBBY / BAR
def _leg4(r, x, y, z0, z1, m, t=0.04, xs=None, ys=None):
    for sx in (-1, 1):
        for sy in (-1, 1):
            S(r, (sx * x - t / 2, sx * x + t / 2), (sy * y - t / 2, sy * y + t / 2), (z0, z1), m)


@M("sofa_2", "P0", "floor", "gala", (2, 1, 0.9))
def sofa_2(r):
    for x in (-.9, .9):
        for y in (-.38, .38):
            C(r, (x, y, 0.05), 0.04, 0.1, BRASS, v=8, r2=0.028)
    S(r, (-1, 1), (-.46, .46), (0.1, 0.3), CHAR, bv=0.012)
    S(r, (-.86, .86), (.2, .46), (0.3, 0.88), NAVY, bv=0.03, seg=2)
    for x0 in (-.85, .01):
        S(r, (x0, x0 + .84), (-.44, .22), (0.3, 0.5), NAVY_L, bv=0.035, seg=2)
        B(r, (x0 + .42, .14, 0.66), (0.8, 0.16, 0.4), NAVY_L, bv=0.03, seg=2, rot=(D(-10), 0, 0))
    for s_ in (-1, 1):
        S(r, ((.86, 1.0) if s_ > 0 else (-1.0, -.86)), (-.46, .46), (0.1, 0.66), NAVY, bv=0.03, seg=2)
        S(r, ((.86, 1.0) if s_ > 0 else (-1.0, -.86)), (-.46, .46), (0.64, 0.68), BRASS, bv=0.01)


@M("armchair", "P0", "floor", "gala", (1, 1, 0.9))
def armchair(r):
    for x in (-.4, .4):
        for y in (-.4, .4):
            C(r, (x, y, 0.05), 0.04, 0.1, BRASS, v=8, r2=0.028)
    S(r, (-.48, .48), (-.48, .48), (0.1, 0.3), CHAR, bv=0.012)
    S(r, (-.36, .36), (.2, .48), (0.3, 0.9), OX, bv=0.03, seg=2)
    S(r, (-.36, .36), (-.44, .22), (0.3, 0.5), OX_L, bv=0.035, seg=2)
    B(r, (0, .15, 0.68), (0.66, 0.16, 0.4), OX_L, bv=0.03, seg=2, rot=(D(-10), 0, 0))
    for s_ in (-1, 1):
        S(r, ((.36, .48) if s_ > 0 else (-.48, -.36)), (-.48, .48), (0.1, 0.62), OX, bv=0.03, seg=2)
        S(r, ((.36, .48) if s_ > 0 else (-.48, -.36)), (-.48, .48), (0.6, 0.64), BRASS, bv=0.01)


@M("coffee_table", "P0", "floor", "gala", (1, 1, 0.45))
def coffee_table(r):
    for sx in (-1, 1):
        for sy in (-1, 1):
            S(r, (sx * .44 - .02, sx * .44 + .02), (sy * .44 - .02, sy * .44 + .02), (0, 0.42), BRASS, bv=0.005)
    ring4(r, -.46, .46, -.46, .46, 0.4, 0.45, 0.03, BRASS, bv=0.004)
    S(r, (-.44, .44), (-.44, .44), (0.415, 0.435), GLASS)
    S(r, (-.36, .36), (-.36, .36), (0.1, 0.13), MARB_B, bv=0.004)
    B(r, (-.1, .1, 0.5 - 0.07), (0.16, 0.22, 0.02), OX, rot=(0, 0, D(20)))          # book on lower shelf? on glass
    B(r, (.15, -.12, 0.145), (0.12, 0.08, 0.03), MARB_W)


@M("table_round", "P0", "floor", "gala", (2, 2, 0.8))
def table_round(r):
    C(r, (0, 0, 0.02), 0.34, 0.04, BRASS, v=16)
    C(r, (0, 0, 0.4), 0.06, 0.76, WAL_D, v=10, smooth=True)
    C(r, (0, 0, 0.3), 0.9, 0.04, BLACK, v=24)
    C(r, (0, 0, 0.53), 0.97, 0.5, CLOTH, v=32, r2=0.97, smooth=True)                  # cloth skirt (drops from top)
    C(r, (0, 0, 0.76), 0.98, 0.05, CLOTH, v=32)
    for a in (0.6, 3.7):
        x, y = math.cos(a) * 0.5, math.sin(a) * 0.5
        C(r, (x, y, 0.8), 0.024, 0.06, GLASS, v=8, smooth=True)                      # stem/bowl
        C(r, (x, y, 0.855), 0.055, 0.1, GLASS, v=10, r2=0.032, smooth=True)
    C(r, (0.0, 0.0, 0.79), 0.04, 0.04, BRASS, v=10, smooth=True)
    C(r, (0.0, 0.0, 0.825), 0.012, 0.03, WHITE, v=6)
    B(r, (0.0, 0.0, 0.85), (0.012, 0.012, 0.014), E_LAMP)
    for a in (2.2, 5.3):
        x, y = math.cos(a) * 0.62, math.sin(a) * 0.62
        C(r, (x, y, 0.788), 0.11, 0.012, MARB_W, v=12)       # plates


@M("chair_dining", "P0", "floor", "gala", (1, 1, 0.9))
def chair_dining(r):
    _leg4(r, .19, .19, 0, 0.46, WAL_D, 0.04)
    S(r, (-.22, .22), (-.22, .22), (0.44, 0.5), WAL, bv=0.008)
    S(r, (-.19, .19), (-.19, .19), (0.5, 0.55), OX, bv=0.012, seg=2)
    for sx in (-1, 1):
        S(r, (sx * .19 - .02, sx * .19 + .02), (.17, .21), (0.46, 0.9), WAL_D)
    S(r, (-.21, .21), (.165, .215), (0.78, 0.9), WAL, bv=0.008)
    S(r, (-.16, .16), (.145, .165), (0.6, 0.76), OX_L, bv=0.01)


@M("bar_counter", "P0", "floor", "gala", (1, 1, 1.1))
def bar_counter(r):
    S(r, (-.5, .5), (-.4, .4), (0.08, 1.0), WAL_D, bv=0.006)
    S(r, (-.5, .5), (-.4, .4), (0, 0.08), BLACK)
    for u in (-.33, 0, .33):
        S(r, (u - .13, u + .13), (-.415, -.4), (0.2, 0.9), WAL, bv=0.004)
        S(r, (u - .13, u + .13), (-.42, -.414), (0.2, 0.9) if False else (0.5, 0.52), BRASS)
    S(r, (-.5, .5), (-.5, .44), (1.0, 1.06), MARB_B, bv=0.008)
    S(r, (-.5, .5), (-.5, -.485), (1.0, 1.06), BRASS, bv=0.004)
    for (x, y, l, a) in ((-.15, -.05, .5, 25), (.25, .15, .4, -40), (0, .25, .3, 70)):
        B(r, (x, y, 1.061), (l, 0.012, 0.003), MARB_V, rot=(0, 0, D(a)))
    C(r, (0, -.47, 0.16), 0.025, 1.0, BRASS, v=8, ax="x", smooth=True)                # foot rail
    for x in (-.4, .4):
        S(r, (x - .012, x + .012), (-.47, -.4), (0.13, 0.19), BRASS)
    S(r, (-.5, .5), (.39, .41), (0.7, 0.72), BRASS_D)


@M("bar_corner", "P0", "floor", "gala", (1, 1, 1.1))
def bar_corner(r):
    S(r, (-.4, .5), (-.4, .5), (0.08, 1.0), WAL_D, bv=0.006)
    S(r, (-.4, .5), (-.4, .5), (0, 0.08), BLACK)
    for u in (-.1, .25):
        S(r, (-.415, -.4), (u - .13, u + .13), (0.2, 0.9), WAL, bv=0.004)
        S(r, (u - .13, u + .13), (-.415, -.4), (0.2, 0.9), WAL, bv=0.004)
    S(r, (-.5, .5), (-.5, .5), (1.0, 1.06), MARB_B, bv=0.008)
    S(r, (-.5, .5), (-.5, -.485), (1.0, 1.06), BRASS, bv=0.004)
    S(r, (-.5, -.485), (-.5, .5), (1.0, 1.06), BRASS, bv=0.004)
    C(r, (0, -.47, 0.16), 0.025, 0.98, BRASS, v=8, ax="x", smooth=True)
    C(r, (-.47, 0, 0.16), 0.025, 0.98, BRASS, v=8, ax="y", smooth=True)
    P(r, (-.47, -.47, 0.16), 0.035, BRASS, seg=8, rings=4)
    S(r, (.3, .5), (.3, .5), (1.06, 1.1), MARB_V)         # small back bar-top ledge (bartender side)


@M("bar_backshelf", "P0", "floor", "gala", (1, 1, 2.2))
def bar_backshelf(r):
    rng = random.Random(4)
    S(r, (-.5, .5), (-.4, .5), (0, 0.9), WAL_D, bv=0.006)                       # lower cabinet
    S(r, (-.46, .46), (-.415, -.4), (0.15, 0.85), WAL, bv=0.004)
    S(r, (-.5, .5), (-.45, .5), (0.9, 0.95), MARB_B, bv=0.006)
    S(r, (-.48, .48), (.44, .5), (0.95, 2.2), STEEL_B)                       # mirror/back panel
    S(r, (-.46, .46), (.435, .44), (1.0, 2.15), mat("#1c2430", 0.1, 0.7))
    for x in (-.5, .5):
        S(r, (x - .02, x + .02), (.1, .5), (0.95, 2.2), WAL_D)
    S(r, (-.5, .5), (.1, .5), (2.15, 2.2), WAL, bv=0.006)
    bcols = [mat("#2c6b45", .1, 0, "bottle_green"), mat("#8a4b16", .1, 0, "b_amber"), mat("#d8dcd8", .2), mat("#1a1c22", .15), mat("#7a1a22", .2)]
    for zi, z in enumerate((1.25, 1.65, 2.05)):
        S(r, (-.48, .48), (.12, .46), (z - .02, z), WAL, bv=0.004)
        S(r, (-.46, .46), (.11, .13), (z - .05, z - .02), E_LAMP)          # under-shelf strip
        for i in range(7):
            x = -.4 + i * .135 + rng.uniform(-.01, .01)
            h = rng.uniform(.17, .24)
            m = bcols[(i + zi) % len(bcols)]
            C(r, (x, .3 + rng.uniform(-.03, .03), z + h / 2), 0.038, h, m, v=8, smooth=True)
            C(r, (x, .3, z + h + .05), 0.014, 0.1, m, v=6)


@M("bar_stool", "P0", "floor", "gala", (1, 1, 0.75))
def bar_stool(r):
    C(r, (0, 0, 0.015), 0.19, 0.03, BRASS, v=16, smooth=True)
    C(r, (0, 0, 0.38), 0.03, 0.72, BRASS, v=8, smooth=True)
    annulus(r, (0, 0, 0.24), 0.17, 0.15, 0.025, BRASS, v=16)
    for i in range(4):
        a = i * PI / 2 + PI / 4
        beam(r, (0, 0, 0.24), (math.cos(a) * .16, math.sin(a) * .16, 0.24), 0.015, 0.015, BRASS)
    C(r, (0, 0, 0.7), 0.2, 0.06, OX, v=16, smooth=True)
    C(r, (0, 0, 0.665), 0.16, 0.02, BRASS, v=16)


def _leaf(r, base, az, tilt, length, width, m):
    q = Euler((tilt, 0, az), "XYZ").to_matrix()
    dv = q @ Vector((0, 0, 1))
    c = Vector(base) + dv * (length / 2)
    P(r, c, 1.0, m, sc=(width, 0.02, length / 2), seg=6, rings=4, rot=(tilt, 0, az))


def _plant(r, n, pot_r, pot_h, spread, height, seed):
    rng = random.Random(seed)
    pot = mat("#1d2226", 0.35)
    C(r, (0, 0, pot_h / 2), pot_r, pot_h, pot, v=10, r2=pot_r * 0.8)
    annulus(r, (0, 0, pot_h), pot_r * 1.02, pot_r * 0.9, 0.03, BRASS, v=10)
    C(r, (0, 0, pot_h - 0.02), pot_r * 0.9, 0.03, mat("#1a130c", 1.0), v=10)
    lm = [mat("#2a6a3a", 0.5), mat("#1f5530", 0.5), mat("#3b8048", 0.5)]
    for i in range(n):
        az = i * (2 * PI / n) + rng.uniform(-.3, .3)
        tilt = D(rng.uniform(28, 60))
        ln = height * rng.uniform(0.4, 0.55)
        _leaf(r, (0, 0, pot_h), az, tilt, ln, spread, lm[i % 3])
    for i in range(3):
        _leaf(r, (0, 0, pot_h), rng.uniform(0, 6), D(rng.uniform(4, 14)), (height - pot_h) * 0.85, spread * 0.9, lm[i % 3])


@M("plant_large", "P0", "floor", "gala", (1, 1, 1.6))
def plant_large(r):
    _plant(r, 9, 0.3, 0.5, 0.15, 1.6, 11)


@M("plant_small", "P0", "floor", "gala", (1, 1, 0.8))
def plant_small(r):
    _plant(r, 7, 0.2, 0.28, 0.09, 0.8, 5)


@M("painting_wall", "P0", "wall", "gala", (1, 0.1, 1.4))
def painting_wall(r):
    S(r, (-.5, .5), (-.1, 0), (0, 0.06), BRASS, bv=0.006)
    S(r, (-.5, .5), (-.1, 0), (1.34, 1.4), BRASS, bv=0.006)
    S(r, (-.5, -.44), (-.1, 0), (0.06, 1.34), BRASS, bv=0.006)
    S(r, (.44, .5), (-.1, 0), (0.06, 1.34), BRASS, bv=0.006)
    S(r, (-.44, .44), (-.06, -.02), (0.06, 1.34), BLACK)
    S(r, (-.42, .42), (-.07, -.06), (0.08, 1.32), NAVY)
    S(r, (-.42, .05), (-.075, -.07), (0.08, 0.7), OX)
    S(r, (-.1, .42), (-.075, -.07), (0.7, 1.32), CHAR)
    S(r, (.05, .42), (-.077, -.07), (0.08, 0.6), mat("#c9c1a8", 0.7))
    S(r, (-.42, -.1), (-.077, -.07), (0.7, 1.0), BRASS_D)
    S(r, (-.42, .42), (-.08, -.07), (0.64, 0.66), BRASS)


@M("statue_bust", "P0", "floor", "gala", (1, 1, 1.7))
def statue_bust(r):
    S(r, (-.46, .46), (-.46, .46), (0, 0.1), MARB_B, bv=0.01)
    S(r, (-.38, .38), (-.38, .38), (0.1, 0.16), MARB_W, bv=0.008)
    S(r, (-.25, .25), (-.25, .25), (0.16, 1.05), MARB_B, bv=0.008)
    S(r, (-.26, .26), (-.26, .26), (0.16, 0.19), BRASS, bv=0.004)
    S(r, (-.3, .3), (-.3, .3), (1.05, 1.13), MARB_W, bv=0.01)
    S(r, (-.31, .31), (-.31, .31), (1.13, 1.15), BRASS, bv=0.004)
    P(r, (0, 0, 1.3), 0.22, MARB_W, sc=(1.0, 0.55, 0.75), seg=10, rings=6)
    C(r, (0, 0, 1.46), 0.07, 0.14, MARB_W, v=8, smooth=True)
    P(r, (0, 0, 1.58), 0.125, MARB_W, sc=(0.9, 1.0, 1.15), seg=10, rings=6)
    B(r, (0, -.115, 1.57), (0.03, 0.04, 0.06), MARB_W)


# =================================================================== OFFICE / SECURITY / SERVER / VAULT
def _monitor(r, x, y, z, w=0.5, h=0.3, ang=0.0, screen_m=None, name=None):
    """desktop monitor whose base stand sits at (x,y,z); screen faces -Y (rotated by ang about Z)."""
    screen_m = screen_m or E_SCREEN
    g = Euler((0, 0, ang), "XYZ").to_matrix()

    def L(dx, dy, dz):
        v = g @ Vector((dx, dy, dz))
        return (x + v.x, y + v.y, z + v.z)
    B(r, L(0, 0.02, 0.008), (0.22, 0.16, 0.016), BLACK, rot=(0, 0, ang))
    B(r, L(0, 0.05, 0.08), (0.04, 0.03, 0.14), BLACK, rot=(0, 0, ang))
    B(r, L(0, 0.0, 0.14 + h / 2), (w, 0.03, h), BLACK, bv=0.004, rot=(0, 0, ang))
    B(r, L(0, -0.017, 0.14 + h / 2), (w - 0.03, 0.006, h - 0.03), screen_m, name=name, rot=(0, 0, ang))


@M("desk_office", "P0", "floor", "office", (2, 1, 0.75))
def desk_office(r):
    S(r, (-1, 1), (-.48, .48), (0.69, 0.75), WAL, bv=0.008)
    S(r, (-.95, -.9), (-.42, .42), (0, 0.69), WAL_D)
    S(r, (-.95, .95), (.36, .4), (0.2, 0.69), WAL_D)                             # modesty panel
    S(r, (.32, .95), (-.42, .42), (0, 0.69), WAL_D, bv=0.006)                    # drawer pedestal
    for i in range(3):
        z0 = 0.06 + i * 0.21
        S(r, (.34, .93), (-.435, -.42), (z0, z0 + 0.19), WAL, bv=0.004)
        B(r, (.635, -.45, z0 + .1), (0.16, 0.025, 0.02), BRASS, bv=0.004)
    S(r, (-.95, .32), (-.42, -.38), (0.62, 0.69), WAL_D)
    _monitor(r, -.3, .2, 0.75, 0.5, 0.3, 0, E_SCREEN, "screen")
    B(r, (-.3, -.16, 0.765), (0.4, 0.14, 0.02), BLACK, bv=0.004)                   # keyboard
    B(r, (-.3, -.16, 0.777), (0.36, 0.1, 0.004), GRAPH_L)
    B(r, (.0, -.14, 0.767), (0.06, 0.09, 0.025), BLACK, bv=0.006)                  # mouse
    B(r, (.62, .05, 0.765), (0.25, 0.32, 0.03), PAPER, rot=(0, 0, D(12)))
    B(r, (.62, .05, 0.79), (0.24, 0.3, 0.02), mat("#c9ccd4", 0.9), rot=(0, 0, D(-8)))
    C(r, (.85, .3, 0.8), 0.04, 0.1, BRASS, v=8, smooth=True)


@M("office_chair", "P0", "floor", "office", (1, 1, 1.0))
def office_chair(r):
    for i in range(5):
        a = i * 2 * PI / 5 + PI / 2
        beam(r, (0, 0, 0.1), (math.cos(a) * .3, math.sin(a) * .3, 0.09), 0.05, 0.03, STEEL_B)
        C(r, (math.cos(a) * .3, math.sin(a) * .3, 0.035), 0.035, 0.07, BLACK, v=8, smooth=True)
    C(r, (0, 0, 0.28), 0.04, 0.35, STEEL, v=8, smooth=True)
    S(r, (-.26, .26), (-.26, .26), (0.42, 0.5), CHAR, bv=0.03, seg=2)
    S(r, (-.24, .24), (.2, .27), (0.5, 0.98), CHAR, bv=0.03, seg=2, rot=(D(8), 0, 0))
    for s_ in (-1, 1):
        S(r, (s_ * .29 - .015, s_ * .29 + .015), (-.15, .12), (0.66, 0.69), BLACK, bv=0.005)
        S(r, (s_ * .29 - .015, s_ * .29 + .015), (.08, .11), (0.5, 0.67), BLACK)


@M("filing_cabinet", "P0", "floor", "office", (1, 1, 1.3))
def filing_cabinet(r):
    gm = mat("#3a4048", 0.5, 0.5)
    S(r, (-.48, .48), (-.42, .42), (0, 1.3), gm, bv=0.01)
    for i in range(4):
        z0 = 0.05 + i * 0.31
        S(r, (-.45, .45), (-.435, -.42), (z0, z0 + 0.28), GRAPH, bv=0.006)
        B(r, (0, -.45, z0 + .21), (0.3, 0.03, 0.03), STEEL, bv=0.005)
        B(r, (0, -.44, z0 + .1), (0.18, 0.012, 0.07), PAPER)
    S(r, (-.5, .5), (-.44, .44), (1.3 - 0.03, 1.3), STEEL_D)


@M("bookshelf", "P0", "floor", "office", (2, 1, 2.0))
def bookshelf(r):
    rng = random.Random(7)
    S(r, (-1, -.96), (-.45, .45), (0, 2.0), WAL_D)
    S(r, (.96, 1), (-.45, .45), (0, 2.0), WAL_D)
    S(r, (-1, 1), (.42, .45), (0, 2.0), WAL_D)
    S(r, (-1.0, 1.0), (-.45, .45), (0, 0.1), BLACK)
    S(r, (-1.02, 1.02), (-.47, .47), (1.96, 2.0), WAL, bv=0.008)
    cols = [OX, NAVY, mat("#1f4a3a", .8), mat("#8a6a2c", .8), CHAR, mat("#c9c1a8", .8), WAL_L, mat("#3a2a5a", .8)]
    for zi, z in enumerate((0.1, 0.58, 1.06, 1.54)):
        S(r, (-.96, .96), (-.44, .44), (z, z + 0.03), WAL, bv=0.004)
        if zi == 4 and False:
            continue
        for row_y in (-.33, -.05):
            x = -.92
            while x < .9:
                w = rng.uniform(.05, .1)
                h = rng.uniform(.28, .4)
                if rng.random() < 0.08:
                    x += rng.uniform(.06, .14)
                    continue
                if x + w > .94:
                    break
                B(r, (x + w / 2, row_y - rng.uniform(0, .04), z + .03 + h / 2), (w, 0.22, h), rng.choice(cols),
                  rot=(0, 0, 0) if rng.random() > 0.05 else (0, D(rng.uniform(-14, 14)), 0)) if row_y < -.2 else None
                x += w + 0.003
    # spine mid divider
    S(r, (-.01, .01), (-.44, .44), (0.1, 1.96), WAL_D)


@M("copier", "P0", "floor", "office", (1, 1, 1.0))
def copier(r):
    lg = mat("#c9ccd2", 0.5)
    S(r, (-.46, .46), (-.44, .44), (0, 0.9), lg, bv=0.012)
    S(r, (-.46, .46), (-.4, .4), (0, 0.1), GRAPH)
    S(r, (-.48, .48), (-.42, .42), (0.9, 0.98), CHAR, bv=0.012)
    S(r, (-.42, .42), (-.05, .38), (0.98, 1.0), GLASS_D)
    for i in range(2):
        S(r, (-.4, .4), (-.415, -.4), (0.14 + i * 0.3, 0.4 + i * 0.3), GRAPH_L, bv=0.006)
        B(r, (0, -.43, 0.32 + i * 0.3), (0.2, 0.03, 0.02), STEEL_D)
    B(r, (.25, -.35, 0.94), (0.24, 0.16, 0.04), BLACK, rot=(D(-15), 0, 0))
    B(r, (.25, -.42, 0.945), (0.16, 0.06, 0.004), E_SCREEN)
    B(r, (.1, -.43, 0.95), (0.03, 0.03, 0.02), E_LED_G)
    S(r, (-.4, .0), (-.46, -.4), (0.6, 0.65), STEEL_D)


@M("water_cooler", "P0", "floor", "office", (0.55, 0.55, 1.1))
def water_cooler(r):
    lg = mat("#d5d8dc", 0.5)
    S(r, (-.24, .24), (-.24, .24), (0, 0.98), lg, bv=0.012)
    S(r, (-.2, .2), (-.245, -.24), (0.15, 0.75), GRAPH)
    B(r, (0, -.26, 0.62), (0.1, 0.03, 0.05), RED_P)
    B(r, (-.12, -.26, 0.62), (0.06, 0.03, 0.05), mat("#3a6ea8", 0.5))
    B(r, (.12, -.26, 0.62), (0.03, 0.03, 0.03), E_LED_G)
    S(r, (-.16, .16), (-.28, -.2), (0.4, 0.42), STEEL)
    C(r, (0, 0, 0.98 + 0.05), 0.22, 0.1, lg, v=14, smooth=True)
    C(r, (0, 0, 1.05), 0.2, 0.15, GLASS, v=14, smooth=True)


@M("meeting_table", "P0", "floor", "office", (3, 2, 0.75))
def meeting_table(r):
    S(r, (-1.5, 1.5), (-.95, .95), (0.69, 0.75), WAL, bv=0.02, seg=2)
    S(r, (-1.4, 1.4), (-.85, .85), (0.75, 0.756), mat("#20140b", 0.35))
    for x in (-.85, .85):
        S(r, (x - .18, x + .18), (-.6, .6), (0, 0.06), STEEL_B, bv=0.008)
        S(r, (x - .06, x + .06), (-.4, .4), (0.06, 0.69), STEEL_D, bv=0.008)
    for x in (-.4, 0, .4):
        B(r, (x, 0, 0.757), (0.1, 0.1, 0.006), BRASS)
    B(r, (0, 0, 0.758), (0.06, 0.06, 0.004), BLACK)
    for i in range(4):
        B(r, (-.9 + i * .6, .55 * (1 if i % 2 else -1), 0.762), (0.2, 0.14, 0.012), PAPER, rot=(0, 0, D(i * 25)))


@M("laptop", "P0", "floor", "office", (0.4, 0.3, 0.25))
def laptop(r):
    B(r, (0, 0, 0.011), (0.36, 0.25, 0.022), STEEL_D, bv=0.004)
    B(r, (0, -.02, 0.0225), (0.3, 0.1, 0.002), BLACK)
    B(r, (0, -.085, 0.0225), (0.08, 0.05, 0.002), GRAPH_L)
    # lid hinged at back edge, opened ~105 deg
    a = D(15)
    lid_c = Vector((0, 0.125, 0.022)) + Vector((0, math.sin(a) * 0.115, math.cos(a) * 0.115)) * 1.0
    B(r, lid_c, (0.36, 0.014, 0.23), STEEL_D, bv=0.004, rot=(-a, 0, 0))
    sc = lid_c + Vector((0, -0.009 * math.cos(a), -0.009 * -math.sin(a)))
    B(r, (lid_c.x, lid_c.y - 0.008 * math.cos(a), lid_c.z + 0.008 * math.sin(a)), (0.33, 0.004, 0.2), E_SCREEN, rot=(-a, 0, 0))


@M("safe_small", "P0", "floor", "office", (1, 1, 1.0))
def safe_small(r):
    S(r, (-.45, .45), (-.42, .42), (0, 0.06), STEEL_B)
    S(r, (-.45, -.37), (-.42, .42), (0.06, 1.0), STEEL_D, bv=0.008)
    S(r, (.37, .45), (-.42, .42), (0.06, 1.0), STEEL_D, bv=0.008)
    S(r, (-.45, .45), (.34, .42), (0.06, 1.0), STEEL_D, bv=0.008)
    S(r, (-.45, .45), (-.42, .42), (0.94, 1.0), STEEL_D, bv=0.008)
    S(r, (-.37, .37), (.3, .34), (0.08, 0.93), mat("#07080a", 1.0))              # dark interior back
    S(r, (-.37, .37), (-.34, .3), (0.06, 0.08), mat("#07080a", 1.0))
    S(r, (-.37, .37), (-.3, .3), (0.5, 0.52), STEEL_B)                            # shelf
    for z in (0.15, 0.82):
        C(r, (-.4, -.44, z), 0.025, 0.12, BRASS, v=8, smooth=True)
    d = pv("door", r, (-.4, -.44, 0.5))
    S(d, (-.4, .4), (-.5, -.38), (0.06, 0.94), STEEL, bv=0.01)
    S(d, (-.34, .34), (-.505, -.5), (0.12, 0.88), STEEL_D)
    C(d, (0.08, -.53, 0.5), 0.13, 0.05, BRASS_D, v=20, ax="y", smooth=True)
    C(d, (0.08, -.56, 0.5), 0.075, 0.03, BRASS, v=16, ax="y", smooth=True)
    B(d, (0.08, -.585, 0.55), (0.012, 0.012, 0.05), BLACK)
    for i in range(12):
        a = i * PI / 6
        B(d, (0.08 + math.cos(a) * .115, -.555, 0.5 + math.sin(a) * .115), (0.01, 0.01, 0.01), BRASS)
    B(d, (.29, -.55, 0.72), (0.03, 0.035, 0.03), E_LED_R)
    B(d, (.29, -.545, 0.28), (0.04, 0.03, 0.12), STEEL_B)


@M("security_desk", "P0", "floor", "office", (3, 1, 1.1))
def security_desk(r):
    # centre + two angled wings
    segs = [(0.0, 0.0, 1.3, 0.0), (-.95, -0.06, 0.85, D(-14)), (.95, -0.06, 0.85, D(14))]
    for cx, cy, w, a in segs:
        B(r, (cx, cy, 0.34), (w, 0.8, 0.68), CHAR, bv=0.012, rot=(0, 0, a))
        B(r, (cx, cy, 0.7), (w + 0.05, 0.84, 0.06), MARB_B, bv=0.008, rot=(0, 0, a))
    B(r, (0, -.44, 0.5), (1.2, 0.02, 0.02), BRASS_D)
    ms = [E_SCREEN, E_SCREEN_G, E_SCREEN, E_SCREEN_G, E_SCREEN]
    pos = [(-1.05, .08, D(-14)), (-.53, .14, D(-6)), (0, .16, 0), (.53, .14, D(6)), (1.05, .08, D(14))]
    for i, (x, y, a) in enumerate(pos):
        _monitor(r, x, y, 0.73, 0.5, 0.26, a, ms[i])
    for x in (-.3, .3):
        B(r, (x, -.22, 0.74), (0.36, 0.13, 0.02), BLACK, bv=0.004)
    B(r, (-1.0, -.2, 0.735), (0.2, 0.14, 0.01), GRAPH_L)
    B(r, (0.95, -.22, 0.745), (0.06, 0.06, 0.03), E_LED_R)


@M("breaker_panel", "P0", "wall", "office", (1, 0.15, 1.0))
def breaker_panel(r):
    gm = mat("#3c4046", 0.5, 0.5)
    S(r, (-.46, .46), (-.02, 0), (0, 1.0), STEEL_B)
    S(r, (-.46, -.44), (-.14, -.02), (0, 1.0), gm)
    S(r, (.44, .46), (-.14, -.02), (0, 1.0), gm)
    S(r, (-.46, .46), (-.14, -.02), (0.98, 1.0), gm)
    S(r, (-.46, .46), (-.14, -.02), (0, 0.02), gm)
    for row in range(3):
        for i in range(7):
            B(r, (-.31 + i * .1, -.05, 0.18 + row * .22), (0.055, 0.04, 0.09), BLACK)
            B(r, (-.31 + i * .1, -.075, 0.2 + row * .22), (0.03, 0.02, 0.03), GRAPH_L)
            if (i + row) % 3 == 0:
                B(r, (-.31 + i * .1, -.072, 0.28 + row * .22), (0.02, 0.01, 0.015), E_LED_G)
    B(r, (.38, -.06, 0.8), (0.05, 0.05, 0.05), E_LED_G)
    d = pv("door", r, (-.46, -.14, 0.5))
    S(d, (-.46, .42), (-.185, -.14), (0.02, 0.98), STEEL, bv=0.006)
    B(d, (.2, -.2, 0.5), (0.05, 0.02, 0.4), STEEL_B)
    B(d, (.34, -.22, 0.55), (0.05, 0.04, 0.05), RED_P)
    B(d, (-.35, -.2, 0.85), (0.14, 0.01, 0.06), YELLOW)


@M("keypad_wall", "P0", "wall", "office", (0.3, 0.08, 0.4))
def keypad_wall(r):
    S(r, (-.14, .14), (-.05, 0), (0.0, 0.4), STEEL_B, bv=0.008)
    S(r, (-.12, .12), (-.058, -.05), (0.24, 0.36), BLACK)
    S(r, (-.1, .1), (-.062, -.058), (0.26, 0.34), E_SCREEN)
    for i in range(3):
        for j in range(4):
            B(r, (-.06 + i * .06, -.06, 0.03 + j * .047 + 0.0), (0.045, 0.014, 0.035), GRAPH_L)
    B(r, (.1, -.058, 0.375), (0.03, 0.01, 0.015), E_LED_R)


@M("terminal_hack", "P0", "floor", "office", (1, 1, 1.3))
def terminal_hack(r):
    S(r, (-.44, .44), (-.44, .44), (0, 0.7), STEEL_B, bv=0.015)
    S(r, (-.44, .44), (-.4, .4), (0, 0.06), BLACK)
    for i in range(4):
        S(r, (-.34 + i * .22, -.28 + i * .22), (-.41, -.4), (0.12, 0.6), GRAPH, bv=0.004)
    S(r, (-.46, .46), (-.42, .3), (0.7, 0.78), STEEL_D, bv=0.015)                  # keyboard shelf
    B(r, (0, -.18, 0.79), (0.6, 0.2, 0.02), BLACK, bv=0.004)
    B(r, (0, -.18, 0.802), (0.55, 0.16, 0.004), mat("#20e0c0", 0.5, 0, "emit_keys_teal", emit="#20e0c0", strength=1.2))
    B(r, (0, .18, 1.0), (0.9, 0.12, 0.6), STEEL_B, bv=0.015, rot=(D(-14), 0, 0))
    B(r, (0, .105, 1.02), (0.8, 0.02, 0.5), E_SCREEN_T, rot=(D(-14), 0, 0))
    S(r, (-.44, -.38), (.05, .4), (0.7, 1.28), STEEL_B, bv=0.01)
    S(r, (.38, .44), (.05, .4), (0.7, 1.28), STEEL_B, bv=0.01)
    S(r, (-.44, .44), (.3, .4), (1.2, 1.3), STEEL_D, bv=0.01)
    B(r, (.3, -.43, 0.4), (0.05, 0.02, 0.05), E_LED_G)


@M("server_rack", "P0", "floor", "office", (1, 1, 2.0))
def server_rack(r):
    rng = random.Random(3)
    S(r, (-.45, .45), (-.45, .47), (0.08, 2.0), BLACK, bv=0.01)
    S(r, (-.46, .46), (-.46, .48), (0, 0.08), STEEL_B)
    S(r, (-.46, .46), (-.46, .48), (1.96, 2.0), STEEL_B)
    for i in range(10):
        z = 0.14 + i * 0.185
        S(r, (-.38, .38), (-.475, -.45), (z, z + 0.15), GRAPH, bv=0.004)
        S(r, (-.34, .1), (-.481, -.475), (z + .035, z + .115), BLACK)
        for k in range(3):
            m = E_LED_G if rng.random() > 0.25 else E_LED_R
            B(r, (0.14 + k * 0.055, -.49, z + 0.075), (0.032, 0.02, 0.032), m)
        for k in range(3):
            B(r, (-.3 + k * .06, -.484, z + 0.075), (0.03, 0.01, 0.08), GRAPH_L)
    for x in (-.45, .45):
        S(r, (x - .02, x + .02), (-.47, -.44), (0.08, 1.96), STEEL_D)


@M("safe_deposit_wall", "P0", "floor", "office", (2, 1, 2.4))
def safe_deposit_wall(r):
    S(r, (-1, 1), (-.5, .5), (0, 0.15), STEEL_B)
    S(r, (-1, 1), (-.5, .5), (2.3, 2.4), STEEL_B)
    S(r, (-.98, .98), (-.42, .5), (0.15, 2.3), STEEL_D)
    cols, rows = 8, 6
    bw, bh = 0.235, 0.34
    brushed = mat("#9098a0", 0.4, 0.65)
    for i in range(cols):
        for j in range(rows):
            x = -.98 + 0.015 + bw / 2 + i * (bw + 0.0075) if False else (-0.985 + (i + .5) * (1.97 / cols))
            z = 0.2 + (j + .5) * (2.05 / rows)
            S(r, (x - bw / 2 + .006, x + bw / 2 - .006), (-.445, -.42), (z - bh / 2 + .006, z + bh / 2 - .006), brushed)
            B(r, (x, -.457, z + .01), (0.05, 0.02, 0.012), BRASS)
    S(r, (-.985, .985), (-.46, -.42), (2.28, 2.3), BRASS)
    S(r, (-1, 1), (-.5, -.44), (0.15, 0.2), BRASS_D)


BANK_G = mat("#4f6f4e", 0.9)
BANK_Y = mat("#7c8878", 0.9)
BANK_B = mat("#b9b8a4", 0.9)


def _bundle(r, x, y, z, w, d, h, m):
    S(r, (x - w / 2, x + w / 2), (y - d / 2, y + d / 2), (z, z + h), m)
    S(r, (x - w * .08, x + w * .08), (y - d / 2 - .002, y + d / 2 + .002), (z - .001, z + h + .001), BANK_B)


@M("cash_pallet", "P0", "floor", "office", (1, 1, 0.9))
def cash_pallet(r):
    S(r, (-.5, .5), (-.5, .5), (0.09, 0.14), WAL_L)
    for x in (-.45, 0, .45):
        S(r, (x - .06, x + .06), (-.5, .5), (0, 0.09), WAL)
    for i in range(7):
        S(r, (-.5, .5), (-.5 + i * .147, -.5 + i * .147 + .12), (0.14, 0.15), WAL_L)
    z = 0.15
    for layer in range(8):
        for ix in (-1, 1):
            for iy in (-1, 1):
                m = BANK_G if (layer + (ix > 0)) % 2 == 0 else BANK_Y
                _bundle(r, ix * .225, iy * .225, z, 0.44, 0.44, 0.09, m)
        z += 0.095
    for zz in (0.35, 0.65):
        ring4(r, -.463, .463, -.463, .463, zz, zz + 0.03, 0.006, BLACK)


@M("cash_stack", "P0", "floor", "office", (0.4, 0.2, 0.2))
def cash_stack(r):
    for i in range(2):
        for j in range(2):
            _bundle(r, -.1 + i * .2, 0, j * .1, 0.2, 0.2, 0.1, BANK_G if (i + j) % 2 == 0 else BANK_Y)


@M("gold_bar_stack", "P0", "floor", "office", (0.5, 0.3, 0.3))
def gold_bar_stack(r):
    layers = [(2, 3), (2, 2), (2, 1), (1, 1)]
    for li, (nx, ny) in enumerate(layers):
        for i in range(nx):
            for j in range(ny):
                x = (i - (nx - 1) / 2) * 0.245
                y = (j - (ny - 1) / 2) * 0.1
                B(r, (x, y, li * 0.075 + 0.035), (0.24, 0.095, 0.07), GOLD, bv=0.01)


@M("briefcase", "P0", "floor", "office", (0.5, 0.35, 0.15))
def briefcase(r):
    S(r, (-.25, .25), (-.175, .175), (0, 0.14), LEATHER, bv=0.012, seg=2)
    S(r, (-.25, .25), (-.005, .005), (0.0, 0.14), BLACK)
    for x in (-.14, .14):
        B(r, (x, -.178, 0.115), (0.05, 0.012, 0.03), BRASS)
    B(r, (-.07, 0, 0.152), (0.012, 0.03, 0.02), BRASS_D)
    B(r, (.07, 0, 0.152), (0.012, 0.03, 0.02), BRASS_D)
    B(r, (0, 0, 0.16), (0.16, 0.014, 0.012), LEATHER)


@M("loot_bag", "P0", "floor", "office", (0.6, 0.3, 0.3))
def loot_bag(r):
    can = mat("#1f2a24", 0.9)
    C(r, (0, 0, 0.14), 0.14, 0.34, can, v=10, ax="x", smooth=True)
    for s_ in (-1, 1):
        P(r, (s_ * .17, 0, 0.14), 0.14, can, seg=10, rings=6)
    for x in (-.12, .12):
        B(r, (x, 0, 0.14), (0.03, 0.29, 0.29), BLACK)
    B(r, (0, 0, 0.283), (0.34, 0.02, 0.008), BLACK)
    S(r, (-.12, -.11), (-.02, .02), (0.28, 0.3), BLACK)
    S(r, (.11, .12), (-.02, .02), (0.28, 0.3), BLACK)
    S(r, (-.12, .12), (-.02, .02), (0.295, 0.305), BLACK)


@M("keycard", "P0", "floor", "office", (0.24, 0.24, 0.02))
def keycard(r):
    C(r, (0, 0, 0.002), 0.12, 0.004, E_MARK, v=20)
    B(r, (0, 0, 0.009), (0.09, 0.06, 0.01), STEEL_B, bv=0.002)
    B(r, (0, 0.015, 0.0145), (0.07, 0.008, 0.002), E_LED_G)
    B(r, (-.02, -.012, 0.0145), (0.03, 0.02, 0.002), BRASS)


@M("usb_drive", "P0", "floor", "office", (0.24, 0.24, 0.02))
def usb_drive(r):
    C(r, (0, 0, 0.002), 0.12, 0.004, E_MARK, v=20)
    B(r, (0, -.005, 0.011), (0.02, 0.055, 0.014), BLACK, bv=0.002)
    B(r, (0, .035, 0.011), (0.014, 0.025, 0.007), STEEL)
    B(r, (0, -.03, 0.019), (0.012, 0.01, 0.002), E_MARK)




# =================================================================== KITCHEN / BACK-OF-HOUSE / ALLEY
SS = mat("#b4bac0", 0.32, 0.65)         # stainless
SS_D = mat("#7a8087", 0.4, 0.65)


@M("counter_kitchen", "P0", "floor", "kitchen", (1, 1, 0.9))
def counter_kitchen(r):
    S(r, (-.5, .5), (-.46, .46), (0, 0.06), BLACK)
    S(r, (-.48, .48), (-.44, .44), (0.06, 0.84), SS_D, bv=0.008)
    S(r, (-.5, .5), (-.5, .48), (0.84, 0.9), SS, bv=0.01)
    for x in (-.24, .24):
        S(r, (x - .22, x + .22), (-.455, -.44), (0.12, 0.8), SS, bv=0.006)
        C(r, (x + (.15 if x < 0 else -.15), -.475, 0.6), 0.012, 0.22, STEEL_B, v=8, smooth=True)
    B(r, (0, .47, 0.92), (0.98, 0.04, 0.04), SS, bv=0.005)


@M("stove_range", "P0", "floor", "kitchen", (1, 1, 1.0))
def stove_range(r):
    S(r, (-.48, .48), (-.44, .44), (0.0, 0.9), SS_D, bv=0.01)
    S(r, (-.48, .48), (-.44, .44), (0.9, 0.94), BLACK, bv=0.006)
    for (x, y) in ((-.22, -.14), (.22, -.14), (-.22, .2), (.22, .2)):
        annulus(r, (x, y, 0.945), 0.13, 0.08, 0.012, STEEL_B, v=14)
        C(r, (x, y, 0.95), 0.06, 0.012, VOID, v=12)
    S(r, (-.46, .46), (.4, .46), (0.94, 1.0), SS_D, bv=0.006)
    S(r, (-.42, .42), (-.465, -.44), (0.1, 0.62), SS, bv=0.008)
    S(r, (-.3, .3), (-.475, -.465), (0.22, 0.5), GLASS_D)
    B(r, (0, -.5, 0.6), (0.7, 0.03, 0.03), STEEL_B, bv=0.004)
    for i in range(4):
        C(r, (-.3 + i * .2, -.47, 0.8), 0.03, 0.03, STEEL_B, v=10, ax="y", smooth=True)
    B(r, (.42, -.47, 0.75), (0.03, 0.02, 0.03), E_LED_R)


@M("fridge_large", "P0", "floor", "kitchen", (1, 1, 2.0))
def fridge_large(r):
    S(r, (-.46, .46), (-.42, .42), (0, 2.0), SS, bv=0.015, seg=2)
    S(r, (-.46, .46), (-.435, -.42), (0.7, 0.71), BLACK)
    S(r, (-.46, .46), (-.435, -.42), (0.04, 0.05), BLACK)
    for x in (-.4, -.32):
        pass
    B(r, (-.38, -.46, 1.5), (0.03, 0.04, 0.6), STEEL_B, bv=0.005)
    B(r, (-.38, -.46, 0.4), (0.03, 0.04, 0.4), STEEL_B, bv=0.005)
    S(r, (.1, .38), (-.44, -.42), (1.6, 1.85), BLACK)
    S(r, (.14, .34), (-.445, -.44), (1.68, 1.78), E_SCREEN)
    B(r, (.3, -.445, 1.64), (0.03, 0.01, 0.02), E_LED_G)
    S(r, (-.46, .46), (.42, .46), (0.3, 2.0), STEEL_D)


@M("sink_kitchen", "P0", "floor", "kitchen", (1, 1, 0.95))
def sink_kitchen(r):
    S(r, (-.5, .5), (-.46, .46), (0, 0.06), BLACK)
    S(r, (-.48, .48), (-.44, .44), (0.06, 0.84), SS_D, bv=0.008)
    S(r, (-.5, .5), (-.5, -.3), (0.84, 0.9), SS, bv=0.008)
    S(r, (-.5, .5), (.28, .5), (0.84, 0.9), SS, bv=0.008)
    S(r, (-.5, -.3), (-.3, .28), (0.84, 0.9), SS, bv=0.008)
    S(r, (.3, .5), (-.3, .28), (0.84, 0.9), SS, bv=0.008)
    S(r, (-.3, .3), (-.3, .28), (0.74, 0.78), SS_D)
    for s_ in (-.3, .3):
        pass
    S(r, (-.3, -.28), (-.3, .28), (0.76, 0.86), SS_D)
    S(r, (.28, .3), (-.3, .28), (0.76, 0.86), SS_D)
    S(r, (-.3, .3), (-.3, -.28), (0.76, 0.86), SS_D)
    S(r, (-.3, .3), (.26, .28), (0.76, 0.86), SS_D)
    C(r, (0, .34, 0.95), 0.03, 0.22, SS, v=8, smooth=True)
    beam(r, (0, .34, 1.05), (0, .18, 1.03), 0.035, 0.035, SS)
    B(r, (-.1, .38, 0.9), (0.03, 0.03, 0.04), STEEL_B)
    B(r, (.1, .38, 0.9), (0.03, 0.03, 0.04), STEEL_B)
    S(r, (-.42, .42), (-.455, -.44), (0.12, 0.78), SS, bv=0.006)
    B(r, (0, -.47, 0.62), (0.3, 0.02, 0.02), STEEL_B)


@M("cart_catering", "P0", "floor", "kitchen", (1, 1, 1.0))
def cart_catering(r):
    for sx in (-1, 1):
        for sy in (-1, 1):
            S(r, (sx * .42 - .02, sx * .42 + .02), (sy * .39 - .02, sy * .39 + .02), (0.08, 0.92), BRASS, bv=0.004)
            C(r, (sx * .42, sy * .39, 0.05), 0.05, 0.03, BLACK, v=10, ax="x", smooth=True)
    for z in (0.22, 0.86):
        S(r, (-.46, .46), (-.44, .44), (z, z + 0.04), SS, bv=0.006)
        ring4(r, -.46, .46, -.44, .44, z + .04, z + .07, 0.015, SS_D)
    S(r, (-.42, .42), (.36, .44), (0.92, 0.96), BRASS)
    B(r, (0, .44, 0.98), (0.9, 0.03, 0.03), BRASS, bv=0.004)
    for sx in (-1, 1):
        S(r, (sx * .44 - .015, sx * .44 + .015), (.36, .44), (0.9, 0.98), BRASS)
    for i in range(5):
        C(r, (-.3 + i * .15, -.05 + (i % 2) * .1, 0.94), 0.03, 0.08, GLASS, v=8, r2=0.02, smooth=True)
    S(r, (-.25, .25), (-.2, .15), (0.9, 0.91), WHITE)
    C(r, (-.2, .0, 0.3), 0.07, 0.15, WHITE, v=10, smooth=True)


def _crate(r, cx, cy, z0, s, ang=0.0):
    B(r, (cx, cy, z0 + s / 2), (s - .02, s - .02, s - .02), WAL_D, rot=(0, 0, ang))
    for k in range(3):
        zz = z0 + s * (0.17 + k * 0.33)
        B(r, (cx, cy, zz), (s, s, s * 0.2), WAL, rot=(0, 0, ang))
    for sx in (-1, 1):
        for sy in (-1, 1):
            g = Euler((0, 0, ang)).to_matrix() @ Vector((sx * (s / 2 - .02), sy * (s / 2 - .02), 0))
            B(r, (cx + g.x, cy + g.y, z0 + s / 2), (0.05, 0.05, s), WAL_L, rot=(0, 0, ang))


@M("crate_stack", "P0", "floor", "kitchen", (1, 1, 1.0))
def crate_stack(r):
    for i in (-1, 1):
        for j in (-1, 1):
            _crate(r, i * .25, j * .25, 0, 0.5)
    _crate(r, -.25, -.0, 0.5, 0.5, D(8))
    _crate(r, .27, .2, 0.5, 0.46, D(-14))


@M("locker_tall", "P0", "floor", "kitchen", (1, 1, 2.0))
def locker_tall(r):
    lk = mat("#3b5560", 0.45, 0.4)
    inner = mat("#0a0c0f", 1.0)
    S(r, (-.45, .45), (-.4, .4), (0, 0.06), BLACK)
    S(r, (-.45, -.41), (-.44, .44), (0.06, 2.0), lk)
    S(r, (.41, .45), (-.44, .44), (0.06, 2.0), lk)
    S(r, (-.45, .45), (.4, .44), (0.06, 2.0), lk)
    S(r, (-.45, .45), (-.44, .44), (1.96, 2.0), lk)
    S(r, (-.41, .41), (.38, .4), (0.06, 1.96), inner)
    S(r, (-.41, -.39), (-.4, .38), (0.06, 1.96), inner)
    S(r, (.39, .41), (-.4, .38), (0.06, 1.96), inner)
    S(r, (-.39, .39), (-.4, .38), (0.06, 0.08), inner)
    S(r, (-.39, .39), (-.4, .38), (1.6, 1.62), STEEL_B)
    for x in (-.2, 0, .2):
        B(r, (x, .2, 1.5), (0.03, 0.04, 0.04), STEEL)
    S(r, (-.39, .39), (-.4, .38), (1.94, 1.96), inner)
    d = pv("door", r, (-.45, -.46, 1.0))
    S(d, (-.45, .45), (-.48, -.44), (0.06, 1.96), lk, bv=0.008)
    for i in range(6):
        S(d, (-.3, .3), (-.485, -.48), (1.6 + i * .05, 1.63 + i * .05), inner)
    B(d, (.32, -.5, 1.0), (0.05, 0.03, 0.2), STEEL, bv=0.005)
    B(d, (0, -.483, 1.3), (0.2, 0.006, 0.07), PAPER)
    for z in (0.3, 1.0, 1.7):
        C(d, (-.45, -.46, z), 0.015, 0.14, STEEL_D, v=8, smooth=True)


@M("dumpster", "P0", "floor", "kitchen", (2, 1, 1.3))
def dumpster(r):
    dg = mat("#1c3a2a", 0.55, 0.3)
    dg2 = mat("#2a5540", 0.55, 0.3)
    S(r, (-.96, .96), (-.42, .42), (0.18, 1.12), dg, bv=0.012)
    S(r, (-1, 1), (-.46, .46), (1.05, 1.12), dg2, bv=0.01)
    for i in range(7):
        S(r, (-.9 + i * .3, -.84 + i * .3), (-.435, -.42), (0.25, 1.0), dg2)
    for x in (-.8, .8):
        S(r, (x - .1, x + .1), (-.36, .36), (0.08, 0.18), STEEL_B)
        C(r, (x, -.36, 0.07), 0.07, 0.06, BLACK, v=10, ax="x", smooth=True)
        C(r, (x, .36, 0.07), 0.07, 0.06, BLACK, v=10, ax="x", smooth=True)
    lid = pv("lid", r, (0, .46, 1.12))
    B(lid, (0, -.02, 1.24), (2.0, 0.94, 0.05), CHAR, bv=0.008, rot=(D(-13), 0, 0))
    for x in (-.5, .5):
        B(lid, (x, -.0, 1.28), (0.06, 0.06, 0.05), STEEL_B)
    B(lid, (0, -.45, 1.3 + -.0), (0.6, 0.04, 0.05), STEEL_B, rot=(D(-13), 0, 0))
    S(r, (-.98, .98), (.4, .46), (1.0, 1.12), dg2)


@M("trash_can", "P0", "floor", "kitchen", (0.6, 0.6, 0.85))
def trash_can(r):
    C(r, (0, 0, 0.4), 0.27, 0.8, STEEL_D, v=14, r2=0.3, smooth=True)
    annulus(r, (0, 0, 0.8), 0.31, 0.27, 0.04, STEEL, v=14)
    C(r, (0, 0, 0.83), 0.3, 0.04, STEEL_B, v=14, r2=0.26, smooth=True)
    C(r, (0, 0, 0.865), 0.05, 0.03, STEEL, v=8, smooth=True)
    for z in (0.15, 0.55):
        annulus(r, (0, 0, z), 0.29, 0.275, 0.03, STEEL_B, v=14)
    B(r, (0, -.3, 0.08), (0.12, 0.05, 0.02), BLACK)


@M("shelving_industrial", "P0", "floor", "kitchen", (2, 1, 2.0))
def shelving_industrial(r):
    bl = mat("#26456b", 0.5, 0.3)
    for x in (-.96, -.0, .96):
        for y in (-.45, .45):
            S(r, (x - .025, x + .025), (y - .025, y + .025), (0, 2.0), bl)
    for i, z in enumerate((0.15, 0.7, 1.25, 1.8)):
        S(r, (-.98, .98), (-.45, .45), (z, z + 0.03), STEEL_D, bv=0.004)
        S(r, (-.98, .98), (-.455, -.43), (z - .04, z), bl)
    rng = random.Random(9)
    for z, n in ((0.18, 4), (0.73, 3), (1.28, 4)):
        for k in range(n):
            x = -.75 + k * .5 + rng.uniform(-.05, .05)
            w, d_, h = rng.uniform(.3, .42), rng.uniform(.3, .5), rng.uniform(.25, .4)
            B(r, (x, rng.uniform(-.1, .1), z + h / 2), (w, d_, h), CARDB if k % 2 else CARDB_D)
    C(r, (.7, .0, 1.86), 0.08, 0.12, mat("#a03030", 0.5), v=8, smooth=True)


@M("pallet_boxes", "P0", "floor", "kitchen", (1, 1, 1.2))
def pallet_boxes(r):
    S(r, (-.5, .5), (-.5, .5), (0.09, 0.14), WAL_L)
    for x in (-.45, 0, .45):
        S(r, (x - .06, x + .06), (-.5, .5), (0, 0.09), WAL)
    z = 0.14
    for layer, n in enumerate((4, 4, 2)):
        pts = [(-.24, -.24), (.24, -.24), (-.24, .24), (.24, .24)][:n] if layer < 2 else [(-.24, 0), (.24, 0)]
        for k, (x, y) in enumerate(pts):
            h = 0.35
            m = CARDB if (k + layer) % 2 else CARDB_D
            B(r, (x, y, z + h / 2), (0.46, 0.46, h), m, bv=0.006)
            B(r, (x, y, z + h + .001), (0.06, 0.46, 0.004), PAPER)
            B(r, (x, y - .231, z + h / 2), (0.14, 0.004, 0.1), PAPER)
        z += 0.35
    ring4(r, -.49, .49, -.49, .49, 0.26, 0.28, 0.006, BLACK)


@M("barrel_steel", "P0", "floor", "kitchen", (0.6, 0.6, 0.9))
def barrel_steel(r):
    bm = mat("#2b3d4f", 0.4, 0.5)
    C(r, (0, 0, 0.45), 0.29, 0.9, bm, v=14, smooth=True)
    for z in (0.12, 0.45, 0.78):
        annulus(r, (0, 0, z), 0.31, 0.28, 0.035, STEEL_D, v=14)
    C(r, (0, 0, 0.9), 0.27, 0.02, STEEL_B, v=14)
    C(r, (.12, .1, 0.915), 0.04, 0.02, STEEL, v=8, smooth=True)
    B(r, (0, -.292, 0.6), (0.2, 0.01, 0.14), YELLOW)




# =================================================================== SECURITY TECH
def ringXZ(par, x0, x1, y0, y1, z0, z1, t, m, bv=0.0):
    S(par, (x0, x1), (y0, y1), (z0, z0 + t), m, bv=bv)
    S(par, (x0, x1), (y0, y1), (z1 - t, z1), m, bv=bv)
    S(par, (x0, x0 + t), (y0, y1), (z0 + t, z1 - t), m, bv=bv)
    S(par, (x1 - t, x1), (y0, y1), (z0 + t, z1 - t), m, bv=bv)


def _sec_screws(par, pts, y, m=BRASS, r=0.013):
    for (x, z) in pts:
        C(par, (x, y, z), r, 0.012, m, v=8, ax="y")


@M("security_camera", "P0", "wall", "tech", (0.4, 0.4, 0.35))
def security_camera(r):
    S(r, (-.13, .13), (-.03, 0), (0.06, 0.35), STEEL_B, bv=0.006)
    _sec_screws(r, [(-.09, .1), (.09, .1), (-.09, .31), (.09, .31)], -.033, STEEL)
    S(r, (-.03, .03), (-.15, -.03), (0.29, 0.34), STEEL_D, bv=0.004)
    h = pv("head", r, (0, -.15, 0.31))
    C(h, (0, -.15, 0.3), 0.025, 0.06, STEEL, v=8, smooth=True)
    B(h, (0, -.31, 0.23), (0.13, 0.3, 0.12), CHAR, bv=0.012, seg=2)
    B(h, (0, -.32, 0.3), (0.16, 0.34, 0.012), STEEL_D)
    C(h, (0, -.465, 0.23), 0.052, 0.04, STEEL_B, v=12, ax="y", smooth=True)
    C(h, (0, -.488, 0.23), 0.04, 0.012, GLASS_D, v=12, ax="y", smooth=True)
    B(h, (0.05, -.44, 0.292), (0.022, 0.022, 0.012), E_LED_R)
    B(h, (0, -.165, 0.23), (0.11, 0.02, 0.1), STEEL_D)


@M("laser_emitter", "P0", "wall", "tech", (0.25, 0.25, 0.25))
def laser_emitter(r):
    S(r, (-.125, .125), (-.02, 0), (0, 0.25), STEEL_B, bv=0.006)
    S(r, (-.1, .1), (-.2, -.02), (0.03, 0.22), CHAR, bv=0.012, seg=2)
    S(r, (-.1, .1), (-.2, -.18), (0.03, 0.05), BRASS_D)
    C(r, (0, -.205, 0.125), 0.05, 0.03, STEEL_B, v=12, ax="y", smooth=True)
    C(r, (0, -.225, 0.125), 0.032, 0.03, E_LASER, v=12, ax="y", smooth=True).name = "lens"
    _sec_screws(r, [(-.1, .02), (.1, .02), (-.1, .23), (.1, .23)], -.022, STEEL)


@M("laser_receiver", "P0", "wall", "tech", (0.25, 0.25, 0.25))
def laser_receiver(r):
    S(r, (-.125, .125), (-.02, 0), (0, 0.25), STEEL_B, bv=0.006)
    S(r, (-.1, .1), (-.2, -.02), (0.03, 0.22), CHAR, bv=0.012, seg=2)
    S(r, (-.1, .1), (-.2, -.18), (0.03, 0.05), STEEL_D)
    C(r, (0, -.205, 0.125), 0.05, 0.03, STEEL_B, v=12, ax="y", smooth=True)
    C(r, (0, -.225, 0.125), 0.032, 0.03, mat("#05070a", 0.1), v=12, ax="y", smooth=True).name = "lens"
    B(r, (0.075, -.2, 0.2), (0.02, 0.012, 0.02), E_LED_G)
    _sec_screws(r, [(-.1, .02), (.1, .02), (-.1, .23), (.1, .23)], -.022, STEEL)


@M("motion_sensor", "P0", "ceiling", "tech", (0.3, 0.3, 0.2))
def motion_sensor(r):
    S(r, (-.14, .14), (-.14, .14), (3.17, 3.2), STEEL_B, bv=0.006)
    C(r, (0, 0, 3.14), 0.12, 0.05, WHITE, v=16, r2=0.1, smooth=True)
    P(r, (0, 0, 3.12), 0.1, mat("#e4e4e0", 0.3), sc=(1, 1, 0.75), seg=14, rings=6)
    C(r, (0, 0, 3.075), 0.06, 0.03, BLACK, v=12, smooth=True)
    B(r, (0, -.09, 3.09), (0.03, 0.02, 0.02), E_LED_R)


@M("alarm_light", "P0", "wall", "tech", (0.3, 0.3, 0.3))
def alarm_light(r):
    S(r, (-.13, .13), (-.02, 0), (0.0, 0.3), STEEL_B, bv=0.006)
    S(r, (-.05, .05), (-.16, -.02), (0.04, 0.09), STEEL_D)
    C(r, (0, -.16, 0.08), 0.12, 0.04, STEEL_B, v=16, smooth=True)
    b = pv("beacon", r, (0, -.16, 0.1))
    C(b, (0, -.16, 0.2), 0.1, 0.18, E_LED_R, v=14, r2=0.1, smooth=True)
    P(b, (0, -.16, 0.29), 0.1, E_LED_R, seg=14, rings=5, sc=(1, 1, 0.55))
    B(b, (0, -.16, 0.2), (0.16, 0.025, 0.14), BLACK)              # rotating reflector bar (visible spin)
    B(b, (0, -.16, 0.2), (0.025, 0.16, 0.14), BLACK)
    for z in (0.11, 0.3):
        pass


@M("pressure_plate", "P0", "floor", "tech", (1, 1, 0.03))
def pressure_plate(r):
    S(r, (-.46, .46), (-.46, .46), (0, 0.025), STEEL_D, bv=0.004)
    ring4(r, -.48, .48, -.48, .48, 0, 0.03, 0.05, YELLOW)
    for i in range(6):
        B(r, (-.25 + i * .1, 0, 0.027), (0.03, 0.7, 0.006), STEEL_B)
    C(r, (.38, .38, 0.03), 0.028, 0.012, E_LED_R, v=10)
    B(r, (-.38, -.38, 0.03), (0.03, 0.03, 0.01), BRASS)


@M("vent_grate_wall", "P0", "wall", "tech", (1, 0.12, 0.7))
def vent_grate_wall(r):
    ringXZ(r, -.5, .5, -.1, 0, 0, 0.7, 0.05, STEEL_D, bv=0.004)
    S(r, (-.45, .45), (-.02, 0), (0.05, 0.65), VOID)
    g = pv("grate", r, (0, -.105, 0.35))
    ringXZ(g, -.48, .48, -.115, -.095, 0.02, 0.68, 0.035, STEEL, bv=0.003)
    for i in range(7):
        B(g, (0, -.107, 0.1 + i * .083), (0.88, 0.022, 0.035), STEEL_B, rot=(D(-28), 0, 0))
    _sec_screws(g, [(-.455, .045), (.455, .045), (-.455, .655), (.455, .655)], -.12, BRASS)


@M("vent_grate_floor", "P0", "floor", "tech", (1, 1, 0.05))
def vent_grate_floor(r):
    ring4(r, -.5, .5, -.5, .5, 0, 0.03, 0.06, STEEL_D)
    S(r, (-.44, .44), (-.44, .44), (0.0, 0.006), VOID)
    for x in (-.4, .4):
        S(r, (x - .015, x + .015), (-.44, .44), (0.006, 0.03), STEEL_B)
    g = pv("grate", r, (0, 0, 0.04))
    ring4(g, -.47, .47, -.47, .47, 0.03, 0.05, 0.035, STEEL, bv=0.003)
    for i in range(9):
        S(g, (-.43, .43), (-.4 + i * .1 - .02, -.4 + i * .1 + .02), (0.033, 0.048), STEEL_B)
    S(g, (-.02, .02), (-.43, .43), (0.03, 0.045), STEEL)
    for sx in (-1, 1):
        for sy in (-1, 1):
            C(g, (sx * .45, sy * .45, 0.05), 0.014, 0.008, BRASS, v=8)


_DIRS = {"W": (-1, 0, "-X"), "E": (1, 0, "+X"), "S": (0, -1, "+Z"), "N": (0, 1, "-Z")}


def duct(r, arms, grate_front=False):
    z0, z1, h = 0.05, 0.65, 0.4
    S(r, (-h, h), (-h, h), (z0, z1), STEEL, bv=0.008)
    for a in arms:
        dx, dy, _ = _DIRS[a]

        def A(u0, u1, v0, v1, za, zb, m, bv=0.0):
            cs = [(dx * u - dy * v, dy * u + dx * v) for u in (u0, u1) for v in (v0, v1)]
            S(r, (min(c[0] for c in cs), max(c[0] for c in cs)), (min(c[1] for c in cs), max(c[1] for c in cs)), (za, zb), m, bv=bv)
        A(0, 0.46, -h, h, z0, z1, STEEL, 0.008)
        A(0.24, 0.29, -h - .015, h + .015, z0 - .015, z1 + .015, STEEL_D)
        A(0.46, 0.5, .38, .47, .03, .69, STEEL_D)         # flange ring
        A(0.46, 0.5, -.47, -.38, .03, .69, STEEL_D)
        A(0.46, 0.5, -.38, .38, .03, .1, STEEL_D)
        A(0.46, 0.5, -.38, .38, .62, .69, STEEL_D)
        A(0.455, 0.475, -.38, .38, .1, .62, VOID)         # dark recess
        A(0.1, 0.4, -.05, .05, z1, z1 + .008, STEEL_D)    # top ridge
    if grate_front:
        for i in range(6):
            B(r, (0, -.425, 0.14 + i * 0.09), (0.6, 0.022, 0.035), STEEL_B, rot=(D(-25), 0, 0))
        S(r, (-.34, .34), (-.412, -.4), (0.1, 0.6), VOID)
        ringXZ(r, -.37, .37, -.42, -.4, 0.09, 0.61, 0.03, STEEL_D)


@M("vent_straight", "P0", "floor", "tech", (1, 1, 0.7), connects=["-X", "+X"])
def vent_straight(r):
    duct(r, "WE")


@M("vent_corner", "P0", "floor", "tech", (1, 1, 0.7), connects=["-X", "+Z"])
def vent_corner(r):
    duct(r, "WS")


@M("vent_tee", "P0", "floor", "tech", (1, 1, 0.7), connects=["-X", "+X", "+Z"])
def vent_tee(r):
    duct(r, "WES")


@M("vent_cross", "P0", "floor", "tech", (1, 1, 0.7), connects=["-X", "+X", "+Z", "-Z"])
def vent_cross(r):
    duct(r, "WESN")


@M("vent_end", "P0", "floor", "tech", (1, 1, 0.7), connects=["-X"])
def vent_end(r):
    S(r, (0, .5), (-.4, .4), (0.05, 0.65), STEEL, bv=0.008)
    duct(r, "W", grate_front=True)


# =================================================================== LIGHT FIXTURES
@M("ceiling_light_panel", "P0", "ceiling", "light", (1, 1, 0.1))
def ceiling_light_panel(r):
    S(r, (-.48, .48), (-.48, .48), (3.15, 3.2), STEEL_B)
    ring4(r, -.48, .48, -.48, .48, 3.1, 3.2, 0.05, STEEL_D, bv=0.004)
    S(r, (-.43, .43), (-.43, .43), (3.1, 3.13), E_LAMP)


@M("pendant_lamp", "P0", "ceiling", "light", (1, 1, 0.9))
def pendant_lamp(r):
    C(r, (0, 0, 3.185), 0.07, 0.03, BRASS, v=10)
    B(r, (0, 0, 2.92), (0.012, 0.012, 0.56), BLACK)
    C(r, (0, 0, 2.62), 0.045, 0.06, BRASS, v=10, smooth=True)
    C(r, (0, 0, 2.45), 0.3, 0.26, CHAR, v=18, r2=0.06, smooth=True)
    annulus(r, (0, 0, 2.32), 0.3, 0.285, 0.02, BRASS, v=18)
    C(r, (0, 0, 2.325), 0.285, 0.01, E_LAMP, v=18)
    P(r, (0, 0, 2.42), 0.07, E_LAMP, seg=8, rings=5)


@M("floor_lamp", "P0", "floor", "light", (0.35, 0.35, 1.8))
def floor_lamp(r):
    C(r, (0, 0, 0.015), 0.17, 0.03, BRASS, v=16, smooth=True)
    C(r, (0, 0, 0.9), 0.012, 1.7, BRASS, v=8, smooth=True)
    C(r, (0, 0, 1.65), 0.175, 0.3, E_LAMP, v=14, r2=0.13, smooth=True)
    annulus(r, (0, 0, 1.5), 0.175, 0.16, 0.015, BRASS, v=14)
    annulus(r, (0, 0, 1.8), 0.13, 0.115, 0.015, BRASS, v=14)
    C(r, (0, 0, 1.79), 0.03, 0.03, BRASS, v=8)


@M("desk_lamp", "P0", "floor", "light", (0.3, 0.3, 0.45))
def desk_lamp(r):
    C(r, (0, 0, 0.0125), 0.1, 0.025, BRASS, v=14, smooth=True)
    C(r, (0, 0, 0.16), 0.012, 0.27, BRASS, v=8, smooth=True)
    C(r, (0, 0, 0.38), 0.14, 0.14, GREEN_D, v=14, r2=0.06, smooth=True)
    C(r, (0, 0, 0.312), 0.125, 0.01, E_LAMP, v=14)
    C(r, (0, 0, 0.455), 0.02, 0.03, BRASS, v=8)


@M("wall_sconce", "P0", "wall", "light", (0.25, 0.12, 0.4))
def wall_sconce(r):
    S(r, (-.1, .1), (-.012, 0), (0.06, 0.34), BRASS, bv=0.004)
    B(r, (0, -.04, 0.2), (0.03, 0.06, 0.03), BRASS)
    C(r, (0, -.065, 0.2), 0.065, 0.22, E_LAMP, v=12, r2=0.075, smooth=True)
    C(r, (0, -.065, 0.3), 0.07, 0.03, BRASS, v=12, smooth=True)
    C(r, (0, -.065, 0.1), 0.06, 0.03, BRASS, v=12, smooth=True)
    for s_ in (-1, 1):
        beam(r, (0, -.04, 0.2), (s_ * .12, -.05, 0.28), 0.012, 0.012, BRASS)
        C(r, (s_ * .12, -.05, 0.29), 0.012, 0.03, BRASS, v=6)


@M("street_lamp", "P0", "floor", "light", (1, 1, 4.5))
def street_lamp(r):
    iron = mat("#1b1d21", 0.45, 0.6)
    S(r, (-.2, .2), (-.2, .2), (0, 0.12), iron, bv=0.008)
    C(r, (0, 0, 0.32), 0.14, 0.4, iron, v=8, r2=0.06, smooth=True)
    C(r, (0, 0, 2.3), 0.05, 3.9, iron, v=10, r2=0.04, smooth=True)
    for z in (0.75, 3.7):
        C(r, (0, 0, z), 0.075, 0.06, iron, v=10, smooth=True)
    C(r, (0, 0, 4.16), 0.2, 0.06, iron, v=6, r2=0.17)
    C(r, (0, 0, 4.4), 0.17, 0.42, E_LAMP, v=6, r2=0.2)
    for i in range(6):
        a = i * PI / 3
        beam(r, (math.cos(a) * .185, math.sin(a) * .185, 4.2), (math.cos(a) * .2, math.sin(a) * .2, 4.62), 0.02, 0.02, iron)
    C(r, (0, 0, 4.66), 0.26, 0.12, iron, v=6, r2=0.02)


def _tube(par, p0, p1, m, t=0.028):
    beam(par, p0, p1, t, t, m)


def _neon_letter(par, ch, cx, y, z0, z1, m, w=0.4):
    l, rr = cx - w / 2, cx + w / 2
    zm = (z0 + z1) / 2
    seg = lambda a, b, c, d: _tube(par, (a, y, b), (c, y, d), m)
    if ch == "B":
        seg(l, z0, l, z1); seg(l, z1, rr - .05, z1); seg(l, zm, rr, zm); seg(l, z0, rr - .05, z0)
        seg(rr, zm, rr, z1 - .05); seg(rr, z0 + .05, rr, zm); seg(rr - .05, z1, rr, z1 - .05); seg(rr - .05, z0, rr, z0 + .05)
    elif ch == "A":
        seg(l, z0, cx - .04, z1); seg(rr, z0, cx + .04, z1); seg(cx - .04, z1, cx + .04, z1); seg(l + .06, zm - .04, rr - .06, zm - .04)
    elif ch == "R":
        seg(l, z0, l, z1); seg(l, z1, rr - .05, z1); seg(l, zm, rr - .02, zm); seg(rr, zm + .02, rr, z1 - .05)
        seg(rr - .05, z1, rr, z1 - .05); seg(rr - .02, zm, rr, zm + .02); seg(cx - .05, zm, rr, z0)
    elif ch == "V":
        seg(l, z1, cx, z0); seg(rr, z1, cx, z0)
    elif ch == "I":
        seg(cx, z0, cx, z1); seg(cx - .08, z1, cx + .08, z1); seg(cx - .08, z0, cx + .08, z0)
    elif ch == "P":
        seg(l, z0, l, z1); seg(l, z1, rr - .05, z1); seg(l, zm, rr - .05, zm)
        seg(rr, zm + .05, rr, z1 - .05); seg(rr - .05, z1, rr, z1 - .05); seg(rr - .05, zm, rr, zm + .05)


def _neon(r, text, m):
    S(r, (-1, 1), (-.02, 0), (0, 0.5), BLACK, bv=0.004)
    for x in (-.9, .9):
        for z in (0.06, 0.44):
            C(r, (x, -.03, z), 0.012, 0.03, STEEL, v=6, ax="y")
    xs = {3: (-.55, 0, .55)}[len(text)]
    for ch, cx in zip(text, xs):
        _neon_letter(r, ch, cx, -.05, 0.1, 0.42, m)
    _tube(r, (-.88, -.05, 0.04), (.88, -.05, 0.04), m, 0.02)
    _tube(r, (-.88, -.05, 0.47), (.88, -.05, 0.47), m, 0.02)


@M("neon_sign", "P0", "wall", "light", (2, 0.1, 0.5))
def neon_sign(r):
    _neon(r, "BAR", E_NEON_P)


@M("neon_sign_blue", "P0", "wall", "light", (2, 0.1, 0.5))
def neon_sign_blue(r):
    _neon(r, "VIP", E_NEON_B)


@M("lamp_bulb_bare", "P0", "floor", "light", (0.15, 0.15, 0.15))
def lamp_bulb_bare(r):
    """origin = cord attachment point (swing pivot); hangs down to z=-0.15"""
    C(r, (0, 0, -0.03), 0.02, 0.06, BRASS, v=8, smooth=True)
    P(r, (0, 0, -0.1), 0.05, E_LAMP, seg=10, rings=6, sc=(1, 1, 1.15))


# =================================================================== EXTERIOR / ROOF / ALLEY
@M("roof_ac_unit", "P0", "floor", "exterior", (2, 1, 1.2))
def roof_ac_unit(r):
    ac = mat("#4d535a", 0.6, 0.4)
    ac_d = mat("#2b2f34", 0.6, 0.4)
    for x in (-.8, .8):
        S(r, (x - .1, x + .1), (-.4, .4), (0, 0.1), ac_d)
    S(r, (-.95, .95), (-.44, .44), (0.1, 1.02), ac, bv=0.012)
    S(r, (-.97, .97), (-.46, .46), (1.02, 1.06), ac_d, bv=0.01)
    for i in range(8):
        S(r, (-.9 + i * .225, -.9 + i * .225 + .19), (-.445, -.44), (0.2, 0.9), ac_d)
    for i in range(9):
        S(r, (-.955, -.95), (-.38 + i * .09, -.32 + i * .09), (0.2, 0.9), ac_d)
        S(r, (.95, .955), (-.38 + i * .09, -.32 + i * .09), (0.2, 0.9), ac_d)
    C(r, (-.35, 0, 1.075), 0.34, 0.03, VOID, v=20)
    annulus(r, (-.35, 0, 1.08), 0.38, 0.33, 0.1, STEEL_B, v=20)
    for i in range(2):
        a = i * PI / 2 + PI / 6
    for i in range(3):
        a = i * 2 * PI / 3 + 0.4
        beam(r, (-.35, 0, 1.06), (-.35 + math.cos(a) * .3, math.sin(a) * .3, 1.07), 0.09, 0.008, STEEL_D)
    for rr_ in (0.12, 0.22, 0.3):
        annulus(r, (-.35, 0, 1.11), rr_ + .006, rr_ - .006, 0.008, STEEL_D, v=16)
    C(r, (-.35, 0, 1.12), 0.04, 0.02, STEEL_B, v=8)
    S(r, (.3, .8), (-.3, .3), (1.06, 1.2), ac_d, bv=0.01)                 # control box on top
    for i in range(4):
        S(r, (.32 + i * .12, .38 + i * .12), (-.301, -.3), (1.1, 1.17), BLACK)
    B(r, (.9, .0, 0.62), (0.06, 0.2, 0.25), ac_d)


@M("helipad", "P0", "floor", "exterior", (5, 5, 0.05))
def helipad(r):
    C(r, (0, 0, 0.025), 2.5, 0.05, mat("#2b2c30", 0.95), v=40, smooth=True)
    annulus(r, (0, 0, 0.052), 2.2, 2.12, 0.004, E_MARK, v=40)
    annulus(r, (0, 0, 0.052), 1.72, 1.66, 0.004, E_MARK, v=40)
    for x in (-.35, .35):
        S(r, (x - .06, x + .06), (-.55, .55), (0.05, 0.054), E_MARK)
    S(r, (-.35, .35), (-.06, .06), (0.05, 0.054), E_MARK)
    for i in range(20):
        a = i * 2 * PI / 20
        C(r, (math.cos(a) * 2.38, math.sin(a) * 2.38, 0.06), 0.045, 0.03, E_LED_G, v=8)


@M("roof_door", "P0", "floor", "exterior", (1, 1, 2.6))
def roof_door(r):
    S(r, (-.5, -.45), (-.5, .5), (0, 2.6), CONC, bv=0.01)
    S(r, (.45, .5), (-.5, .5), (0, 2.6), CONC, bv=0.01)
    S(r, (-.5, .5), (-.5, .5), (2.4, 2.6), CONC_L, bv=0.01)
    S(r, (-.45, .45), (.2, .5), (0, 2.4), VOID)
    S(r, (-.45, .45), (-.5, -.44), (0, 0.05), STEEL_D)
    S(r, (-.45, -.42), (-.5, -.35), (0, 2.4), STEEL_D)
    S(r, (.42, .45), (-.5, -.35), (0, 2.4), STEEL_D)
    S(r, (-.45, .45), (-.5, -.35), (2.37, 2.4), STEEL_D)
    d = pv("door", r, (-.42, -.37, 1.2))
    S(d, (-.42, .42), (-.4, -.34), (0.05, 2.36), STEEL_B, bv=0.006)
    S(d, (-.3, .3), (-.405, -.4), (1.5, 1.95), GLASS_D)
    ringXZ(d, -.32, .32, -.415, -.4, 1.48, 1.97, 0.03, STEEL)
    B(d, (0, -.43, 0.95), (0.7, 0.03, 0.04), BRASS, bv=0.004)
    S(d, (-.4, .4), (-.405, -.4), (0.08, 0.35), STEEL_D)
    for z in (0.3, 1.2, 2.1):
        C(d, (-.42, -.37, z), 0.02, 0.15, STEEL_D, v=8, smooth=True)
    B(r, (0.0, -.505, 2.5), (0.34, 0.01, 0.1), YELLOW)
    B(r, (0.0, -.512, 2.5), (0.28, 0.006, 0.05), BLACK)


@M("fence_chainlink", "P0", "floor", "exterior", (1, 0.1, 2.0))
def fence_chainlink(r):
    wire = mat("#8b9199", 0.5, 0.7)
    for x in (-.48, .48):
        C(r, (x, 0.0, 1.0), 0.03, 2.0, STEEL_D, v=8, smooth=True)
        C(r, (x, 0.0, 2.0), 0.038, 0.04, STEEL_B, v=8)
    ring_top = 1.9
    beam(r, (-.48, 0.0, ring_top), (.48, 0.0, ring_top), 0.025, 0.025, STEEL_D)
    beam(r, (-.48, 0.0, 0.06), (.48, 0.0, 0.06), 0.02, 0.02, STEEL_D)
    x0, x1, z0, z1 = -.47, .47, .08, 1.89
    step = 0.13
    for sgn in (1, -1):
        c = -3.0
        while c < 4.0:
            # line: z = sgn*x + c inside rect
            pts = []
            for x in (x0, x1):
                z = sgn * x + c
                if z0 <= z <= z1:
                    pts.append((x, z))
            for z in (z0, z1):
                x = (z - c) / sgn
                if x0 <= x <= x1:
                    pts.append((x, z))
            uniq = []
            for p in pts:
                if all(abs(p[0] - q[0]) + abs(p[1] - q[1]) > 1e-4 for q in uniq):
                    uniq.append(p)
            if len(uniq) >= 2:
                beam(r, (uniq[0][0], 0.0 + (0.006 if sgn > 0 else -0.006), uniq[0][1]), (uniq[1][0], 0.0 + (0.006 if sgn > 0 else -0.006), uniq[1][1]), 0.008, 0.008, wire)
            c += step
    S(r, (-.48, .48), (-.02, .02), (0, 0.04), CONC_D)


@M("fire_escape_ladder", "P0", "wall", "exterior", (1, 0.5, 3.2))
def fire_escape_ladder(r):
    for x in (-.38, .38):
        S(r, (x - .02, x + .02), (-.22, -.18), (0.05, 3.2), STEEL_B)
    for i in range(10):
        z = 0.2 + i * 0.3
        C(r, (0, -.2, z), 0.015, 0.76, STEEL, v=8, ax="x", smooth=True)
    for z in (0.3, 1.6, 2.9):
        for x in (-.38, .38):
            S(r, (x - .02, x + .02), (-.2, 0), (z, z + 0.04), STEEL_D)
    for z in (1.5, 2.2, 2.9):                        # safety cage hoops
        S(r, (-.45, .45), (-.5, -.46), (z, z + 0.03), STEEL_D)
        for x in (-.45, .45):
            S(r, (x - .015, x + .015), (-.5, -.2), (z, z + 0.03), STEEL_D)
    for x in (-.45, -.15, .15, .45):
        S(r, (x - .012, x + .012), (-.5, -.47), (1.5, 3.2), STEEL_D)




# =================================================================== P1
def poly_xy(par, pts, z0, z1, m, name=None, smooth=False):
    bm = bmesh.new()
    a = [bm.verts.new((x, y, z0)) for x, y in pts]
    b = [bm.verts.new((x, y, z1)) for x, y in pts]
    bm.faces.new(a[::-1])
    bm.faces.new(b)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[j], a[i], b[i], b[j]))
    return _finish(bm, name, par, (0, 0, 0), m)


@M("vault_wall", "P1", "floor", "structure", (1, 1, 3.2))
def vault_wall(r):
    S(r, (-.5, .5), (-.5, .5), (0, 3.2), STEEL_D)
    S(r, (-.5, .5), (-.5, .5), (0, 0.12), STEEL_B)
    for z in (0.5, 1.6, 2.7):
        S(r, (-.505, .505), (-.505, .505), (z - .07, z + .07), STEEL_B)
        for k in range(4):
            for f in (0, 2):
                fbox(r, f, -.375 + k * .25, 0.035, z - .017, z + .017, BRASS_D, off=0.505, depth=0.014)
    S(r, (-.5, .5), (-.5, .5), (3.1, 3.2), STEEL_B)


@M("stairs_down", "P1", "floor", "structure", (2, 2, 1.5))
def stairs_down(r):
    n = 10
    for i in range(n):
        y0 = -1.0 + i * 0.19
        zt = -0.04 - i * 0.14
        S(r, (-.92, .92), (y0, y0 + 0.2), (-1.5, zt), STEEL_D)
        S(r, (-.92, .92), (y0, y0 + 0.055), (zt - 0.012, zt + 0.0), YELLOW)
        S(r, (-.92, .92), (y0 + .055, y0 + 0.2), (zt - 0.008, zt), STEEL_B)
    S(r, (-1, -.92), (-1, 1), (-1.5, 0.05), CONC_D)
    S(r, (.92, 1), (-1, 1), (-1.5, 0.05), CONC_D)
    S(r, (-.92, .92), (.9, 1), (-1.5, -0.4), VOID)
    for s_ in (-1, 1):                      # handrail on both sides
        x = s_ * .9
        for y in (-.85, 0.0, .85):
            S(r, (x - .015, x + .015), (y - .015, y + .015), (0.05, 0.9 - 0.14 * (y + 1) * 0.0), BRASS)
        beam(r, (x, -.85, 0.9), (x, .85, 0.9), 0.035, 0.035, BRASS)


@M("piano_grand", "P1", "floor", "gala", (3, 2, 1.1))
def piano_grand(r):
    pk = mat("#08090c", 0.15, 0.2)
    pts = [(-1.0, -0.875), (0.2, -0.875), (0.8, -0.8), (1.25, -0.55), (1.55, -0.15), (1.65, 0.3), (1.4, 0.55), (0.2, 0.82), (-1.0, 0.875)]
    dx = 0.1
    pts = [(x * 0.8 + dx, y * 0.98) for x, y in pts]
    poly_xy(r, pts, 0.72, 0.93, pk)
    poly_xy(r, [(x * 0.97 + 0.03, y * 0.97) for x, y in pts], 0.93, 0.955, mat("#15171c", 0.15, 0.2))
    for (x, y) in ((-0.62 + dx, -0.72), (-0.62 + dx, 0.72), (1.1 + dx, 0.15)):
        C(r, (x, y, 0.36), 0.05, 0.72, BRASS_D, v=8, r2=0.035, smooth=True)
        C(r, (x, y, 0.03), 0.05, 0.03, BRASS, v=8)
    S(r, (-.98 + dx, -.7 + dx), (-.72, .72), (0.7, 0.76), pk)             # key bed / slip
    S(r, (-1.06 + dx, -.72 + dx), (-.66, .66), (0.76, 0.8), WHITE)
    for i in range(14):
        B(r, (-.88 + dx, -.62 + i * 0.095, 0.815), (0.16, 0.012, 0.03), MARB_B if i in (1, 3, 4, 6, 7, 9, 11, 12) and False else WHITE)
    for k in (1, 2, 4, 5, 6, 8, 9, 11, 12):
        B(r, (-.9 + dx, -.66 + k * 0.095, 0.83), (0.09, 0.05, 0.03), BLACK)
    S(r, (-.68 + dx, -.6 + dx), (-.5, .5), (0.93, 1.1), pk)               # music desk
    S(r, (-.66 + dx, -.62 + dx), (-.46, .46), (0.98, 1.06), PAPER)
    for y in (-.2, .2):                                                    # pedal lyre
        S(r, (-.55 + dx, -.5 + dx), (y - .02, y + .02), (0.05, 0.4), BRASS_D)
    S(r, (-1.9 + dx, -1.55 + dx), (-.3, .3), (0.44, 0.5), OX, bv=0.01)      # bench
    for sx in (-1.87 + dx, -1.58 + dx):
        for sy in (-.26, .26):
            S(r, (sx - .02, sx + .02), (sy - .02, sy + .02), (0, 0.44), BLACK)


@M("stage_platform", "P1", "floor", "gala", (1, 1, 0.3))
def stage_platform(r):
    S(r, (-.5, .5), (-.5, .5), (0, 0.26), BASEB, bv=0.008)
    S(r, (-.5, .5), (-.5, .5), (0.26, 0.3), WAL, bv=0.008)
    S(r, (-.505, .505), (-.505, .505), (0.06, 0.09), BRASS)
    S(r, (-.48, .48), (-.48, .48), (0.3, 0.304), mat("#141419", 0.8))
    ring4(r, -.44, .44, -.44, .44, 0.3, 0.306, 0.012, BRASS_D)


@M("speaker_tall", "P1", "floor", "gala", (1, 1, 1.6))
def speaker_tall(r):
    S(r, (-.3, .3), (-.28, .28), (0.06, 1.6), BLACK, bv=0.015, seg=2)
    S(r, (-.32, .32), (-.3, .3), (0, 0.06), STEEL_B)
    for z, rr in ((0.45, 0.19), (1.1, 0.13)):
        C(r, (0, -.285, z), rr + 0.02, 0.03, GRAPH_L, v=16, ax="y", smooth=True)
        C(r, (0, -.3, z), rr, 0.03, CHAR, v=16, ax="y", smooth=True)
        C(r, (0, -.31, z), rr * 0.35, 0.03, STEEL_D, v=10, ax="y", smooth=True)
    C(r, (0, -.3, 1.45), 0.04, 0.03, BRASS, v=10, ax="y", smooth=True)
    B(r, (0, -.295, 0.12), (0.1, 0.012, 0.03), BRASS)
    B(r, (.2, -.295, 1.55), (0.02, 0.012, 0.02), E_LED_G)


@M("rug_round", "P1", "floor", "gala", (3, 3, 0.03))
def rug_round(r):
    C(r, (0, 0, 0.01), 1.5, 0.02, OX_D, v=36)
    annulus(r, (0, 0, 0.022), 1.4, 1.32, 0.006, BRASS_D, v=36)
    annulus(r, (0, 0, 0.022), 1.2, 1.0, 0.006, NAVY, v=36)
    annulus(r, (0, 0, 0.022), 0.88, 0.85, 0.006, BRASS_D, v=36)
    C(r, (0, 0, 0.022), 0.7, 0.006, OX, v=36)
    for i in range(8):
        a = i * PI / 4
        B(r, (math.cos(a) * .45, math.sin(a) * .45, 0.027), (0.3, 0.05, 0.004), BRASS_D, rot=(0, 0, a))


@M("champagne_cart", "P1", "floor", "gala", (1, 1, 1.1))
def champagne_cart(r):
    for sx in (-1, 1):
        for sy in (-1, 1):
            S(r, (sx * .42 - .02, sx * .42 + .02), (sy * .3 - .02, sy * .3 + .02), (0.08, 1.0), BRASS, bv=0.004)
            C(r, (sx * .42, sy * .3, 0.05), 0.05, 0.03, BLACK, v=10, ax="x", smooth=True)
    for z in (0.2, 0.84):
        S(r, (-.46, .46), (-.35, .35), (z, z + 0.04), MARB_B, bv=0.006)
        ring4(r, -.46, .46, -.35, .35, z + .04, z + .07, 0.015, BRASS)
    C(r, (-.15, 0, 0.98), 0.14, 0.2, STEEL, v=14, r2=0.16, smooth=True)                # ice bucket
    for k in range(2):
        C(r, (-.15 + (k - .5) * .09, 0, 1.13), 0.03, 0.28, mat("#1d3a2a", 0.15), v=8, smooth=True)
        C(r, (-.15 + (k - .5) * .09, 0, 1.3), 0.012, 0.06, GOLD, v=6)
    for i in range(6):
        C(r, (.1 + (i % 3) * .12, -.1 + (i // 3) * .14, 0.93), 0.03, 0.08, GLASS, v=8, r2=0.02, smooth=True)
    B(r, (.0, .37, 1.06), (0.9, 0.03, 0.04), BRASS, bv=0.004)
    for sx in (-1, 1):
        S(r, (sx * .44 - .015, sx * .44 + .015), (.3, .38), (0.98, 1.06), BRASS)
    B(r, (.3, .0, 0.26), (0.2, 0.2, 0.1), OX)


@M("chandelier", "P1", "ceiling", "light", (2, 2, 0.8))
def chandelier(r):
    C(r, (0, 0, 3.19), 0.08, 0.02, BRASS, v=10)
    C(r, (0, 0, 3.05), 0.012, 0.3, BRASS, v=6)
    C(r, (0, 0, 2.86), 0.07, 0.1, BRASS, v=10, smooth=True)
    P(r, (0, 0, 2.7), 0.1, BRASS, seg=8, rings=5)
    for rad, z, nb in ((0.95, 2.55, 12), (0.55, 2.7, 6)):
        annulus(r, (0, 0, z), rad + .025, rad - .025, 0.04, BRASS, v=24)
        for i in range(nb):
            a = i * 2 * PI / nb
            x, y = math.cos(a) * rad, math.sin(a) * rad
            C(r, (x, y, z + 0.05), 0.02, 0.06, BRASS, v=6)
            C(r, (x, y, z + 0.13), 0.028, 0.1, E_LAMP, v=6, r2=0.005)
        for i in range(4):
            a = i * PI / 2 + PI / 4
    for i in range(6):
        a = i * PI / 3
        beam(r, (0, 0, 2.72), (math.cos(a) * 0.95, math.sin(a) * 0.95, 2.55), 0.025, 0.025, BRASS)
        P(r, (math.cos(a) * 0.95, math.sin(a) * 0.95, 2.4), 0.05, GLASS, sc=(0.6, 0.6, 1.4), seg=6, rings=4)
        P(r, (math.cos(a + PI / 6) * 0.55, math.sin(a + PI / 6) * 0.55, 2.55), 0.04, GLASS, sc=(0.6, 0.6, 1.4), seg=6, rings=4)
    C(r, (0, 0, 2.42), 0.05, 0.3, GLASS, v=6, r2=0.005)


@M("fountain", "P1", "floor", "gala", (2, 2, 0.9))
def fountain(r):
    water = mat("#2c7a96", 0.05, 0.0, name="glass_water", alpha=0.55)
    annulus(r, (0, 0, 0.2), 1.0, 0.86, 0.4, MARB_W, v=16)
    annulus(r, (0, 0, 0.42), 1.03, 0.83, 0.05, BRASS, v=16)
    C(r, (0, 0, 0.02), 0.9, 0.04, MARB_B, v=16)
    C(r, (0, 0, 0.3), 0.85, 0.02, water, v=16)
    C(r, (0, 0, 0.35), 0.22, 0.6, MARB_W, v=10, r2=0.16, smooth=True)
    annulus(r, (0, 0, 0.62), 0.5, 0.42, 0.06, MARB_W, v=14)
    C(r, (0, 0, 0.6), 0.45, 0.04, MARB_W, v=14)
    C(r, (0, 0, 0.64), 0.4, 0.02, water, v=14)
    C(r, (0, 0, 0.78), 0.06, 0.24, MARB_W, v=8, smooth=True)
    P(r, (0, 0, 0.9), 0.055, BRASS, seg=8, rings=5)
    for i in range(4):
        a = i * PI / 2
        P(r, (math.cos(a) * 0.72, math.sin(a) * 0.72, 0.36), 0.08, MARB_WV, sc=(1, 1, 0.5), seg=6, rings=4)


@M("whiteboard", "P1", "wall", "office", (2, 0.1, 1.2))
def whiteboard(r):
    S(r, (-1, 1), (-.04, 0), (0, 1.2), STEEL_D, bv=0.006)
    S(r, (-.96, .96), (-.045, -.04), (0.04, 1.16), mat("#e8eaee", 0.3))
    S(r, (-.8, .8), (-.1, -.04), (0, 0.035), STEEL, bv=0.004)
    for (x0, x1, z, m) in ((-.8, -.2, 0.9, NAVY_L), (-.8, -.4, 0.75, NAVY_L), (0.1, .8, 0.85, RED_P), (0.2, .6, 0.6, RED_P), (-.2, .3, 0.35, mat("#1f7a4a", 0.5))):
        S(r, (x0, x1), (-.048, -.045), (z, z + 0.012), m)
    B(r, (.5, -.07, 0.05), (0.14, 0.03, 0.02), RED_P)
    for i in range(3):
        B(r, (-.2 + i * .1, -.07, 0.05), (0.08, 0.02, 0.02), NAVY_L)


@M("cubicle_wall", "P1", "floor", "office", (1, 0.12, 1.5))
def cubicle_wall(r):
    fab = mat("#4a5566", 0.95)
    S(r, (-.48, .48), (-.05, .05), (0.1, 1.5), STEEL_D, bv=0.006)
    S(r, (-.46, .46), (-.058, -.05), (0.14, 1.36), fab)
    S(r, (-.46, .46), (.05, .058), (0.14, 1.36), fab)
    S(r, (-.5, .5), (-.06, .06), (1.4, 1.5), STEEL, bv=0.006)
    for x in (-.45, .45):
        S(r, (x - .03, x + .03), (-.06, .06), (0, 0.12), BLACK)
    S(r, (-.3, .3), (-.06, -.03), (0.9, 0.93), STEEL_D)


@M("cabinet_tall", "P1", "floor", "office", (1, 1, 2.0))
def cabinet_tall(r):
    S(r, (-.46, .46), (-.4, .4), (0, 2.0), WAL_D, bv=0.01)
    S(r, (-.48, .48), (-.42, .42), (1.94, 2.0), WAL, bv=0.01)
    S(r, (-.46, .46), (-.4, .4), (0, 0.1), BLACK)
    for x in (-.23, .23):
        S(r, (x - .21, x + .21), (-.415, -.4), (0.15, 1.9), WAL, bv=0.004)
        S(r, (x - .15, x + .15), (-.42, -.415), (0.3, 1.75), WAL_D)
    for x in (-.04, .04):
        B(r, (x, -.44, 1.0), (0.025, 0.03, 0.16), BRASS, bv=0.004)


@M("vending_machine", "P1", "floor", "office", (1, 1, 1.9))
def vending_machine(r):
    S(r, (-.45, .45), (-.42, .42), (0, 1.9), mat("#20242c", 0.4, 0.4), bv=0.012)
    S(r, (-.4, .1), (-.425, -.42), (0.15, 1.75), GLASS_D)
    for j in range(5):
        for i in range(4):
            B(r, (-.33 + i * .12, -.41, 0.4 + j * .3), (0.08, 0.04, 0.16), (OX, NAVY_L, mat("#c9a23a", .5), mat("#2a6a3a", .5))[(i + j) % 4])
        S(r, (-.4, .1), (-.4, -.3), (0.32 + j * .3, 0.34 + j * .3), STEEL_D)
    S(r, (.17, .4), (-.43, -.42), (1.2, 1.7), BLACK)
    S(r, (.2, .37), (-.435, -.43), (1.4, 1.65), E_SCREEN)
    for i in range(3):
        for j in range(4):
            B(r, (.22 + i * .07, -.44, 1.08 - j * .07), (0.05, 0.02, 0.05), GRAPH_L)
    S(r, (.2, .37), (-.44, -.42), (0.5, 0.8), BLACK)
    S(r, (-.3, .3), (-.44, -.4), (0.06, 0.2), BLACK)                     # pickup flap
    B(r, (.3, -.43, 0.9), (0.14, 0.02, 0.02), E_LED_G)


@M("meeting_screen_wall", "P1", "wall", "office", (2, 0.1, 1.2))
def meeting_screen_wall(r):
    S(r, (-1, 1), (-.06, 0), (0.05, 1.15), BLACK, bv=0.008)
    S(r, (-.95, .95), (-.064, -.06), (0.1, 1.1), E_SCREEN)
    B(r, (0.0, -.066, 0.6), (1.8, 0.004, 0.02), mat("#0a2a3a", 0.5))
    B(r, (-.5, -.066, 0.8), (0.7, 0.004, 0.3), mat("#0a2a3a", 0.5))
    B(r, (.5, -.066, 0.4), (0.7, 0.004, 0.3), mat("#0a2a3a", 0.5))
    B(r, (.9, -.062, 0.07), (0.04, 0.01, 0.02), E_LED_G)


@M("vault_pedestal", "P1", "floor", "office", (1, 1, 1.0))
def vault_pedestal(r):
    S(r, (-.48, .48), (-.48, .48), (0, 0.12), MARB_B, bv=0.01)
    S(r, (-.485, .485), (-.485, .485), (0.12, 0.15), BRASS, bv=0.006)
    S(r, (-.36, .36), (-.36, .36), (0.15, 0.88), MARB_B, bv=0.008)
    for i in range(4):
        a = i * PI / 2 + PI / 4
    S(r, (-.44, .44), (-.44, .44), (0.88, 0.94), BRASS, bv=0.008)
    S(r, (-.42, .42), (-.42, .42), (0.94, 1.0), MARB_W, bv=0.008)
    ring4(r, -.38, .38, -.38, .38, 1.0, 1.006, 0.01, E_MARK)


@M("boxes_small", "P1", "floor", "kitchen", (1, 1, 0.5))
def boxes_small(r):
    for (x, y, w, d_, h, a) in ((-.22, -.2, .5, .4, .3, 0), (.24, -.22, .4, .4, .24, D(-10)), (.2, .22, .42, .38, .28, D(14)), (-.25, .22, .36, .34, .22, D(5))):
        B(r, (x, y, h / 2), (w, d_, h), CARDB if h > .25 else CARDB_D, rot=(0, 0, a), bv=0.005)
        B(r, (x, y, h + .002), (0.06, d_, 0.004), PAPER, rot=(0, 0, a))
    B(r, (-.2, -.2, 0.4), (0.34, 0.3, 0.2), CARDB_D, rot=(0, 0, D(-12)), bv=0.005)


@M("mop_bucket", "P1", "floor", "kitchen", (1, 1, 1.2))
def mop_bucket(r):
    yl = mat("#c9a512", 0.5)
    C(r, (0, 0, 0.16), 0.2, 0.32, yl, v=12, r2=0.25, smooth=True)
    annulus(r, (0, 0, 0.32), 0.26, 0.22, 0.02, yl, v=12)
    C(r, (0, 0, 0.27), 0.22, 0.02, mat("#3a5f75", 0.1), v=12)
    S(r, (-.26, .26), (.2, .36), (0.32, 0.4), STEEL_D)
    for sx in (-1, 1):
        C(r, (sx * .12, .28, 0.05), 0.04, 0.05, BLACK, v=8, ax="x")
    beam(r, (0, .0, 0.3), (.12, -.15, 1.2), 0.025, 0.025, WAL_L)
    C(r, (-.02, -.03, 0.36), 0.06, 0.1, PAPER, v=8, smooth=True)


@M("pipes_wall", "P1", "wall", "kitchen", (1, 0.3, 2.0))
def pipes_wall(r):
    pm = mat("#54595f", 0.5, 0.6)
    for x, y, rr, m in ((-.38, -.12, 0.07, pm), (0.0, -.07, 0.045, mat("#7a3a2a", 0.6, 0.4)), (.36, -.24, 0.075, pm)):
        C(r, (x, y, 1.0), rr, 2.0, m, v=12, smooth=True)
        for z in (0.3, 1.0, 1.7):
            annulus(r, (x, y, z), rr + .015, rr, 0.06, STEEL_D, v=12)
        for z in (0.5, 1.5):
            S(r, (x - .04, x + .04), (-.06 if x else -.03, 0) if False else (y, 0), (z, z + 0.03), STEEL_B)
    C(r, (.36, -.3, 1.2), 0.07, 0.02, RED_P, v=10, ax="y", smooth=True)
    C(r, (.36, -.28, 1.2), 0.012, 0.04, STEEL, v=6, ax="y")
    C(r, (0.0, -.07, 1.85), 0.06, 0.1, pm, v=10, smooth=True)


@M("fire_extinguisher", "P1", "wall", "kitchen", (0.2, 0.2, 0.5))
def fire_extinguisher(r):
    S(r, (-.05, .05), (-.02, 0), (0.05, 0.4), STEEL_B)
    C(r, (0, -.08, 0.22), 0.065, 0.36, RED_P, v=12, smooth=True)
    P(r, (0, -.08, 0.4), 0.065, RED_P, sc=(1, 1, 0.5), seg=12, rings=4)
    C(r, (0, -.08, 0.44), 0.02, 0.05, STEEL_B, v=8)
    S(r, (-.03, .03), (-.11, -.05), (0.46, 0.5), STEEL_B)
    annulus(r, (0, -.08, 0.3), 0.07, 0.062, 0.03, STEEL_B, v=12)
    B(r, (0, -.146, 0.25), (0.05, 0.005, 0.08), PAPER)
    beam(r, (0.03, -.07, 0.45), (0.05, -.04, 0.12), 0.012, 0.012, BLACK)


@M("emp_charge", "P1", "floor", "tech", (0.2, 0.2, 0.2))
def emp_charge(r):
    C(r, (0, 0, 0.04), 0.1, 0.08, STEEL_B, v=14, smooth=True)
    C(r, (0, 0, 0.1), 0.07, 0.06, GRAPH_L, v=14, smooth=True)
    annulus(r, (0, 0, 0.065), 0.101, 0.095, 0.014, E_LED_G, v=14)
    C(r, (0, 0, 0.14), 0.03, 0.02, BLACK, v=8)
    B(r, (0, 0, 0.165), (0.03, 0.03, 0.03), E_LED_R)
    C(r, (.05, .04, 0.16), 0.006, 0.12, STEEL, v=5)
    for i in range(3):
        a = i * 2 * PI / 3
        B(r, (math.cos(a) * .09, math.sin(a) * .09, 0.02), (0.03, 0.03, 0.04), YELLOW, rot=(0, 0, a))


@M("alarm_panel", "P1", "wall", "tech", (0.4, 0.1, 0.5))
def alarm_panel(r):
    S(r, (-.19, .19), (-.09, 0), (0.0, 0.5), RED_P, bv=0.008)
    S(r, (-.16, .16), (-.095, -.09), (0.32, 0.46), BLACK)
    S(r, (-.14, .14), (-.098, -.095), (0.34, 0.44), mat("#2a0a0a", 0.4, 0, "emit_screen_red", emit="#ff3020", strength=1.2))
    B(r, (0, -.098, 0.24), (0.14, 0.02, 0.06), BLACK)
    B(r, (-.1, -.10, 0.16), (0.04, 0.02, 0.04), E_LED_R)
    B(r, (0, -.10, 0.16), (0.04, 0.02, 0.04), E_LED_R)
    B(r, (.1, -.10, 0.16), (0.04, 0.02, 0.04), E_LED_G)
    S(r, (-.12, .12), (-.1, -.09), (0.04, 0.1), YELLOW)


@M("light_switch", "P1", "wall", "light", (0.12, 0.05, 0.12))
def light_switch(r):
    S(r, (-.05, .05), (-.012, 0), (0.0, 0.12), WHITE, bv=0.004)
    B(r, (0, -.02, 0.07), (0.022, 0.02, 0.05), STEEL_D, rot=(D(-20), 0, 0))
    B(r, (0, -.016, 0.02), (0.012, 0.01, 0.012), E_LED_G)


@M("cctv_monitor_wall", "P1", "wall", "tech", (1, 0.15, 0.6))
def cctv_monitor_wall(r):
    S(r, (-.5, .5), (-.12, 0), (0, 0.6), BLACK, bv=0.008)
    for i in range(2):
        for j in range(2):
            S(r, (-.46 + i * .465, -.035 + i * .465), (-.128, -.12), (0.04 + j * .265, 0.29 + j * .265), E_SCREEN if (i + j) % 2 == 0 else E_SCREEN_G)
    B(r, (.46, -.125, 0.03), (0.03, 0.01, 0.015), E_LED_R)


@M("spotlight_track", "P1", "ceiling", "light", (2, 0.3, 0.3))
def spotlight_track(r):
    S(r, (-1, 1), (-.03, .03), (3.16, 3.2), STEEL_B, bv=0.004)
    for x in (-.65, 0, .65):
        C(r, (x, 0, 3.1), 0.012, 0.1, STEEL_D, v=6)
        C(r, (x, -.06, 3.0), 0.06, 0.16, CHAR, v=10, r2=0.045, smooth=True, rot=(D(25), 0, 0))
        C(r, (x, -.07, 2.98), 0.05, 0.02, E_LAMP, v=10, rot=(D(25), 0, 0))
        B(r, (x, 0, 3.15), (0.06, 0.05, 0.02), STEEL_B)


@M("skylight", "P1", "ceiling", "light", (2, 2, 0.3))
def skylight(r):
    ring4(r, -1, 1, -1, 1, 2.9, 3.2, 0.08, STEEL_B, bv=0.006)
    ring4(r, -.92, .92, -.92, .92, 2.98, 3.06, 0.03, STEEL)
    S(r, (-.92, .92), (-.92, .92), (3.08, 3.1), GLASS)
    S(r, (-.02, .02), (-.92, .92), (3.0, 3.1), STEEL)
    S(r, (-.92, .92), (-.02, .02), (3.0, 3.1), STEEL)


@M("antenna_mast", "P1", "floor", "exterior", (1, 1, 4.0))
def antenna_mast(r):
    S(r, (-.5, .5), (-.5, .5), (0, 0.08), CONC_D)
    pts = [(math.cos(a) * 0.32, math.sin(a) * 0.32) for a in (PI / 2, PI / 2 + 2 * PI / 3, PI / 2 + 4 * PI / 3)]
    top = 0.06
    for (x, y) in pts:
        beam(r, (x, y, 0.08), (x * top / 0.32, y * top / 0.32, 3.6), 0.04, 0.04, STEEL_D)
    levels = [0.08 + i * 0.6 for i in range(6)]
    for i in range(len(levels) - 1):
        z0, z1 = levels[i], levels[i + 1]
        f0, f1 = 1 - (z0 - 0.08) / 3.52 * (1 - top / 0.32), 1 - (z1 - 0.08) / 3.52 * (1 - top / 0.32)
        for k in range(3):
            a, b = pts[k], pts[(k + 1) % 3]
            beam(r, (a[0] * f0, a[1] * f0, z0), (b[0] * f1, b[1] * f1, z1), 0.02, 0.02, STEEL)
    C(r, (0, 0, 3.8), 0.02, 0.4, STEEL, v=6)
    C(r, (0, -.13, 3.3), 0.22, 0.05, mat("#d9dadf", 0.5, 0.3), v=16, ax="y", smooth=True)
    beam(r, (0, -.0, 3.3), (0, -.25, 3.3), 0.03, 0.03, STEEL_D)
    P(r, (0, 0, 4.03), 0.05, E_LED_R, seg=8, rings=4)
    for z in (1.5, 2.5):
        B(r, (0.0, -.18, z), (0.25, 0.15, 0.3), CHAR)
        B(r, (0.0, -.26, z), (0.2, 0.02, 0.05), E_LED_G)


@M("water_tank", "P1", "floor", "exterior", (2, 2, 3.0))
def water_tank(r):
    rust = mat("#5a3a26", 0.7, 0.2)
    for i in range(4):
        a = i * PI / 2 + PI / 4
        x, y = math.cos(a) * 0.8, math.sin(a) * 0.8
        S(r, (x - .05, x + .05), (y - .05, y + .05), (0, 1.3), STEEL_D)
    for a1, a2 in ((PI / 4, 3 * PI / 4), (3 * PI / 4, 5 * PI / 4), (5 * PI / 4, 7 * PI / 4), (7 * PI / 4, 9 * PI / 4)):
        beam(r, (math.cos(a1) * .8, math.sin(a1) * .8, 0.3), (math.cos(a2) * .8, math.sin(a2) * .8, 1.1), 0.03, 0.03, STEEL_B)
        beam(r, (math.cos(a1) * .8, math.sin(a1) * .8, 1.1), (math.cos(a2) * .8, math.sin(a2) * .8, 0.3), 0.03, 0.03, STEEL_B)
    C(r, (0, 0, 1.32), 0.95, 0.04, WAL_D, v=16)
    C(r, (0, 0, 2.15), 0.92, 1.6, rust, v=16, r2=0.92)
    for z in (1.5, 1.95, 2.4, 2.85 - 0.1):
        annulus(r, (0, 0, z), 0.95, 0.9, 0.05, STEEL_B, v=16)
    C(r, (0, 0, 2.85), 0.95, 0.2, WAL_D, v=16, r2=0.5, smooth=False)
    C(r, (0, 0, 3.0), 0.5, 0.1, WAL_D, v=16, r2=0.12)


@M("car_sedan", "P1", "floor", "exterior", (2, 4.4, 1.4))
def car_sedan(r):
    body = mat("#0d0e12", 0.22, 0.6)
    glass = mat("#1a2632", 0.05, 0.0, name="glass_tint", alpha=0.6)
    tire = mat("#08080a", 0.9)
    prof = [(-2.2, 0.32), (-2.2, 0.7), (-1.95, 0.8), (-0.95, 0.86), (-0.45, 1.3), (0.85, 1.36), (1.5, 0.94), (2.05, 0.9), (2.2, 0.8), (2.2, 0.32)]
    poly_yz(r, prof, -0.93, 0.93, body)
    S(r, (-1.0, 1.0), (-2.15, 2.15), (0.28, 0.5), body, bv=0.02)
    beam(r, (0, -0.93, 0.87), (0, -0.48, 1.29), 1.6, 0.02, glass)                       # windshield
    beam(r, (0, 1.5, 0.95), (0, 0.87, 1.33), 1.6, 0.02, glass)                          # rear glass
    poly_yz(r, [(-0.4, 1.27), (-0.9, .88 + .0), (-0.1, .88), (0.7, .88), (1.35, .95), (0.8, 1.33)][0:1] + [(-0.83, 0.9), (1.3, 0.94), (0.83, 1.33), (-0.42, 1.28)], 0.934, 0.95, glass)
    poly_yz(r, [(-0.83, 0.9), (1.3, 0.94), (0.83, 1.33), (-0.42, 1.28)], -0.95, -0.934, glass)
    S(r, (-.93, .93), (-0.02, 0.02), (0.9, 1.3), body)
    for y in (-0.05, 0.02):
        pass
    for sx in (-1, 1):                                                       # wheels
        for y in (-1.4, 1.4):
            C(r, (sx * 0.84, y, 0.34), 0.34, 0.24, tire, v=14, ax="x", smooth=True)
            C(r, (sx * (0.96), y, 0.34), 0.2, 0.03, STEEL, v=10, ax="x", smooth=True)
            C(r, (sx * (0.975), y, 0.34), 0.05, 0.03, BRASS_D, v=8, ax="x")
    for sx in (-1, 1):                                                       # headlights, tail lights
        B(r, (sx * 0.65, -2.2, 0.62), (0.4, 0.05, 0.1), E_LAMP, rot=(0, 0, 0))
        B(r, (sx * 0.65, 2.2, 0.72), (0.45, 0.05, 0.1), E_LED_R)
        B(r, (sx * 1.0, -0.65, 1.02), (0.08, 0.14, 0.07), body)
    B(r, (0, -2.205, 0.5), (0.9, 0.04, 0.2), BLACK)                          # grille
    B(r, (0, -2.22, 0.36), (1.8, 0.06, 0.1), STEEL_B)                        # bumpers
    B(r, (0, 2.22, 0.36), (1.8, 0.06, 0.1), STEEL_B)
    B(r, (0, 2.23, 0.55), (0.26, 0.01, 0.13), PAPER)



# =================================================================== MAIN
def main(argv):
    want = [a for a in argv if not a.startswith("-")]
    specs = [s for s in MODELS if not want or s["name"] in want]
    unknown = [w for w in want if w not in {s["name"] for s in MODELS}]
    if unknown:
        print("unknown models:", unknown)
    print("Building %d models -> %s" % (len(specs), OUT))
    mpath = os.path.join(OUT, "manifest.json")
    old = {}
    if os.path.exists(mpath):
        try:
            old = {e["name"]: e for e in json.load(open(mpath))}
        except Exception:
            old = {}
    for s in specs:
        root = pv(s["name"], None, (0, 0, 0))
        try:
            s["fn"](root)
            old[s["name"]] = export(s)
        except Exception as ex:
            import traceback
            traceback.print_exc()
            print("  FAILED", s["name"], ex)
            for o in list(_made):
                bpy.data.objects.remove(o, do_unlink=True)
            _made.clear()
            _W.clear()
    order = {s["name"]: i for i, s in enumerate(MODELS)}
    man = sorted(old.values(), key=lambda e: order.get(e["name"], 9999))
    json.dump(man, open(mpath, "w"), indent=1)
    print("manifest: %d entries, %d tris total, %.1f MB" % (len(man), sum(e["tris"] for e in man), sum(os.path.getsize(os.path.join(OUT, e["name"] + ".glb")) for e in man) / 1e6))


if __name__ == "__main__":
    main(sys.argv[1:])
