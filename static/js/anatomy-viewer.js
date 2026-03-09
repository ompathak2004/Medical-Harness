/**
 * AnatomyViewer — Interactive 3D anatomical body using Three.js
 * Renders skeletal + muscular systems with realistic muscle shapes,
 * fiber textures, veins, and anatomical detail.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ================================================================
   PROCEDURAL MUSCLE-FIBER TEXTURE
   Creates a canvas texture that looks like muscle striations
   ================================================================ */
function createMuscleFiberTexture(baseColor, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Base fill
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, size, size);

  // Draw longitudinal fiber lines
  for (let i = 0; i < 80; i++) {
    const y = Math.random() * size;
    const alpha = 0.08 + Math.random() * 0.12;
    ctx.strokeStyle = `rgba(0,0,0,${alpha})`;
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    // Slightly wavy lines
    for (let x = 0; x < size; x += 8) {
      ctx.lineTo(x, y + Math.sin(x * 0.05 + i) * 2);
    }
    ctx.stroke();
  }

  // Cross-striations (lighter bands)
  for (let x = 0; x < size; x += 4 + Math.random() * 6) {
    const alpha = 0.03 + Math.random() * 0.06;
    ctx.strokeStyle = `rgba(255,200,180,${alpha})`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + Math.random() * 3, size);
    ctx.stroke();
  }

  // Fascia/membrane highlights
  for (let i = 0; i < 12; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = `rgba(255,220,200,${0.04 + Math.random() * 0.05})`;
    ctx.lineWidth = 2 + Math.random() * 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 10);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 2);
  return tex;
}

/* ================================================================
   PROCEDURAL NORMAL MAP for muscle fiber bump
   ================================================================ */
function createFiberNormalMap(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Neutral normal (128,128,255)
  ctx.fillStyle = 'rgb(128,128,255)';
  ctx.fillRect(0, 0, size, size);

  // Horizontal fiber grooves
  for (let i = 0; i < 60; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = `rgb(${120 + Math.random() * 16}, ${125 + Math.random() * 6}, 255)`;
    ctx.lineWidth = 0.8 + Math.random() * 2;
    ctx.beginPath();
    for (let x = 0; x < size; x += 6) {
      ctx.lineTo(x, y + Math.sin(x * 0.06 + i) * 1.5);
    }
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 2);
  return tex;
}

/* ================================================================
   MATERIAL FACTORIES
   ================================================================ */
function makeBoneMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xE8DCC8, roughness: 0.35, metalness: 0.05,
    clearcoat: 0.4, clearcoatRoughness: 0.25,
  });
}

function makeMuscleMat(hexColor = 0x8B2020) {
  const c = new THREE.Color(hexColor);
  const cssColor = `rgb(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)})`;
  const map = createMuscleFiberTexture(cssColor);
  const normalMap = createFiberNormalMap();
  return new THREE.MeshPhysicalMaterial({
    color: hexColor,
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.55,
    metalness: 0.02,
    clearcoat: 0.15,
    clearcoatRoughness: 0.4,
  });
}

function makeTendonMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xD4C9B8, roughness: 0.6, metalness: 0.0,
    clearcoat: 0.3, clearcoatRoughness: 0.5,
  });
}

function makeVeinMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x2244AA, roughness: 0.4, metalness: 0.05,
    clearcoat: 0.5, clearcoatRoughness: 0.3,
    transparent: true, opacity: 0.75,
  });
}

function makeArteryMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xAA2222, roughness: 0.4, metalness: 0.05,
    clearcoat: 0.5, clearcoatRoughness: 0.3,
    transparent: true, opacity: 0.75,
  });
}

/* ================================================================
   GEOMETRY HELPERS
   ================================================================ */
function capsule(r, h) { return new THREE.CapsuleGeometry(r, h, 8, 16); }
function cyl(rt, rb, h) { return new THREE.CylinderGeometry(rt, rb, h, 16); }
function sphere(r) { return new THREE.SphereGeometry(r, 16, 12); }

/**
 * Create anatomically-shaped muscle geometry using LatheGeometry.
 * Profile: tapered tendon ends → swelling belly → tapered tendon end.
 * @param {number} bellyR  - max radius at belly
 * @param {number} length  - total length
 * @param {number} tendonR - radius at tendon ends
 * @param {number} flatness - Z-scale for flatter muscles (1 = round)
 */
function muscleGeo(bellyR, length, tendonR = 0.04, flatness = 1) {
  const pts = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;            // 0..1 along length
    const y = (t - 0.5) * length;  // centered on origin

    // Bell-shaped profile: sin² for natural muscle belly
    const bellyCurve = Math.sin(t * Math.PI);
    const r = tendonR + (bellyR - tendonR) * bellyCurve * bellyCurve;

    pts.push(new THREE.Vector2(Math.max(r, 0.01), y));
  }
  const geo = new THREE.LatheGeometry(pts, 16);
  if (flatness !== 1) {
    geo.scale(1, 1, flatness);
  }
  return geo;
}

/**
 * Create a vessel (vein/artery) as a tube along a path.
 */
