#!/usr/bin/env python3
"""Build per-organ deep-dive scene assets + the anatomy grounding index.

Phase A of the "visual story" pipeline:

  - static/assets/anatomy/scenes/<scene>.glb   one GLB per deep-dive scene
    (heart, eyes, teeth, brain), meshopt-compressed, node names = FJ ids,
    meshes kept in the same normalized body space as the body layers so the
    viewer can cross-fade between the whole body and an organ.
  - static/assets/anatomy/scenes/scenes.json   per-scene structure metadata:
        {scenes: {id: {label, structures: [{id, name, center, size}],
                       bounds: {min, max}}}}

  - app/data/anatomy_grounding.json            deterministic term->structure
    index for the backend grounding service:
        {names: {lowercased concept name: [fid, ...]},
         structures: {fid: {name, scenes: [...], layer: str|null}}}
    Every FMA ancestor concept of a displayable mesh is indexed, so a query
    for "heart" resolves to every heart mesh while "left ventricle" resolves
    to just the LV meshes — the part-of hierarchy comes pre-flattened from
    BodyParts3D element_parts.

Provenance: BodyParts3D 4.0 isa OBJ archive (CC-BY-SA 2.1 JP / CC-BY-4.0
derivative), same pack as scripts/build_anatomy_assets.py.

Usage:
  python scripts/build_scene_assets.py \
      --obj-zip /path/to/isa_obj.zip \
      --metadata /path/to/parsed_metadata.json \
      --body-structures static/assets/anatomy/structures.json \
      --out static/assets/anatomy/scenes \
      --grounding-out app/data/anatomy_grounding.json
"""
from __future__ import annotations

import argparse
import json
import struct
import subprocess
import zipfile
from collections import defaultdict
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_anatomy_assets import _parse_obj, _smooth_normals, swap_sides  # noqa: E402

# ---------------------------------------------------------------------------
# Scene definitions. Each scene selects meshes by matching the union of a
# mesh's FMA concept names (its own isa names plus every part-of ancestor
# name) against keyword predicates.
# ---------------------------------------------------------------------------

def _heart(names: set[str]) -> bool:
    # Include the great vessels at trunk level: clinically the "heart"
    # picture is incomplete without the aorta, pulmonary trunk and venae
    # cavae, but in FMA they are not part-of the heart organ. Exact names
    # only — substring matching would pull in the whole lung vasculature.
    GREAT_VESSELS = {
        "aorta", "ascending aorta", "arch of aorta", "thoracic aorta",
        "descending aorta", "pulmonary trunk", "trunk of pulmonary vein",
        "superior vena cava", "inferior vena cava",
        "left pulmonary artery", "right pulmonary artery",
    }
    return any(
        "heart" in n or "coronary" in n or "cardiac" in n or n in GREAT_VESSELS
        for n in names
    )


def _eyes(names: set[str]) -> bool:
    EXACT = {"cornea", "iris", "lens", "sclera", "choroid", "vitreous body"}
    return any(
        "eyeball" in n
        # "retina" alone would also match "retinaculum" (wrist/ankle bands).
        or ("retina" in n and "retinacul" not in n)
        or "cornea" in n
        or any(n.endswith(e) or n == e for e in EXACT)
        for n in names
    )


def _teeth(names: set[str]) -> bool:
    return any("tooth" in n for n in names)


def _brain(names: set[str]) -> bool:
    return any(
        "brain" in n or "cerebell" in n or "cerebral hemisphere" in n
        or "brainstem" in n
        for n in names
    )


SCENES = {
    "heart": {"label": "Heart", "match": _heart},
    "eyes": {"label": "Eyes", "match": _eyes},
    "teeth": {"label": "Teeth", "match": _teeth},
    "brain": {"label": "Brain", "match": _brain},
}

GENERIC = {
    "human body", "anatomical entity", "body proper", "physical anatomical entity",
    "organ", "organ part", "organ system", "cavity of organ part", "organ region",
    "anatomical structure", "material anatomical entity", "anatomical set",
    "organ component", "anatomical space", "artery", "vein", "venous trunk",
}


def load_metadata(meta_path: Path) -> dict:
    if meta_path.suffix == ".zip":
        with zipfile.ZipFile(meta_path) as z:
            name = next(n for n in z.namelist() if n.endswith("parsed_metadata.json"))
            return json.loads(z.read(name))
    return json.loads(meta_path.read_text())


def index_concepts(meta: dict) -> tuple[dict, dict, dict]:
    """Return (fid -> all concept names, fid -> specific display name,
    lowercased concept name -> fids)."""
    isa_names: dict[str, set[str]] = defaultdict(set)
    all_names: dict[str, set[str]] = defaultdict(set)
    concept_files: dict[str, set[str]] = defaultdict(set)
    for ep in meta.get("element_parts", []):
        fid, nm = ep.get("element_file_id"), ep.get("name")
        if not (fid and nm):
            continue
        all_names[fid].add(nm.lower())
        concept_files[nm.lower()].add(fid)
        if ep.get("tree") == "isa":
            isa_names[fid].add(nm)

    display: dict[str, str] = {}
    for fid, names in isa_names.items():
        ranked = sorted(
            names,
            key=lambda nm: (len(concept_files[nm.lower()]), len(nm)),
        )
        named = [nm for nm in ranked if nm.lower() not in GENERIC]
        if named:
            display[fid] = named[0]
    name_index = {nm: sorted(fids) for nm, fids in concept_files.items()}
    return all_names, display, name_index


