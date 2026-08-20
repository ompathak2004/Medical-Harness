/**
 * AnatomyViewer — real human anatomy viewer for a medical AI agent.
 *
 * Data: BodyParts3D 4.0 (© The Database Center for Life Science, CC-BY-4.0),
 * preprocessed into six meshopt-compressed GLB layers plus structures.json
 * (2,000+ named structures with layer / body-region / clinical-group
 * metadata) by scripts/build_anatomy_assets.py.
 *
 * Capabilities:
 *  - Progressive loading: skin + skeleton up front, other layers lazy.
 *  - Granular raycast picking down to a single muscle / bone / organ /
 *    vessel, with hover labels and structure selection.
 *  - Region highlight + eased camera focus driven by the backend's
 *    27 body-region ids (app/tools/anatomy.py ANATOMY_REGIONS).
 *  - Name search over all structures (used by the panel search box).
 *  - Layer system: skin / muscles / skeleton / organs / vascular /
 *    nerves / all, with ghosted skin for depth context.
 *
 * Public API (consumed by app.js — keep stable):
 *   isWebGLAvailable(), REGIONS,
 *   new AnatomyViewer(container, { accentColor, reducedMotion })
 *     .onHover(cb) .onSelect(cb) .highlight(regionIds) .focusRegion(id)
 *     .setLayer(name) .setView(name) .resetCamera() .resize()
 *     .search(query) .selectStructure(id) .ready (Promise)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ──────────────────────────────────────────────────────────────────────────
// WEBGL AVAILABILITY
// ──────────────────────────────────────────────────────────────────────────

export function isWebGLAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    );
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// REGIONS — the 27 backend body-region ids (labels used across the app)
// Geometry (centers/bounds) is derived at runtime from structures.json.
// ──────────────────────────────────────────────────────────────────────────

export const REGIONS = {
  head: { label: 'Head' },
  neck: { label: 'Neck' },
  chest: { label: 'Chest' },
  upper_back: { label: 'Upper Back' },
  abdomen: { label: 'Abdomen' },
  lower_back: { label: 'Lower Back' },
  hip: { label: 'Hip / Pelvis' },
  left_shoulder: { label: 'Left Shoulder' },
  right_shoulder: { label: 'Right Shoulder' },
  left_upper_arm: { label: 'Left Upper Arm' },
  right_upper_arm: { label: 'Right Upper Arm' },
  left_elbow: { label: 'Left Elbow' },
  right_elbow: { label: 'Right Elbow' },
  left_forearm: { label: 'Left Forearm' },
  right_forearm: { label: 'Right Forearm' },
  left_hand: { label: 'Left Hand' },
  right_hand: { label: 'Right Hand' },
  left_thigh: { label: 'Left Thigh' },
  right_thigh: { label: 'Right Thigh' },
  left_knee: { label: 'Left Knee' },
  right_knee: { label: 'Right Knee' },
  left_lower_leg: { label: 'Left Lower Leg' },
  right_lower_leg: { label: 'Right Lower Leg' },
  left_ankle: { label: 'Left Ankle' },
  right_ankle: { label: 'Right Ankle' },
  left_foot: { label: 'Left Foot' },
  right_foot: { label: 'Right Foot' },
};

// ──────────────────────────────────────────────────────────────────────────
// LAYERS & MATERIALS
// ──────────────────────────────────────────────────────────────────────────

const ASSET_BASE = '/static/assets/anatomy';

const LAYERS = {
  skin: { files: ['skin.glb'], color: 0xd9a184, roughness: 0.6 },
  skeleton: { files: ['skeleton.glb'], color: 0xe8e3d5, roughness: 0.55 },
  muscles: { files: ['muscles.glb', 'muscles_extra.glb'], color: 0xb5493f, roughness: 0.5 },
  organs: { files: ['organs.glb'], color: 0xc4756a, roughness: 0.45 },
  vascular: { files: ['vascular.glb'], color: 0xa03030, roughness: 0.4 },
  nerves: { files: ['nerves.glb'], color: 0xd8c94a, roughness: 0.5 },
};

const LAYER_ORDER = ['skin', 'skeleton', 'muscles', 'organs', 'vascular', 'nerves'];

function makeLayerMaterial(name) {
  const cfg = LAYERS[name];
  const mat = new THREE.MeshStandardMaterial({
    color: cfg.color,
    roughness: cfg.roughness,
    metalness: 0.0,
    envMapIntensity: 0.7,
  });
  if (name === 'skin') {
    mat.transparent = true; // enables ghost mode without material swap
    mat.opacity = 1.0;
  }
  return mat;
}

// ──────────────────────────────────────────────────────────────────────────
// ANATOMY VIEWER
// ──────────────────────────────────────────────────────────────────────────

export class AnatomyViewer {
  constructor(container, opts = {}) {
    this.container = container;
    this._accent = new THREE.Color(opts.accentColor ?? 0x22d3ee);
    this._reducedMotion = !!opts.reducedMotion;
    this._hoverCb = null;
    this._selectCb = null;
    this._progressCb = null;

    // Structure metadata (from structures.json)
    this._structures = new Map(); // id -> {id,name,layer,region,center,size,group}
    this._regionIndex = new Map(); // region id -> {center: V3, radius}
    this._searchList = []; // [{id, name, nameLower, layer, region}]

    // Scene graph: one Group per layer, meshes carry userData.structureId
    this._layerGroups = new Map(); // layer -> THREE.Group
    this._layerLoaded = new Map(); // layer -> Promise | undefined
    this._materials = new Map(); // layer -> shared material
    this._meshById = new Map(); // structure id -> mesh
    this._activeLayer = 'skin';

    // Picking / highlight state
    this._hovered = null; // mesh
    this._selected = null; // mesh
    this._highlightedRegions = [];
    this._regionGlow = []; // pulse overlay meshes
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._pointerDown = null;

    // Camera animation
    this._camAnim = null;
    this._clock = new THREE.Clock();

    this._initScene();
    this._bindEvents();

    // Load metadata + first layers progressively.
    this._metaReady = this._loadMetadata();
    this.ready = this._metaReady.then(() => {
      const first = [this._ensureLayer('skin'), this._ensureLayer('skeleton')];
      return Promise.all(first);
    });
    this.ready.then(() => this._applyLayerVisibility()).catch((err) => {
      console.error('AnatomyViewer: initial load failed', err);
    });

    this._animate = this._animate.bind(this);
    this._renderer.setAnimationLoop(this._animate);
  }

  // ── Scene setup ─────────────────────────────────────────────────────────

  _initScene() {
    const w = this.container.clientWidth || 480;
    const h = this.container.clientHeight || 560;

    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(w, h);
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.05;
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this._renderer.domElement);

    this._scene = new THREE.Scene();
    const env = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this._renderer);
    this._scene.environment = pmrem.fromScene(env, 0.04).texture;

    // Model is ~1 unit tall centered near origin (y in [-0.5, 0.5]).
    this._camera = new THREE.PerspectiveCamera(35, w / h, 0.005, 20);
    this._homePos = new THREE.Vector3(0, 0.05, 1.55);
    this._homeTarget = new THREE.Vector3(0, 0, 0);
    this._camera.position.copy(this._homePos);

    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.target.copy(this._homeTarget);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.minDistance = 0.12;
    this._controls.maxDistance = 3.2;
    this._controls.update();

    // Lighting: IBL + key/fill/rim for definition.
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1.2, 1.6, 1.8);
    const fill = new THREE.DirectionalLight(0xbfd8ff, 0.5);
    fill.position.set(-1.5, 0.4, -1.0);
    const rim = new THREE.DirectionalLight(0xffe8d0, 0.65);
    rim.position.set(0, 1.2, -1.8);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 0.35);
    this._scene.add(key, fill, rim, hemi);

    this._root = new THREE.Group();
    this._scene.add(this._root);

    for (const name of LAYER_ORDER) {
      const g = new THREE.Group();
      g.name = `layer-${name}`;
      g.visible = false;
      this._layerGroups.set(name, g);
      this._materials.set(name, makeLayerMaterial(name));
      this._root.add(g);
    }
  }

  // ── Asset loading ───────────────────────────────────────────────────────

  async _loadMetadata() {
    const resp = await fetch(`${ASSET_BASE}/structures.json`);
    if (!resp.ok) throw new Error(`structures.json HTTP ${resp.status}`);
    const data = await resp.json();
    this.attribution = data.attribution || '';
    this.license = data.license || '';

    const regionAcc = new Map(); // region -> {min: V3, max: V3}
    for (const s of data.structures) {
      this._structures.set(s.id, s);
      if (s.layer !== 'skin') {
        this._searchList.push({
          id: s.id,
          name: s.name,
          nameLower: s.name.toLowerCase(),
          layer: s.layer,
          region: s.region,
        });
      }
      // Skin meshes span the whole body — exclude them from region bounds
      // so focusRegion() targets stay tight.
      if (s.layer === 'skin') continue;
      const c = s.center, sz = s.size;
      let acc = regionAcc.get(s.region);
      if (!acc) {
        acc = {
          min: new THREE.Vector3(Infinity, Infinity, Infinity),
          max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
        };
        regionAcc.set(s.region, acc);
      }
      acc.min.min(new THREE.Vector3(c[0] - sz[0] / 2, c[1] - sz[1] / 2, c[2] - sz[2] / 2));
      acc.max.max(new THREE.Vector3(c[0] + sz[0] / 2, c[1] + sz[1] / 2, c[2] + sz[2] / 2));
    }
    for (const [region, acc] of regionAcc) {
      const center = acc.min.clone().add(acc.max).multiplyScalar(0.5);
      const radius = Math.max(0.06, acc.min.distanceTo(acc.max) / 2);
      this._regionIndex.set(region, { center, radius, min: acc.min, max: acc.max });
    }
    this._searchList.sort((a, b) => a.name.length - b.name.length);
  }

  _ensureLayer(name) {
    if (this._layerLoaded.has(name)) return this._layerLoaded.get(name);
    const cfg = LAYERS[name];
    if (!cfg) return Promise.resolve();
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const group = this._layerGroups.get(name);
    const material = this._materials.get(name);

    // Structure-id resolution during traversal needs structures.json, so
    // gate on metadata (layer buttons can fire before it has arrived).
    const promise = this._metaReady.then(() => Promise.all(
      cfg.files.map(
        (file) =>
          new Promise((resolve, reject) => {
            loader.load(
              `${ASSET_BASE}/${file}`,
              (gltf) => {
                gltf.scene.traverse((node) => {
                  if (!node.isMesh) return;
                  node.material = material;
                  // The structure id (FJ####/FJ####M) is the name of the mesh
                  // itself or of an ancestor node (gltfpack keeps node names
                  // but renames mesh primitives to mesh_N).
                  let sid = null;
                  for (let n = node; n && !sid; n = n.parent) {
                    if (this._structures.has(n.name)) sid = n.name;
                  }
                  node.userData.structureId = sid;
                  node.userData.layer = name;
                  if (sid && !this._meshById.has(sid)) this._meshById.set(sid, node);
                });
                group.add(gltf.scene);
                resolve();
              },
              undefined,
              (err) => reject(err)
            );
          })
      )
    )).then(() => {
      this._progressCb?.(name);
    });
    this._layerLoaded.set(name, promise);
    return promise;
  }

  // ── Layer system ────────────────────────────────────────────────────────

  /** layer: skin | muscles | skeleton | organs | vascular | nerves | all */
  setLayer(layer) {
    this._activeLayer = layer;
    const needed = layer === 'all' ? [...LAYER_ORDER] : [layer];
    // Always keep skeleton available as an anatomical anchor for non-skin views.
    if (layer !== 'skin' && layer !== 'all' && layer !== 'skeleton') needed.push('skeleton');
    Promise.all(needed.map((n) => this._ensureLayer(n))).then(() => {
      if (this._activeLayer === layer) this._applyLayerVisibility();
    });
    this._applyLayerVisibility(); // show whatever is already loaded
  }

  _applyLayerVisibility() {
    const layer = this._activeLayer;
    const skinMat = this._materials.get('skin');
    for (const name of LAYER_ORDER) {
      const g = this._layerGroups.get(name);
      if (layer === 'all') {
        g.visible = true;
      } else if (layer === 'skin') {
        g.visible = name === 'skin';
      } else {
        g.visible = name === layer || name === 'skeleton';
      }
    }
    if (layer === 'skin') {
      skinMat.opacity = 1.0;
      skinMat.depthWrite = true;
    } else if (layer === 'all') {
      this._layerGroups.get('skin').visible = true;
      skinMat.opacity = 0.16;
      skinMat.depthWrite = false;
    } else {
      // Ghost the skin for silhouette context.
      this._layerGroups.get('skin').visible = true;
      skinMat.opacity = 0.1;
      skinMat.depthWrite = false;
    }
  }

  // ── Picking ─────────────────────────────────────────────────────────────

  _bindEvents() {
    const el = this._renderer.domElement;
    el.addEventListener('pointermove', (e) => this._onPointerMove(e));
    el.addEventListener('pointerdown', (e) => {
      this._pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointerup', (e) => this._onPointerUp(e));
    el.addEventListener('pointerleave', () => this._setHover(null));
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.container);
  }

  _pick(e) {
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._pointer, this._camera);
    const targets = [];
    for (const name of LAYER_ORDER) {
      const g = this._layerGroups.get(name);
      // In ghost mode the skin is visible but should not swallow picks.
      if (!g.visible) continue;
      if (name === 'skin' && this._activeLayer !== 'skin') continue;
      targets.push(g);
    }
    const hits = this._raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      const sid = hit.object?.userData?.structureId;
      if (sid && this._structures.has(sid)) return hit.object;
    }
    return null;
  }

  _onPointerMove(e) {
    if (this._pointerDown && (Math.abs(e.clientX - this._pointerDown.x) > 4 ||
        Math.abs(e.clientY - this._pointerDown.y) > 4)) {
      this._setHover(null); // dragging — don't flicker labels
      return;
    }
    this._setHover(this._pick(e));
  }

  _onPointerUp(e) {
    const down = this._pointerDown;
    this._pointerDown = null;
    if (!down) return;
    const moved = Math.abs(e.clientX - down.x) > 5 || Math.abs(e.clientY - down.y) > 5;
    const slow = performance.now() - down.t > 400;
    if (moved || slow) return; // was a drag, not a click
    const mesh = this._pick(e);
    if (mesh) this._selectMesh(mesh, { focus: false });
  }

  // ── Hover / selection visuals ───────────────────────────────────────────

  _setHover(mesh) {
    if (mesh === this._hovered) return;
    if (this._hovered && this._hovered !== this._selected) {
      this._clearEmphasis(this._hovered);
    }
    this._hovered = mesh;
    if (mesh) {
      if (mesh !== this._selected) this._applyEmphasis(mesh, 0.35);
      const s = this._structures.get(mesh.userData.structureId);
      this._hoverCb?.({
        region: s.region,
        label: this._structureLabel(s),
        layer: s.layer,
        structure: s.id,
        structureName: s.name,
        group: s.group || null,
      });
      this._renderer.domElement.style.cursor = 'pointer';
    } else {
      this._hoverCb?.(null);
      this._renderer.domElement.style.cursor = '';
    }
  }

  _structureLabel(s) {
    // Patient-facing label: structure name, capitalized.
    return s.name.charAt(0).toUpperCase() + s.name.slice(1);
  }

  _applyEmphasis(mesh, strength) {
    if (!mesh.userData.ownMaterial) {
      // Clone the shared layer material once per emphasized mesh.
      mesh.userData.sharedMaterial = mesh.material;
      mesh.material = mesh.material.clone();
      mesh.userData.ownMaterial = true;
    }
    mesh.material.emissive = this._accent.clone();
    mesh.material.emissiveIntensity = strength;
    if (mesh.userData.layer === 'skin') {
      mesh.material.opacity = Math.max(mesh.material.opacity, 0.85);
    }
  }

  _clearEmphasis(mesh) {
    if (mesh.userData.ownMaterial) {
      mesh.material.dispose();
      mesh.material = mesh.userData.sharedMaterial;
      mesh.userData.ownMaterial = false;
    }
  }

  _selectMesh(mesh, { focus = true } = {}) {
    if (this._selected && this._selected !== mesh) this._clearEmphasis(this._selected);
    this._selected = mesh;
    this._applyEmphasis(mesh, 0.75);
    const s = this._structures.get(mesh.userData.structureId);
    if (focus) this._focusPoint(new THREE.Vector3(...s.center), Math.max(...s.size) * 2.2);
    this._selectCb?.({
      region: s.region,
      label: this._structureLabel(s),
      layer: s.layer,
      structure: s.id,
      structureName: s.name,
      group: s.group || null,
    });
  }

  /** Programmatic selection by structure id (used by search). */
  async selectStructure(id) {
    const s = this._structures.get(id);
    if (!s) return false;
    await this._ensureLayer(s.layer === 'skin' ? 'skin' : s.layer);
    if (this._activeLayer !== s.layer && this._activeLayer !== 'all') {
      this._activeLayer = s.layer;
      this._applyLayerVisibility();
    }
    const mesh = this._meshById.get(id);
    if (!mesh) {
      // Structure known but mesh missing (defensive) — still focus its center.
      this._focusPoint(new THREE.Vector3(...s.center), Math.max(...s.size) * 2.2);
      return false;
    }
    this._selectMesh(mesh, { focus: true });
    return true;
  }

  /** Name search over all structures. Returns top `limit` matches. */
  search(query, limit = 12) {
    const q = (query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const starts = [];
    const contains = [];
    for (const item of this._searchList) {
      const idx = item.nameLower.indexOf(q);
      if (idx === 0) starts.push(item);
      else if (idx > 0) contains.push(item);
      if (starts.length >= limit) break;
    }
    return starts.concat(contains).slice(0, limit).map((item) => ({
      id: item.id,
      name: item.name,
      layer: item.layer,
      region: item.region,
      regionLabel: REGIONS[item.region]?.label || item.region,
    }));
  }

  // ── Region highlight & focus (backend anatomy context) ──────────────────

  highlight(regionIds) {
    // Clear previous pulses.
    for (const glow of this._regionGlow) {
      glow.parent?.remove(glow);
      glow.geometry.dispose();
      glow.material.dispose();
    }
    this._regionGlow = [];
    this._highlightedRegions = (regionIds || []).filter((id) => this._regionIndex.has(id));
    for (const id of this._highlightedRegions) {
      const { center, radius } = this._regionIndex.get(id);
      const geo = new THREE.SphereGeometry(Math.min(radius * 0.7, 0.1), 24, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: this._accent,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      });
      const glow = new THREE.Mesh(geo, mat);
      glow.position.copy(center);
      glow.userData.pulse = true;
      glow.raycast = () => {}; // never intercepts picking
      this._root.add(glow);
      this._regionGlow.push(glow);
    }
  }

  focusRegion(id) {
    const entry = this._regionIndex.get(id);
    if (!entry) return;
    const span = entry.min.distanceTo(entry.max);
    this._focusPoint(entry.center, Math.max(span * 1.35, 0.22));
  }

  _focusPoint(target, viewSize) {
    const dist = THREE.MathUtils.clamp(
      viewSize / (2 * Math.tan(THREE.MathUtils.degToRad(this._camera.fov / 2))),
      this._controls.minDistance * 1.2,
      this._controls.maxDistance
    );
    // Keep the camera's current bearing, move toward the new target.
    const dir = this._camera.position.clone().sub(this._controls.target).normalize();
    if (!isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    const destPos = target.clone().add(dir.multiplyScalar(dist));
    this._animateCamera(destPos, target.clone());
  }

  // ── Camera views ────────────────────────────────────────────────────────

  setView(view) {
    const t = this._controls.target.clone();
    const d = this._camera.position.distanceTo(t);
    const dirs = {
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1),
      left: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(1, 0, 0),
    };
    const dir = dirs[view];
    if (!dir) return;
    this._animateCamera(t.clone().add(dir.multiplyScalar(d)), t);
  }

  resetCamera() {
    this.highlight([]);
    if (this._selected) {
      this._clearEmphasis(this._selected);
      this._selected = null;
    }
    this._animateCamera(this._homePos.clone(), this._homeTarget.clone());
  }

  _animateCamera(destPos, destTarget) {
    if (this._reducedMotion) {
      this._camera.position.copy(destPos);
      this._controls.target.copy(destTarget);
      this._controls.update();
      return;
    }
    this._camAnim = {
      fromPos: this._camera.position.clone(),
      fromTarget: this._controls.target.clone(),
      toPos: destPos,
      toTarget: destTarget,
      t: 0,
      duration: 0.8,
    };
  }

  // ── Frame loop ──────────────────────────────────────────────────────────

  _animate() {
    const dt = this._clock.getDelta();
    const anim = this._camAnim;
    if (anim) {
      anim.t = Math.min(anim.t + dt / anim.duration, 1);
      const e = anim.t < 0.5 ? 4 * anim.t ** 3 : 1 - (-2 * anim.t + 2) ** 3 / 2; // easeInOutCubic
      this._camera.position.lerpVectors(anim.fromPos, anim.toPos, e);
      this._controls.target.lerpVectors(anim.fromTarget, anim.toTarget, e);
      if (anim.t >= 1) this._camAnim = null;
    }
    if (this._regionGlow.length && !this._reducedMotion) {
      const pulse = 0.12 + 0.08 * (0.5 + 0.5 * Math.sin(this._clock.elapsedTime * 2.4));
      for (const glow of this._regionGlow) glow.material.opacity = pulse;
    }
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }

  // ── Public wiring ───────────────────────────────────────────────────────

  onHover(cb) { this._hoverCb = cb; }
  onSelect(cb) { this._selectCb = cb; }
  onLayerLoaded(cb) { this._progressCb = cb; }

  get activeLayer() { return this._activeLayer; }

  setAccentColor(color) {
    this._accent = new THREE.Color(color);
    for (const glow of this._regionGlow) glow.material.color.copy(this._accent);
    if (this._selected) this._applyEmphasis(this._selected, 0.75);
    if (this._hovered && this._hovered !== this._selected) this._applyEmphasis(this._hovered, 0.35);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(w, h);
  }

  dispose() {
    this._renderer.setAnimationLoop(null);
    this._resizeObserver?.disconnect();
    this._renderer.dispose();
    this._renderer.domElement.remove();
  }
}






