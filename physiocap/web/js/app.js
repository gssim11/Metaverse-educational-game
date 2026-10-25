import { ANGLES, PROTOCOLS, LM, computeAngles, OneEuro, analyze, toCSV, landmarksCSV, toTRC } from './analysis.js';
import { createPose, toFrame } from './pose.js';
import { LineChart, PALETTE } from './chart.js';
import { saveSession, listSessions, getSession, deleteSession } from './store.js';

const $ = (s) => document.querySelector(s);
const isAndroidApp = !!window.AndroidBridge;

// ---------- 설정 ----------
const DEFAULTS = { model: 'full', height: '', countdown: '3', fps: '30', cutoff: '6', voice: true, protocol: 'squat' };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('physiocap.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function storeSettings() {
  try { localStorage.setItem('physiocap.settings', JSON.stringify(settings)); } catch { /* 저장 불가 환경 */ }
}
const settings = loadSettings();
const heightM = () => (Number(settings.height) > 0 ? Number(settings.height) / 100 : 0);
const analyzeOpts = () => ({ fs: 30, cutoff: Number(settings.cutoff) || 6, heightM: heightM() });

const ICONS = { squat: '🏋', sts: '🪑', gait: '🚶', balance: '🦩', rom: '📐', free: '✳' };
const LIVE_KEYS = {
  squat: ['kneeFlexL', 'kneeFlexR', 'hipFlexL', 'hipFlexR', 'fppaL', 'fppaR', 'trunkLean'],
  sts: ['kneeFlexL', 'kneeFlexR', 'hipFlexL', 'trunkLean'],
  gait: ['kneeFlexL', 'kneeFlexR', 'hipFlexL', 'hipFlexR', 'ankleDfL', 'ankleDfR'],
  balance: ['pelvicObliq', 'trunkLateral', 'kneeFlexL', 'kneeFlexR'],
  rom: ['shoulderElevL', 'shoulderElevR', 'elbowFlexL', 'elbowFlexR', 'hipFlexL', 'kneeFlexL'],
  free: ['kneeFlexL', 'kneeFlexR', 'hipFlexL', 'hipFlexR', 'trunkLean'],
};
const CHART_KEYS = {
  squat: ['kneeFlexL', 'kneeFlexR', 'hipFlexL', 'fppaL', 'fppaR'],
  sts: ['kneeFlexL', 'hipFlexL', 'trunkLean'],
  gait: ['kneeFlexL', 'kneeFlexR', 'hipFlexL', 'hipFlexR'],
  balance: ['pelvicObliq', 'trunkLateral'],
  rom: ['shoulderElevL', 'shoulderElevR', 'elbowFlexL', 'kneeFlexL'],
  free: ['kneeFlexL', 'kneeFlexR', 'hipFlexL', 'hipFlexR'],
};
const SHORT = {
  kneeFlexL: '무릎L', kneeFlexR: '무릎R', hipFlexL: '고관절L', hipFlexR: '고관절R', ankleDfL: '발목L', ankleDfR: '발목R',
  fppaL: 'FPPA L', fppaR: 'FPPA R', trunkLean: '체간', trunkLateral: '체간측방', pelvicObliq: '골반경사',
  shoulderElevL: '어깨L', shoulderElevR: '어깨R', elbowFlexL: '팔꿈치L', elbowFlexR: '팔꿈치R',
};

// ---------- 공통 UI ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}
let toastT;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), ms);
}
function speak(text) {
  if (!settings.voice) return;
  if (window.AndroidBridge?.speak) { try { window.AndroidBridge.speak(text); } catch { /* 무시 */ } return; }
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR'; u.rate = 1.1;
    speechSynthesis.speak(u);
  } catch { /* 음성 미지원 */ }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '–') : String(v ?? '–'));
const KOR_NUM = ['영', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];

// ---------- 포즈 엔진 ----------
let pose = null;
let poseModel = null;
let lastTs = 0;
const nextTs = (ms) => (lastTs = Math.max(lastTs + 1, Math.round(ms)));
async function ensurePose(status = () => {}) {
  if (pose && poseModel === settings.model) return pose;
  if (pose) { try { pose.landmarker.close(); } catch { /* 무시 */ } }
  pose = await createPose({ model: settings.model, onStatus: status });
  poseModel = settings.model;
  return pose;
}

