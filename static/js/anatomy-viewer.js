/**
 * AnatomyViewer v4 — Improved Human Anatomy for Medical AI Agent
 *
 * Key upgrades over v3:
 *  - CapsuleGeometry limbs (smooth, no visible segments)
 *  - LatheGeometry torso with realistic waist/chest profile
 *  - Warm skin material + fake subsurface scattering via emissive
 *  - Proper 7.5-head-height proportions
 *  - Transparent skin mode when switching to muscle/skeleton/vascular
 *  - Per-region invisible hit-box layer for reliable click/hover
 *  - Glowing region overlay on hover + pulse on highlight
 *  - Front / Back / Left / Right / Reset view helpers
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ──────────────────────────────────────────────────────────────────────────────
// MATERIALS
// ──────────────────────────────────────────────────────────────────────────────

function mkSkin() {
  return new THREE.MeshStandardMaterial({
    color: 0xD4956A,
    roughness: 0.88,
    metalness: 0.0,
    emissive: new THREE.Color(0.12, 0.04, 0.015),
    emissiveIntensity: 0.35,
  });
}

function mkMuscle(secondary = false) {
  return new THREE.MeshStandardMaterial({
    color: secondary ? 0x8B1A1A : 0xB83232,
    roughness: 0.58,
    metalness: 0.02,
  });
}

function mkTendon() {
  return new THREE.MeshStandardMaterial({ color: 0xD4C8B0, roughness: 0.45 });
}

function mkBone() {
  return new THREE.MeshStandardMaterial({
    color: 0xEDE0C4,
    roughness: 0.32,
    metalness: 0.08,
  });
}

function mkVessel(artery = true) {
  return new THREE.MeshStandardMaterial({
    color: artery ? 0xCC2222 : 0x2244BB,
    roughness: 0.28,
    metalness: 0.12,
    transparent: true,
    opacity: 0.9,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// GEO HELPERS
// ──────────────────────────────────────────────────────────────────────────────

/** Capsule for smooth limbs */
function cap(r, h, seg = 14) {
  return new THREE.CapsuleGeometry(r, h, 4, seg);
}

/** Spindle muscle shape */
function spindle(len, maxR, tS = 0.18, tE = 0.82, segs = 14) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    let r;
    if (t < tS)      r = maxR * 0.09 + maxR * 0.14 * (t / tS);
    else if (t > tE) r = maxR * 0.09 + maxR * 0.14 * ((1 - t) / (1 - tE));
    else {
      const bt = (t - tS) / (tE - tS);
      r = maxR * (0.62 + 0.38 * Math.sin(bt * Math.PI));
    }
    pts.push(new THREE.Vector2(Math.max(r, 0.01), (t - 0.5) * len));
  }
  return new THREE.LatheGeometry(pts, 10);
}

/** Long bone with flared epiphyses */
function longBone(len, shaftR, endR, segs = 12) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, j = 0.16;
    let r;
    if (t < j)       r = endR * (0.55 + 0.45 * (t / j));
    else if (t > 1 - j) r = endR * (0.55 + 0.45 * ((1 - t) / j));
    else if (t < j + 0.1) r = endR - (endR - shaftR) * ((t - j) / 0.1);
    else if (t > 1 - j - 0.1) r = shaftR + (endR - shaftR) * ((t - (1 - j - 0.1)) / 0.1);
    else r = shaftR;
    pts.push(new THREE.Vector2(Math.max(r, 0.01), (t - 0.5) * len));
  }
  return new THREE.LatheGeometry(pts, 7);
}

/** Tube from array of [x,y,z] points */
function tubePath(pts, r, tSeg = 18, rSeg = 6) {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  return new THREE.TubeGeometry(curve, tSeg, r, rSeg, false);
}

/** Add mesh to group */
function addMesh(grp, geo, mat, pos, rot, scale, ud = {}) {
  const m = new THREE.Mesh(geo, mat.clone ? mat.clone() : mat);
  if (pos)   m.position.set(...pos);
  if (rot)   m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.userData = ud;
  m.castShadow = true;
  m.receiveShadow = true;
  grp.add(m);
  return m;
}

// ──────────────────────────────────────────────────────────────────────────────
// BODY REGION MAP  (label, yMin/yMax, xMin/xMax for hit boxes)
// ──────────────────────────────────────────────────────────────────────────────

