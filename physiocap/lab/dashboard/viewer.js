// PhysioCap Lab 3D 뷰어 — OpenCap VisualizerJson(분절별 지면 좌표 위치·회전) + OpenSim 뼈 메시 재생
// 추가: 동역학 결과가 있으면 압력중심(COP)에 지면반력(GRF) 화살표, 그래프와 시간 동기화
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// OpenSim 모델(LaiUhlrich2022)의 분절 연결 — 메시가 없을 때 선 골격으로 그리기 위함
const PARENT = {
  femur_r: 'pelvis', tibia_r: 'femur_r', talus_r: 'tibia_r', calcn_r: 'talus_r', toes_r: 'calcn_r',
  femur_l: 'pelvis', tibia_l: 'femur_l', talus_l: 'tibia_l', calcn_l: 'talus_l', toes_l: 'calcn_l',
  torso: 'pelvis', humerus_r: 'torso', ulna_r: 'humerus_r', radius_r: 'ulna_r', hand_r: 'radius_r',
  humerus_l: 'torso', ulna_l: 'humerus_l', radius_l: 'ulna_l', hand_l: 'radius_l',
};
const meshCache = new Map();

async function loadMesh(base, name) {
  if (!meshCache.has(name)) {
    meshCache.set(name, fetch(base + encodeURIComponent(name)).then((r) => (r.ok ? r.json() : null)).then((m) => {
      if (!m || !m.positions?.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
      g.setIndex(m.indices);
      g.computeVertexNormals();
      return g;
    }).catch(() => null));
  }
  return meshCache.get(name);
}

const parseList = (v) => (typeof v === 'string' ? JSON.parse(v.replace(/'/g, '"')) : v);

export class Viewer {
  constructor(el, { meshBase = '/api/geometry/', onTime = null } = {}) {
    this.el = el;
    this.meshBase = meshBase;
    this.onTime = onTime;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    this.scene.background = new THREE.Color(dark ? 0x10151b : 0xf2f4f7);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.camera.position.set(3, 1.5, 3);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.9, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 6, 4);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(10, 20, dark ? 0x4a5563 : 0x9aa5b1, dark ? 0x27303a : 0xd5dbe1);
    this.scene.add(grid);
    this.boneMat = new THREE.MeshStandardMaterial({ color: 0xeee8d5, roughness: 0.75, metalness: 0.0 });
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.frame = 0; this.playing = false; this.speed = 1; this.lastTs = 0; this.follow = false;
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = (ts) => { this.tick(ts); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  resize() {
    const w = this.el.clientWidth || 600, h = this.el.clientHeight || 400;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async load(vis, kinetics = null) {
    this.clear();
    this.vis = vis;
    this.time = vis.time;
    this.bodies = {};
    let meshCount = 0, missing = 0;
    const jobs = [];
    for (const [name, b] of Object.entries(vis.bodies)) {
      const g = new THREE.Group();
      g.name = name;
      this.root.add(g);
      this.bodies[name] = { group: g, rot: b.rotation, tr: b.translation };
      const scale = parseList(b.scaleFactors) || [1, 1, 1];
      for (const mname of parseList(b.attachedGeometries) || []) {
        jobs.push(loadMesh(this.meshBase, mname).then((geo) => {
          if (!geo) { missing++; return; }
          const m = new THREE.Mesh(geo, this.boneMat);
          m.scale.set(scale[0], scale[1], scale[2]);
          g.add(m);
          meshCount++;
        }));
      }
    }
    await Promise.all(jobs);
    // 선 골격(메시가 없으면 주 표시, 있으면 숨김 가능)
    const n = Object.keys(PARENT).filter((k) => this.bodies[k] && this.bodies[PARENT[k]]).length;
    this.linePos = new Float32Array(n * 6);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x2dd4bf }));
    this.lines.visible = meshCount === 0;
    this.root.add(this.lines);
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.018, 10, 8), new THREE.MeshStandardMaterial({ color: 0x2dd4bf }), Object.keys(this.bodies).length);
    this.joints.visible = meshCount === 0;
    this.root.add(this.joints);
    this.meshInfo = { meshCount, missing };
    this.setupForces(kinetics);
    this.setFrame(0);
    this.frameView('front');
    return this.meshInfo;
  }

  // 동역학 요약의 GRF(체중 배수로 정규화) + COP → 발밑 화살표
  setupForces(kin) {
    this.forces = [];
    if (!kin?.series) return;
    const grf = kin.series.GRF_BW || kin.series.GRF, cop = kin.series.COP;
    if (!grf || !cop) return;
    const toBW = kin.series.GRF_BW ? 1 / 100 : null; // GRF_BW 는 % 체중
    const sides = new Set(grf.labels.map((l) => (l.match(/ground_force_(\w+)_v[xyz]/) || [])[1]).filter(Boolean));
    for (const side of sides) {
      const g = (a) => grf.data[`ground_force_${side}_v${a}`], c = (a) => cop.data[`ground_force_${side}_p${a}`];
      if (!g('x') || !c('x')) continue;
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, side.startsWith('r') ? 0xf72585 : 0x4cc9f0, 0.08, 0.05);
      arrow.visible = false;
      this.root.add(arrow);
      this.forces.push({ arrow, t: kin.time, gx: g('x'), gy: g('y'), gz: g('z'), cx: c('x'), cy: c('y'), cz: c('z'), scale: toBW ?? 1 / 1000 });
    }
  }

  clear() {
    while (this.root.children.length) this.root.remove(this.root.children[0]);
    this.forces = [];
  }

  setFrame(i) {
    if (!this.time) return;
    i = Math.max(0, Math.min(this.time.length - 1, i | 0));
    this.frame = i;
    const tmp = new THREE.Object3D();
    let j = 0;
    for (const b of Object.values(this.bodies)) {
      const t = b.tr[i], r = b.rot[i];
      b.group.position.set(t[0], t[1], t[2]);
      b.group.rotation.set(r[0], r[1], r[2], 'XYZ'); // OpenSim body-fixed XYZ
      tmp.position.set(t[0], t[1], t[2]);
      tmp.updateMatrix();
      this.joints?.setMatrixAt(j++, tmp.matrix);
    }
    if (this.joints) this.joints.instanceMatrix.needsUpdate = true;
    if (this.lines) {
      let k = 0;
      for (const [c, p] of Object.entries(PARENT)) {
        const a = this.bodies[c], b = this.bodies[p];
        if (!a || !b) continue;
        this.linePos.set([...b.tr[i], ...a.tr[i]], k);
        k += 6;
      }
      this.lines.geometry.attributes.position.needsUpdate = true;
    }
    const now = this.time[i];
    for (const f of this.forces) {
      const k = nearest(f.t, now);
      const inRange = now >= f.t[0] - 1e-6 && now <= f.t[f.t.length - 1] + 1e-6;
      const v = new THREE.Vector3(f.gx[k], f.gy[k], f.gz[k]);
      const len = v.length() * f.scale;
      f.arrow.visible = inRange && len > 0.02;
      if (f.arrow.visible) {
        f.arrow.position.set(f.cx[k], f.cy[k], f.cz[k]);
        f.arrow.setDirection(v.normalize());
        f.arrow.setLength(len, Math.min(0.1, len * 0.3), 0.05);
      }
    }
    if (this.follow && this.bodies.pelvis) {
      const p = this.bodies.pelvis.tr[i];
      const d = new THREE.Vector3(p[0], p[1], p[2]).sub(this.controls.target);
      this.controls.target.add(d);
      this.camera.position.add(d);
    }
    this.onTime?.(now, i);
  }

  // 정면·측면·위: 첫 프레임 골반의 전방(X축) 방향 기준
  frameView(kind) {
    const pel = this.bodies?.pelvis;
    if (!pel) return;
    const i = this.frame, t = pel.tr[i];
    const q = new THREE.Euler(...pel.rot[i], 'XYZ');
    const fwd = new THREE.Vector3(1, 0, 0).applyEuler(q); fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3(0, 0, 1).applyEuler(q); right.y = 0; right.normalize();
    const target = new THREE.Vector3(t[0], Math.max(0.8, t[1]), t[2]);
    const dist = 3.8;
    const pos = kind === 'side' ? target.clone().addScaledVector(right, dist)
      : kind === 'top' ? target.clone().add(new THREE.Vector3(0, dist + 1, 0.001))
      : target.clone().addScaledVector(fwd, dist);
    if (kind !== 'top') pos.y += 0.3;
    this.controls.target.copy(target);
    this.camera.position.copy(pos);
    this.controls.update();
  }

  play(on = !this.playing) { this.playing = on; this.lastTs = 0; return on; }

  tick(ts) {
    if (this.playing && this.time) {
      if (this.lastTs) {
        const dt = (ts - this.lastTs) / 1000 * this.speed;
        const target = this.time[this.frame] + dt;
        let i = this.frame;
        while (i < this.time.length - 1 && this.time[i + 1] <= target) i++;
        if (i === this.time.length - 1 && this.frame === i) i = 0; // 반복 재생
        if (i !== this.frame) this.setFrame(i);
      }
      this.lastTs = ts;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  seekTime(sec) { if (this.time) this.setFrame(nearest(this.time, sec)); }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.el.innerHTML = '';
  }
}

function nearest(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(arr[lo - 1] - v) < Math.abs(arr[lo] - v)) lo--;
  return lo;
}

window.PhysioViewer = { Viewer };
window.dispatchEvent(new Event('physioviewer-ready'));