// ---------- 그리기 ----------
const SIDE_COLOR = (i) => (i === 0 || (i >= 1 && i <= 10) ? '#ffffff' : i % 2 === 1 ? '#4cc9f0' : '#f72585'); // 홀수=왼쪽
function drawSkeleton(ctx, lm, w, h, { angles = null, scale = 1 } = {}) {
  if (!lm) return;
  const conns = pose?.connections || [];
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, 3 * scale);
  for (const c of conns) {
    const a = lm[c.start], b = lm[c.end];
    if (!a || !b || (a.visibility ?? 1) < 0.4 || (b.visibility ?? 1) < 0.4) continue;
    ctx.strokeStyle = c.start % 2 === 1 && c.end % 2 === 1 ? '#4cc9f0cc' : c.start % 2 === 0 && c.end % 2 === 0 && c.start > 10 ? '#f72585cc' : '#ffffffaa';
    ctx.beginPath(); ctx.moveTo(a.x * w, a.y * h); ctx.lineTo(b.x * w, b.y * h); ctx.stroke();
  }
  for (let i = 11; i < 33; i++) {
    const p = lm[i];
    if (!p || (p.visibility ?? 1) < 0.4) continue;
    ctx.fillStyle = SIDE_COLOR(i);
    ctx.beginPath(); ctx.arc(p.x * w, p.y * h, Math.max(3, 4.5 * scale), 0, Math.PI * 2); ctx.fill();
  }
  if (angles) {
    const tag = (i, v) => {
      const p = lm[i];
      if (!p || !Number.isFinite(v) || (p.visibility ?? 1) < 0.5) return;
      const txt = Math.round(v) + '°';
      const fs = Math.max(13, 16 * scale);
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      const tw = ctx.measureText(txt).width;
      const x = p.x * w + 10 * scale, y = p.y * h - 8 * scale;
      ctx.fillStyle = '#000b';
      ctx.fillRect(x - 4, y - fs, tw + 8, fs + 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, x, y);
    };
    tag(LM.lKnee, angles.kneeFlexL); tag(LM.rKnee, angles.kneeFlexR);
    tag(LM.lHip, angles.hipFlexL); tag(LM.rHip, angles.hipFlexR);
    tag(LM.lElbow, angles.elbowFlexL); tag(LM.rElbow, angles.elbowFlexR);
  }
}

// ---------- 홈 ----------
function renderHome() {
  const grid = $('#protocolGrid');
  grid.innerHTML = '';
  for (const [key, p] of Object.entries(PROTOCOLS)) {
    const b = document.createElement('button');
    b.className = 'card' + (settings.protocol === key ? ' sel' : '');
    b.innerHTML = `<span class="ico">${ICONS[key]}</span><b>${esc(p.name)}</b><span>${esc(p.view)} 촬영</span>`;
    b.addEventListener('click', () => { settings.protocol = key; storeSettings(); openCapture(key); });
    grid.appendChild(b);
  }
  renderHistory();
}

