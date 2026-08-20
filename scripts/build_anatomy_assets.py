#!/usr/bin/env python3
"""Build anatomy viewer assets from BodyParts3D-derived GLBs.

Inputs (not committed; see docs/BLUEPRINT.md for provenance):
  - Original per-layer GLBs from the anatomy-lab v1.0.0 runtime asset pack
    (BodyParts3D 4.0, CC-BY-4.0, The Database Center for Life Science).
  - parsed_metadata.json from the same pack (FMA concept names per FJ file id).

Outputs (committed):
  - static/assets/anatomy/<layer>.glb        meshopt-compressed via gltfpack
  - static/assets/anatomy/structures.json    per-structure metadata:
        id, name, layer, region, center, size

Region classification uses each structure's world-space bounding box in the
shared normalized model space (unit height, y up, z anterior), refined with
name-based overrides so organs land in clinically sensible regions.

Usage:
  python scripts/build_anatomy_assets.py --assets-dir /path/to/pack --out static/assets/anatomy
Requires: gltfpack (npx gltfpack) on PATH for compression.
"""
from __future__ import annotations

import argparse
import json
import struct
import subprocess
import zipfile
from pathlib import Path

LAYERS = {
    "skin": "skin.glb",
    "skeleton": "skeleton.glb",
    "muscles": "muscle_fat.glb",
    "organs": "organ.glb",
    "vascular": "vessel.glb",
    "nerves": "nerve.glb",
}

# gltfpack simplification ratio per layer (heavier layers get more decimation)
SIMPLIFY = {"muscles": 0.35, "vascular": 0.35, "skin": 0.6, "skeleton": 0.6, "organs": 0.6, "nerves": 0.6}


def read_glb_json(path: Path) -> dict:
    with open(path, "rb") as fh:
        magic, _ver, _length = struct.unpack("<III", fh.read(12))
        assert magic == 0x46546C67, f"not a GLB: {path}"
        clen, ctype = struct.unpack("<II", fh.read(8))
        assert ctype == 0x4E4F534A
        return json.loads(fh.read(clen))


