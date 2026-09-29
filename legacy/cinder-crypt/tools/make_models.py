"""
Builds the fixed character cast + props for the game and exports them as .glb.

Run headless:   python3 tools/blender/make_models.py
Requires:       pip install bpy==4.2.0

Conventions (so the game can animate without baked clips):
  * Models face Blender -Y  (=> +Z in glTF), Z is up, origin on the ground.
  * Limbs are separate pivot empties named legL/legR/armL/armR/wingL/wingR/head/lid.
    The pivot sits at the joint, so rotating the node swings the limb naturally.
"""
import bpy, math, os, sys

bpy.ops.wm.read_factory_settings(use_empty=True)  # must run before any material exists

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "assets", "models")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- helpers
_mats = {}
_made = []


def lin(hexstr):
    h = hexstr.lstrip("#")
    return tuple((int(h[i:i + 2], 16) / 255.0) ** 2.2 for i in (0, 2, 4))


def mat(hexstr, rough=0.85, metal=0.0, emit=None, strength=0.0):
    key = (hexstr, rough, metal, emit, strength)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new("m_" + hexstr.lstrip("#") + ("_e" if emit else ""))
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*lin(hexstr), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*lin(emit), 1)
        b.inputs["Emission Strength"].default_value = strength
    _mats[key] = m
    return m