const REGIONS = {
  head:             { label: 'Head',             y: [7.0, 9.2],  x: [-1.5, 1.5]  },
  neck:             { label: 'Neck',             y: [6.1, 7.0],  x: [-0.8, 0.8]  },
  chest:            { label: 'Chest',            y: [3.2, 6.1],  x: [-2.4, 2.4]  },
  upper_back:       { label: 'Upper Back',       y: [3.2, 6.1],  x: [-2.4, 2.4]  },
  abdomen:          { label: 'Abdomen',          y: [0.0, 3.2],  x: [-1.9, 1.9]  },
  lower_back:       { label: 'Lower Back',       y: [0.0, 2.5],  x: [-1.7, 1.7]  },
  hip:              { label: 'Hip / Pelvis',     y: [-2.0, 0.0], x: [-2.5, 2.5]  },
  left_shoulder:    { label: 'Left Shoulder',    y: [4.5, 6.1],  x: [-4.0, -1.5] },
  right_shoulder:   { label: 'Right Shoulder',   y: [4.5, 6.1],  x: [1.5, 4.0]   },
  left_upper_arm:   { label: 'Left Upper Arm',   y: [1.5, 4.5],  x: [-4.1, -2.8] },
  right_upper_arm:  { label: 'Right Upper Arm',  y: [1.5, 4.5],  x: [2.8, 4.1]   },
  left_elbow:       { label: 'Left Elbow',       y: [0.8, 1.5],  x: [-4.1, -2.8] },
  right_elbow:      { label: 'Right Elbow',      y: [0.8, 1.5],  x: [2.8, 4.1]   },
  left_forearm:     { label: 'Left Forearm',     y: [-1.8, 0.8], x: [-4.1, -2.8] },
  right_forearm:    { label: 'Right Forearm',    y: [-1.8, 0.8], x: [2.8, 4.1]   },
  left_hand:        { label: 'Left Hand',        y: [-3.2, -1.8],x: [-4.1, -2.8] },
  right_hand:       { label: 'Right Hand',       y: [-3.2, -1.8],x: [2.8, 4.1]   },
  left_thigh:       { label: 'Left Thigh',       y: [-5.5, -2.0],x: [-2.0, 0.0]  },
  right_thigh:      { label: 'Right Thigh',      y: [-5.5, -2.0],x: [0.0, 2.0]   },
  left_knee:        { label: 'Left Knee',        y: [-6.2, -5.5],x: [-1.8, 0.0]  },
  right_knee:       { label: 'Right Knee',       y: [-6.2, -5.5],x: [0.0, 1.8]   },
  left_lower_leg:   { label: 'Left Lower Leg',   y: [-8.8, -6.2],x: [-1.8, 0.0]  },
  right_lower_leg:  { label: 'Right Lower Leg',  y: [-8.8, -6.2],x: [0.0, 1.8]   },
  left_ankle:       { label: 'Left Ankle',       y: [-9.2, -8.8],x: [-1.5, 0.0]  },
  right_ankle:      { label: 'Right Ankle',      y: [-9.2, -8.8],x: [0.0, 1.5]   },
  left_foot:        { label: 'Left Foot',        y: [-9.5, -9.0],x: [-1.5, 0.0]  },
  right_foot:       { label: 'Right Foot',       y: [-9.5, -9.0],x: [0.0, 1.5]   },
};

// ──────────────────────────────────────────────────────────────────────────────
// ANATOMY VIEWER CLASS
// ──────────────────────────────────────────────────────────────────────────────

class AnatomyViewer {
  constructor(container) {
    this.container = container;
    this._highlightOverlays = [];
    this._hoverOverlay = null;
    this._hoveredRegion = null;
    this._onSelectCb = null;
    this._onHoverCb = null;
    this._disposed = false;
    this._init();
  }