def write_glb(entries: list[tuple[str, list, list]], out_path: Path) -> None:
    """entries: [(fid, verts, faces)] in normalized body space."""
    bin_chunks: list[bytes] = []
    buffer_views, accessors, meshes, nodes = [], [], [], []
    offset = 0
    for fid, verts, faces in entries:
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
        "asset": {"version": "2.0", "generator": "medisearch build_scene_assets"},
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--obj-zip", required=True)
    ap.add_argument("--metadata", required=True)
    ap.add_argument("--body-structures", default="static/assets/anatomy/structures.json")
    ap.add_argument("--out", default="static/assets/anatomy/scenes")
    ap.add_argument("--grounding-out", default="app/data/anatomy_grounding.json")
    ap.add_argument("--skip-pack", action="store_true")
    args = ap.parse_args()

    meta = load_metadata(Path(args.metadata))
    all_names, display, name_index = index_concepts(meta)

    zobj = zipfile.ZipFile(args.obj_zip)
    available = {n.split("/")[-1][:-4]: n for n in zobj.namelist() if n.endswith(".obj")}

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    scenes_meta: dict[str, dict] = {}
    fid_scenes: dict[str, list[str]] = defaultdict(list)

    for scene_id, cfg in SCENES.items():
        fids = sorted(
            fid for fid, names in all_names.items()
            if fid in available and cfg["match"](names)
        )
        # include mirrored twins (M files share the base fid's metadata)
        for fid in list(fids):
            twin = fid + "M" if not fid.endswith("M") else fid[:-1]
            if twin in available and twin not in fids:
                fids.append(twin)
        fids = sorted(set(fids))

        entries, structures = [], []
        gmin = [1e9] * 3
        gmax = [-1e9] * 3
        for fid in fids:
            verts, faces = _parse_obj(zobj.read(available[fid]))
            if not verts or not faces:
                continue
            base = fid[:-1] if fid.endswith("M") else fid
            name = display.get(fid) or (
                swap_sides(display[base]) if fid.endswith("M") and base in display else fid
            )
            mins = [min(v[i] for v in verts) for i in range(3)]
            maxs = [max(v[i] for v in verts) for i in range(3)]
            for i in range(3):
                gmin[i] = min(gmin[i], mins[i])
                gmax[i] = max(gmax[i], maxs[i])
            entries.append((fid, verts, faces))
            structures.append({
                "id": fid,
                "name": name,
                "center": [round((mins[i] + maxs[i]) / 2, 4) for i in range(3)],
                "size": [round(maxs[i] - mins[i], 4) for i in range(3)],
            })
            fid_scenes[fid].append(scene_id)

        raw = out / f"{scene_id}_raw.glb"
        write_glb(entries, raw)
        dst = out / f"{scene_id}.glb"
        if args.skip_pack:
            raw.rename(dst)
        else:
            subprocess.run(
                ["npx", "--yes", "gltfpack@0.24", "-i", str(raw), "-o", str(dst),
                 "-cc", "-si", "0.6", "-kn"],
                check=True, capture_output=True,
            )
            raw.unlink()
        scenes_meta[scene_id] = {
            "label": cfg["label"],
            "structures": structures,
            "bounds": {"min": [round(v, 4) for v in gmin], "max": [round(v, 4) for v in gmax]},
        }
        print(f"{scene_id}: {len(structures)} structures, {dst.stat().st_size // 1024}KB")

    (out / "scenes.json").write_text(json.dumps({
        "attribution": "BodyParts3D 4.0, (c) The Database Center for Life Science, CC-BY-4.0.",
        "license": "CC-BY-4.0",
        "scenes": scenes_meta,
    }, separators=(",", ":")))
    print(f"scenes.json: {len(scenes_meta)} scenes")

    # ------------------------------------------------------------------
    # Grounding index: every concept name -> displayable fids.
    # Displayable = in a scene GLB or in the whole-body structures.json.
    # ------------------------------------------------------------------
    body = json.loads(Path(args.body_structures).read_text())
    body_structs = body["structures"] if isinstance(body, dict) else body
    body_layer = {s["id"]: s["layer"] for s in body_structs}
    body_region = {s["id"]: s.get("region", "") for s in body_structs}

    displayable = set(fid_scenes) | set(body_layer)

    def expand(fid: str) -> list[str]:
        """A concept mapped to base fid also covers its mirrored twin."""
        twins = [fid]
        m = fid + "M" if not fid.endswith("M") else fid[:-1]
        if m in displayable:
            twins.append(m)
        return twins

    names_out: dict[str, list[str]] = {}
    for nm, fids in name_index.items():
        if nm in GENERIC:
            continue
        hits: list[str] = []
        for fid in fids:
            for f in expand(fid):
                if f in displayable and f not in hits:
                    hits.append(f)
        if hits:
            names_out[nm] = hits

    structures_out: dict[str, dict] = {}
    for fid in sorted(displayable):
        base = fid[:-1] if fid.endswith("M") else fid
        name = display.get(fid) or (
            swap_sides(display[base]) if fid.endswith("M") and base in display else fid
        )
        entry: dict = {"name": name}
        if fid in fid_scenes:
            entry["scenes"] = sorted(set(fid_scenes[fid]))
        if fid in body_layer:
            entry["layer"] = body_layer[fid]
            if body_region.get(fid):
                entry["region"] = body_region[fid]
        structures_out[fid] = entry

    gout = Path(args.grounding_out)
    gout.parent.mkdir(parents=True, exist_ok=True)
    gout.write_text(json.dumps({
        "attribution": "BodyParts3D 4.0 / FMA concept names, CC-BY-4.0.",
        "names": names_out,
        "structures": structures_out,
    }, separators=(",", ":")))
    print(f"grounding index: {len(names_out)} names, {len(structures_out)} structures "
          f"({gout.stat().st_size // 1024}KB)")


if __name__ == "__main__":
    main()