async function renderHistory() {
  const box = $('#history');
  const items = await listSessions();
  if (!items.length) { box.innerHTML = '<p class="empty">아직 기록이 없습니다.</p>'; return; }
  box.innerHTML = '';
  for (const s of items.slice(0, 50)) {
    const d = new Date(s.date);
    const key = s.result?.metrics?.[0];
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="grow"><b>${esc(s.result?.protocolName || s.protocol)}</b><span>${d.toLocaleString('ko-KR')} · ${esc(s.result?.duration ?? '')}s${key ? ' · ' + esc(key.label) + ' ' + esc(fmt(key.value)) + esc(key.unit || '') : ''}</span></div><button aria-label="삭제">🗑</button>`;
    el.querySelector('.grow').addEventListener('click', () => openSession(s.id));
    el.querySelector('button').addEventListener('click', async () => {
      if (!confirm('이 기록을 삭제할까요?')) return;
      await deleteSession(s.id);
      renderHistory();
    });
    box.appendChild(el);
  }
}

// ---------- 실시간 촬영 ----------
const cap = {
  protocol: 'squat', stream: null, facing: 'environment', running: false, recording: false,
  frames: [], t0: 0, recorder: null, chunks: [], filters: {}, reps: 0, phase: 'up', lastVT: -1, timerRAF: 0,
};

async function openCapture(protocol) {
  cap.protocol = protocol;
  const p = PROTOCOLS[protocol];
  $('#capTitle').textContent = p.name;
  $('#capHint').textContent = p.hint;
  $('#stsMode').hidden = protocol !== 'sts';
  $('#liveCounter').hidden = !(protocol === 'squat' || protocol === 'sts');
  $('#liveCounter').textContent = '0';
  $('#recTimer').textContent = '0.0s';
  show('capture');
  try {
    await startCamera();
    await ensurePose((m) => ($('#capStatus').textContent = m));
    $('#capStatus').textContent = pose.delegate === 'GPU' ? 'GPU' : 'CPU';
    cap.running = true;
    requestAnimationFrame(liveLoop);
  } catch (e) {
    console.error(e);
    $('#capStatus').textContent = '오류';
    toast(cameraErrorText(e), 5000);
  }
}

function cameraErrorText(e) {
  if (e?.name === 'NotAllowedError') return '카메라 권한이 거부되었습니다. 설정에서 카메라 권한을 허용해 주세요.';
  if (e?.name === 'NotFoundError') return '사용 가능한 카메라가 없습니다.';
  return '시작 실패: ' + (e?.message || e);
}

async function startCamera() {
  stopCamera();
  const v = $('#liveVideo');
  cap.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: cap.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  v.srcObject = cap.stream;
  await v.play();
}

function stopCamera() {
  cap.stream?.getTracks().forEach((t) => t.stop());
  cap.stream = null;
}

function closeCapture() {
  cap.running = false;
  if (cap.recording) stopRecording(false);
  stopCamera();
}

function liveLoop() {
  if (!cap.running) return;
  const v = $('#liveVideo');
  const c = $('#liveCanvas');
  if (v.readyState >= 2 && v.videoWidth && v.currentTime !== cap.lastVT && pose) {
    cap.lastVT = v.currentTime;
    const w = v.videoWidth, h = v.videoHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, w, h);
    const now = performance.now();
    let res = null;
    try { res = pose.landmarker.detectForVideo(v, nextTs(now)); } catch (e) { console.warn(e); }
    const fr = toFrame(res, (now - cap.t0) / 1000, w, h);
    let ang = null;
    if (fr.lm) {
      ang = computeAngles(fr);
      for (const k in ang) {
        cap.filters[k] ||= new OneEuro();
        ang[k] = cap.filters[k].filter(ang[k], now / 1000);
      }
    }
    drawSkeleton(ctx, fr.lm, w, h, { angles: ang, scale: w / 720 });
    if (!fr.lm) {
      ctx.fillStyle = '#000a'; ctx.fillRect(0, h / 2 - 30, w, 60);
      ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.round(w / 32)}px system-ui`; ctx.textAlign = 'center';
      ctx.fillText('사람이 보이지 않습니다 — 전신이 화면에 들어오게 해 주세요', w / 2, h / 2 + 8);
      ctx.textAlign = 'start';
    }
    if (cap.recording) cap.frames.push(fr);
    updateChips(ang);
    if (ang) liveCount(ang);
  }
  requestAnimationFrame(liveLoop);
}

function updateChips(ang) {
  const box = $('#liveChips');
  const keys = LIVE_KEYS[cap.protocol];
  if (box.childElementCount !== keys.length) box.innerHTML = keys.map((k) => `<span class="chip" data-k="${k}">${SHORT[k]}<b>–</b></span>`).join('');
  for (const el of box.children) {
    const v = ang?.[el.dataset.k];
    el.lastChild.textContent = Number.isFinite(v) ? Math.round(v) + '°' : '–';
  }
}