  // ── Initialise renderer, scene, camera, controls ──────────────────────────
  _init() {
    const W = this.container.clientWidth  || 420;
    const H = this.container.clientHeight || 620;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(W, H);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(36, W / H, 0.1, 200);
    this.camera.position.set(0, 0, 22);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08,
      autoRotate: true, autoRotateSpeed: 0.45,
      minDistance: 5, maxDistance: 40,
    });
    this.controls.target.set(0, 0, 0);

    this._setupLights();

    this.skinGrp     = new THREE.Group();
    this.muscleGrp   = new THREE.Group();
    this.skeletonGrp = new THREE.Group();
    this.vascularGrp = new THREE.Group();
    this.hitGrp      = new THREE.Group();

    this._buildSkin();
    this._buildMuscles();
    this._buildSkeleton();
    this._buildVascular();
    this._buildHitMeshes();

    [this.skinGrp, this.muscleGrp, this.skeletonGrp, this.vascularGrp, this.hitGrp]
      .forEach(g => this.scene.add(g));

    this.hitGrp.visible = false; // invisible, only raycasted

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this._setupInteraction();

    this._resizeObs = new ResizeObserver(() => this.resize());
    this._resizeObs.observe(this.container);

    this.setLayer('skin');
    this._animate();
  }

  // ── Lighting ──────────────────────────────────────────────────────────────
  _setupLights() {
    this.scene.add(new THREE.AmbientLight(0xFFE8D0, 0.45));

    const key = new THREE.DirectionalLight(0xFFF5E8, 2.6);
    key.position.set(5, 9, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { near: 0.5, far: 70, left: -9, right: 9, top: 16, bottom: -16 });
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xCCE0FF, 0.75);
    fill.position.set(-7, 4, 5);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xFFFFFF, 1.15);
    rim.position.set(0, 5, -13);
    this.scene.add(rim);

    const bounce = new THREE.DirectionalLight(0x806040, 0.28);
    bounce.position.set(0, -12, 5);
    this.scene.add(bounce);
  }

  // ── SKIN LAYER ────────────────────────────────────────────────────────────
  _buildSkin() {
    const G = this.skinGrp;
    const sm = mkSkin();
    const a = (geo, pos, rot, scale, region) =>
      addMesh(G, geo, sm, pos, rot, scale, { region, layer: 'skin', label: REGIONS[region]?.label || region });

    // Head — cranium + face forward
    a(new THREE.SphereGeometry(0.9, 24, 20),  [0, 8.1, 0],    null, [0.88, 1.08, 0.94], 'head');
    a(new THREE.SphereGeometry(0.62, 18, 14), [0, 7.7, 0.22], null, [0.95, 0.72, 0.82], 'head');
    // Brow ridge
    a(new THREE.SphereGeometry(0.48, 12, 8),  [0, 8.0, 0.62], null, [1.15, 0.38, 0.55], 'head');

    // Neck
    a(cap(0.265, 0.7, 14), [0, 6.82, 0.03], null, [1, 1, 0.88], 'neck');

    // Torso — lathe profile gives realistic waist taper + chest width
    const tp = [
      new THREE.Vector2(0.58, -2.18), // hip bottom
      new THREE.Vector2(0.55, -1.55), // hip
      new THREE.Vector2(0.37, -0.55), // waist (narrowest)
      new THREE.Vector2(0.45,  0.1 ), // lower abdomen
      new THREE.Vector2(0.54,  0.85), // stomach
      new THREE.Vector2(0.65,  1.62), // chest
      new THREE.Vector2(0.68,  2.18), // upper chest
      new THREE.Vector2(0.60,  2.72), // clavicle
      new THREE.Vector2(0.44,  3.06), // neck base
    ];
    a(new THREE.LatheGeometry(tp, 22), [0, 3.5, 0], null, [1, 1, 0.70], 'chest');

    // Pectoral bulge
    for (const s of [-1, 1])
      a(new THREE.SphereGeometry(0.43, 14, 12), [s * 0.54, 5.18, 0.36], null, [1, 0.68, 0.50], 'chest');

    // Shoulders
    for (const s of [-1, 1])
      a(new THREE.SphereGeometry(0.44, 16, 14), [s * 1.58, 5.70, 0.07], null, [1, 0.82, 0.86],
        s < 0 ? 'left_shoulder' : 'right_shoulder');

    // Pelvis
    a(new THREE.SphereGeometry(0.72, 18, 14), [0, 1.22, 0], null, [1.55, 0.85, 0.80], 'hip');

    // Upper arms (capsule = smooth from shoulder to elbow)
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_upper_arm' : 'right_upper_arm';
      a(cap(0.22, 2.05, 14), [s * 2.2, 4.15, 0.04], [0, 0, s * 0.12], null, r);
    }

    // Elbows
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_elbow' : 'right_elbow';
      a(new THREE.SphereGeometry(0.19, 12, 10), [s * 2.38, 2.16, 0], null, [1, 0.9, 0.84], r);
    }

    // Forearms
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_forearm' : 'right_forearm';
      a(cap(0.185, 1.75, 12), [s * 2.48, 0.80, 0], [0, 0, s * 0.06], [1, 1, 0.85], r);
    }

    // Wrists
    for (const s of [-1, 1])
      a(new THREE.SphereGeometry(0.15, 10, 8), [s * 2.55, -0.14, 0], null, [1.1, 0.86, 0.74],
        s < 0 ? 'left_forearm' : 'right_forearm');

    // Hands — palm + knuckle pad + 4 fingers + thumb
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_hand' : 'right_hand';
      a(new THREE.SphereGeometry(0.27, 16, 12), [s * 2.55, -0.68, 0.05], null, [0.72, 1.0, 0.48], r);
      a(new THREE.SphereGeometry(0.22, 12, 10), [s * 2.55, -0.94, 0.11], null, [0.68, 0.54, 0.44], r);
      for (let f = 0; f < 4; f++) {
        const fx = s * ((f - 1.5) * 0.12);
        a(cap(0.052, 0.38, 8), [s * 2.55 + fx, -1.40, 0.1], null, null, r);
      }
      a(cap(0.062, 0.26, 8), [s * 2.22, -0.80, 0.17], [0, 0, s * -0.54], null, r);
    }

    // Thighs
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_thigh' : 'right_thigh';
      a(cap(0.32, 2.95, 16), [s * 0.78, -3.1, 0], [0, 0, s * 0.04], null, r);
    }

    // Knees
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_knee' : 'right_knee';
      a(new THREE.SphereGeometry(0.25, 14, 12), [s * 0.78, -5.60, 0.1], null, [1, 0.9, 0.84], r);
    }

    // Lower legs — shin (front) + calf (back)
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_lower_leg' : 'right_lower_leg';
      a(cap(0.165, 2.4, 12), [s * 0.72, -7.12, 0.10], null, [1, 1, 0.82], r);
      a(cap(0.185, 1.8, 12), [s * 0.82, -6.98, -0.10], null, [0.88, 1, 1.05], r);
    }

    // Ankles
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_ankle' : 'right_ankle';
      a(new THREE.SphereGeometry(0.17, 12, 10), [s * 0.76, -8.86, 0], null, [1.1, 0.84, 1.04], r);
    }

    // Feet
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_foot' : 'right_foot';
      a(cap(0.155, 0.72, 10), [s * 0.76, -9.1, 0.44], [Math.PI * 0.5, 0, 0], [0.85, 1, 0.72], r);
      a(new THREE.SphereGeometry(0.17, 10, 8),  [s * 0.76, -9.06, -0.22], null, [0.78, 0.68, 0.72], r);
      a(new THREE.SphereGeometry(0.155, 10, 8), [s * 0.76, -9.10, 0.85],  null, [0.72, 0.44, 0.60], r);
    }
  }

  // ── MUSCLE LAYER ──────────────────────────────────────────────────────────
  _buildMuscles() {
    const G = this.muscleGrp;
    const mm = mkMuscle(false), mmd = mkMuscle(true), mt = mkTendon();
    const a = (geo, pos, rot, scale, region, name, mat = mm) =>
      addMesh(G, geo, mat, pos, rot, scale, { region, layer: 'muscle', label: name });

    // Neck — sternocleidomastoid (bilateral)
    for (const s of [-1, 1])
      a(spindle(1.35, 0.15), [s * 0.4, 6.48, 0.13], [0, 0, s * -0.17], null, 'neck', 'Sternocleidomastoid');

    // Trapezius
    a(spindle(2.3, 0.5, 0.07, 0.95), [0, 4.5, -0.5], null, [2.42, 1, 0.30], 'upper_back', 'Trapezius', mmd);

    // Deltoids
    for (const s of [-1, 1])
      a(spindle(1.5, 0.38, 0.06, 0.90), [s * 2.2, 4.2, 0], [0, 0, s * 0.25], [1, 1, 0.74],
        s < 0 ? 'left_shoulder' : 'right_shoulder', 'Deltoid');

    // Pectorals
    for (const s of [-1, 1])
      a(spindle(1.7, 0.40, 0.04, 0.90), [s * 0.82, 3.78, 0.40], [0, s * 0.30, 0],
        [1.25, 0.82, 0.42], 'chest', 'Pectoralis Major');

    // Serratus Anterior
    for (const s of [-1, 1])
      a(spindle(1.6, 0.18, 0.10, 0.85), [s * 1.55, 2.88, 0.12], [0, 0, s * 0.14],
        [0.75, 1, 0.28], 'chest', 'Serratus Anterior', mmd);

    // Biceps Brachii
    for (const s of [-1, 1])
      a(spindle(2.0, 0.22), [s * 2.28, 3.1, 0.12], [0, 0, s * 0.08], null,
        s < 0 ? 'left_upper_arm' : 'right_upper_arm', 'Biceps Brachii');

    // Triceps Brachii
    for (const s of [-1, 1])
      a(spindle(2.1, 0.20, 0.10, 0.80), [s * 2.28, 3.0, -0.14], [0, 0, s * 0.08], null,
        s < 0 ? 'left_upper_arm' : 'right_upper_arm', 'Triceps Brachii', mmd);

    // Forearms
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_forearm' : 'right_forearm';
      a(spindle(1.8, 0.17, 0.10, 0.70), [s * 2.52, 0.10, 0.04], [0, 0, s * 0.06], null, r, 'Forearm Flexors');
      a(spindle(1.6, 0.14, 0.10, 0.70), [s * 2.42, 0.10, -0.06], [0, 0, s * 0.06], null, r, 'Forearm Extensors', mmd);
    }

    // Rectus Abdominis (4 pairs = "6-pack" + lower section)
    for (let i = 0; i < 4; i++) {
      const y = 2.3 - i * 0.60;
      for (const s of [-1, 1])
        a(spindle(0.48, 0.17, 0.04, 0.96), [s * 0.26, y, 0.42], null, [1.1, 1, 0.35], 'abdomen', 'Rectus Abdominis');
    }

    // External Oblique
    for (const s of [-1, 1])
      a(spindle(2.0, 0.26, 0.07, 0.90), [s * 1.25, 1.58, 0.22], [0, 0, s * 0.20],
        [1, 1, 0.40], 'abdomen', 'External Oblique', mmd);

    // Latissimus Dorsi
    for (const s of [-1, 1])
      a(spindle(2.7, 0.48, 0.04, 0.92), [s * 1.18, 2.2, -0.38], null, [1, 1.08, 0.32], 'upper_back', 'Latissimus Dorsi', mmd);

    // Erector Spinae (bilateral)
    for (const s of [-1, 1])
      a(spindle(3.0, 0.18), [s * 0.28, 0.88, -0.48], null, null, 'lower_back', 'Erector Spinae', mmd);

    // Gluteus Maximus
    for (const s of [-1, 1])
      a(spindle(1.5, 0.52, 0.07, 0.90), [s * 0.70, -1.55, -0.32], null, [1.05, 1, 0.82], 'hip', 'Gluteus Maximus');

    // Quadriceps (4 heads per side)
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_thigh' : 'right_thigh';
      a(spindle(3.0, 0.28), [s * 0.95, -3.5, 0.28], null, null, r, 'Rectus Femoris');
      a(spindle(2.7, 0.21), [s * 1.18, -3.75, 0.15], null, null, r, 'Vastus Lateralis', mmd);
      a(spindle(2.5, 0.19), [s * 0.74, -3.75, 0.15], null, null, r, 'Vastus Medialis', mmd);
      a(spindle(2.4, 0.17), [s * 0.95, -3.60, 0.07], null, null, r, 'Vastus Intermedius', mmd);
    }

    // Hamstrings
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_thigh' : 'right_thigh';
      a(spindle(2.8, 0.21), [s * 0.82, -3.55, -0.22], null, null, r, 'Biceps Femoris', mmd);
      a(spindle(2.6, 0.17), [s * 1.05, -3.45, -0.18], null, null, r, 'Semitendinosus', mmd);
    }

    // Adductors
    for (const s of [-1, 1])
      a(spindle(2.1, 0.19), [s * 0.70, -3.0, 0], null, null,
        s < 0 ? 'left_thigh' : 'right_thigh', 'Adductor Magnus', mmd);

    // Gastrocnemius (lateral + medial heads)
    for (const s of [-1, 1]) {
      const r = s < 0 ? 'left_lower_leg' : 'right_lower_leg';
      a(spindle(2.0, 0.20, 0.07, 0.68), [s * 0.86, -6.80, -0.14], null, [1, 1, 1.05], r, 'Gastrocnemius Lateral');
      a(spindle(1.85, 0.18, 0.07, 0.68), [s * 1.08, -6.75, -0.10], null, [1, 1, 1.05], r, 'Gastrocnemius Medial');
    }

    // Soleus
    for (const s of [-1, 1])
      a(spindle(1.6, 0.15, 0.10, 0.62), [s * 0.95, -7.20, -0.06], null, null,
        s < 0 ? 'left_lower_leg' : 'right_lower_leg', 'Soleus', mmd);

    // Tibialis Anterior
    for (const s of [-1, 1])
      a(spindle(1.7, 0.13, 0.10, 0.72), [s * 0.82, -6.80, 0.16], null, null,
        s < 0 ? 'left_lower_leg' : 'right_lower_leg', 'Tibialis Anterior');

    // Achilles tendon
    for (const s of [-1, 1])
      a(spindle(0.85, 0.06, 0.25, 0.75), [s * 0.95, -8.02, -0.12], null, null,
        s < 0 ? 'left_ankle' : 'right_ankle', 'Achilles Tendon', mt);
  }

  // ── SKELETON LAYER ────────────────────────────────────────────────────────
  _buildSkeleton() {
    const G = this.skeletonGrp;
    const bm = mkBone();
    const a = (geo, pos, rot, scale, region, name) =>
      addMesh(G, geo, bm, pos, rot, scale, { region, layer: 'skeleton', label: name });

    // Skull + mandible
    a(new THREE.SphereGeometry(0.88, 20, 16), [0, 8.1, 0],     null, [0.85, 1, 0.88], 'head', 'Skull');
    a(new THREE.SphereGeometry(0.36, 12, 8),  [0, 7.60, 0.30], null, [1.1, 0.52, 0.72], 'head', 'Mandible');

    // Vertebral column (24 vertebrae)
    const vGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.13, 8);
    for (let i = 0; i < 24; i++) {
      const y = 6.2 - i * 0.23, sc = 0.82 + i * 0.022;
      const reg = i < 7 ? 'neck' : (i < 19 ? 'chest' : 'lower_back');
      a(vGeo, [0, y, -0.35], null, [sc, 1, sc], reg, `Vertebra ${i + 1}`);
    }

    // Sacrum
    a(longBone(0.62, 0.11, 0.19), [0, -0.50, -0.30], [0.14, 0, 0], null, 'hip', 'Sacrum');

    // Sternum
    a(new THREE.CylinderGeometry(0.075, 0.095, 2.2, 6), [0, 3.4, 0.45], null, [1.75, 1, 0.42], 'chest', 'Sternum');

    // Ribs (12 pairs)
    const ribW = [1.25, 1.42, 1.58, 1.72, 1.82, 1.90, 1.90, 1.80, 1.65, 1.45, 0.90, 0.72];
    for (let i = 0; i < 12; i++) {
      const y = 4.5 - i * 0.26, w = ribW[i];
      for (const s of [-1, 1]) {
        const pts = [
          [0, y, -0.28], [s * w * 0.44, y - 0.04, -0.20],
          [s * w * 0.86, y + 0.02, 0.08], [s * w * 0.54, y + 0.10, 0.36],
        ];
        if (i < 10) pts.push([s * 0.18, y + 0.12, 0.43]);
        a(tubePath(pts, 0.055, 16, 5), [0, 0, 0], null, null, 'chest', `Rib ${i + 1}`);
      }
    }

    // Clavicles
    for (const s of [-1, 1])
      a(tubePath([[0, 4.75, 0.30], [s * 1.05, 4.85, 0.10], [s * 2.0, 4.65, -0.06]], 0.062, 10, 5),
        [0, 0, 0], null, null, s < 0 ? 'left_shoulder' : 'right_shoulder', 'Clavicle');

    // Scapulae
    for (const s of [-1, 1])
      a(new THREE.CylinderGeometry(0.04, 0.44, 1.25, 3), [s * 1.48, 3.85, -0.56], [0, 0, s * 0.11],
        [1, 1, 0.28], s < 0 ? 'left_shoulder' : 'right_shoulder', 'Scapula');

    // Pelvis
    for (const s of [-1, 1])
      a(new THREE.SphereGeometry(0.84, 14, 10), [s * 0.70, -1.18, 0.02], null, [1.12, 0.98, 0.50], 'hip', 'Ilium');
    a(new THREE.CylinderGeometry(0.24, 0.44, 0.48, 8), [0, -1.80, 0.10], null, [2.25, 1, 0.52], 'hip', 'Pubis');

    // Arms and legs (both sides)
    for (const s of [-1, 1]) {
      const sl = s < 0 ? 'left' : 'right';
      a(new THREE.SphereGeometry(0.21, 10, 8), [s * 2.12, 4.58, 0],   null, null, `${sl}_shoulder`, 'Shoulder Joint');
      a(longBone(2.7, 0.10, 0.17), [s * 2.28, 3.05, 0], [0, 0, s * 0.08], null, `${sl}_upper_arm`, 'Humerus');
      a(new THREE.SphereGeometry(0.16, 10, 8), [s * 2.38, 1.55, 0],   null, null, `${sl}_elbow`, 'Elbow Joint');
      a(longBone(2.3, 0.068, 0.11), [s * 2.50, 0.0, 0.06], [0, 0, s * 0.05], null, `${sl}_forearm`, 'Radius');
      a(longBone(2.4, 0.058, 0.095),[s * 2.36, -0.05, -0.06],[0, 0, s * 0.05], null, `${sl}_forearm`, 'Ulna');
      a(new THREE.SphereGeometry(0.26, 10, 8), [s * 2.55, -1.50, 0],  null, [0.62, 0.96, 0.33], `${sl}_hand`, 'Carpals');
      a(new THREE.SphereGeometry(0.21, 10, 8), [s * 1.02, -1.85, 0],  null, null, 'hip', 'Hip Joint');
      a(longBone(3.65, 0.125, 0.19), [s * 0.98, -3.85, 0], null, null, `${sl}_thigh`, 'Femur');
      a(new THREE.SphereGeometry(0.17, 10, 8), [s * 0.97, -5.70, 0.22], null, [0.96, 0.68, 0.52], `${sl}_knee`, 'Patella');
      a(longBone(3.1, 0.088, 0.135),[s * 0.92, -7.20, 0.04], null, null, `${sl}_lower_leg`, 'Tibia');
      a(longBone(2.9, 0.048, 0.085),[s * 1.10, -7.20, -0.04], null, null, `${sl}_lower_leg`, 'Fibula');
      a(new THREE.SphereGeometry(0.135, 8, 6), [s * 0.97, -8.32, 0],  null, null, `${sl}_ankle`, 'Ankle Joint');
      a(new THREE.SphereGeometry(0.33, 10, 8), [s * 0.97, -8.50, 0.35], null, [0.62, 0.30, 1.25], `${sl}_foot`, 'Foot Bones');
    }
  }

  // ── VASCULAR LAYER ────────────────────────────────────────────────────────
  _buildVascular() {
    const G = this.vascularGrp;
    const aM = mkVessel(true), vM = mkVessel(false);
    const v = (pts, mat, r, region, name) =>
      addMesh(G, tubePath(pts, r, 20, 6), mat, [0, 0, 0], null, null, { region, layer: 'vascular', label: name });

    // Aorta
    v([[0, 4.5, 0.1],[0, 3.5, 0.15],[0, 1.5, 0.12],[0, 0, 0.08],[0, -1.5, 0.05]], aM, 0.078, 'chest', 'Aorta');

    // Carotid arteries (bilateral)
    for (const s of [-1, 1])
      v([[s*0.15, 4.5, 0.12],[s*0.22, 5.2, 0.10],[s*0.25, 6.0, 0.08],[s*0.20, 6.8, 0.05]], aM, 0.038, 'neck', 'Carotid Artery');

    // Subclavian → Brachial arteries
    for (const s of [-1, 1]) {
      const sl = s < 0 ? 'left' : 'right';
      v([[0, 4.5, 0.1],[s*0.8, 4.6, 0.05],[s*1.8, 4.5, 0],[s*2.2, 3.5, 0.05],[s*2.35, 1.5, 0.02]],
        aM, 0.034, `${sl}_upper_arm`, 'Brachial Artery');
    }

    // Iliac → Femoral → Popliteal arteries
    for (const s of [-1, 1]) {
      const sl = s < 0 ? 'left' : 'right';
      v([[0, -1.5, 0.05],[s*0.5, -1.8, 0.02],[s*0.9, -3.0, 0.10],[s*0.95, -5.5, 0.10]],
        aM, 0.038, `${sl}_thigh`, 'Femoral Artery');
      v([[s*0.95, -5.5, 0.1],[s*0.95, -7.0, 0.08],[s*0.95, -8.0, 0.05]],
        aM, 0.028, `${sl}_lower_leg`, 'Popliteal Artery');
    }

    // Vena Cava
    v([[0, 4.5, -0.1],[0, 3.0, -0.12],[0, 1.0, -0.10],[0, -1.0, -0.08]], vM, 0.068, 'chest', 'Vena Cava');

    // Jugular veins
    for (const s of [-1, 1])
      v([[s*0.30, 4.5, -0.08],[s*0.35, 5.5, -0.05],[s*0.30, 6.5, -0.02]], vM, 0.033, 'neck', 'Jugular Vein');

    // Femoral veins
    for (const s of [-1, 1]) {
      const sl = s < 0 ? 'left' : 'right';
      v([[s*0.50, -1.8, -0.05],[s*1.10, -3.5, -0.10],[s*1.10, -5.5, -0.08],[s*1.05, -7.5, -0.05]],
        vM, 0.033, `${sl}_thigh`, 'Femoral Vein');
    }
  }

  // ── HIT MESHES (invisible boxes for reliable raycasting) ─────────────────
  _buildHitMeshes() {
    const transparent = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    Object.entries(REGIONS).forEach(([regionId, info]) => {
      const yC = (info.y[0] + info.y[1]) / 2, yH = (info.y[1] - info.y[0]) / 2;
      const xC = (info.x[0] + info.x[1]) / 2, xH = (info.x[1] - info.x[0]) / 2;
      const m = new THREE.Mesh(new THREE.BoxGeometry(xH * 2, yH * 2, 1.6), transparent.clone());
      m.position.set(xC, yC, 0);
      m.userData = { region: regionId, layer: 'hit', label: info.label, isHitMesh: true };
      this.hitGrp.add(m);
    });
  }

  // ── INTERACTION ───────────────────────────────────────────────────────────
  _setupInteraction() {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', e => this._onMove(e));
    el.addEventListener('pointerdown', e => this._onClick(e));
    el.style.cursor = 'grab';
  }

  _getRayHits(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left)  / rect.width)  * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = [];
    // Check hit group (boxes) + visible body meshes
    [this.hitGrp, this.skinGrp, this.muscleGrp, this.skeletonGrp, this.vascularGrp]
      .forEach(g => g.traverse(c => { if (c.isMesh) meshes.push(c); }));
    return this.raycaster.intersectObjects(meshes, false).filter(h => h.object.userData.region);
  }

  _onMove(e) {
    const hits = this._getRayHits(e);
    const el = this.renderer.domElement;
    if (hits.length) {
      el.style.cursor = 'pointer';
      const ud = hits[0].object.userData;
      if (this._onHoverCb) this._onHoverCb(ud);
      if (this._hoveredRegion !== ud.region) {
        this._hoveredRegion = ud.region;
        this._clearHoverOverlay();
        this._makeHoverOverlay(ud.region);
      }
    } else {
      el.style.cursor = 'grab';
      if (this._onHoverCb) this._onHoverCb(null);
      this._clearHoverOverlay();
      this._hoveredRegion = null;
    }
  }

  _onClick(e) {
    const hits = this._getRayHits(e);
    if (hits.length && this._onSelectCb) this._onSelectCb(hits[0].object.userData);
  }

  _makeHoverOverlay(regionId) {
    const info = REGIONS[regionId]; if (!info) return;
    const yC = (info.y[0] + info.y[1]) / 2, yH = (info.y[1] - info.y[0]) / 2 * 1.12;
    const xC = (info.x[0] + info.x[1]) / 2, xH = (info.x[1] - info.x[0]) / 2 * 1.12;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(xH * 2, yH * 2, 2.0),
      new THREE.MeshBasicMaterial({ color: 0x38BDF8, transparent: true, opacity: 0.13, depthWrite: false }),
    );
    m.position.set(xC, yC, 0);
    m.renderOrder = 10;
    this.scene.add(m);
    this._hoverOverlay = m;
  }

  _clearHoverOverlay() {
    if (this._hoverOverlay) {
      this.scene.remove(this._hoverOverlay);
      this._hoverOverlay.geometry.dispose();
      this._hoverOverlay.material.dispose();
      this._hoverOverlay = null;
    }
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────

  /**
   * Switch body system layer.
   * Modes: 'skin' | 'muscles' | 'skeleton' | 'vascular' | 'all'
   *
   * When a deep layer is selected the skin becomes transparent so you can
   * see through it to the structures underneath.
   */
  setLayer(layer) {
    this.skinGrp.visible     = (layer !== 'vascular');
    this.muscleGrp.visible   = (layer === 'muscles' || layer === 'all');
    this.skeletonGrp.visible = (layer === 'skeleton' || layer === 'all');
    this.vascularGrp.visible = (layer === 'vascular' || layer === 'all');

    const skinOpacity = { skin: 1.0, muscles: 0.18, skeleton: 0.12, vascular: 0.0, all: 0.22 };
    const op = skinOpacity[layer] ?? 1.0;

    this.skinGrp.traverse(c => {
      if (!c.isMesh) return;
      c.material.transparent = op < 1;
      c.material.opacity = op;
      c.material.depthWrite = op >= 0.99;
    });

    this.muscleGrp.traverse(c => {
      if (!c.isMesh) return;
      c.material.transparent = (layer === 'all');
      c.material.opacity = (layer === 'all') ? 0.70 : 1.0;
    });
  }

  /** Highlight one or more regions with a pulsing blue overlay */
  highlight(regionIds = []) {
    this.clearHighlight();
    for (const rid of regionIds) {
      const info = REGIONS[rid]; if (!info) continue;
      const yC = (info.y[0] + info.y[1]) / 2, yH = Math.max((info.y[1] - info.y[0]) / 2, 0.45);
      const xC = (info.x[0] + info.x[1]) / 2, xH = Math.max((info.x[1] - info.x[0]) / 2, 0.45);
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(xH * 2.2, yH * 2.2, 2.2),
        new THREE.MeshBasicMaterial({ color: 0x38BDF8, transparent: true, opacity: 0.14, depthWrite: false }),
      );
      m.position.set(xC, yC, 0);
      m.renderOrder = 10;
      this.scene.add(m);
      this._highlightOverlays.push(m);
    }
  }

  clearHighlight() {
    this._highlightOverlays.forEach(o => {
      this.scene.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    });
    this._highlightOverlays = [];
  }

  /** Smoothly move camera focus to a region */
  focusRegion(regionId) {
    const info = REGIONS[regionId]; if (!info) return;
    const yC = (info.y[0] + info.y[1]) / 2;
    const xC = (info.x[0] + info.x[1]) / 2;
    this.controls.target.set(xC, yC, 0);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target.clone().add(dir.multiplyScalar(12)));
    this.controls.update();
  }

  /** Snap camera to a cardinal view */
  setView(view) {
    this.controls.autoRotate = false;
    const t = this.controls.target.clone();
    const d = 20;
    const positions = { front: [t.x, t.y, t.z + d], back: [t.x, t.y, t.z - d], left: [t.x - d, t.y, t.z], right: [t.x + d, t.y, t.z] };
    if (positions[view]) {
      this.camera.position.set(...positions[view]);
      this.controls.update();
    }
  }

  resetCamera() {
    this.camera.position.set(0, 0, 22);
    this.controls.target.set(0, 0, 0);
    this.controls.autoRotate = true;
    this.controls.update();
  }

  onSelect(cb) { this._onSelectCb = cb; }
  onHover(cb)  { this._onHoverCb  = cb; }

  resize() {
    const W = this.container.clientWidth, H = this.container.clientHeight;
    if (!W || !H) return;
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(W, H);
  }

  _animate() {
    if (this._disposed) return;
    requestAnimationFrame(() => this._animate());
    const t = performance.now() * 0.001;
    this._highlightOverlays.forEach(o => { o.material.opacity = 0.10 + Math.sin(t * 2.8) * 0.06; });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._disposed = true;
    this._resizeObs?.disconnect();
    this.clearHighlight();
    this._clearHoverOverlay();
    this.controls.dispose();
    this.renderer.dispose();
    this.scene.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material?.dispose(); } });
    this.renderer.domElement.parentNode?.removeChild(this.renderer.domElement);
  }
}

// Export the same way as before so index.html works without changes
window.AnatomyViewer = AnatomyViewer;
// Also expose REGIONS for the UI
window.ANATOMY_REGIONS = REGIONS;