function vesselGeo(points, radius = 0.02) {
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, 16, radius, 6, false);
}

function addPart(group, geo, mat, pos, rot, scale, name, region, system) {
  const m = new THREE.Mesh(geo, mat.clone());
  m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.userData = { region, name, label: name, system };
  m.castShadow = true;
  group.add(m);
  return m;
}

/* ================================================================
   MAIN CLASS
   ================================================================ */
class AnatomyViewer {
  constructor(container) {
    this.container = container;
    this.onSelectCb = null;
    this.hoveredMesh = null;
    this.highlighted = [];
    this._disposed = false;
    this._animId = null;
    this._init();
  }

  _init() {
    const W = this.container.clientWidth, H = this.container.clientHeight;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(W, H);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
    this.camera.position.set(8, 2, 12);
    this.camera.lookAt(0, 0, 0);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 25;
    this.controls.target.set(0, 0, 0);

    // Lights
    this._setupLights();

    // Build body groups
    this.skeletonGroup = new THREE.Group();
    this.muscleGroup = new THREE.Group();
    this.vesselGroup = new THREE.Group();
    this._buildSkeleton();
    this._buildMuscles();
    this._buildVessels();
    this.scene.add(this.skeletonGroup);
    this.scene.add(this.muscleGroup);
    this.scene.add(this.vesselGroup);

    // Ground shadow
    const gGeo = new THREE.CircleGeometry(3, 32);
    const gMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 });
    const ground = new THREE.Mesh(gGeo, gMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -8.6;
    this.scene.add(ground);

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this._setupInteraction();

    // Default: show all
    this.setLayer('all');

    // Resize observer
    this._resizeObs = new ResizeObserver(() => this.resize());
    this._resizeObs.observe(this.container);

    this._animate();
  }

  _setupLights() {
    this.scene.add(new THREE.AmbientLight(0x404050, 0.5));
    const key = new THREE.DirectionalLight(0xFFF5E1, 2.0);
    key.position.set(6, 10, 8);
    key.castShadow = true;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xD0E0FF, 0.6);
    fill.position.set(-6, 4, 4);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xFFFFFF, 1.0);
    rim.position.set(0, 5, -10);
    this.scene.add(rim);
    const bottom = new THREE.DirectionalLight(0x8090A0, 0.25);
    bottom.position.set(0, -8, 4);
    this.scene.add(bottom);
  }

  // ────── SKELETON (unchanged — already looks fine) ──────
  _buildSkeleton() {
    const g = this.skeletonGroup;
    const bm = makeBoneMat();

    // Skull
    addPart(g, sphere(0.9), bm, [0, 7, 0], null, [0.85, 1, 0.9], 'Skull', 'head', 'skeleton');
    addPart(g, sphere(0.35), bm, [0, 6, 0.35], null, [1.2, 0.6, 0.8], 'Mandible', 'head', 'skeleton');

    // Spine — 24 vertebrae
    const vGeo = cyl(0.22, 0.22, 0.15);
    for (let i = 0; i < 24; i++) {
      const y = 5.5 - i * 0.24;
      const r = i < 7 ? 'neck' : (i < 19 ? 'upper_back' : 'lower_back');
      const s = 0.9 + i * 0.015;
      addPart(g, vGeo, bm, [0, y, -0.35], null, [s, 1, s], 'Vertebra', r, 'skeleton');
    }
    addPart(g, cyl(0.3, 0.15, 0.6), bm, [0, -0.6, -0.3], [0.15, 0, 0], null, 'Sacrum', 'lower_back', 'skeleton');

    // Sternum
    addPart(g, cyl(0.12, 0.1, 2.2), bm, [0, 3.3, 0.45], null, [1.5, 1, 0.5], 'Sternum', 'chest', 'skeleton');

    // Ribs — 12 pairs
    const ribWidths = [1.35, 1.5, 1.65, 1.75, 1.85, 1.95, 1.95, 1.85, 1.7, 1.5, 0.95, 0.75];
    for (let i = 0; i < 12; i++) {
      const y = 4.5 - i * 0.27;
      const w = ribWidths[i];
      for (const side of [1, -1]) {
        const pts = [
          new THREE.Vector3(0, y, -0.3),
          new THREE.Vector3(side * w * 0.45, y - 0.08, -0.25),
          new THREE.Vector3(side * w * 0.88, y, 0.05),
          new THREE.Vector3(side * w * 0.55, y + 0.08, 0.35),
        ];
        if (i < 10) pts.push(new THREE.Vector3(side * 0.2, y + 0.12, 0.45));
        const curve = new THREE.CatmullRomCurve3(pts);
        const ribGeo = new THREE.TubeGeometry(curve, 16, 0.055, 6, false);
        addPart(g, ribGeo, bm, [0, 0, 0], null, null, `Rib ${i + 1}`, 'chest', 'skeleton');
      }
    }

    // Clavicles
    for (const s of [1, -1]) {
      const pts = [new THREE.Vector3(0, 4.7, 0.3), new THREE.Vector3(s * 1.2, 4.8, 0.1), new THREE.Vector3(s * 2.0, 4.6, -0.1)];
      const crv = new THREE.CatmullRomCurve3(pts);
      addPart(g, new THREE.TubeGeometry(crv, 10, 0.07, 6), bm, [0, 0, 0], null, null, 'Clavicle', s > 0 ? 'right_shoulder' : 'left_shoulder', 'skeleton');
    }

    // Scapula
    for (const s of [1, -1]) {
      addPart(g, cyl(0.05, 0.5, 1.2), bm, [s * 1.5, 3.8, -0.55], [0, 0, s * 0.15], [1, 1, 3], 'Scapula', s > 0 ? 'right_shoulder' : 'left_shoulder', 'skeleton');
    }

    // Pelvis
    for (const s of [1, -1]) {
      addPart(g, sphere(0.9), bm, [s * 0.75, -1.2, 0], null, [1.2, 1, 0.55], 'Ilium', 'hip', 'skeleton');
    }
    addPart(g, cyl(0.3, 0.5, 0.5), bm, [0, -1.8, 0.1], null, [2.2, 1, 0.6], 'Pubis', 'hip', 'skeleton');

    // Arms
    for (const s of [1, -1]) {
      const sl = s > 0 ? 'right' : 'left';
      addPart(g, sphere(0.22), bm, [s * 2.15, 4.55, 0], null, null, 'Shoulder Joint', `${sl}_shoulder`, 'skeleton');
      addPart(g, capsule(0.12, 2.5), bm, [s * 2.3, 3, 0], [0, 0, s * 0.08], null, 'Humerus', `${sl}_upper_arm`, 'skeleton');
      addPart(g, sphere(0.16), bm, [s * 2.4, 1.5, 0], null, null, 'Elbow', `${sl}_elbow`, 'skeleton');
      addPart(g, capsule(0.08, 2.2), bm, [s * 2.5, -0.1, 0.08], [0, 0, s * 0.06], null, 'Radius', `${sl}_forearm`, 'skeleton');
      addPart(g, capsule(0.07, 2.3), bm, [s * 2.35, -0.1, -0.08], [0, 0, s * 0.06], null, 'Ulna', `${sl}_forearm`, 'skeleton');
      addPart(g, sphere(0.28), bm, [s * 2.6, -1.6, 0], null, [0.7, 1, 0.4], 'Hand Bones', `${sl}_hand`, 'skeleton');
    }

    // Legs
    for (const s of [1, -1]) {
      const sl = s > 0 ? 'right' : 'left';
      addPart(g, sphere(0.22), bm, [s * 1.05, -1.8, 0], null, null, 'Hip Joint', 'hip', 'skeleton');
      addPart(g, capsule(0.14, 3.5), bm, [s * 1.0, -3.8, 0], [0, 0, s * 0.02], null, 'Femur', `${sl}_thigh`, 'skeleton');
      addPart(g, sphere(0.16), bm, [s * 1.0, -5.65, 0.22], null, [1, 0.7, 0.6], 'Patella', `${sl}_knee`, 'skeleton');
      addPart(g, capsule(0.1, 3.0), bm, [s * 0.95, -7.2, 0.05], null, null, 'Tibia', `${sl}_lower_leg`, 'skeleton');
      addPart(g, capsule(0.06, 2.8), bm, [s * 1.15, -7.2, -0.05], null, null, 'Fibula', `${sl}_lower_leg`, 'skeleton');
      addPart(g, sphere(0.14), bm, [s * 1.0, -8.3, 0], null, null, 'Ankle', `${sl}_ankle`, 'skeleton');
      addPart(g, sphere(0.35), bm, [s * 1.0, -8.5, 0.35], null, [0.7, 0.35, 1.3], 'Foot Bones', `${sl}_foot`, 'skeleton');
    }
  }

  // ────── MUSCULAR SYSTEM — anatomically shaped ──────
  _buildMuscles() {
    const g = this.muscleGroup;
    const deep = 0x6B1818;
    const mid = 0x8B2020;
    const light = 0x9B3030;
    const tendMat = makeTendonMat();

    // ─── Neck: Sternocleidomastoid ───
    for (const s of [1, -1]) {
      const geo = muscleGeo(0.16, 1.4, 0.04, 0.7);
      addPart(g, geo, makeMuscleMat(mid), [s * 0.4, 5.5, 0.1], [0, 0, s * -0.15], null, 'Sternocleidomastoid', 'neck', 'muscular');
      // Tendon at each end
      addPart(g, cyl(0.04, 0.04, 0.2), tendMat, [s * 0.3, 6.15, 0.15], null, null, 'SCM Tendon', 'neck', 'muscular');
      addPart(g, cyl(0.04, 0.04, 0.2), tendMat, [s * 0.5, 4.85, 0.05], null, null, 'SCM Tendon', 'neck', 'muscular');
    }

    // ─── Trapezius (broad flat diamond shape) ───
    const trapGeo = muscleGeo(0.5, 2.6, 0.08, 0.25);
    addPart(g, trapGeo, makeMuscleMat(mid), [0, 4.2, -0.55], [0, 0, 0], [2.2, 1, 1], 'Trapezius', 'upper_back', 'muscular');

    // ─── Deltoids (3-headed shoulder cap) ───
    for (const s of [1, -1]) {
      const sl = s > 0 ? 'right' : 'left';
      // Anterior head
      addPart(g, muscleGeo(0.2, 0.8, 0.04, 0.7), makeMuscleMat(light),
        [s * 2.0, 4.35, 0.18], [0, 0, s * 0.3], null, 'Anterior Deltoid', `${sl}_shoulder`, 'muscular');
      // Lateral head
      addPart(g, muscleGeo(0.22, 0.9, 0.04, 0.8), makeMuscleMat(0xA03030),
        [s * 2.25, 4.4, 0], [0, 0, s * 0.2], null, 'Lateral Deltoid', `${sl}_shoulder`, 'muscular');
      // Posterior head
      addPart(g, muscleGeo(0.18, 0.75, 0.04, 0.7), makeMuscleMat(deep),
        [s * 2.0, 4.35, -0.18], [0, 0, s * 0.25], null, 'Posterior Deltoid', `${sl}_shoulder`, 'muscular');
    }

    // ─── Pectorals (fan-shaped) ───
    for (const s of [1, -1]) {
      const pecGeo = muscleGeo(0.38, 1.4, 0.06, 0.4);
      addPart(g, pecGeo, makeMuscleMat(mid),
        [s * 0.8, 3.7, 0.38], [0, s * 0.3, s * 0.15], [1.2, 1, 1], 'Pectoralis Major', 'chest', 'muscular');
      // Pec minor underneath
      addPart(g, muscleGeo(0.22, 0.9, 0.04, 0.35), makeMuscleMat(deep),
        [s * 0.7, 3.5, 0.25], [0, s * 0.2, s * 0.1], null, 'Pectoralis Minor', 'chest', 'muscular');
    }

    // ─── Serratus Anterior (rib-hugging fingers) ───
    for (const s of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        const y = 3.2 - i * 0.35;
        addPart(g, muscleGeo(0.12, 0.6, 0.03, 0.4), makeMuscleMat(deep),
          [s * 1.5, y, 0.0], [0, 0, s * 0.5], null, 'Serratus Anterior', 'chest', 'muscular');
      }
    }

    // ─── Rectus Abdominis (8-pack segments) ───
    for (let row = 0; row < 4; row++) {
      const y = 2.4 - row * 0.65;
      const w = 0.28 - row * 0.005;
      for (const s of [1, -1]) {
        const abGeo = muscleGeo(w, 0.35, 0.06, 0.45);
        addPart(g, abGeo, makeMuscleMat(mid),
          [s * 0.32, y, 0.4], null, [1, 1, 1], 'Rectus Abdominis', 'abdomen', 'muscular');
      }
      // Linea alba (white-line tendon strip between abs)
      addPart(g, cyl(0.02, 0.02, 0.5), tendMat, [0, y, 0.42], null, null, 'Linea Alba', 'abdomen', 'muscular');
    }

    // ─── External Obliques (angled, layered) ───
    for (const s of [1, -1]) {
      const oblGeo = muscleGeo(0.28, 2.0, 0.05, 0.35);
      addPart(g, oblGeo, makeMuscleMat(deep),
        [s * 1.2, 1.5, 0.15], [0, 0, s * 0.2], null, 'External Oblique', 'abdomen', 'muscular');
      // Internal oblique beneath
      addPart(g, muscleGeo(0.22, 1.6, 0.04, 0.3), makeMuscleMat(0x5A1212),
        [s * 1.05, 1.4, 0.08], [0, 0, s * 0.15], null, 'Internal Oblique', 'abdomen', 'muscular');
    }

    // ─── Latissimus Dorsi (wide back wings) ───
    for (const s of [1, -1]) {
      const latGeo = muscleGeo(0.45, 2.8, 0.06, 0.25);
      addPart(g, latGeo, makeMuscleMat(deep),
        [s * 1.3, 2.2, -0.42], [0, 0, s * 0.12], [1, 1.2, 1], 'Latissimus Dorsi', 'upper_back', 'muscular');
    }

    // ─── Erector Spinae (paired columns along spine) ───
    for (const s of [1, -1]) {
      // Iliocostalis
      addPart(g, muscleGeo(0.12, 3.0, 0.03), makeMuscleMat(deep),
        [s * 0.45, 1.5, -0.48], null, null, 'Iliocostalis', 'lower_back', 'muscular');
      // Longissimus
      addPart(g, muscleGeo(0.1, 2.8, 0.03), makeMuscleMat(0x5A1212),
        [s * 0.25, 1.2, -0.45], null, null, 'Longissimus', 'lower_back', 'muscular');
      // Spinalis
      addPart(g, muscleGeo(0.07, 2.4, 0.02), makeMuscleMat(0x4D1010),
        [s * 0.12, 1.0, -0.42], null, null, 'Spinalis', 'lower_back', 'muscular');
    }

    // ─── Rhomboids (between spine and scapula) ───
    for (const s of [1, -1]) {
      addPart(g, muscleGeo(0.25, 1.2, 0.04, 0.3), makeMuscleMat(deep),
        [s * 0.8, 4.0, -0.52], [0, 0, s * 0.1], null, 'Rhomboid', 'upper_back', 'muscular');
    }

    // ─── ARM MUSCLES ───
    for (const s of [1, -1]) {
      const sl = s > 0 ? 'right' : 'left';

      // Biceps Brachii — long head + short head
      addPart(g, muscleGeo(0.2, 1.9, 0.04, 0.85), makeMuscleMat(light),
        [s * 2.25, 3.05, 0.2], [0, 0, s * 0.08], null, 'Biceps (Long Head)', `${sl}_upper_arm`, 'muscular');
      addPart(g, muscleGeo(0.16, 1.6, 0.04, 0.8), makeMuscleMat(0xA53030),
        [s * 2.35, 3.1, 0.22], [0, 0, s * 0.08], null, 'Biceps (Short Head)', `${sl}_upper_arm`, 'muscular');
      // Biceps tendon
      addPart(g, cyl(0.03, 0.03, 0.4), tendMat,
        [s * 2.35, 1.9, 0.18], [0, 0, s * 0.08], null, 'Biceps Tendon', `${sl}_upper_arm`, 'muscular');

      // Triceps Brachii — 3 heads
      addPart(g, muscleGeo(0.18, 1.9, 0.04, 0.8), makeMuscleMat(mid),
        [s * 2.25, 2.95, -0.18], [0, 0, s * 0.08], null, 'Triceps (Long Head)', `${sl}_upper_arm`, 'muscular');
      addPart(g, muscleGeo(0.14, 1.4, 0.04, 0.75), makeMuscleMat(deep),
        [s * 2.35, 2.6, -0.2], [0, 0, s * 0.08], null, 'Triceps (Lateral Head)', `${sl}_upper_arm`, 'muscular');
      addPart(g, muscleGeo(0.12, 1.2, 0.04, 0.7), makeMuscleMat(0x5A1212),
        [s * 2.15, 2.7, -0.16], [0, 0, s * 0.08], null, 'Triceps (Medial Head)', `${sl}_upper_arm`, 'muscular');
      // Triceps tendon at elbow
      addPart(g, cyl(0.035, 0.025, 0.35), tendMat,
        [s * 2.35, 1.75, -0.16], [0, 0, s * 0.06], null, 'Triceps Tendon', `${sl}_upper_arm`, 'muscular');

      // Brachialis (deep under biceps)
      addPart(g, muscleGeo(0.15, 1.2, 0.04, 0.7), makeMuscleMat(deep),
        [s * 2.3, 2.5, 0.08], [0, 0, s * 0.08], null, 'Brachialis', `${sl}_upper_arm`, 'muscular');

      // Forearm flexor group (multiple bellies)
      addPart(g, muscleGeo(0.14, 1.6, 0.03, 0.75), makeMuscleMat(mid),
        [s * 2.48, 0.2, 0.1], [0, 0, s * 0.06], null, 'Flexor Carpi Radialis', `${sl}_forearm`, 'muscular');
      addPart(g, muscleGeo(0.12, 1.5, 0.03, 0.7), makeMuscleMat(light),
        [s * 2.55, 0.1, 0.05], [0, 0, s * 0.06], null, 'Palmaris Longus', `${sl}_forearm`, 'muscular');
      addPart(g, muscleGeo(0.13, 1.4, 0.03, 0.7), makeMuscleMat(mid),
        [s * 2.42, 0.15, 0.0], [0, 0, s * 0.06], null, 'Flexor Carpi Ulnaris', `${sl}_forearm`, 'muscular');

      // Forearm extensor group
      addPart(g, muscleGeo(0.12, 1.5, 0.03, 0.7), makeMuscleMat(deep),
        [s * 2.42, 0.1, -0.1], [0, 0, s * 0.06], null, 'Extensor Digitorum', `${sl}_forearm`, 'muscular');
      addPart(g, muscleGeo(0.1, 1.3, 0.03, 0.65), makeMuscleMat(0x5A1212),
        [s * 2.52, 0.0, -0.08], [0, 0, s * 0.06], null, 'Extensor Carpi Ulnaris', `${sl}_forearm`, 'muscular');

      // Brachioradialis
      addPart(g, muscleGeo(0.11, 1.8, 0.03, 0.65), makeMuscleMat(light),
        [s * 2.55, 0.5, 0.12], [0, 0, s * 0.07], null, 'Brachioradialis', `${sl}_forearm`, 'muscular');
    }

    // ─── Gluteus group ───
    for (const s of [1, -1]) {
      // Gluteus maximus
      addPart(g, muscleGeo(0.5, 1.4, 0.06, 0.7), makeMuscleMat(mid),
        [s * 0.75, -1.5, -0.35], [0.2, 0, 0], [1.1, 1, 1], 'Gluteus Maximus', 'hip', 'muscular');
      // Gluteus medius
      addPart(g, muscleGeo(0.35, 0.9, 0.05, 0.6), makeMuscleMat(deep),
        [s * 0.9, -0.9, -0.25], null, null, 'Gluteus Medius', 'hip', 'muscular');
    }

    // ─── LEG MUSCLES ───
    for (const s of [1, -1]) {
      const sl = s > 0 ? 'right' : 'left';

      // === QUADRICEPS (4 heads) ===
      // Rectus femoris (center front)
      addPart(g, muscleGeo(0.22, 2.8, 0.04, 0.8), makeMuscleMat(light),
        [s * 1.0, -3.5, 0.28], null, null, 'Rectus Femoris', `${sl}_thigh`, 'muscular');
      // Vastus lateralis (outer)
      addPart(g, muscleGeo(0.2, 2.4, 0.04, 0.75), makeMuscleMat(mid),
        [s * 1.25, -3.8, 0.12], null, null, 'Vastus Lateralis', `${sl}_thigh`, 'muscular');
      // Vastus medialis (inner, teardrop near knee)
      addPart(g, muscleGeo(0.18, 1.8, 0.04, 0.7), makeMuscleMat(mid),
        [s * 0.82, -4.2, 0.18], null, null, 'Vastus Medialis', `${sl}_thigh`, 'muscular');
      // Vastus intermedius (deep, under rectus)
      addPart(g, muscleGeo(0.18, 2.2, 0.04, 0.75), makeMuscleMat(deep),
        [s * 1.0, -3.6, 0.15], null, null, 'Vastus Intermedius', `${sl}_thigh`, 'muscular');
      // Quadriceps tendon → patellar tendon
      addPart(g, cyl(0.04, 0.03, 0.5), tendMat,
        [s * 1.0, -5.2, 0.24], null, null, 'Patellar Tendon', `${sl}_knee`, 'muscular');

      // === HAMSTRINGS (3 muscles) ===
      // Biceps femoris (outer back)
      addPart(g, muscleGeo(0.18, 2.6, 0.04, 0.75), makeMuscleMat(mid),
        [s * 1.15, -3.6, -0.22], null, null, 'Biceps Femoris', `${sl}_thigh`, 'muscular');
      // Semitendinosus (inner back)
      addPart(g, muscleGeo(0.14, 2.8, 0.03, 0.6), makeMuscleMat(deep),
        [s * 0.85, -3.5, -0.2], null, null, 'Semitendinosus', `${sl}_thigh`, 'muscular');
      // Semimembranosus (deep inner)
      addPart(g, muscleGeo(0.16, 2.4, 0.04, 0.65), makeMuscleMat(0x5A1212),
        [s * 0.85, -3.7, -0.28], null, null, 'Semimembranosus', `${sl}_thigh`, 'muscular');

      // Adductor group
      addPart(g, muscleGeo(0.18, 2.2, 0.04, 0.6), makeMuscleMat(deep),
        [s * 0.72, -3.0, 0.0], null, null, 'Adductor Magnus', `${sl}_thigh`, 'muscular');
      addPart(g, muscleGeo(0.12, 1.5, 0.03, 0.55), makeMuscleMat(0x5A1212),
        [s * 0.68, -2.7, 0.05], null, null, 'Adductor Longus', `${sl}_thigh`, 'muscular');

      // Sartorius (longest muscle, diagonal)
      const sartPts = [
        new THREE.Vector3(s * 1.1, -2.0, 0.2),
        new THREE.Vector3(s * 1.0, -3.0, 0.25),
        new THREE.Vector3(s * 0.85, -4.5, 0.1),
        new THREE.Vector3(s * 0.8, -5.3, -0.05),
      ];
      const sartCurve = new THREE.CatmullRomCurve3(sartPts);
      const sartGeo = new THREE.TubeGeometry(sartCurve, 20, 0.06, 8, false);
      addPart(g, sartGeo, makeMuscleMat(light), [0, 0, 0], null, null, 'Sartorius', `${sl}_thigh`, 'muscular');

      // IT Band (connective tissue strip)
      const itPts = [
        new THREE.Vector3(s * 1.25, -1.8, 0.0),
        new THREE.Vector3(s * 1.3, -3.5, 0.05),
        new THREE.Vector3(s * 1.2, -5.5, 0.1),
      ];
      const itCurve = new THREE.CatmullRomCurve3(itPts);
      addPart(g, new THREE.TubeGeometry(itCurve, 12, 0.03, 6, false), tendMat,
        [0, 0, 0], null, null, 'IT Band', `${sl}_thigh`, 'muscular');

      // === CALF MUSCLES ===
      // Gastrocnemius medial head
      addPart(g, muscleGeo(0.18, 1.6, 0.04, 0.85), makeMuscleMat(light),
        [s * 0.92, -6.7, -0.1], null, null, 'Gastrocnemius (Medial)', `${sl}_lower_leg`, 'muscular');
      // Gastrocnemius lateral head
      addPart(g, muscleGeo(0.16, 1.4, 0.04, 0.8), makeMuscleMat(light),
        [s * 1.1, -6.7, -0.12], null, null, 'Gastrocnemius (Lateral)', `${sl}_lower_leg`, 'muscular');
      // Soleus (deep, wider)
      addPart(g, muscleGeo(0.18, 1.8, 0.04, 0.7), makeMuscleMat(deep),
        [s * 1.0, -7.1, -0.06], null, null, 'Soleus', `${sl}_lower_leg`, 'muscular');
      // Achilles tendon
      const achilPts = [
        new THREE.Vector3(s * 1.0, -7.8, -0.1),
        new THREE.Vector3(s * 1.0, -8.3, -0.08),
        new THREE.Vector3(s * 1.0, -8.5, 0.0),
      ];
      addPart(g, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(achilPts), 8, 0.035, 6, false), tendMat,
        [0, 0, 0], null, null, 'Achilles Tendon', `${sl}_lower_leg`, 'muscular');

      // Tibialis Anterior (shin)
      addPart(g, muscleGeo(0.12, 1.8, 0.03, 0.7), makeMuscleMat(mid),
        [s * 0.85, -6.7, 0.18], null, null, 'Tibialis Anterior', `${sl}_lower_leg`, 'muscular');

      // Peroneus (outer calf)
      addPart(g, muscleGeo(0.1, 1.5, 0.03, 0.65), makeMuscleMat(deep),
        [s * 1.15, -7.0, 0.05], null, null, 'Peroneus Longus', `${sl}_lower_leg`, 'muscular');
    }
  }

  // ────── VESSELS (veins and arteries) ──────
  _buildVessels() {
    const g = this.vesselGroup;
    const vMat = makeVeinMat();
    const aMat = makeArteryMat();

    // Aorta (main artery down trunk)
    const aortaPts = [
      new THREE.Vector3(0, 5.5, -0.2),
      new THREE.Vector3(0.05, 4.0, -0.15),
      new THREE.Vector3(0.05, 2.5, -0.1),
      new THREE.Vector3(0.05, 1.0, -0.15),
      new THREE.Vector3(0, -0.5, -0.2),
    ];
    addPart(g, vesselGeo(aortaPts, 0.05), aMat, [0, 0, 0], null, null, 'Aorta', 'chest', 'vascular');

    // Superior vena cava
    const svcPts = [
      new THREE.Vector3(0.15, 5.5, -0.1),
      new THREE.Vector3(0.15, 4.5, -0.05),
      new THREE.Vector3(0.12, 3.8, -0.08),
    ];
    addPart(g, vesselGeo(svcPts, 0.04), vMat, [0, 0, 0], null, null, 'Superior Vena Cava', 'chest', 'vascular');

    // Arm vessels
    for (const s of [1, -1]) {
      const sl = s > 0 ? 'right' : 'left';
      // Brachial artery
      const brachPts = [
        new THREE.Vector3(s * 2.1, 4.3, 0.05),
        new THREE.Vector3(s * 2.25, 3.0, 0.08),
        new THREE.Vector3(s * 2.35, 1.7, 0.05),
        new THREE.Vector3(s * 2.45, 0.5, 0.06),
      ];
      addPart(g, vesselGeo(brachPts, 0.025), aMat, [0, 0, 0], null, null, 'Brachial Artery', `${sl}_upper_arm`, 'vascular');

      // Basilic vein (visible surface vein)
      const basVPts = [
        new THREE.Vector3(s * 2.15, 4.1, 0.15),
        new THREE.Vector3(s * 2.3, 3.2, 0.2),
        new THREE.Vector3(s * 2.4, 1.8, 0.15),
        new THREE.Vector3(s * 2.5, 0.8, 0.12),
        new THREE.Vector3(s * 2.55, -0.5, 0.1),
      ];
      addPart(g, vesselGeo(basVPts, 0.02), vMat, [0, 0, 0], null, null, 'Basilic Vein', `${sl}_upper_arm`, 'vascular');

      // Cephalic vein
      const cephPts = [
        new THREE.Vector3(s * 2.3, 4.3, 0.12),
        new THREE.Vector3(s * 2.45, 3.0, 0.18),
        new THREE.Vector3(s * 2.55, 1.5, 0.14),
        new THREE.Vector3(s * 2.6, 0.0, 0.1),
      ];
      addPart(g, vesselGeo(cephPts, 0.018), vMat, [0, 0, 0], null, null, 'Cephalic Vein', `${sl}_forearm`, 'vascular');

      // Femoral artery + vein
      const femAPts = [
        new THREE.Vector3(s * 0.85, -1.5, 0.1),
        new THREE.Vector3(s * 0.9, -3.0, 0.12),
        new THREE.Vector3(s * 0.95, -5.0, 0.08),
      ];
      addPart(g, vesselGeo(femAPts, 0.03), aMat, [0, 0, 0], null, null, 'Femoral Artery', `${sl}_thigh`, 'vascular');

      const femVPts = [
        new THREE.Vector3(s * 0.8, -1.5, 0.05),
        new THREE.Vector3(s * 0.85, -3.0, 0.06),
        new THREE.Vector3(s * 0.9, -5.0, 0.04),
      ];
      addPart(g, vesselGeo(femVPts, 0.025), vMat, [0, 0, 0], null, null, 'Femoral Vein', `${sl}_thigh`, 'vascular');

      // Great saphenous vein (visible leg vein)
      const gsvPts = [
        new THREE.Vector3(s * 0.82, -5.5, 0.15),
        new THREE.Vector3(s * 0.85, -6.5, 0.18),
        new THREE.Vector3(s * 0.88, -7.5, 0.15),
        new THREE.Vector3(s * 0.9, -8.2, 0.1),
      ];
      addPart(g, vesselGeo(gsvPts, 0.018), vMat, [0, 0, 0], null, null, 'Great Saphenous Vein', `${sl}_lower_leg`, 'vascular');
    }
  }

  // ────── INTERACTION ──────
  _setupInteraction() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    canvas.addEventListener('click', (e) => this._onClick(e));
    canvas.style.cursor = 'grab';
  }

  _getIntersects(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = [];
    this.scene.traverse(c => { if (c.isMesh && c.userData.region) meshes.push(c); });
    return this.raycaster.intersectObjects(meshes, false);
  }

  _onMouseMove(e) {
    const hits = this._getIntersects(e);
    if (this.hoveredMesh && this.hoveredMesh !== this._selectedMesh) {
      if (!this.highlighted.includes(this.hoveredMesh)) {
        this.hoveredMesh.material.emissive.set(0x000000);
        this.hoveredMesh.material.emissiveIntensity = 0;
      }
    }
    if (hits.length > 0) {
      const mesh = hits[0].object;
      if (mesh.visible) {
        this.hoveredMesh = mesh;
        if (!this.highlighted.includes(mesh)) {
          mesh.material.emissive.set(0x334455);
          mesh.material.emissiveIntensity = 0.3;
        }
        this.renderer.domElement.style.cursor = 'pointer';
        if (this._onHoverCb) this._onHoverCb(mesh.userData);
      }
    } else {
      this.hoveredMesh = null;
      this.renderer.domElement.style.cursor = 'grab';
      if (this._onHoverCb) this._onHoverCb(null);
    }
  }

  _onClick(e) {
    const hits = this._getIntersects(e);
    if (hits.length > 0) {
      const mesh = hits[0].object;
      if (mesh.visible && this.onSelectCb) {
        this.onSelectCb(mesh.userData);
      }
    }
  }

  // ────── PUBLIC API ──────
  setLayer(layer) {
    this._currentLayer = layer;
    this.skeletonGroup.visible = (layer === 'skeleton' || layer === 'all');
    this.muscleGroup.visible = (layer === 'muscular' || layer === 'all');
    this.vesselGroup.visible = (layer === 'vascular' || layer === 'all');
    if (layer === 'all') {
      this.muscleGroup.traverse(c => {
        if (c.isMesh) { c.material.transparent = true; c.material.opacity = 0.7; }
      });
      this.vesselGroup.traverse(c => {
        if (c.isMesh) { c.material.transparent = true; c.material.opacity = 0.55; }
      });
    } else {
      this.muscleGroup.traverse(c => {
        if (c.isMesh) { c.material.transparent = false; c.material.opacity = 1.0; }
      });
      this.vesselGroup.traverse(c => {
        if (c.isMesh) { c.material.transparent = false; c.material.opacity = 1.0; }
      });
    }
  }

  highlight(regionIds) {
    this.clearHighlight();
    if (!regionIds || regionIds.length === 0) return;
    this.scene.traverse(c => {
      if (c.isMesh && c.userData.region && regionIds.includes(c.userData.region)) {
        c.material.emissive.set(0x38BDF8);
        c.material.emissiveIntensity = 0.6;
        this.highlighted.push(c);
      }
    });
  }

  clearHighlight() {
    this.highlighted.forEach(m => {
      m.material.emissive.set(0x000000);
      m.material.emissiveIntensity = 0;
    });
    this.highlighted = [];
  }

  focusRegion(regionId) {
    const positions = [];
    this.scene.traverse(c => {
      if (c.isMesh && c.userData.region === regionId) {
        const wp = new THREE.Vector3();
        c.getWorldPosition(wp);
        positions.push(wp);
      }
    });
    if (positions.length === 0) return;
    const center = new THREE.Vector3();
    positions.forEach(p => center.add(p));
    center.divideScalar(positions.length);
    this.controls.target.copy(center);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(center.clone().add(dir.multiplyScalar(8)));
  }

  onSelect(cb) { this.onSelectCb = cb; }
  onHover(cb) { this._onHoverCb = cb; }

  resize() {
    const W = this.container.clientWidth, H = this.container.clientHeight;
    if (W === 0 || H === 0) return;
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(W, H);
  }

  _animate() {
    if (this._disposed) return;
    this._animId = requestAnimationFrame(() => this._animate());
    const t = performance.now() * 0.001;
    this.highlighted.forEach(m => {
      m.material.emissiveIntensity = 0.4 + Math.sin(t * 2.5) * 0.25;
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._disposed = true;
    if (this._animId) cancelAnimationFrame(this._animId);
    if (this._resizeObs) this._resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.scene.traverse(c => {
      if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
    });
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}

window.AnatomyViewer = AnatomyViewer;
