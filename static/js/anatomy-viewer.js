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
 *
 * Deep-dive scenes (per-organ GLBs from scripts/build_scene_assets.py):
 *   .listScenes() .setScene(id|null) .activeScene
 *   .focusStructures(ids) .highlightStructures(ids, mode) .clearStructureHighlights()
 *   mode: 'highlight' | 'stenosis' | 'inflammation' | 'flow' | 'none'
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

// Deep-dive scene meshes are colored by tissue category inferred from the
// structure name (scene GLBs mix vessels, muscle, bone and organ tissue).
const SCENE_MATERIALS = {
  artery: { color: 0xb03a3a, roughness: 0.4 },
  vein: { color: 0x4a5f9e, roughness: 0.45 },
  nerve: { color: 0xd8c94a, roughness: 0.5 },
  bone: { color: 0xe8e3d5, roughness: 0.55 },
  tooth: { color: 0xf2eee2, roughness: 0.35 },
  default: { color: 0xc4756a, roughness: 0.45 },
};

function sceneCategoryFor(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('tooth')) return 'tooth';
  if (n.includes('artery') || n.includes('aorta') || n.includes('arterial') ||
      n.includes('pulmonary trunk')) return 'artery';
  if (n.includes('vein') || n.includes('vena cava') || n.includes('venous') ||
      n.includes('sinus')) return 'vein';
  if (n.includes('nerve')) return 'nerve';
  if (n.includes('bone') || n.includes('vertebra') || n.includes('rib') ||
      n.includes('skull') || n.includes('mandible') || n.includes('maxilla')) return 'bone';
  return 'default';
}