function liveCount(ang) {
  if (cap.protocol !== 'squat' && cap.protocol !== 'sts') return;
  const vals = [ang.kneeFlexL, ang.kneeFlexR].filter(Number.isFinite);
  if (!vals.length) return;
  const k = vals.reduce((a, b) => a + b) / vals.length;
  if (cap.protocol === 'squat') {
    if (cap.phase === 'up' && k > 45) cap.phase = 'down';
    else if (cap.phase === 'down' && k < 25) { cap.phase = 'up'; bumpRep(); }
  } else {
    if (cap.phase === 'up' && k > 65) cap.phase = 'down'; // 앉음
    else if (cap.phase === 'down' && k < 30) { cap.phase = 'up'; bumpRep(); }
  }
}

function bumpRep() {
  if (!cap.recording) return;
  cap.reps++;
  $('#liveCounter').textContent = String(cap.reps);
  speak(KOR_NUM[cap.reps] || String(cap.reps));
  if (cap.protocol === 'sts' && $('#stsMode').value === 'five' && cap.reps >= 5) stopRecording(true);
}

async function toggleRecord() {
  if (cap.recording) { stopRecording(true); return; }
  if (!cap.running) return;
  const n = Number(settings.countdown) || 0;
  const cd = $('#countdown');
  $('#btnRec').disabled = true;
  for (let i = n; i > 0; i--) {
    cd.hidden = false; cd.textContent = String(i);
    speak(KOR_NUM[i] || String(i));
    await new Promise((r) => setTimeout(r, 1000));
    if (!cap.running) { cd.hidden = true; $('#btnRec').disabled = false; return; }
  }
  cd.hidden = true;
  $('#btnRec').disabled = false;
  speak('시작');
  cap.frames = [];
  cap.reps = 0;
  cap.phase = 'up'; // STS도 앉은 자세(>65°)를 먼저 확인한 뒤 기립을 센다
  $('#liveCounter').textContent = '0';
  cap.t0 = performance.now();
  cap.recording = true;
  $('#btnRec').classList.add('on');
  startVideoRecorder();
  const tick = () => {
    if (!cap.recording) return;
    const s = (performance.now() - cap.t0) / 1000;
    $('#recTimer').textContent = s.toFixed(1) + 's';
    if (cap.protocol === 'sts' && $('#stsMode').value === 'thirty' && s >= 30) { stopRecording(true); return; }
    cap.timerRAF = requestAnimationFrame(tick);
  };
  tick();
}

function startVideoRecorder() {
  cap.chunks = [];
  cap.recorder = null;
  const c = $('#liveCanvas');
  if (!c.captureStream || !window.MediaRecorder) return;
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported?.(t));
  try {
    const rec = new MediaRecorder(c.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 4e6 } : undefined);
    rec.ondataavailable = (e) => e.data.size && cap.chunks.push(e.data);
    rec.start(500);
    cap.recorder = rec;
  } catch (e) { console.warn('영상 녹화 불가', e); }
}

function stopRecorder() {
  return new Promise((res) => {
    const rec = cap.recorder;
    if (!rec || rec.state === 'inactive') { res(null); return; }
    rec.onstop = () => res(new Blob(cap.chunks, { type: rec.mimeType || 'video/webm' }));
    rec.stop();
  });
}

async function stopRecording(goResults) {
  cap.recording = false;
  cancelAnimationFrame(cap.timerRAF);
  $('#btnRec').classList.remove('on');
  speak('종료');
  const blob = await stopRecorder();
  if (!goResults) return;
  const frames = cap.frames;
  if (frames.length < 10) { toast('기록이 너무 짧습니다.'); return; }
  closeCapture();
  await finishSession({ frames, protocol: cap.protocol, source: 'live', videoBlob: blob });
}

