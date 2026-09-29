"""
Shrinks the Quaternius Universal Animation Library .glb files (CC0) into web-friendly "clips only" files:
  * drops meshes / skins / materials / textures (bodies come from the character files)
  * drops constant SCALE tracks and constant TRANSLATION tracks (keeps root + pelvis motion)
  * quantises rotations to normalised int16, de-duplicates identical time arrays
  * keeps only a whitelist of clips
usage: python3 tools/anim_strip.py <in.glb> <out.glb> clipA,clipB,... | all
"""
import json, struct, sys, hashlib
import numpy as np

def read_glb(path):
    d = open(path, 'rb').read()
    jl = struct.unpack('<I', d[12:16])[0]
    j = json.loads(d[20:20 + jl])
    bo = 20 + jl
    bl = struct.unpack('<I', d[bo:bo + 4])[0]
    return j, d[bo + 8:bo + 8 + bl]

def accessor_array(j, b, idx):
    a = j['accessors'][idx]; bv = j['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return np.frombuffer(b, dtype='<f4', count=a['count'] * n, offset=off).reshape(a['count'], n).copy()

def main(src, dst, wanted):
    j, b = read_glb(src)
    names = [n['name'] for n in j['nodes']]
    keep_clips = [a for a in j['animations'] if wanted == 'all' or a['name'] in wanted]
    blob = bytearray(); views = []; accessors = []; cache = {}
    def add(arr, ctype, typ, normalized=False, minmax=False):
        raw = arr.tobytes()
        key = (hashlib.md5(raw).hexdigest(), ctype, typ)
        if key in cache: return cache[key]
        while len(blob) % 4: blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(raw)}); blob.extend(raw)
        acc = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
        if normalized: acc['normalized'] = True
        if minmax: acc['min'] = [float(arr.min())]; acc['max'] = [float(arr.max())]
        accessors.append(acc); cache[key] = len(accessors) - 1
        return cache[key]
    out_anims = []
    dropped = {'scale': 0, 'translation': 0}
    for a in keep_clips:
        chans, samps, smap = [], [], {}
        for c in a['channels']:
            node = c['target']['node']; path = c['target']['path']; nm = names[node]
            if path == 'scale': dropped['scale'] += 1; continue
            if path == 'translation' and nm not in ('root', 'pelvis'): dropped['translation'] += 1; continue
            s = a['samplers'][c['sampler']]
            t = accessor_array(j, b, s['input'])[:, 0].astype('<f4')
            v = accessor_array(j, b, s['output'])
            ia = add(t, 5126, 'SCALAR', minmax=True)
            if path == 'rotation':
                v = v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)
                oa = add(np.round(v * 32767).astype('<i2'), 5122, 'VEC4', normalized=True)
            else:
                oa = add(v.astype('<f4'), 5126, 'VEC3')
            key = (ia, oa, s.get('interpolation', 'LINEAR'))
            if key not in smap:
                smap[key] = len(samps); samps.append({'input': ia, 'output': oa, 'interpolation': key[2]})
            chans.append({'sampler': smap[key], 'target': {'node': node, 'path': path}})
        out_anims.append({'name': a['name'], 'channels': chans, 'samplers': samps})
    # nodes: keep hierarchy, drop mesh / skin
    nodes = []
    for n in j['nodes']:
        n = dict(n); n.pop('mesh', None); n.pop('skin', None); nodes.append(n)
    scene_roots = j['scenes'][j.get('scene', 0)]['nodes']
    out = {'asset': {'version': '2.0', 'generator': 'tools/anim_strip.py'}, 'scene': 0, 'scenes': [{'nodes': scene_roots}],
           'nodes': nodes, 'animations': out_anims, 'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}]}
    js = json.dumps(out, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    while len(blob) % 4: blob.append(0)
    glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(blob), 0x004E4942) + bytes(blob)
    open(dst, 'wb').write(glb)
    print(f'{dst}: {len(glb)//1024} KB, {len(out_anims)} clips (dropped {dropped})')

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    want = 'all' if len(sys.argv) < 4 or sys.argv[3] == 'all' else set(sys.argv[3].split(','))
    main(src, dst, want)