def _bake(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for p in o.data.polygons:
        p.use_smooth = False


def _place(o, name, parent, loc, m):
    _bake(o)
    o.name = name
    o.data.materials.append(m)
    o.parent = parent
    o.location = loc
    _made.append(o)
    return o


def box(name, parent, loc, size, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.scale = size
    o.rotation_euler = rot
    return _place(o, name, parent, loc, m)


def cyl(name, parent, loc, r1, r2, depth, m, verts=8, rot=(0, 0, 0), scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth)
    o = bpy.context.active_object
    o.scale = scale
    o.rotation_euler = rot
    return _place(o, name, parent, loc, m)


def cone(name, parent, loc, r, depth, m, verts=6, rot=(0, 0, 0)):
    return cyl(name, parent, loc, r, 0.0, depth, m, verts, rot)


def ball(name, parent, loc, r, m, scale=(1, 1, 1), sub=1):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r)
    o = bpy.context.active_object
    o.scale = scale
    return _place(o, name, parent, loc, m)


def pivot(name, parent, loc):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    o.parent = parent
    o.location = loc
    _made.append(o)
    return o


def root(name):
    return pivot(name, None, (0, 0, 0))


def export(name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in _made:
        o.select_set(True)
    path = os.path.join(OUT, name + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
    )
    tris = sum(len(o.data.polygons) for o in _made if o.type == "MESH")
    print(f"  wrote {name}.glb  ({tris} faces, {os.path.getsize(path)//1024} KB)")
    for o in _made:
        bpy.data.objects.remove(o, do_unlink=True)
    _made.clear()


# ---------------------------------------------------------------- palette
BONE = mat("#d8cfb8")
BONE_D = mat("#a89f88")
IRON = mat("#5b5f68", 0.5, 0.6)
RUST = mat("#7a4b32", 0.7, 0.4)
LEATHER = mat("#4a3426")
WOOD = mat("#5c3d22")
WOOD_D = mat("#3a2615")
GOLD = mat("#c9a23a", 0.35, 0.8)
STONE = mat("#6b6a72")
STONE_D = mat("#45444c")
BLACK = mat("#0d0b10")
SKIN = mat("#c99a7a")
EYE_C = mat("#66f0ff", 0.5, 0, "#66f0ff", 6.0)
EYE_O = mat("#ff9b3a", 0.5, 0, "#ff8a20", 6.0)
EYE_R = mat("#ff3030", 0.5, 0, "#ff2020", 6.0)


def limb(name, parent, shoulder, length, thick, m, hand=None, hand_r=0.06):
    p = pivot(name, parent, shoulder)
    box(name + "_m", p, (0, 0, -length / 2), (thick, thick, length), m)
    if hand:
        ball(name + "_h", p, (0, 0, -length - 0.01), hand_r, hand)
    return p


# ---------------------------------------------------------------- hero
def build_hero():
    r = root("hero")
    robe = mat("#2c3e6b")
    robe_d = mat("#1b2547")
    trim = GOLD
    # legs (mostly hidden by the robe, boots peek out)
    for s, n in ((-1, "legL"), (1, "legR")):
        p = pivot(n, r, (0.12 * s, 0, 0.5))
        box(n + "_m", p, (0, 0, -0.22), (0.13, 0.13, 0.4), robe_d)
        box(n + "_boot", p, (0, -0.04, -0.46), (0.16, 0.26, 0.14), LEATHER)
    cyl("robe", r, (0, 0, 0.85), 0.44, 0.26, 0.95, robe, 8)
    cyl("hem", r, (0, 0, 0.41), 0.455, 0.44, 0.07, trim, 8)
    cyl("belt", r, (0, 0, 1.02), 0.3, 0.3, 0.08, LEATHER, 8)
    box("buckle", r, (0, -0.28, 1.02), (0.09, 0.03, 0.09), trim)
    cyl("chest", r, (0, 0, 1.36), 0.27, 0.22, 0.4, robe, 8)
    cyl("mantle", r, (0, 0, 1.54), 0.36, 0.28, 0.14, robe_d, 8)
    cyl("mantle_trim", r, (0, 0, 1.47), 0.37, 0.37, 0.04, trim, 8)
    box("cloak", r, (0, 0.24, 1.0), (0.52, 0.06, 1.1), robe_d, rot=(math.radians(-6), 0, 0))
    # head + hood
    h = pivot("head", r, (0, 0, 1.66))
    ball("face", h, (0, -0.03, 0.02), 0.16, mat("#181418"), (1, 1, 1.05))
    box("eyeL", h, (-0.055, -0.175, 0.03), (0.05, 0.02, 0.025), EYE_C)
    box("eyeR", h, (0.055, -0.175, 0.03), (0.05, 0.02, 0.025), EYE_C)
    cone("hood", h, (0, 0.03, 0.14), 0.26, 0.42, robe_d, 8, rot=(math.radians(-14), 0, 0))
    cyl("hood_rim", h, (0, -0.02, 0.0), 0.225, 0.225, 0.06, robe, 8, rot=(math.radians(90), 0, 0), scale=(1, 1, 0.5))
    # left arm
    p = pivot("armL", r, (-0.37, 0, 1.5))
    box("armL_m", p, (0, 0, -0.26), (0.14, 0.14, 0.5), robe)
    ball("armL_h", p, (0, 0, -0.55), 0.06, SKIN)
    # right arm holds the staff
    p = pivot("armR", r, (0.37, 0, 1.5))
    box("armR_m", p, (0, 0, -0.26), (0.14, 0.14, 0.5), robe)
    ball("armR_h", p, (0, 0, -0.55), 0.06, SKIN)
    box("staff", p, (0, -0.06, -0.3), (0.05, 0.05, 1.9), WOOD)
    for i, a in enumerate((0, 90, 180, 270)):
        cone("prong%d" % i, p, (math.cos(math.radians(a)) * 0.07, -0.06 + math.sin(math.radians(a)) * 0.07, 0.72), 0.03, 0.2, trim, 4)
    ball("orb", p, (0, -0.06, 0.68), 0.09, mat("#ff7a1a", 0.3, 0, "#ff6a10", 8.0), sub=1)
    export("hero")


# ---------------------------------------------------------------- skeletons
def skeleton_body(r, s=1.0, bone=BONE, eye=EYE_O, cloth=None):
    for sd, n in ((-1, "legL"), (1, "legR")):
        p = pivot(n, r, (0.1 * s * sd, 0, 0.72 * s))
        box(n + "_m", p, (0, 0, -0.34 * s), (0.07 * s, 0.07 * s, 0.68 * s), bone)
        box(n + "_f", p, (0, -0.05 * s, -0.7 * s), (0.09 * s, 0.2 * s, 0.06 * s), bone)
    box("pelvis", r, (0, 0, 0.78 * s), (0.3 * s, 0.14 * s, 0.14 * s), bone)
    box("spine", r, (0, 0.02 * s, 1.0 * s), (0.06 * s, 0.06 * s, 0.4 * s), bone)
    for i in range(3):
        w = (0.34 - 0.05 * i) * s
        box("rib%d" % i, r, (0, -0.01 * s, (0.98 + 0.11 * i) * s), (w, 0.16 * s, 0.05 * s), bone)
    box("shoulders", r, (0, 0, 1.3 * s), (0.44 * s, 0.1 * s, 0.07 * s), bone)
    if cloth:
        box("loin", r, (0, -0.09 * s, 0.7 * s), (0.22 * s, 0.03 * s, 0.32 * s), cloth)
    h = pivot("head", r, (0, 0, 1.44 * s))
    ball("skull", h, (0, 0, 0.06 * s), 0.14 * s, bone, (1, 1.05, 1.05))
    box("jaw", h, (0, -0.06 * s, -0.08 * s), (0.14 * s, 0.11 * s, 0.06 * s), bone)
    box("sockL", h, (-0.055 * s, -0.135 * s, 0.09 * s), (0.055 * s, 0.03 * s, 0.055 * s), BLACK)
    box("sockR", h, (0.055 * s, -0.135 * s, 0.09 * s), (0.055 * s, 0.03 * s, 0.055 * s), BLACK)
    box("eyeL", h, (-0.055 * s, -0.15 * s, 0.09 * s), (0.03 * s, 0.015 * s, 0.03 * s), eye)
    box("eyeR", h, (0.055 * s, -0.15 * s, 0.09 * s), (0.03 * s, 0.015 * s, 0.03 * s), eye)
    return h


def arm(r, name, sd, s, bone, length=0.56, thick=0.06):
    p = pivot(name, r, (0.26 * s * sd, 0, 1.28 * s))
    box(name + "_m", p, (0, 0, -length * s / 2), (thick * s, thick * s, length * s), bone)
    ball(name + "_h", p, (0, 0, -length * s), 0.045 * s, bone)
    return p


def build_skeleton():
    r = root("skeleton")
    skeleton_body(r, 1.0, BONE, EYE_O, cloth=LEATHER)
    arm(r, "armL", -1, 1.0, BONE)
    ar = arm(r, "armR", 1, 1.0, BONE)
    # shield-less rusty sword held forward
    box("blade", ar, (0, -0.1, -0.55), (0.04, 0.05, 0.75), RUST, rot=(math.radians(-70), 0, 0))
    box("guard", ar, (0, -0.04, -0.56), (0.16, 0.04, 0.04), IRON)
    export("skeleton")


def build_archer():
    r = root("archer")
    cloth = mat("#3d4a34")
    skeleton_body(r, 0.98, BONE_D, mat("#9cff5a", 0.5, 0, "#80ff40", 6.0), cloth=cloth)
    h = [o for o in _made if o.name == "head"][0]
    cone("hood", h, (0, 0.03, 0.15), 0.19, 0.3, cloth, 6, rot=(math.radians(-10), 0, 0))
    arm(r, "armR", 1, 0.98, BONE_D)
    al = arm(r, "armL", -1, 0.98, BONE_D)
    # bow, held in the left hand and pointing forward
    box("bowM", al, (0, -0.06, -0.52), (0.04, 0.04, 0.16), WOOD)
    box("bowU", al, (0, -0.1, -0.35), (0.03, 0.03, 0.34), WOOD, rot=(math.radians(-22), 0, 0))
    box("bowL", al, (0, -0.1, -0.69), (0.03, 0.03, 0.34), WOOD, rot=(math.radians(22), 0, 0))
    box("string", al, (0, -0.02, -0.52), (0.012, 0.012, 0.72), BONE)
    box("quiver", r, (0.1, 0.13, 1.1), (0.1, 0.1, 0.45), LEATHER, rot=(math.radians(10), 0, math.radians(-8)))
    for i in range(3):
        box("fletch%d" % i, r, (0.1 + 0.02 * i - 0.02, 0.14, 1.36 + 0.02 * i), (0.02, 0.02, 0.14), BONE)
    export("archer")


# ---------------------------------------------------------------- brute
def build_brute():
    r = root("brute")
    skin = mat("#5c7a4a")
    skin_d = mat("#465d38")
    for sd, n in ((-1, "legL"), (1, "legR")):
        p = pivot(n, r, (0.24 * sd, 0, 0.72))
        box(n + "_m", p, (0, 0, -0.34), (0.26, 0.26, 0.68), skin_d)
        box(n + "_f", p, (0, -0.06, -0.68), (0.3, 0.38, 0.14), skin)
    ball("belly", r, (0, -0.04, 1.0), 0.5, skin, (1.0, 0.85, 0.9))
    cyl("loin", r, (0, 0, 0.82), 0.42, 0.36, 0.32, LEATHER, 8)
    box("belt", r, (0, 0, 0.98), (0.8, 0.5, 0.08), IRON)
    ball("chest", r, (0, -0.06, 1.4), 0.5, skin, (1.15, 0.8, 0.7))
    ball("hump", r, (0, 0.22, 1.55), 0.3, skin_d, (1.2, 0.9, 0.8))
    h = pivot("head", r, (0, -0.08, 1.75))
    ball("skull", h, (0, -0.04, 0), 0.2, skin, (1.05, 1, 0.85))
    box("brow", h, (0, -0.19, 0.06), (0.36, 0.06, 0.06), skin_d)
    box("eyeL", h, (-0.08, -0.2, 0.02), (0.06, 0.02, 0.03), EYE_R)
    box("eyeR", h, (0.08, -0.2, 0.02), (0.06, 0.02, 0.03), EYE_R)
    box("jaw", h, (0, -0.14, -0.12), (0.3, 0.14, 0.09), skin_d)
    cone("tuskL", h, (-0.11, -0.2, -0.08), 0.03, 0.14, BONE, 4)
    cone("tuskR", h, (0.11, -0.2, -0.08), 0.03, 0.14, BONE, 4)
    for sd, n in ((-1, "armL"), (1, "armR")):
        p = pivot(n, r, (0.62 * sd, 0, 1.55))
        box(n + "_m", p, (0, 0, -0.34), (0.28, 0.28, 0.7), skin)
        ball(n + "_h", p, (0, -0.02, -0.76), 0.19, skin_d)
        if sd == 1:
            box("club", p, (0, -0.2, -0.7), (0.14, 0.14, 1.1), WOOD, rot=(math.radians(-55), 0, 0))
            ball("club_head", p, (0, -0.62, -1.05), 0.2, WOOD_D, (1, 1.3, 1))
            for i in range(4):
                a = math.radians(i * 90)
                cone("spike%d" % i, p, (math.cos(a) * 0.16, -0.62 + math.sin(a) * 0.16, -1.05), 0.03, 0.12, IRON, 4)
    export("brute")


# ---------------------------------------------------------------- shaman
def build_shaman():
    r = root("shaman")
    red = mat("#6b1a1f")
    red_d = mat("#3d0c12")
    purple = mat("#b060ff", 0.3, 0, "#a040ff", 8.0)
    for sd, n in ((-1, "legL"), (1, "legR")):
        p = pivot(n, r, (0.1 * sd, 0, 0.4))
        box(n + "_m", p, (0, -0.02, -0.18), (0.11, 0.16, 0.36), red_d)
    cyl("robe", r, (0, 0, 0.8), 0.46, 0.2, 1.0, red, 8)
    cyl("hem", r, (0, 0, 0.32), 0.47, 0.47, 0.05, GOLD, 8)
    cyl("sash", r, (0, 0, 1.0), 0.28, 0.28, 0.07, BONE_D, 8)
    cyl("shoulders", r, (0, 0, 1.4), 0.32, 0.2, 0.2, red_d, 8)
    h = pivot("head", r, (0, 0, 1.6))
    ball("mask", h, (0, -0.04, 0.03), 0.13, BONE, (0.9, 0.8, 1.15))
    box("eyeL", h, (-0.05, -0.135, 0.06), (0.045, 0.02, 0.06), purple)
    box("eyeR", h, (0.05, -0.135, 0.06), (0.045, 0.02, 0.06), purple)
    cone("hood", h, (0, 0.03, 0.2), 0.22, 0.55, red_d, 6, rot=(math.radians(-8), 0, 0))
    for sd, n in ((-1, "armL"), (1, "armR")):
        p = pivot(n, r, (0.33 * sd, 0, 1.38))
        box(n + "_m", p, (0, 0, -0.24), (0.11, 0.11, 0.46), red)
        ball(n + "_h", p, (0, 0, -0.5), 0.05, BONE)
        if sd == 1:
            box("staff", p, (0, -0.06, -0.15), (0.045, 0.045, 1.7), WOOD_D)
            ball("skull", p, (0, -0.06, 0.78), 0.1, BONE)
            ball("orb", p, (0, -0.06, 0.96), 0.08, purple)
    export("shaman")


# ---------------------------------------------------------------- bat
def build_bat():
    r = root("bat")
    fur = mat("#3a2a4d")
    fur_d = mat("#241832")
    ball("body", r, (0, 0, 0.8), 0.14, fur, (0.9, 1.2, 0.95))
    h = pivot("head", r, (0, -0.15, 0.86))
    ball("headm", h, (0, 0, 0), 0.1, fur)
    cone("earL", h, (-0.06, 0.0, 0.11), 0.04, 0.12, fur_d, 4)
    cone("earR", h, (0.06, 0.0, 0.11), 0.04, 0.12, fur_d, 4)
    box("eyeL", h, (-0.04, -0.09, 0.02), (0.03, 0.015, 0.03), EYE_R)
    box("eyeR", h, (0.04, -0.09, 0.02), (0.03, 0.015, 0.03), EYE_R)
    box("fang", h, (0, -0.09, -0.05), (0.03, 0.015, 0.05), BONE)
    for sd, n in ((-1, "wingL"), (1, "wingR")):
        p = pivot(n, r, (0.1 * sd, 0.02, 0.84))
        box(n + "_a", p, (0.22 * sd, 0, 0.0), (0.44, 0.03, 0.09), fur_d)
        box(n + "_b", p, (0.32 * sd, 0.06, -0.07), (0.3, 0.02, 0.2), fur)
        box(n + "_c", p, (0.5 * sd, 0.08, -0.12), (0.16, 0.02, 0.14), fur_d)
    export("bat")


# ---------------------------------------------------------------- boss
def build_boss():
    r = root("boss")
    skeleton_body(r, 1.7, mat("#c4b89c"), EYE_R, cloth=mat("#4a0f18"))
    h = [o for o in _made if o.name == "head"][0]
    # crown
    cyl("crown", h, (0, 0, 0.3), 0.26, 0.26, 0.1, GOLD, 8)
    for i in range(6):
        a = math.radians(i * 60)
        cone("cr%d" % i, h, (math.cos(a) * 0.24, math.sin(a) * 0.24, 0.42), 0.06, 0.22, GOLD, 4)
    ball("gem", h, (0, -0.25, 0.32), 0.05, mat("#ff2a2a", 0.3, 0, "#ff1010", 8.0))
    arm(r, "armL", -1, 1.7, mat("#c4b89c"), 0.56, 0.06)
    ar = arm(r, "armR", 1, 1.7, mat("#c4b89c"), 0.56, 0.06)
    for sd in (-1, 1):
        ball("pauldron%d" % sd, r, (0.46 * 1.7 * sd, 0, 1.3 * 1.7), 0.2, IRON, (1.2, 1, 0.8))
        cone("pspike%d" % sd, r, (0.5 * 1.7 * sd, 0, 1.3 * 1.7 + 0.16), 0.06, 0.24, IRON, 4)
    box("cape", r, (0, 0.2, 1.45), (0.9, 0.05, 1.7), mat("#5a0d16"), rot=(math.radians(-5), 0, 0))
    box("blade", ar, (0, -0.35, -1.2), (0.09, 0.07, 1.6), IRON, rot=(math.radians(-75), 0, 0))
    box("guard", ar, (0, -0.06, -0.95), (0.42, 0.07, 0.07), GOLD)
    export("boss")


# ---------------------------------------------------------------- props
def build_barrel(name, band_hex, liquid_hex):
    r = root(name)
    cyl("stave", r, (0, 0, 0.4), 0.3, 0.3, 0.8, WOOD, 10)
    cyl("belly", r, (0, 0, 0.4), 0.34, 0.34, 0.5, WOOD, 10)
    for z in (0.14, 0.66):
        cyl("band%.2f" % z, r, (0, 0, z), 0.335, 0.335, 0.07, mat(band_hex, 0.4, 0.5), 10)
    cyl("top", r, (0, 0, 0.82), 0.27, 0.27, 0.04, mat(liquid_hex, 0.2, 0.0, liquid_hex, 0.6), 10)
    export(name)


def build_chest():
    r = root("chest")
    box("base", r, (0, 0, 0.2), (0.8, 0.5, 0.4), WOOD)
    box("trimF", r, (0, -0.255, 0.2), (0.82, 0.02, 0.06), GOLD)
    lid = pivot("lid", r, (0, 0.25, 0.4))
    box("lid_m", lid, (0, -0.25, 0.09), (0.82, 0.52, 0.18), WOOD_D)
    box("lid_band", lid, (0, -0.25, 0.2), (0.84, 0.54, 0.03), GOLD)
    box("lock", lid, (0, -0.52, 0.04), (0.1, 0.03, 0.12), GOLD)
    export("chest")


def build_exit():
    r = root("exit")
    box("pillarL", r, (-0.9, 0, 1.1), (0.4, 0.5, 2.2), STONE)
    box("pillarR", r, (0.9, 0, 1.1), (0.4, 0.5, 2.2), STONE)
    box("lintel", r, (0, 0, 2.35), (2.4, 0.55, 0.4), STONE_D)
    box("cap", r, (0, 0, 2.62), (2.0, 0.45, 0.16), STONE)
    box("baseL", r, (-0.9, 0, 0.1), (0.55, 0.65, 0.2), STONE_D)
    box("baseR", r, (0.9, 0, 0.1), (0.55, 0.65, 0.2), STONE_D)
    box("portal", r, (0, 0, 1.1), (1.4, 0.06, 2.1), mat("#7a5cff", 0.2, 0, "#6a4cff", 5.0))
    export("exit")


def build_brazier():
    r = root("brazier")
    for i in range(3):
        a = math.radians(i * 120 + 30)
        box("leg%d" % i, r, (math.cos(a) * 0.17, math.sin(a) * 0.17, 0.35), (0.06, 0.06, 0.7), IRON,
            rot=(math.sin(a) * 0.12, -math.cos(a) * 0.12, 0))
    cyl("bowl", r, (0, 0, 0.78), 0.3, 0.2, 0.2, STONE_D, 8)
    cone("flame", r, (0, 0, 1.08), 0.2, 0.5, mat("#ff8a2a", 0.3, 0, "#ff7a10", 10.0), 6)
    export("brazier")


if __name__ == "__main__":
    print("Building models ->", OUT)
    build_hero()
    build_skeleton()
    build_archer()
    build_brute()
    build_shaman()
    build_bat()
    build_boss()
    build_barrel("barrel_oil", "#2a2a2a", "#121008")
    build_barrel("barrel_water", "#3a6ea8", "#3a8fd0")
    build_chest()
    build_exit()
    build_brazier()
    print("done")