// Procedural overlay palette (per-overlay accents used by the story player).
const OVERLAY_COLORS = {
  highlight: 0x22d3ee,
  stenosis: 0xe4574f,
  inflammation: 0xf59e0b,
  flow: 0x38bdf8,
};

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

    // Deep-dive scene state
    this._sceneIndex = null; // scenes.json payload (lazy)
    this._sceneIndexPromise = null;
    this._sceneGroups = new Map(); // scene id -> THREE.Group
    this._sceneLoaded = new Map(); // scene id -> Promise
    this._sceneStructures = new Map(); // scene id -> Map(id -> {id,name,center,size})
    this._sceneMaterials = new Map(); // category -> shared material
    this._activeScene = null; // scene id or null (whole body)
    this._structureGlow = []; // overlay meshes from highlightStructures
    this._overlayMeshes = new Set(); // emphasized meshes to restore

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

  // ── Deep-dive scenes ────────────────────────────────────────────────────

  _ensureSceneIndex() {
    if (!this._sceneIndexPromise) {
      this._sceneIndexPromise = fetch(`${ASSET_BASE}/scenes/scenes.json`)
        .then((r) => {
          if (!r.ok) throw new Error(`scenes.json HTTP ${r.status}`);
          return r.json();
        })
        .then((data) => {
          this._sceneIndex = data;
          for (const [id, scene] of Object.entries(data.scenes || {})) {
            const byId = new Map();
            for (const s of scene.structures) byId.set(s.id, s);
            this._sceneStructures.set(id, byId);
          }
          return data;
        });
    }
    return this._sceneIndexPromise;
  }

  /** [{id, label, count}] for the scene switcher UI. */
  async listScenes() {
    const data = await this._ensureSceneIndex();
    return Object.entries(data.scenes || {}).map(([id, s]) => ({
      id, label: s.label, count: s.structures.length,
    }));
  }

  get activeScene() { return this._activeScene; }

  _sceneMaterial(category) {
    let mat = this._sceneMaterials.get(category);
    if (!mat) {
      const cfg = SCENE_MATERIALS[category] || SCENE_MATERIALS.default;
      mat = new THREE.MeshStandardMaterial({
        color: cfg.color, roughness: cfg.roughness, metalness: 0.0, envMapIntensity: 0.7,
      });
      this._sceneMaterials.set(category, mat);
    }
    return mat;
  }

  _ensureScene(id) {
    if (this._sceneLoaded.has(id)) return this._sceneLoaded.get(id);
    const promise = this._ensureSceneIndex().then(() => new Promise((resolve, reject) => {
      const byId = this._sceneStructures.get(id);
      if (!byId) { reject(new Error(`unknown scene ${id}`)); return; }
      const group = new THREE.Group();
      group.name = `scene-${id}`;
      group.visible = false;
      this._root.add(group);
      this._sceneGroups.set(id, group);
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(
        `${ASSET_BASE}/scenes/${id}.glb`,
        (gltf) => {
          gltf.scene.traverse((node) => {
            if (!node.isMesh) return;
            let sid = null;
            for (let n = node; n && !sid; n = n.parent) {
              if (byId.has(n.name)) sid = n.name;
            }
            node.userData.structureId = sid;
            node.userData.scene = id;
            const info = sid ? byId.get(sid) : null;
            node.material = this._sceneMaterial(sceneCategoryFor(info?.name));
            if (sid) {
              const key = `${id}:${sid}`;
              if (!this._meshById.has(key)) this._meshById.set(key, node);
            }
          });
          group.add(gltf.scene);
          resolve();
        },
        undefined,
        (err) => reject(err)
      );
    })).then(() => { this._progressCb?.(`scene:${id}`); });
    this._sceneLoaded.set(id, promise);
    return promise;
  }

  /**
   * Enter a deep-dive scene (heart/eyes/teeth/brain) or return to the whole
   * body with setScene(null). Resolves when the scene assets are visible.
   */
  async setScene(id) {
    if (!id) {
      if (!this._activeScene) return;
      this._exitScene(true);
      return;
    }
    if (this._activeScene === id) return;
    await this._ensureScene(id);
    this.highlight([]); // whole-body region markers don't belong in a scene
    this.clearStructureHighlights();
    this._setHover(null);
    if (this._selected) { this._clearEmphasis(this._selected); this._selected = null; }
    this._activeScene = id;
    // Hide the whole-body layers; show only this scene.
    for (const name of LAYER_ORDER) this._layerGroups.get(name).visible = false;
    for (const [sid, g] of this._sceneGroups) g.visible = sid === id;
    // Tiny organs (eye ~2.5cm in body units) need a much closer near limit.
    const b = this._sceneIndex.scenes[id].bounds;
    const min = new THREE.Vector3(...b.min);
    const max = new THREE.Vector3(...b.max);
    const span = min.distanceTo(max);
    this._controls.minDistance = Math.max(span * 0.12, 0.004);
    const center = min.clone().add(max).multiplyScalar(0.5);
    this._focusPoint(center, Math.max(span * 1.25, 0.02));
  }

  _exitScene(resetCam) {
    this.clearStructureHighlights();
    this._setHover(null);
    if (this._selected) { this._clearEmphasis(this._selected); this._selected = null; }
    this._activeScene = null;
    for (const g of this._sceneGroups.values()) g.visible = false;
    this._controls.minDistance = 0.12;
    this._applyLayerVisibility();
    if (resetCam) this._animateCamera(this._homePos.clone(), this._homeTarget.clone());
  }

  /** Structure metadata for hover/select — body index or active-scene index. */
  _structureInfo(sid, sceneId) {
    if (sceneId) {
      const s = this._sceneStructures.get(sceneId)?.get(sid);
      if (s) {
        return {
          id: s.id, name: s.name, center: s.center, size: s.size,
          layer: this._sceneIndex?.scenes?.[sceneId]?.label?.toLowerCase() || sceneId,
          region: null, group: null, scene: sceneId,
        };
      }
    }
    return this._structures.get(sid) || null;
  }

  /** Meshes for a structure id in the active scene (fallback: body layers). */
  _meshesFor(id) {
    const out = [];
    if (this._activeScene) {
      const m = this._meshById.get(`${this._activeScene}:${id}`);
      if (m) out.push(m);
    }
    if (!out.length) {
      const m = this._meshById.get(id);
      if (m) out.push(m);
    }
    return out;
  }

  /**
   * Make the given body structures visible and pickable: ensure their
   * layers are loaded and switch to the right layer ('all' when the ids
   * span several). Used by the story player when a story has no deep-dive
   * scene — without this, overlays would sit under the opaque skin layer
   * (or on meshes that were never loaded). No-op in scene mode.
   */
  async prepareForStructures(ids) {
    if (this._activeScene) return;
    await this._metaReady; // _structures must be populated before the lookup
    const layers = new Set();
    for (const id of ids || []) {
      const s = this._structures.get(id);
      if (s?.layer && s.layer !== 'skin') layers.add(s.layer);
    }
    if (!layers.size) return;
    await Promise.all([...layers].map((l) => this._ensureLayer(l)));
    const target = layers.size === 1 ? [...layers][0] : 'all';
    if (target === 'all') await Promise.all(LAYER_ORDER.map((l) => this._ensureLayer(l)));
    if (this._activeLayer !== target) {
      this._activeLayer = target;
      this._applyLayerVisibility();
    }
  }

  /** Fit the camera to the union bounds of the given structure ids. */
  focusStructures(ids) {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    let found = 0;
    for (const id of ids || []) {
      const info = this._structureInfo(id, this._activeScene) || this._structures.get(id);
      if (!info?.center || !info?.size) continue;
      const c = info.center, sz = info.size;
      min.min(new THREE.Vector3(c[0] - sz[0] / 2, c[1] - sz[1] / 2, c[2] - sz[2] / 2));
      max.max(new THREE.Vector3(c[0] + sz[0] / 2, c[1] + sz[1] / 2, c[2] + sz[2] / 2));
      found++;
    }
    if (!found) return false;
    const center = min.clone().add(max).multiplyScalar(0.5);
    const span = Math.max(min.distanceTo(max), 0.01);
    this._focusPoint(center, span * 1.5);
    return true;
  }

  /**
   * Procedural overlays for the visual story player.
   * mode: highlight | stenosis | inflammation | flow | none
   */
  highlightStructures(ids, mode = 'highlight') {
    this.clearStructureHighlights();
    if (!ids?.length || mode === 'none') return 0;
    const color = new THREE.Color(OVERLAY_COLORS[mode] || OVERLAY_COLORS.highlight);
    let phase = 0;
    let count = 0;
    for (const id of ids) {
      for (const mesh of this._meshesFor(id)) {
        if (!mesh.userData.ownMaterial) {
          mesh.userData.sharedMaterial = mesh.material;
          mesh.material = mesh.material.clone();
          mesh.userData.ownMaterial = true;
        }
        mesh.material.emissive = color.clone();
        mesh.material.emissiveIntensity = 0.55;
        mesh.userData.overlayPhase = phase;
        this._overlayMeshes.add(mesh);
        count++;
      }
      const info = this._structureInfo(id, this._activeScene) || this._structures.get(id);
      if (info?.center && info?.size) {
        if (mode === 'stenosis') this._addStenosisRing(info, color);
        else if (mode === 'inflammation') this._addGlowSphere(info, color);
      }
      phase += 0.9;
    }
    this._overlayMode = mode;
    return count;
  }

  _addStenosisRing(info, color) {
    // A pinch ring around the structure — the classic "narrowed vessel" cue.
    const r = Math.max(Math.min(info.size[0], info.size[2]) * 0.75, 0.0015);
    const geo = new THREE.TorusGeometry(r, r * 0.22, 12, 36);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.set(...info.center);
    ring.rotation.x = Math.PI / 2;
    ring.raycast = () => {};
    ring.userData.overlaySpin = true;
    this._root.add(ring);
    this._structureGlow.push(ring);
  }

  _addGlowSphere(info, color) {
    const r = Math.max(...info.size) * 0.75;
    const geo = new THREE.SphereGeometry(Math.max(r, 0.002), 24, 16);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, depthWrite: false });
    const glow = new THREE.Mesh(geo, mat);
    glow.position.set(...info.center);
    glow.raycast = () => {};
    glow.userData.overlayPulse = true;
    this._root.add(glow);
    this._structureGlow.push(glow);
  }

  clearStructureHighlights() {
    for (const mesh of this._overlayMeshes) {
      if (mesh === this._selected || mesh === this._hovered) {
        // Re-apply the ordinary emphasis rather than dropping it.
        this._clearEmphasis(mesh);
        this._applyEmphasis(mesh, mesh === this._selected ? 0.75 : 0.35);
      } else {
        this._clearEmphasis(mesh);
      }
      delete mesh.userData.overlayPhase;
    }
    this._overlayMeshes.clear();
    for (const m of this._structureGlow) {
      m.parent?.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this._structureGlow = [];
    this._overlayMode = null;
  }

  // ── Layer system ────────────────────────────────────────────────────────

  /** layer: skin | muscles | skeleton | organs | vascular | nerves | all */
  setLayer(layer) {
    if (this._activeScene) this._exitScene(false); // layer buttons leave scene mode
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
    if (this._activeScene) return; // scene mode owns visibility
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
    if (this._activeScene) {
      const g = this._sceneGroups.get(this._activeScene);
      if (g) targets.push(g);
    } else {
      for (const name of LAYER_ORDER) {
        const g = this._layerGroups.get(name);
        // In ghost mode the skin is visible but should not swallow picks.
        if (!g.visible) continue;
        if (name === 'skin' && this._activeLayer !== 'skin') continue;
        targets.push(g);
      }
    }
    const hits = this._raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      const sid = hit.object?.userData?.structureId;
      if (sid && this._structureInfo(sid, hit.object.userData.scene)) return hit.object;
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
      this._restoreOverlay(this._hovered);
    }
    this._hovered = mesh;
    if (mesh) {
      if (mesh !== this._selected) this._applyEmphasis(mesh, 0.35);
      const s = this._structureInfo(mesh.userData.structureId, mesh.userData.scene);
      this._hoverCb?.({
        region: s.region || null,
        label: this._structureLabel(s),
        layer: s.layer || null,
        structure: s.id,
        structureName: s.name,
        group: s.group || null,
        scene: mesh.userData.scene || null,
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

  /** After hover/select emphasis ends, restore any story-overlay tint. */
  _restoreOverlay(mesh) {
    if (!this._overlayMeshes.has(mesh) || !this._overlayMode) return;
    if (!mesh.userData.ownMaterial) {
      mesh.userData.sharedMaterial = mesh.material;
      mesh.material = mesh.material.clone();
      mesh.userData.ownMaterial = true;
    }
    const color = new THREE.Color(OVERLAY_COLORS[this._overlayMode] || OVERLAY_COLORS.highlight);
    mesh.material.emissive = color;
    mesh.material.emissiveIntensity = 0.55;
  }

  _selectMesh(mesh, { focus = true } = {}) {
    if (this._selected && this._selected !== mesh) {
      this._clearEmphasis(this._selected);
      this._restoreOverlay(this._selected);
    }
    this._selected = mesh;
    this._applyEmphasis(mesh, 0.75);
    const s = this._structureInfo(mesh.userData.structureId, mesh.userData.scene);
    if (focus) this._focusPoint(new THREE.Vector3(...s.center), Math.max(...s.size) * 2.2);
    this._selectCb?.({
      region: s.region || null,
      label: this._structureLabel(s),
      layer: s.layer || null,
      structure: s.id,
      structureName: s.name,
      group: s.group || null,
      scene: mesh.userData.scene || null,
    });
  }

  /** Programmatic selection by structure id (used by search). */
  async selectStructure(id) {
    // In scene mode, prefer the structure inside the active scene.
    if (this._activeScene) {
      const info = this._sceneStructures.get(this._activeScene)?.get(id);
      if (info) {
        const mesh = this._meshById.get(`${this._activeScene}:${id}`);
        if (mesh) { this._selectMesh(mesh, { focus: true }); return true; }
        this._focusPoint(new THREE.Vector3(...info.center), Math.max(...info.size) * 2.2);
        return false;
      }
    }
    const s = this._structures.get(id);
    if (!s) return false;
    if (this._activeScene) this._exitScene(false); // body structure — leave scene mode
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

  /** Name search over all structures. Returns top `limit` matches.
   *  In scene mode, matches inside the active scene rank first. */
  search(query, limit = 12) {
    const q = (query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const sceneMatches = [];
    if (this._activeScene) {
      const byId = this._sceneStructures.get(this._activeScene);
      const label = this._sceneIndex?.scenes?.[this._activeScene]?.label || this._activeScene;
      for (const s of byId?.values() || []) {
        if (s.name.toLowerCase().includes(q)) {
          sceneMatches.push({
            id: s.id, name: s.name,
            layer: label.toLowerCase(), region: null, regionLabel: label,
            scene: this._activeScene,
          });
          if (sceneMatches.length >= limit) break;
        }
      }
      sceneMatches.sort((a, b) => a.name.length - b.name.length);
    }
    const starts = [];
    const contains = [];
    for (const item of this._searchList) {
      const idx = item.nameLower.indexOf(q);
      if (idx === 0) starts.push(item);
      else if (idx > 0) contains.push(item);
      if (starts.length >= limit) break;
    }
    const body = starts.concat(contains).map((item) => ({
      id: item.id,
      name: item.name,
      layer: item.layer,
      region: item.region,
      regionLabel: REGIONS[item.region]?.label || item.region,
    }));
    const seen = new Set(sceneMatches.map((m) => m.id));
    return sceneMatches
      .concat(body.filter((m) => !seen.has(m.id)))
      .slice(0, limit);
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
      this._restoreOverlay(this._selected);
      this._selected = null;
    }
    if (this._activeScene) {
      // Re-fit to the active scene instead of the whole-body home view.
      const b = this._sceneIndex?.scenes?.[this._activeScene]?.bounds;
      if (b) {
        const min = new THREE.Vector3(...b.min);
        const max = new THREE.Vector3(...b.max);
        const center = min.clone().add(max).multiplyScalar(0.5);
        this._focusPoint(center, Math.max(min.distanceTo(max) * 1.25, 0.02));
        return;
      }
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
    if (!this._reducedMotion) {
      const t = this._clock.elapsedTime;
      for (const m of this._structureGlow) {
        if (m.userData.overlayPulse) m.material.opacity = 0.1 + 0.1 * (0.5 + 0.5 * Math.sin(t * 2.8));
        if (m.userData.overlaySpin) m.rotation.z = t * 0.7;
      }
      if (this._overlayMode === 'flow' && this._overlayMeshes.size) {
        // Traveling emphasis wave — reads as directional flow along vessels.
        for (const mesh of this._overlayMeshes) {
          if (mesh === this._selected || mesh === this._hovered) continue;
          const ph = mesh.userData.overlayPhase || 0;
          mesh.material.emissiveIntensity = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(t * 3.0 - ph));
        }
      }
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