// ---------- 영상 파일 분석 ----------
let cancelFile = false;
async function analyzeFile(file) {
  const protocol = settings.protocol;
  cancelFile = false;
  show('processing');
  $('#procTitle').textContent = `영상 분석 중 — ${PROTOCOLS[protocol].name}`;
  $('#procBar').style.width = '0%';
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('이 영상 형식을 열 수 없습니다.')); });
    await ensurePose((m) => ($('#procText').textContent = m));
    const fps = Number(settings.fps) || 30;
    const dur = v.duration;
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('영상 길이를 알 수 없습니다.');
    const n = Math.floor(dur * fps);
    const w = v.videoWidth, h = v.videoHeight;
    const pc = $('#procCanvas');
    pc.width = w; pc.height = h;
    const pctx = pc.getContext('2d');
    const frames = [];
    const base = lastTs + 1000;
    const started = performance.now();
    for (let i = 0; i < n; i++) {
      if (cancelFile) throw new Error('취소됨');
      const t = i / fps;
      await seek(v, t);
      let res = null;
      try { res = pose.landmarker.detectForVideo(v, nextTs(base + t * 1000)); } catch (e) { console.warn(e); }
      const fr = toFrame(res, t, w, h);
      frames.push(fr);
      if (i % 3 === 0 || i === n - 1) {
        pctx.drawImage(v, 0, 0, w, h);
        drawSkeleton(pctx, fr.lm, w, h, { scale: w / 720 });
        $('#procBar').style.width = ((i + 1) / n * 100).toFixed(1) + '%';
        const el = (performance.now() - started) / 1000;
        const remain = (el / (i + 1)) * (n - i - 1);
        $('#procText').textContent = `${i + 1} / ${n} 프레임 · 남은 시간 약 ${Math.ceil(remain)}초`;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await finishSession({ frames, protocol, source: 'file', videoURL: url, fileName: file.name });
  } catch (e) {
    URL.revokeObjectURL(url);
    toast(e.message || String(e), 4000);
    show('home');
  }
}