def load_names(meta_path: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Map FJ file id -> (most specific concept name, broad parent name).

    ``element_parts`` lists EVERY ancestor concept for each file (e.g. a
    coronary-artery mesh maps to "human body", "heart", ... down to its exact
    branch). The most specific concept is the one shared by the fewest files.
    """
    if meta_path.suffix == ".zip":
        with zipfile.ZipFile(meta_path) as z:
            name = next(n for n in z.namelist() if n.endswith("parsed_metadata.json"))
            meta = json.loads(z.read(name))
    else:
        meta = json.loads(meta_path.read_text())

    concept_files: dict[str, set[str]] = {}
    file_concepts: dict[str, set[tuple[str, str]]] = {}
    file_partof: dict[str, set[str]] = {}
    for ep in meta.get("element_parts", []):
        fid, cid, nm = ep.get("element_file_id"), ep.get("concept_id"), ep.get("name")
        if not (fid and cid and nm):
            continue
        if ep.get("tree") == "isa":
            # isa tree gives clean specific type names
            concept_files.setdefault(cid, set()).add(fid)
            file_concepts.setdefault(fid, set()).add((cid, nm))
        else:
            # partof tree carries organ/system ancestry (heart, left lung, ...)
            file_partof.setdefault(fid, set()).add(nm)

    GENERIC = {
        "human body", "anatomical entity", "body proper", "physical anatomical entity",
        "organ", "organ part", "organ system", "cavity of organ part",
        "anatomical structure", "material anatomical entity", "anatomical set",
    }
    specific: dict[str, str] = {}
    parent: dict[str, str] = {}
    for fid, concepts in file_concepts.items():
        ranked = sorted(concepts, key=lambda cn: (len(concept_files[cn[0]]), len(cn[1])))
        named = [(cid, nm) for cid, nm in ranked if nm.lower() not in GENERIC]
        if not named:
            continue
        specific[fid] = named[0][1]
        # Group = a clinically meaningful organ/system ancestor from a
        # curated whitelist. The partof tree carries the useful organ
        # ancestry (heart, left lung, liver...); isa mostly carries
        # abstract types ("cavitated organ") we ignore.
        group = ""
        candidates = [nm for nm in file_partof.get(fid, ()) if nm.lower() in CLINICAL_GROUPS]
        if not candidates:
            candidates = [nm for _cid, nm in named if nm.lower() in CLINICAL_GROUPS]
        if candidates:
            group = sorted(candidates, key=len)[0]
        parent[fid] = group
    return specific, parent


# ---------------------------------------------------------------------------
# Supplemental muscles
# ---------------------------------------------------------------------------
# The anatomy-lab muscle subset omits most large superficial muscles patients
# actually ask about. We convert those directly from the BodyParts3D isa OBJ
# archive into the shared normalized GLB space.
#
# Exact OBJ->GLB space transform, fitted on 20 meshes present in both spaces
# (max error 0.0 at 6 decimals):  g.x = S*o.x + BX ; g.y = S*o.z + BY ;
# g.z = -S*o.y + BZ   (BP3D is z-up mm; the pack is y-up unit-extent).
OBJ_SCALE = 0.00057812116
OBJ_OFFSET = (0.000374, -0.454842, -0.058256)

# Most specific FMA concept names to pull from the OBJ archive (right-side
# file + mirrored M twin cover both sides).
SUPPLEMENT_MUSCLES = [
    "medial head of right gastrocnemius", "lateral head of right gastrocnemius",
    "right soleus",
    "short head of right biceps brachii", "long head of right biceps brachii",
    "medial head of right triceps brachii", "lateral head of right triceps brachii",
    "long head of right triceps brachii",
    "clavicular part of right deltoid", "acromial part of right deltoid",
    "spinal part of right deltoid",
    "clavicular part of right pectoralis major", "sternocostal part of right pectoralis major",
    "abdominal part of right pectoralis major",
    "ascending part of right trapezius", "transverse part of right trapezius",
    "descending part of right trapezius",
    "right rectus femoris", "right vastus lateralis", "right vastus medialis",
    "right vastus intermedius",
    "long head of right biceps femoris", "short head of right biceps femoris",
    "right semitendinosus", "right semimembranosus",
    "right gluteus maximus", "right sartorius", "right tibialis anterior",
    "right brachioradialis", "right serratus anterior", "right psoas major",
    "right sternocleidomastoid", "left sternocleidomastoid",
]


# Organ/system-level FMA concepts worth surfacing as navigation groups.
CLINICAL_GROUPS = {
    "heart", "liver", "brain", "brainstem", "cerebellum", "spinal cord",
    "left lung", "right lung", "stomach", "pancreas", "spleen", "esophagus",
    "left kidney", "right kidney", "urinary bladder", "gallbladder",
    "small intestine", "large intestine", "trachea", "larynx", "pharynx",
    "thyroid gland", "diaphragm", "tongue", "left eyeball", "right eyeball",
    "vertebral column", "rib cage", "skull", "pelvis", "left hip bone",
    "right hip bone", "coronary artery", "aorta", "pulmonary trunk",
    "systemic arterial system", "segment of venous tree organ",
    "segment of neural tree organ", "portal venous system",
}


def swap_sides(name: str) -> str:
    """Swap left/right in a structure name (mirrored meshes)."""
    import re
    def repl(m: "re.Match[str]") -> str:
        return {"left": "right", "right": "left"}[m.group(0).lower()]
    return re.sub(r"\b(left|right)\b", repl, name, flags=re.IGNORECASE)


def structure_boxes(glb: dict) -> list[dict]:
    """World-space bbox per mesh node (quantized int16-normalized positions)."""
    accessors = glb["accessors"]
    meshes = glb["meshes"]
    out = []
    for node in glb["nodes"]:
        if "mesh" not in node:
            continue
        t = node.get("translation", [0, 0, 0])
        s = node.get("scale", [1, 1, 1])
        prim = meshes[node["mesh"]]["primitives"][0]
        acc = accessors[prim["attributes"]["POSITION"]]
        lo, hi = acc["min"], acc["max"]
        denom = 32767.0 if acc.get("normalized") else 1.0
        mn = [lo[i] / denom * s[i] + t[i] for i in range(3)]
        mx = [hi[i] / denom * s[i] + t[i] for i in range(3)]
        out.append({
            "id": node.get("name", f"mesh{node['mesh']}"),
            "center": [round((mn[i] + mx[i]) / 2, 4) for i in range(3)],
            "size": [round(mx[i] - mn[i], 4) for i in range(3)],
            "min": mn, "max": mx,
        })
    return out


# --- region classification -------------------------------------------------
# Shared normalized space: unit extent along height (y), centered at origin.
# Empirical y bands (fraction of height, -0.5..0.5), z>0 = anterior.

def classify(center, size, name: str) -> str:
    x, y, z = center
    n = f" {name.lower()} "
    side = "left" if x > 0.02 else ("right" if x < -0.02 else None)
    nside = "left" if " left " in n else ("right" if " right " in n else side)

    # Name-based overrides first (clinical sense beats geometry; long
    # structures like the humerus have centers near region boundaries).
    SIDED = {  # limb structures: region resolved per side from the name/geometry
        "humerus": "upper_arm", "biceps brachii": "upper_arm", "triceps brachii": "upper_arm",
        "deltoid": "shoulder", "rotator": "shoulder", "supraspinatus": "shoulder",
        "infraspinatus": "shoulder", "teres m": "shoulder", "subscapularis": "shoulder",
        "scapula": "shoulder", "clavicle": "shoulder", "acromio": "shoulder",
        "radius": "forearm", "ulna": "forearm", "brachioradialis": "forearm",
        "carpi": "forearm", "pronator": "forearm", "supinator": "forearm",
        "femur": "thigh", "quadriceps": "thigh", "vastus": "thigh",
        "rectus femoris": "thigh", "sartorius": "thigh", "biceps femoris": "thigh",
        "semitendinosus": "thigh", "semimembranosus": "thigh", "adductor": "thigh",
        "gracilis": "thigh", "hamstring": "thigh",
        "patella": "knee", "popliteal": "knee", "genicular": "knee", "meniscus": "knee",
        "tibia": "lower_leg", "fibula": "lower_leg", "gastrocnemius": "lower_leg",
        "soleus": "lower_leg", "achilles": "lower_leg", "calcaneal tendon": "lower_leg",
        "fibularis": "lower_leg", "peroneal": "lower_leg", "tibialis": "lower_leg",
        "calcaneus": "foot", "talus": "foot", "metatarsal": "foot", "toe": "foot",
        "plantar": "foot", "hallucis": "foot",
        "metacarpal": "hand", "finger": "hand", "thumb": "hand", "palmar": "hand",
        "carpal": "hand", "scaphoid": "hand", "lunate": "hand",
    }
    for key, part in SIDED.items():
        if key in n:
            if part in ("shoulder", "upper_arm", "forearm", "hand", "thigh", "knee", "lower_leg", "foot") and nside:
                return f"{nside}_{part}"
            break
    FIXED = [
        (("brain", "cerebr", "skull", "cranium", "eye", "orbit", "mandible", "maxilla", "tongue", "teeth", "tooth", " ear ", "masseter", "temporalis"), "head"),
        (("thyroid", "larynx", "pharynx", "trachea", "hyoid", "cervical vertebra", "sternocleidomastoid", "scalenus", "carotid"), "neck"),
        (("heart", "lung", "aortic arch", "pulmonary", "sternum", " rib", "thoracic vertebra", "esophagus", "bronch", "pericardium", "mammary", "pectoralis", "intercostal", "coronary"), "chest"),
        (("trapezius", "latissimus", "rhomboid", "erector spinae", "serratus posterior"), "upper_back"),
        (("liver", "stomach", "spleen", "pancreas", "gallbladder", "kidney", "intestine", "colon", "duodenum", "abdominal", "adrenal", "ureter", "umbilic", "rectus abdominis", "external oblique", "internal oblique", "psoas"), "abdomen"),
        (("lumbar vertebra", "quadratus lumborum", "iliocostalis lumborum"), "lower_back"),
        (("bladder", "uterus", "ovary", "prostate", "rectum", "sacrum", "coccyx", "pelvis", "pelvic", "hip bone", "ilium", "ischium", "pubis", "gluteus", "iliacus", "inguinal"), "hip"),
    ]
    for keys, region in FIXED:
        if any(k in n for k in keys):
            return region

    if y > 0.335:
        return "head"
    if y > 0.28:
        return "neck"
    if y > 0.05:
        # torso vs arms by lateral offset
        if abs(x) > 0.115:
            if y > 0.21:
                return f"{side}_shoulder" if side else "chest"
            if y > 0.10:
                return f"{side}_upper_arm" if side else "chest"
            return f"{side}_elbow" if side else "chest"
        # anterior/posterior split
        if y > 0.10:
            return "chest" if z > -0.01 else "upper_back"
        return "abdomen" if z > -0.01 else "lower_back"
    if y > -0.05:
        if abs(x) > 0.13:
            return f"{side}_forearm" if side else "hip"
        if abs(x) > 0.10 and y < 0.0:
            return f"{side}_hand" if side else "hip"
        return "hip" if z > -0.03 else "lower_back"
    if y > -0.12 and abs(x) > 0.13:
        return f"{side}_hand" if side else "hip"
    if y > -0.24:
        return f"{side}_thigh" if side else "hip"
    if y > -0.30:
        return f"{side}_knee" if side else "hip"
    if y > -0.43:
        return f"{side}_lower_leg" if side else "hip"
    if y > -0.465:
        return f"{side}_ankle" if side else "hip"
    return f"{side}_foot" if side else "hip"


def _parse_obj(data: bytes) -> tuple[list[list[float]], list[int]]:
    verts: list[list[float]] = []
    faces: list[int] = []
    for line in data.decode("utf-8", "replace").splitlines():
        if line.startswith("v "):
            p = line.split()
            x, y, z = float(p[1]), float(p[2]), float(p[3])
            # BP3D mm z-up -> shared unit y-up space
            verts.append([
                OBJ_SCALE * x + OBJ_OFFSET[0],
                OBJ_SCALE * z + OBJ_OFFSET[1],
                -OBJ_SCALE * y + OBJ_OFFSET[2],
            ])
        elif line.startswith("f "):
            idx = [int(t.split("/")[0]) - 1 for t in line.split()[1:4]]
            faces.extend(idx)
    return verts, faces


def _smooth_normals(verts: list[list[float]], faces: list[int]) -> list[list[float]]:
    import math
    normals = [[0.0, 0.0, 0.0] for _ in verts]
    for i in range(0, len(faces), 3):
        a, b, c = faces[i], faces[i + 1], faces[i + 2]
        va, vb, vc = verts[a], verts[b], verts[c]
        e1 = [vb[j] - va[j] for j in range(3)]
        e2 = [vc[j] - va[j] for j in range(3)]
        n = [e1[1] * e2[2] - e1[2] * e2[1],
             e1[2] * e2[0] - e1[0] * e2[2],
             e1[0] * e2[1] - e1[1] * e2[0]]
        for vi in (a, b, c):
            for j in range(3):
                normals[vi][j] += n[j]
    for n in normals:
        ln = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
        n[0] /= ln; n[1] /= ln; n[2] /= ln
    return normals


def build_supplement_glb(
    obj_zip: Path, meta_path: Path, out_path: Path, exclude: set[str] | None = None
) -> list[str]:
    """Convert SUPPLEMENT_MUSCLES (+ mirrored twins) from the BP3D isa OBJ
    archive into one GLB in the shared normalized space. Returns fids.

    ``exclude`` skips fids already present in the base muscle layer."""
    exclude = exclude or set()
    if meta_path.suffix == ".zip":
        with zipfile.ZipFile(meta_path) as z:
            name = next(n for n in z.namelist() if n.endswith("parsed_metadata.json"))
            meta = json.loads(z.read(name))
    else:
        meta = json.loads(meta_path.read_text())
    # concept name -> file ids (isa tree)
    by_name: dict[str, set[str]] = {}
    for ep in meta.get("element_parts", []):
        if ep.get("tree") != "isa":
            continue
        by_name.setdefault(ep["name"], set()).add(ep["element_file_id"])

    zobj = zipfile.ZipFile(obj_zip)
    available = {n.split("/")[-1][:-4]: n for n in zobj.namelist() if n.endswith(".obj")}

    fids: list[str] = []
    for concept in SUPPLEMENT_MUSCLES:
        for fid in sorted(by_name.get(concept, ())):
            if fid in available and fid not in fids and fid not in exclude:
                fids.append(fid)
                twin = fid + "M" if not fid.endswith("M") else fid[:-1]
                if twin in available and twin not in fids and twin not in exclude:
                    fids.append(twin)

    bin_chunks: list[bytes] = []
    buffer_views, accessors, meshes, nodes = [], [], [], []
    offset = 0
    for fid in fids:
        verts, faces = _parse_obj(zobj.read(available[fid]))
        if not verts or not faces:
            continue
        normals = _smooth_normals(verts, faces)
        pos = b"".join(struct.pack("<fff", *v) for v in verts)
        nor = b"".join(struct.pack("<fff", *n) for n in normals)
        idx = b"".join(struct.pack("<I", i) for i in faces)
        mins = [min(v[i] for v in verts) for i in range(3)]
        maxs = [max(v[i] for v in verts) for i in range(3)]
        for blob, target in ((pos, 34962), (nor, 34962), (idx, 34963)):
            buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": target})
            bin_chunks.append(blob + b"\x00" * (-len(blob) % 4))
            offset += len(bin_chunks[-1])
        base = len(accessors)
        accessors.append({"bufferView": len(buffer_views) - 3, "componentType": 5126, "count": len(verts), "type": "VEC3", "min": mins, "max": maxs})
        accessors.append({"bufferView": len(buffer_views) - 2, "componentType": 5126, "count": len(verts), "type": "VEC3"})
        accessors.append({"bufferView": len(buffer_views) - 1, "componentType": 5125, "count": len(faces), "type": "SCALAR"})
        meshes.append({"primitives": [{"attributes": {"POSITION": base, "NORMAL": base + 1}, "indices": base + 2}]})
        nodes.append({"name": fid, "mesh": len(meshes) - 1})

    binblob = b"".join(bin_chunks)
    gltf = {
        "asset": {"version": "2.0", "generator": "medisearch build_anatomy_assets"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes, "accessors": accessors,
        "bufferViews": buffer_views, "buffers": [{"byteLength": len(binblob)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(binblob)
    with open(out_path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A)); fh.write(js)
        fh.write(struct.pack("<II", len(binblob), 0x004E4942)); fh.write(binblob)
    return [n["name"] for n in nodes]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", required=True, help="dir with original per-layer GLBs")
    ap.add_argument("--metadata", required=True, help="parsed_metadata.json or asset-pack zip")
    ap.add_argument("--out", default="static/assets/anatomy")
    ap.add_argument("--skip-pack", action="store_true", help="skip gltfpack compression")
    ap.add_argument("--obj-zip", default="", help="BP3D isa OBJ archive for supplemental muscles")
    args = ap.parse_args()

    assets = Path(args.assets_dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    names, parents = load_names(Path(args.metadata))

    layer_files = dict(LAYERS)
    if args.obj_zip:
        base_muscle_fids = {
            n["name"] for n in read_glb_json(assets / LAYERS["muscles"]).get("nodes", [])
            if "mesh" in n
        }
        supp = assets / "muscles_extra.glb"
        fids = build_supplement_glb(
            Path(args.obj_zip), Path(args.metadata), supp, exclude=base_muscle_fids
        )
        print(f"muscles_extra: {len(fids)} supplemental muscle meshes")
        layer_files["muscles_extra"] = "muscles_extra.glb"
        SIMPLIFY.setdefault("muscles_extra", 0.5)

    structures = []
    for layer, fname in layer_files.items():
        src = assets / fname
        glb = read_glb_json(src)
        for box in structure_boxes(glb):
            raw = box["id"]
            fid = raw[:-1] if raw.endswith("M") else raw  # mirrored copies share metadata
            if raw in names:
                # Mirrored M-files usually have their own metadata entries
                # with the correct side already in the name.
                name, group = names[raw], parents.get(raw, "")
            elif raw.endswith("M") and fid in names:
                # Fallback: mirrored copy without own metadata — the geometry
                # is flipped across the sagittal plane, so swap sides.
                name = swap_sides(names[fid])
                group = swap_sides(parents.get(fid, ""))
            else:
                name, group = names.get(fid, fid), parents.get(fid, "")
            region = classify(box["center"], box["size"], f"{name} {group}")
            entry = {
                "id": raw,
                "name": name,
                "layer": "muscles" if layer == "muscles_extra" else layer,
                "region": region,
                "center": box["center"],
                "size": box["size"],
            }
            if group and group != name:
                entry["group"] = group
            structures.append(entry)
        if not args.skip_pack:
            dst = out / f"{layer}.glb"
            subprocess.run(
                ["npx", "--yes", "gltfpack@0.24", "-i", str(src), "-o", str(dst),
                 "-cc", "-si", str(SIMPLIFY[layer]), "-kn"],
                check=True, capture_output=True,
            )
            print(f"{layer}: {src.stat().st_size//1024}KB -> {dst.stat().st_size//1024}KB")

    (out / "structures.json").write_text(json.dumps({
        "attribution": "BodyParts3D 4.0, (c) The Database Center for Life Science, CC-BY-4.0. Derived GLBs via the anatomy-lab (MIT) pipeline; simplified and meshopt-compressed.",
        "license": "CC-BY-4.0",
        "structures": structures,
    }, separators=(",", ":")))
    print(f"structures.json: {len(structures)} structures")


if __name__ == "__main__":
    main()
