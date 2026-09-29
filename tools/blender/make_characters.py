"""
Builds the modular character kit for the stealth game from the CC0 Quaternius "Universal Base Characters".

Outputs (assets/characters/):
  body_<male|female>_<light|dark>.glb   skinned body + eyes on the shared 65-joint rig  (1024px jpeg skin)
  hair_<style>.glb / brows_<style>.glb   hair pieces rigged to the head bone (512px png, tinted at runtime)
  outfit_<male|female>_<name>.glb        garment shells skinned to the SAME rig (flat colours, no textures)
  acc_<name>.glb                         props attached to bones at runtime (pistol, flashlight, tray ...)

Every garment is a duplicate of a body region (chosen by skin-weight + height/plane tests) pushed out along the
normals, so it inherits the body's skinning and follows ALL Quaternius animations. The engine mixes body + hair +
outfit at runtime, which also makes disguises (outfit swaps) trivial.

usage: python3 tools/blender/make_characters.py [bodies] [hair] [outfits] [acc]     (default: all)
Requires: pip install bpy==4.2.0 ; the Quaternius packs downloaded (see DL_ROOT below).
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector

bpy.ops.wm.read_factory_settings(use_empty=True)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'assets', 'characters'))
DL_ROOT = os.environ.get('DL_ROOT', '/tmp/claude-0/-home-user-sonnet-test/0f3e21fc-e756-582e-a0ed-e15821664ef7/scratchpad/dl')
BC = os.path.join(DL_ROOT, 'universal-base-characters/x/Universal Base Characters[Standard]/')
GUNS = os.path.join(DL_ROOT, '50-lowpoly-guns/x/')
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------------------- helpers
def lin(h):
    h = h.lstrip('#'); return tuple((int(h[i:i + 2], 16) / 255.0) ** 2.2 for i in (0, 2, 4))

_mats = {}
def mat(name, hexcol, rough=0.75, metal=0.0, emit=None, strength=0.0):
    if name in _mats: return _mats[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*lin(hexcol), 1)
    b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*lin(emit), 1); b.inputs['Emission Strength'].default_value = strength
    _mats[name] = m; return m

def wipe():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.meshes): bpy.data.meshes.remove(m)
    for i in list(bpy.data.images): bpy.data.images.remove(i)
    for m in list(bpy.data.materials): bpy.data.materials.remove(m)
    for a in list(bpy.data.armatures): bpy.data.armatures.remove(a)
    _mats.clear()

def import_gltf(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]

def select(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]

def export(path, objs, image_format='AUTO', uv=True):
    select(objs)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_yup=True,
                              export_skins=True, export_animations=False, export_cameras=False, export_lights=False,
                              export_image_format=image_format, export_jpeg_quality=82, export_texcoords=uv,
                              export_normals=True, export_tangents=False)
    print(f'  wrote {os.path.basename(path)}  {os.path.getsize(path) // 1024} KB')

def scale_image(img, size):
    if img.size[0] > size: img.scale(size, size)

# ---------------------------------------------------------------------------- body access
class Rig:
    """Imported base body + measurements used to size garments."""
    def __init__(self, gender, skin):
        self.gender, self.skin = gender, skin
        self.objs = import_gltf(BC + 'Base Characters/Godot - UE/Superhero_%s_FullBody.gltf' % gender.capitalize())
        self.arm = [o for o in self.objs if o.type == 'ARMATURE'][0]
        meshes = [o for o in self.objs if o.type == 'MESH']
        self.body = [m for m in meshes if m.name.lower().startswith('super')][0]
        self.eyes = [m for m in meshes if m.name == 'Eyes'][0]
        self.brows = [m for m in meshes if m.name == 'Eyebrows'][0]
        for o in self.objs:                                   # stray helper mesh in the pack
            if o.type == 'MESH' and o.name.startswith('Icosphere'): bpy.data.objects.remove(o, do_unlink=True)
        B = self.arm.data.bones
        self.b = lambda n: B[n].head_local.copy()
        self.pelvis_z = self.b('pelvis').z
        self.wrist_x = self.b('hand_l').x
        self.ankle_z = self.b('foot_l').z
        self.neck_z = self.b('neck_01').z
        self.head_z = self.b('Head').z
        ez = sum(v.co.z for v in self.eyes.data.vertices) / len(self.eyes.data.vertices)
        self.eye_z = ez
        hv = [v.co for v in self.body.data.vertices if v.co.z > self.head_z + 0.02]
        self.head_top = max(v.z for v in hv)
        self.head_r = (max(v.x for v in hv) - min(v.x for v in hv)) / 2
        self.head_cy = sum(v.y for v in hv) / len(hv)
        self.head_cz = (self.head_top + self.head_z + 0.03) / 2
        self.vg = {i: g.name for i, g in enumerate(self.body.vertex_groups)}
        self._bv = [v.co.copy() for v in self.body.data.vertices]

    def front_y(self, z, half=0.05):
        ys = [c.y for c in self._bv if abs(c.x) < half and abs(c.z - z) < 0.03 and c.y < 0.12]
        return min(ys) if ys else -0.09

    def skin_material(self):
        f = {('male', 'light'): 'T_Superhero_Male_Ligh.png', ('male', 'dark'): 'T_Superhero_Male_Dark.png',
             ('female', 'light'): 'T_Superhero_Female_Light_BaseColor.png', ('female', 'dark'): 'T_Superhero_Female_Dark_BaseColor.png'}[(self.gender, self.skin)]
        img = bpy.data.images.load(BC + 'Base Characters/Textures/' + f); scale_image(img, 1024)
        m = bpy.data.materials.new('skin_%s_%s' % (self.gender, self.skin)); m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']; t = m.node_tree.nodes.new('ShaderNodeTexImage'); t.image = img
        m.node_tree.links.new(t.outputs['Color'], b.inputs['Base Color'])
        b.inputs['Roughness'].default_value = 0.62
        self.body.data.materials.clear(); self.body.data.materials.append(m)

# dominant-group name sets
def grp(*prefixes):
    return lambda g: any(g.startswith(p) for p in prefixes)
TORSO = grp('spine', 'clavicle')
UPARM = grp('upperarm'); LOARM = grp('lowerarm')
HAND = grp('hand', 'index', 'middle', 'pinky', 'ring', 'thumb')
THIGH = grp('thigh'); CALF = grp('calf'); FOOT = grp('foot', 'ball')
NECK = grp('neck'); HEAD = grp('Head'); PELVIS = grp('pelvis')
ARM = lambda g: UPARM(g) or LOARM(g)

def region(rig, name, pred, offset, material, smooth=True):
    """Duplicate of the body restricted to vertices where pred(co, dominant_group) is true, inflated along normals."""
    me = rig.body.data.copy(); me.name = name
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    for g in rig.body.vertex_groups: ob.vertex_groups.new(name=g.name)
    ob.parent = rig.arm
    md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = rig.arm
    bm = bmesh.new(); bm.from_mesh(me)
    dl = bm.verts.layers.deform.active
    drop = []
    for v in bm.verts:
        d = v[dl]; g = rig.vg[max(d.items(), key=lambda kv: kv[1])[0]] if len(d) else 'root'
        if not pred(v.co, g): drop.append(v)
    bmesh.ops.delete(bm, geom=drop, context='VERTS')
    bm.normal_update()
    for v in bm.verts:
        o = offset(v.co) if callable(offset) else offset
        v.co += v.normal * o
    bm.to_mesh(me); bm.free()
    me.materials.clear(); me.materials.append(material)
    for p in me.polygons: p.use_smooth = smooth
    return ob

def _bind_rigid(rig, ob, bone):
    vg = ob.vertex_groups.new(name=bone); vg.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    ob.parent = rig.arm
    md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = rig.arm

def prim(rig, kind, name, bone, loc, size, material, rot=(0, 0, 0), verts=12, smooth=False, r2=None):
    if kind == 'box': bpy.ops.mesh.primitive_cube_add(size=1)
    elif kind == 'cyl': bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=0.5, depth=1)
    elif kind == 'cone': bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=0.5, radius2=(r2 or 0), depth=1)
    elif kind == 'ball': bpy.ops.mesh.primitive_uv_sphere_add(segments=verts, ring_count=max(4, verts // 2), radius=0.5)
    elif kind == 'torus': bpy.ops.mesh.primitive_torus_add(major_segments=verts * 2, minor_segments=8, major_radius=0.5, minor_radius=size[2] if len(size) > 3 else 0.06)
    ob = bpy.context.active_object; ob.name = name
    ob.scale = size[:3]; ob.rotation_euler = rot; ob.location = loc
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    ob.data.materials.append(material)
    for p in ob.data.polygons: p.use_smooth = smooth
    _bind_rigid(rig, ob, bone)
    return ob

# ---------------------------------------------------------------------------- garment recipes
NOIR = {
    'black': '#0b0b0e', 'charcoal': '#1d2027', 'graphite': '#2b2f38', 'navy': '#141b2c', 'steel': '#56657a', 'white': '#e9e9ee',
    'burgundy': '#5b0f1f', 'emerald': '#0f3b2e', 'midnight': '#151a3d', 'gold': '#c9a23a', 'brown': '#3a2618', 'leather': '#22170f',
    'khaki': '#5b5540', 'coverall': '#2f465e', 'hivis': '#c8a020',
}
def C(n): return NOIR[n]

NOT_BODYTOP = lambda g: HEAD(g) or NECK(g) or HAND(g)

def shoes(rig, hexcol='#08080a', height=0.09):
    return region(rig, 'shoes', lambda co, g: co.z < rig.ankle_z + height and not ARM(g) and not HAND(g), 0.014, mat('shoe_' + hexcol, hexcol, 0.45))

def trousers(rig, hexcol, off=0.011, waist=0.06, rough=0.85):
    wz = rig.pelvis_z + waist
    return region(rig, 'trousers', lambda co, g: co.z < wz and co.z > rig.ankle_z + 0.075 and not ARM(g) and not HAND(g), off, mat('trousers_' + hexcol, hexcol, rough))

def top(rig, hexcol, off=0.012, hem=0.11, arms=True, name='top', rough=0.85, collar=True):
    hz = rig.pelvis_z - hem
    def pred(co, g):
        if NOT_BODYTOP(g) or co.z < hz: return False
        if not arms and ARM(g): return False
        return True
    return region(rig, name, pred, off, mat(name + hexcol, hexcol, rough))

def gloves(rig, hexcol, off=0.006, long=False):
    return region(rig, 'gloves', lambda co, g: HAND(g) or (long and LOARM(g)), off, mat('gloves' + hexcol, hexcol, 0.5))

def neck_gaiter(rig, hexcol):
    return region(rig, 'gaiter', lambda co, g: NECK(g) or (HEAD(g) and co.z < rig.head_z + 0.045 and co.y > -0.03), 0.010, mat('gaiter' + hexcol, hexcol, 0.9))

def cap(rig, hexcol, off=0.013, brim=True, brow=0.045, name='cap'):
    ez = rig.eye_z + brow
    ob = region(rig, name, lambda co, g: HEAD(g) and (co.z > ez or (co.y > 0.02 and co.z > rig.eye_z - 0.04)), off, mat('cap' + hexcol, hexcol, 0.85))
    if brim:
        prim(rig, 'cyl', 'brim', 'Head', (0, rig.head_cy - rig.head_r * 0.95, ez + 0.005), (rig.head_r * 1.5, rig.head_r * 0.9, 0.012),
             mat('cap' + hexcol, hexcol, 0.85), rot=(math.radians(8), 0, 0), verts=16, smooth=True)
    return ob

def belt(rig, hexcol='#151210', z=None, thick=0.03):
    z = z if z is not None else rig.pelvis_z + 0.045
    return prim(rig, 'cyl', 'belt', 'pelvis', (0, rig.b('pelvis').y - 0.005, z), (0.34, 0.24, thick), mat('belt', hexcol, 0.5), verts=20, smooth=True)

def buckle(rig, z=None):
    z = z if z is not None else rig.pelvis_z + 0.045
    return prim(rig, 'box', 'buckle', 'pelvis', (0, -0.115, z), (0.05, 0.012, 0.035), mat('brass', C('gold'), 0.3, 0.9))

def tie(rig, hexcol, z_top=None):
    zt = z_top if z_top is not None else rig.neck_z - 0.06
    prim(rig, 'box', 'knot', 'spine_03', (0, -0.075, zt), (0.035, 0.028, 0.035), mat('tie' + hexcol, hexcol, 0.45))
    prim(rig, 'cone', 'tieblade', 'spine_02', (0, -0.088, zt - 0.11), (0.06, 0.02, 0.2), mat('tie' + hexcol, hexcol, 0.45), rot=(math.radians(180), 0, 0), verts=4, r2=0.22)

def bowtie(rig, hexcol='#0b0b0e'):
    z = rig.neck_z - 0.045
    m = mat('bow' + hexcol, hexcol, 0.4)
    prim(rig, 'cone', 'bowL', 'spine_03', (0.035, -0.078, z), (0.05, 0.024, 0.05), m, rot=(0, math.radians(90), 0), verts=4)
    prim(rig, 'cone', 'bowR', 'spine_03', (-0.035, -0.078, z), (0.05, 0.024, 0.05), m, rot=(0, math.radians(-90), 0), verts=4)
    prim(rig, 'ball', 'bowK', 'spine_03', (0, -0.078, z), (0.022, 0.022, 0.022), m, verts=6)

def collar(rig, hexcol):
    m = mat('collar' + hexcol, hexcol, 0.7)
    for s in (-1, 1):
        prim(rig, 'box', 'collar', 'spine_03', (0.038 * s, -0.062, rig.neck_z - 0.032), (0.05, 0.012, 0.045), m, rot=(math.radians(-20), 0, math.radians(30) * -s))

def goggles(rig, lens='#66ffcc'):
    z = rig.eye_z + 0.075; y = rig.head_cy - rig.head_r * 0.98
    band = mat('gogband', '#101114', 0.6)
    prim(rig, 'torus', 'gogstrap', 'Head', (0, rig.head_cy, z), (rig.head_r * 2.15, rig.head_r * 2.3, 0.04, 0.014), band, verts=14, smooth=True)
    em = mat('emit_goggle', lens, 0.4, 0, lens, 6.0)
    for s in (-1, 1):
        prim(rig, 'cyl', 'goglens', 'Head', (0.045 * s, y - 0.012, z + 0.005), (0.055, 0.055, 0.045), band, rot=(math.radians(90), 0, 0), verts=10, smooth=True)
        prim(rig, 'cyl', 'goglens_e', 'Head', (0.045 * s, y - 0.038, z + 0.005), (0.04, 0.04, 0.008), em, rot=(math.radians(90), 0, 0), verts=10, smooth=True)

def holster(rig, side=1, hexcol='#14110f'):
    b = 'thigh_r' if side > 0 else 'thigh_l'
    x = -0.155 * side
    prim(rig, 'box', 'holster', b, (x, 0.0, rig.pelvis_z - 0.16), (0.05, 0.11, 0.2), mat('holster', hexcol, 0.5), smooth=False)

def radio(rig, side=1):
    prim(rig, 'box', 'radio', 'spine_03', (0.10 * side, -0.075, rig.neck_z - 0.13), (0.045, 0.028, 0.085), mat('radio', '#0d0d10', 0.4))
    prim(rig, 'cyl', 'radioant', 'spine_03', (0.105 * side, -0.075, rig.neck_z - 0.045), (0.008, 0.008, 0.08), mat('radio', '#0d0d10', 0.4), verts=6)
    prim(rig, 'box', 'radioled', 'spine_03', (0.10 * side, -0.091, rig.neck_z - 0.11), (0.012, 0.004, 0.012), mat('emit_led_g', '#33ff66', 0.4, 0, '#33ff66', 4.0))

def flashlight_belt(rig):
    prim(rig, 'cyl', 'torch', 'pelvis', (0.17, -0.02, rig.pelvis_z - 0.03), (0.032, 0.032, 0.17), mat('torch', '#0c0c0f', 0.4, 0.5), verts=10, smooth=True)

def badge(rig, side=-1):
    prim(rig, 'box', 'badge', 'spine_03', (0.075 * side, -0.083, rig.neck_z - 0.11), (0.04, 0.008, 0.046), mat('brass', C('gold'), 0.3, 0.9))

def pouches(rig):
    m = mat('pouch', '#16181d', 0.9)
    for i, x in enumerate((-0.09, -0.03, 0.03, 0.09)):
        prim(rig, 'box', 'pouch%d' % i, 'spine_01', (x, -0.104, rig.pelvis_z + 0.22), (0.05, 0.03, 0.065), m)

def lapels(rig, hexcol='#050506'):
    m = mat('satin' + hexcol, hexcol, 0.28)
    for s in (-1, 1):
        prim(rig, 'box', 'lapel', 'spine_03', (0.055 * s, -0.087, rig.neck_z - 0.15), (0.035, 0.014, 0.22), m, rot=(0, 0, math.radians(14) * s))

def shirt_front(rig, hexcol, off=0.017):
    """White shirt panel visible between the lapels: a tapered slab hugging the chest front."""
    z0, z1 = rig.pelvis_z + 0.07, rig.neck_z - 0.05
    m = mat('shirt' + hexcol, hexcol, 0.6)
    zm = (z0 + z1) / 2; y = rig.front_y(zm) - 0.016
    prim(rig, 'box', 'shirtpanel', 'spine_02', (0, y, zm), (0.085, 0.012, z1 - z0 - 0.04), m)
    prim(rig, 'box', 'shirtpanel_u', 'spine_03', (0, rig.front_y(z1 - 0.02) - 0.014, z1 - 0.01), (0.07, 0.012, 0.05), m)

def skirt(rig, hexcol, hem=0.10, flare=0.46, waist_r=0.245, rough=0.55):
    """Floor-length flared skirt, lathed and skinned pelvis -> thighs (split left/right by x)."""
    top_z = rig.pelvis_z + 0.09; rings = 10; seg = 32
    me = bpy.data.meshes.new('skirt'); ob = bpy.data.objects.new('skirt', me); bpy.context.scene.collection.objects.link(ob)
    verts, faces = [], []
    for i in range(rings):
        t = i / (rings - 1); z = top_z + (hem - top_z) * t
        r = waist_r + (flare - waist_r) * (t ** 1.15)
        for k in range(seg):
            a = 2 * math.pi * k / seg; verts.append((math.cos(a) * r, rig.b('pelvis').y + math.sin(a) * r * 0.78, z))
    for i in range(rings - 1):
        for k in range(seg):
            a, b_ = i * seg + k, i * seg + (k + 1) % seg
            faces.append((a, b_, b_ + seg, a + seg))
    me.from_pydata(verts, [], faces); me.update()
    for p in me.polygons: p.use_smooth = True
    for n in ['pelvis', 'thigh_l', 'thigh_r']: ob.vertex_groups.new(name=n)
    gp, gl, gr = (ob.vertex_groups[n] for n in ['pelvis', 'thigh_l', 'thigh_r'])
    for i in range(rings):
        t = i / (rings - 1)
        for k in range(seg):
            idx = i * seg + k; x = verts[idx][0]
            s = max(0.0, min(1.0, (x + 0.14) / 0.28)); s = s * s * (3 - 2 * s)      # +x = left leg
            wleg = min(0.92, t * 1.1)
            gp.add([idx], 1 - wleg, 'REPLACE'); gl.add([idx], wleg * s, 'REPLACE'); gr.add([idx], wleg * (1 - s), 'REPLACE')
    me.materials.append(mat('skirt' + hexcol, hexcol, rough))
    ob.parent = rig.arm; md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = rig.arm
    return ob

def necklace(rig):
    prim(rig, 'torus', 'necklace', 'spine_03', (0, rig.b('neck_01').y - 0.01, rig.neck_z - 0.02), (0.15, 0.15, 0.03, 0.006), mat('brass', C('gold'), 0.25, 0.95), verts=12, smooth=True)

def glasses(rig, hexcol='#0a0a0c'):
    z = rig.eye_z + 0.002; y = rig.head_cy - rig.head_r * 0.98 - 0.006
    m = mat('glasses', hexcol, 0.3)
    for s in (-1, 1): prim(rig, 'torus', 'lens', 'Head', (0.043 * s, y, z), (0.05, 0.05, 0.05, 0.004), m, rot=(math.radians(90), 0, 0), verts=8, smooth=True)
    prim(rig, 'box', 'bridge', 'Head', (0, y, z + 0.005), (0.02, 0.006, 0.006), m)

def chef_hat(rig):
    m = mat('chefwhite', '#f2f2f4', 0.8)
    prim(rig, 'cyl', 'chefband', 'Head', (0, rig.head_cy, rig.head_top - 0.02), (rig.head_r * 1.9, rig.head_r * 2.0, 0.07), m, verts=16, smooth=True)
    prim(rig, 'ball', 'chefpuff', 'Head', (0, rig.head_cy, rig.head_top + 0.07), (rig.head_r * 2.2, rig.head_r * 2.2, 0.17), m, verts=12, smooth=True)

def apron(rig, hexcol):
    prim(rig, 'box', 'apron', 'pelvis', (0, rig.front_y(rig.pelvis_z - 0.1, 0.12) - 0.03, rig.pelvis_z - 0.2), (0.22, 0.02, 0.38), mat('apron' + hexcol, hexcol, 0.8))

def helmet(rig, hexcol='#101216'):
    ez = rig.eye_z + 0.03
    region(rig, 'helmet', lambda co, g: HEAD(g) and (co.z > ez or (co.y > 0.0 and co.z > rig.eye_z - 0.07)), 0.02, mat('helmet' + hexcol, hexcol, 0.4, 0.2))

OUTFITS = {}
def outfit(fn): OUTFITS[fn.__name__] = fn; return fn

@outfit
def thief(rig):
    top(rig, C('charcoal'), 0.010, name='turtle', rough=0.9)
    region(rig, 'vest', lambda co, g: rig.pelvis_z + 0.02 < co.z < rig.neck_z - 0.02 and abs(co.x) < 0.17 and not NOT_BODYTOP(g), 0.028, mat('vest', C('graphite'), 0.7))
    trousers(rig, C('black'), rough=0.85); shoes(rig, '#060607', 0.13); gloves(rig, C('black'))
    neck_gaiter(rig, C('charcoal')); cap(rig, C('black'), brim=False); goggles(rig)
    belt(rig, '#0f0f10'); pouches(rig); holster(rig, 1, '#0e0e10'); flashlight_belt(rig)

@outfit
def guard(rig):
    top(rig, C('navy'), 0.011, name='shirt', rough=0.8)
    region(rig, 'armor', lambda co, g: rig.pelvis_z + 0.03 < co.z < rig.neck_z - 0.02 and abs(co.x) < 0.17 and not NOT_BODYTOP(g), 0.026, mat('armor', '#1a1e26', 0.75))
    trousers(rig, '#10141d'); shoes(rig, '#070708', 0.12); gloves(rig, '#0b0b0d', 0.005)
    cap(rig, '#0d1018', brim=True); belt(rig, '#0d0d0f'); buckle(rig); holster(rig); radio(rig, 1); flashlight_belt(rig); badge(rig); pouches(rig)
    for sd in (-1, 1): prim(rig, 'box', 'patch', 'upperarm_l' if sd > 0 else 'upperarm_r', (0.31 * sd, 0.065, rig.b('upperarm_l').z + 0.05), (0.07, 0.06, 0.012), mat('brass', C('gold'), 0.3, 0.9))

@outfit
def guard_elite(rig):
    top(rig, C('black'), 0.011, name='shirt', rough=0.8)
    region(rig, 'armor', lambda co, g: rig.pelvis_z + 0.03 < co.z < rig.neck_z - 0.02 and abs(co.x) < 0.17 and not NOT_BODYTOP(g), 0.03, mat('armor_e', '#0c0d10', 0.55, 0.15))
    trousers(rig, '#0b0b0e'); shoes(rig, '#050506', 0.14); gloves(rig, '#08080a', 0.006)
    helmet(rig); belt(rig, '#0a0a0c'); holster(rig); radio(rig, -1); flashlight_belt(rig); pouches(rig)

@outfit
def tuxedo(rig):
    top(rig, C('black'), 0.014, name='jacket', hem=0.20, rough=0.7)
    shirt_front(rig, C('white')); trousers(rig, C('black'), rough=0.6); shoes(rig, '#0a0a0b', 0.1)
    lapels(rig); bowtie(rig); collar(rig, C('white'))
    gloves(rig, '#d9d9dd', 0.004)

@outfit
def dress(rig):
    col = C('burgundy')
    region(rig, 'bodice', lambda co, g: co.z > rig.pelvis_z - 0.06 and abs(co.x) < rig.b('upperarm_l').x + 0.06 and not NOT_BODYTOP(g), 0.009, mat('dress' + col, col, 0.42))
    skirt(rig, col); gloves(rig, '#0b0b0e', 0.005, long=True); necklace(rig); shoes(rig, '#0a0a0c', 0.06)
    prim(rig, 'box', 'clasp', 'spine_03', (0, -0.085, rig.pelvis_z + 0.19), (0.022, 0.012, 0.022), mat('brass', C('gold'), 0.3, 0.9))

@outfit
def dress_green(rig):
    col = C('emerald')
    region(rig, 'bodice', lambda co, g: co.z > rig.pelvis_z - 0.06 and abs(co.x) < 0.2 and not NOT_BODYTOP(g), 0.009, mat('dress' + col, col, 0.42))
    skirt(rig, col, flare=0.36); necklace(rig); shoes(rig, '#0a0a0c', 0.06)

@outfit
def waiter(rig):
    top(rig, C('white'), 0.010, name='shirt', hem=0.12, rough=0.7)
    region(rig, 'vest', lambda co, g: rig.pelvis_z - 0.02 < co.z < rig.neck_z - 0.03 and abs(co.x) < 0.17 and not NOT_BODYTOP(g), 0.018, mat('vestblk', '#0b0b0e', 0.6))
    trousers(rig, '#0b0b0e', rough=0.7); shoes(rig, '#08080a', 0.1); bowtie(rig); apron(rig, '#f0f0f2')

@outfit
def exec_suit(rig):
    top(rig, '#2a2f3a', 0.014, name='jacket', hem=0.20, rough=0.85)
    shirt_front(rig, C('white')); trousers(rig, '#2a2f3a', rough=0.85); shoes(rig, '#2a1a10', 0.1); tie(rig, C('burgundy')); collar(rig, C('white')); glasses(rig)

@outfit
def staff(rig):
    region(rig, 'coverall', lambda co, g: co.z > rig.ankle_z + 0.08 and not NOT_BODYTOP(g), 0.014, mat('coverall', C('coverall'), 0.9))
    shoes(rig, '#1a1410', 0.13); cap(rig, '#22364a', brim=True); belt(rig, '#181410'); prim(rig, 'box', 'patch', 'spine_03', (0.07, -0.085, rig.neck_z - 0.12), (0.06, 0.008, 0.03), mat('patch', C('hivis'), 0.6))

@outfit
def chef(rig):
    region(rig, 'jacket', lambda co, g: co.z > rig.pelvis_z - 0.12 and not NOT_BODYTOP(g), 0.014, mat('chefjacket', '#efeff2', 0.8))
    trousers(rig, '#2b2f3a', rough=0.85); shoes(rig, '#0c0c0e', 0.1); chef_hat(rig); apron(rig, '#dcdce0')

# ---------------------------------------------------------------------------- builders
def build_bodies():
    for gender in ('male', 'female'):
        for skin in ('light', 'dark'):
            wipe(); rig = Rig(gender, skin); rig.skin_material()
            # eyes: keep their own material, drop the eyebrows (they come from the hair pack, alpha-tested png)
            bpy.data.objects.remove(rig.brows, do_unlink=True)
            for im in bpy.data.images:
                if im.size[0] > 512 and 'Skin' not in im.name and 'Super' not in im.name and 'T_Superhero' not in im.name: pass
            export(os.path.join(OUT, f'body_{gender}_{skin}.glb'), [rig.arm, rig.body, rig.eyes], 'JPEG')

def build_hair():
    src = BC + 'Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/'
    for f in sorted(os.listdir(src)):
        if not f.endswith('.gltf'): continue
        wipe(); objs = import_gltf(src + f)
        for im in bpy.data.images: scale_image(im, 512)
        name = f[:-5].lower().replace('hair_', 'hair_').replace('eyebrows_', 'brows_')
        keep = [o for o in objs if o.type in ('ARMATURE', 'MESH')]
        export(os.path.join(OUT, name + '.glb'), keep, 'AUTO')

def build_outfits(only=None):
    for gender in ('male', 'female'):
        for name, fn in OUTFITS.items():
            if only and name not in only: continue
            if gender == 'male' and name in ('dress', 'dress_green'): continue
            wipe(); rig = Rig(gender, 'light')
            fn(rig)
            base = (rig.body, rig.eyes, rig.brows)
            garments = [o for o in bpy.data.objects if o.type == 'MESH' and o not in base and o.parent == rig.arm]
            export(os.path.join(OUT, f'outfit_{gender}_{name}.glb'), [rig.arm] + garments, 'AUTO', uv=False)

def build_acc():
    """Bone-attached props. Origin = the grip point; they are parented to hand_r / thigh / spine bones at runtime."""
    def pistol(name, silencer, torch):
        wipe()
        src = GUNS + 'FBX/Pistol_1.fbx'
        before = set(bpy.data.objects); bpy.ops.import_scene.fbx(filepath=src)
        objs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
        if silencer:
            b2 = set(bpy.data.objects); bpy.ops.import_scene.fbx(filepath=GUNS + 'FBX/Accessories/Silencer_Short.fbx'); objs += [o for o in bpy.data.objects if o not in b2 and o.type == 'MESH']
        if torch:
            b2 = set(bpy.data.objects); bpy.ops.import_scene.fbx(filepath=GUNS + 'FBX/Accessories/Flashlight.fbx'); objs += [o for o in bpy.data.objects if o not in b2 and o.type == 'MESH']
        for o in objs: o.parent = None
        for im in bpy.data.images: scale_image(im, 256)
        export(os.path.join(OUT, name + '.glb'), objs, 'AUTO')
    try:
        pistol('acc_pistol', False, False); pistol('acc_dart_pistol', True, False); pistol('acc_pistol_torch', False, True)
    except Exception as e:
        print('  (gun import skipped:', e, ')')

if __name__ == '__main__':
    what = set(a for a in sys.argv[1:] if not a.startswith('-')) or {'bodies', 'hair', 'outfits', 'acc'}
    only = [a.split('=')[1] for a in sys.argv if a.startswith('outfit=')]
    if 'bodies' in what: build_bodies()
    if 'hair' in what: build_hair()
    if 'outfits' in what: build_outfits(only or None)
    if 'acc' in what: build_acc()
    print('done')