function seek(v, t) {
  return new Promise((res) => {
    const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
    const to = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

// ---------- 결과 ----------
const view = { session: null, analysis: null, chart: null, active: new Set(), videoURL: null, overlay: false, raf: 0 };

async function finishSession({ frames, protocol, source, videoBlob = null, videoURL = null, fileName = '' }) {
  const session = {
    id: 's' + Date.now().toString(36),
    date: Date.now(), protocol, source, fileName,
    settings: { model: settings.model, height: settings.height, cutoff: settings.cutoff, fps: settings.fps },
    frames,
  };
  const analysis = analyze(frames, protocol, analyzeOpts());
  session.result = analysis.result;
  const ok = await saveSession(session);
  if (!ok) toast('기기 저장 공간에 기록을 저장하지 못했습니다(결과는 볼 수 있음).');
  const url = videoBlob ? URL.createObjectURL(videoBlob) : videoURL;
  showResults(session, analysis, { videoURL: url, videoBlob, overlay: source === 'file' });
}

async function openSession(id) {
  const s = await getSession(id);
  if (!s) { toast('기록을 불러오지 못했습니다.'); return; }
  const analysis = analyze(s.frames, s.protocol, { fs: 30, cutoff: Number(s.settings?.cutoff) || 6, heightM: Number(s.settings?.height) > 0 ? Number(s.settings.height) / 100 : 0 });
  showResults(s, analysis, { videoURL: null, overlay: false });
}

async function previousOf(session) {
  const all = await listSessions();
  return all.find((s) => s.protocol === session.protocol && s.date < session.date) || null;
}

async function showResults(session, analysis, { videoURL, videoBlob = null, overlay }) {
  if (view.videoURL && view.videoURL !== videoURL) URL.revokeObjectURL(view.videoURL);
  Object.assign(view, { session, analysis, videoURL, videoBlob, overlay });
  const r = analysis.result;
  show('results');
  $('#resTitle').textContent = r.protocolName;
  $('#resSub').textContent = `${new Date(session.date).toLocaleString('ko-KR')} · ${r.duration}s · 신체 검출 ${r.detectionRate}%`;

  // 이전 기록 대비
  const prev = await previousOf(session);
  const prevMap = new Map((prev?.result?.metrics || []).map((m) => [m.label, m.value]));
  $('#resNotes').innerHTML = r.notes.map((n) => `<p>${esc(n)}</p>`).join('');
  $('#resMetrics').innerHTML = r.metrics.map((m) => {
    const pv = prevMap.get(m.label);
    const delta = typeof m.value === 'number' && typeof pv === 'number' && Number.isFinite(m.value) && Number.isFinite(pv)
      ? `<em>이전 ${pv}${esc(m.unit)} (${m.value - pv >= 0 ? '+' : ''}${Math.round((m.value - pv) * 10) / 10})</em>` : '';
    return `<div class="metric ${m.flag || ''}"><span>${esc(m.label)}</span><b>${esc(fmt(m.value))}</b><small>${esc(m.unit)}</small>${delta}</div>`;
  }).join('');

  // 반복/이벤트 표
  const box = $('#repTableBox');
  if (r.reps.length) {
    box.innerHTML = `<h2 class="sec">반복별 분석</h2><div class="scroll"><table class="tbl"><tr><th>#</th><th>시간s</th><th>무릎L</th><th>무릎R</th><th>고관절L</th><th>고관절R</th><th>체간</th><th>FPPA L</th><th>FPPA R</th></tr>${
      r.reps.map((x) => `<tr><td>${x.n}</td><td>${fmt(x.duration)}</td><td>${fmt(x.kneeL)}</td><td>${fmt(x.kneeR)}</td><td>${fmt(x.hipL)}</td><td>${fmt(x.hipR)}</td><td>${fmt(x.trunk)}</td><td>${fmt(x.fppaL)}</td><td>${fmt(x.fppaR)}</td></tr>`).join('')}</table></div>`;
  } else if (r.events.length) {
    box.innerHTML = `<h2 class="sec">이벤트</h2><div class="scroll"><table class="tbl"><tr><th>#</th><th>시점(s)</th><th>구분</th></tr>${
      r.events.map((e) => `<tr><td>${e.n}</td><td>${fmt(e.t)}</td><td>${esc(e.label || e.side || '')}</td></tr>`).join('')}</table></div>`;
  } else box.innerHTML = '';

  // ROM 표
  $('#romTable').innerHTML = `<div class="scroll"><table class="tbl"><tr><th>관절</th><th>최소</th><th>최대</th><th>평균</th><th>범위</th></tr>${
    Object.values(r.rom).map((x) => `<tr><td>${esc(x.label)}</td><td>${fmt(x.min)}</td><td>${fmt(x.max)}</td><td>${fmt(x.mean)}</td><td>${fmt(x.rom)}</td></tr>`).join('')}</table></div>`;

  // 차트
  view.active = new Set(CHART_KEYS[session.protocol] || CHART_KEYS.free);
  if (!view.chart) view.chart = new LineChart($('#chart'), { onSeek: (sec) => seekReplay(sec) });
  renderSeriesChips();
  drawChart();

  // 재생
  const rb = $('#replayBox');
  const rv = $('#replayVideo');
  cancelAnimationFrame(view.raf);
  if (videoURL) {
    rb.hidden = false;
    rv.src = videoURL;
    rv.onloadedmetadata = () => fixDuration(rv);
    if (overlay) overlayLoop();
    else clearOverlay();
  } else {
    rb.hidden = true;
    rv.removeAttribute('src');
  }
  $('#expVideo').hidden = !videoBlob;
}

function renderSeriesChips() {
  const box = $('#seriesChips');
  box.innerHTML = '';
  ANGLES.forEach((a, i) => {
    const el = document.createElement('span');
    el.className = 'chip' + (view.active.has(a.key) ? ' on' : '');
    el.style.color = PALETTE[i % PALETTE.length];
    el.textContent = SHORT[a.key];
    el.addEventListener('click', () => {
      if (view.active.has(a.key)) view.active.delete(a.key); else view.active.add(a.key);
      el.classList.toggle('on');
      drawChart();
    });
    box.appendChild(el);
  });
}

function drawChart() {
  const S = view.analysis.series;
  const series = ANGLES.map((a, i) => ({ key: a.key, color: PALETTE[i % PALETTE.length], y: S.series[a.key] }))
    .filter((s) => view.active.has(s.key));
  view.chart.set(S.t, series, view.analysis.result.events || []);
}

// MediaRecorder webm은 길이 정보가 없어 탐색이 안 되는 문제 우회
function fixDuration(v) {
  if (Number.isFinite(v.duration)) return;
  const back = () => { v.removeEventListener('timeupdate', back); v.currentTime = 0; };
  v.addEventListener('timeupdate', back);
  v.currentTime = 1e7;
}

function seekReplay(sec) {
  const rv = $('#replayVideo');
  view.chart.setCursor(sec);
  if (rv.src && Number.isFinite(rv.duration)) rv.currentTime = Math.min(sec, rv.duration);
}

function clearOverlay() {
  const c = $('#replayCanvas');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  const rv = $('#replayVideo');
  const tick = () => {
    if (!view.videoURL) return;
    if (Number.isFinite(rv.currentTime) && $('#results').classList.contains('active')) view.chart?.setCursor(rv.currentTime);
    view.raf = requestAnimationFrame(tick);
  };
  view.raf = requestAnimationFrame(tick);
}

function overlayLoop() {
  const rv = $('#replayVideo');
  const c = $('#replayCanvas');
  const frames = view.session.frames;
  let lastT = -1;
  const tick = () => {
    if (!view.overlay) return;
    const r = rv.getBoundingClientRect();
    const box = rv.parentElement.getBoundingClientRect();
    // object-fit contain 영역 계산
    const vw = rv.videoWidth || 16, vh = rv.videoHeight || 9;
    const s = Math.min(r.width / vw, r.height / vh);
    const dw = vw * s, dh = vh * s;
    const ox = r.left - box.left + (r.width - dw) / 2, oy = r.top - box.top + (r.height - dh) / 2;
    if (c.width !== Math.round(dw) || c.height !== Math.round(dh)) { c.width = Math.round(dw); c.height = Math.round(dh); lastT = -1; }
    c.style.left = ox + 'px'; c.style.top = oy + 'px';
    const t = rv.currentTime;
    if (t !== lastT) {
      lastT = t;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      const f = nearestFrame(frames, t);
      if (f?.lm) drawSkeleton(ctx, f.lm, c.width, c.height, { angles: computeAngles(f), scale: c.width / 720 });
      view.chart?.setCursor(t);
    }
    view.raf = requestAnimationFrame(tick);
  };
  view.raf = requestAnimationFrame(tick);
}

function nearestFrame(frames, t) {
  let lo = 0, hi = frames.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (frames[m].t < t) lo = m + 1; else hi = m;
  }
  if (lo > 0 && Math.abs(frames[lo - 1].t - t) < Math.abs(frames[lo].t - t)) lo--;
  return frames[lo];
}

// ---------- 내보내기 ----------
function stamp() {
  const d = new Date(view.session.date);
  const p = (n) => String(n).padStart(2, '0');
  return `${view.session.protocol}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function summaryText() {
  const r = view.analysis.result;
  const lines = [`[PhysioCap] ${r.protocolName} — ${new Date(view.session.date).toLocaleString('ko-KR')}`, `기록 ${r.duration}s · 검출률 ${r.detectionRate}%`];
  for (const m of r.metrics) lines.push(`• ${m.label}: ${fmt(m.value)}${m.unit}`);
  for (const n of r.notes) lines.push(`※ ${n}`);
  lines.push('※ 단일 카메라 기반 추정치이며 임상 진단을 대신하지 않습니다.');
  return lines.join('\n');
}

async function exportAs(kind) {
  const base = 'physiocap_' + stamp();
  const S = view.analysis.series;
  const frames = view.session.frames;
  switch (kind) {
    case 'csv': return saveFile(base + '_angles.csv', 'text/csv', '﻿' + toCSV(S));
    case 'lm': return saveFile(base + '_landmarks.csv', 'text/csv', landmarksCSV(frames));
    case 'trc': return saveFile(base + '.trc', 'text/plain', toTRC(frames, { fs: 30, name: base + '.trc', heightM: Number(view.session.settings?.height) > 0 ? Number(view.session.settings.height) / 100 : 0 }));
    case 'json': return saveFile(base + '.json', 'application/json', JSON.stringify({ app: 'PhysioCap', ...view.analysis.result, settings: view.session.settings }, null, 2));
    case 'video': if (view.videoBlob) return saveFile(base + (view.videoBlob.type.includes('mp4') ? '.mp4' : '.webm'), view.videoBlob.type, view.videoBlob); return;
    case 'text': {
      const txt = summaryText();
      if (isAndroidApp && window.AndroidBridge.shareText) { window.AndroidBridge.shareText(txt); return; }
      if (navigator.share) { try { await navigator.share({ title: 'PhysioCap 결과', text: txt }); return; } catch { /* 취소 */ } }
      try { await navigator.clipboard.writeText(txt); toast('요약을 클립보드에 복사했습니다.'); } catch { toast('공유를 지원하지 않는 환경입니다.'); }
      return;
    }
  }
}

async function saveFile(name, mime, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (isAndroidApp) {
    const b64 = await blobToBase64(blob);
    const msg = window.AndroidBridge.saveFile(name, mime, b64);
    toast(msg || '저장했습니다: ' + name, 4000);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('다운로드: ' + name);
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------- 설정 대화상자 ----------
function openSettings() {
  const dlg = $('#settingsDlg');
  const f = dlg.querySelector('form');
  f.model.value = settings.model; f.height.value = settings.height; f.countdown.value = settings.countdown;
  f.fps.value = settings.fps; f.cutoff.value = settings.cutoff; f.voice.checked = !!settings.voice;
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    Object.assign(settings, { model: f.model.value, height: f.height.value, countdown: f.countdown.value, fps: f.fps.value, cutoff: f.cutoff.value, voice: f.voice.checked });
    storeSettings();
    toast('설정을 저장했습니다.');
  };
}

// ---------- 이벤트 연결 ----------
$('#btnSettings').addEventListener('click', openSettings);
$('#btnBack').addEventListener('click', () => { closeCapture(); show('home'); renderHome(); });
$('#btnHome').addEventListener('click', () => {
  view.overlay = false; cancelAnimationFrame(view.raf);
  $('#replayVideo').pause();
  show('home'); renderHome();
});
$('#btnRec').addEventListener('click', toggleRecord);
$('#btnFlip').addEventListener('click', async () => {
  if (cap.recording) return;
  cap.facing = cap.facing === 'environment' ? 'user' : 'environment';
  try { await startCamera(); } catch (e) { toast(cameraErrorText(e)); }
});
$('#btnCancel').addEventListener('click', () => { cancelFile = true; });
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) analyzeFile(f);
});
document.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', () => exportAs(b.dataset.exp).catch((e) => toast('내보내기 실패: ' + e.message))));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && cap.running && !cap.recording) { closeCapture(); show('home'); renderHome(); }
});
// Android 뒤로가기 → 웹 화면 뒤로
window.physiocapBack = () => {
  if ($('#capture').classList.contains('active')) { $('#btnBack').click(); return true; }
  if ($('#results').classList.contains('active')) { $('#btnHome').click(); return true; }
  if ($('#processing').classList.contains('active')) { cancelFile = true; return true; }
  return false;
};

if ('serviceWorker' in navigator && !isAndroidApp && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const first = !navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (!first) return;
    const w = reg.installing || reg.waiting;
    if (!w) return;
    toast('오프라인용 엔진·모델(약 29MB) 받는 중…', 4000);
    w.addEventListener('statechange', () => {
      if (w.state === 'activated') toast('오프라인 사용 준비 완료 — 이제 인터넷 없이도 동작합니다.', 4000);
      if (w.state === 'redundant') toast('오프라인 준비에 실패했습니다. 다음 접속 때 다시 시도합니다.', 4000);
    });
  }).catch(() => {});
}

renderHome();
// 첫 진입 시 엔진을 미리 데워 둔다 (실패해도 촬영 때 다시 시도)
setTimeout(() => ensurePose().catch(() => {}), 300);
// 테스트용 훅
window.__physiocap = { analyzeFile, finishSession, settings, getPose: () => pose };
