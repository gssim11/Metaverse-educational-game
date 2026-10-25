// PhysioCap Lab 대시보드 — 서버 API(/api/*)를 2초마다 읽어 화면을 갱신한다.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail ? (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)) : r.statusText);
  return j;
};
const toast = (m) => alert(m);
const STATE_KO = { recording: '녹화 중', uploading: '업로드 대기', preparing: '영상 변환', queued: '대기열', processing: '처리 중', done: '완료', error: '오류' };
const PALETTE = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#b388ff', '#ff8c42', '#90be6d', '#e0e0e0', '#f94144', '#43aa8b'];

let state = { devices: [], sessions: [], session: null, kinetic: {}, sel: null, intr: null };

// ---------- 탭 ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
}));

// ---------- 서버 주소 + QR ----------
const urlInput = $('#serverUrl');
urlInput.value = localStorage.getItem('serverUrl') || (location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '' : location.origin);
function drawQR() {
  const v = urlInput.value.trim();
  try { localStorage.setItem('serverUrl', v); } catch { /* 무시 */ }
  if (!v) { $('#qr').innerHTML = '<p style="color:#333;width:160px">PC 내부 IP 주소를 입력하면 QR 이 생깁니다</p>'; return; }
  const q = qrcode(0, 'M');
  q.addData('physiocap-lab:' + v);
  q.make();
  $('#qr').innerHTML = q.createSvgTag({ cellSize: 5, margin: 2 });
}
urlInput.addEventListener('input', drawQR);
drawQR();

// ---------- 주기 갱신 ----------
async function refresh() {
  try {
    const h = await api('/api/health');
    state.kinetic = h.kinetic_motions;
    $('#health').textContent = `서버 정상 · 대기 ${h.jobs.queue} · 실행 ${h.jobs.running}`;
    $('#health').className = 'pill ok';
  } catch {
    $('#health').textContent = '서버 연결 끊김';
    $('#health').className = 'pill bad';
    return;
  }
  state.devices = await api('/api/devices');
  state.sessions = await api('/api/sessions');
  state.intr = await api('/api/intrinsics');
  if (state.session) state.session = await api('/api/sessions/' + state.session.id).catch(() => null);
  render();
}

function render() {
  // 기기
  $('#devTable').innerHTML = '<tr><th>폰</th><th>기종</th><th>녹화 설정</th><th>상태</th></tr>' + state.devices.map((d) =>
    `<tr><td><span class="dot ${d.online ? 'on' : ''}"></span>${esc(d.label)}</td><td>${esc(d.model)}</td><td>${d.width}×${d.height} ${d.fps}fps</td><td>${esc(d.state || '')} ${esc(d.message || '')}</td></tr>`).join('');
  const opts = state.devices.map((d) => `<option value="${esc(d.id)}">${esc(d.label)} (${esc(d.model)})${d.online ? '' : ' - 끊김'}</option>`).join('');
  for (const id of ['#sCam0', '#sCam1', '#intrDevice']) {
    const el = $(id), keep = el.value;
    if (el.dataset.opts !== opts) { el.innerHTML = opts; el.dataset.opts = opts; if (keep) el.value = keep; }
  }
  if ($('#sCam1').selectedIndex === 0 && $('#sCam1').options.length > 1 && !$('#sCam1').dataset.touched) $('#sCam1').selectedIndex = 1;
  // 동역학 동작
  const mo = '<option value="none">동역학 안 함 (관절각만)</option>' + Object.entries(state.kinetic).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  if ($('#tMotion').dataset.opts !== mo) { $('#tMotion').innerHTML = mo; $('#tMotion').dataset.opts = mo; }
  // 렌즈 보정
  $('#intrModels').innerHTML = state.intr.models.length ? state.intr.models.map((m) => `<li>${esc(m)}</li>`).join('') : '<li class="muted">아직 없음</li>';
  $('#intrTable').innerHTML = '<tr><th>캡처</th><th>기종</th><th>상태</th><th>결과</th></tr>' + state.intr.captures.map((c) =>
    `<tr><td>${esc(c.id)}</td><td>${esc(c.model)}</td><td class="state ${c.state}">${STATE_KO[c.state] || c.state}</td><td>${c.error ? `<span class="err">${esc(c.error)}</span>` : c.result ? 'fx=' + Number(c.result.intrinsicMat?.[0]?.[0]).toFixed(1) : ''}</td></tr>`).join('');
  // 세션 목록
  $('#sessionList').innerHTML = state.sessions.map((s) => `<li data-sid="${esc(s.id)}" class="${state.session?.id === s.id ? 'on' : ''}"><b>${esc(s.name)}</b> <span class="muted">${new Date(s.created).toLocaleString('ko-KR')} · 시행 ${s.trials}</span></li>`).join('') || '<li class="muted">세션이 없습니다</li>';
  document.querySelectorAll('#sessionList li[data-sid]').forEach((li) => li.onclick = async () => { state.session = await api('/api/sessions/' + li.dataset.sid); state.sel = null; $('#resultView').hidden = true; render(); });
  renderSession();
}

function renderSession() {
  const s = state.session;
  $('#sessionView').hidden = !s;
  if (!s) return;
  $('#svTitle').textContent = s.name;
  $('#svSub').textContent = `키 ${s.subject.height_m} m · 체중 ${s.subject.mass_kg} kg · ` + Object.entries(s.cameras).map(([c, v]) => `${c}=${v.label}`).join(', ') + ` · 체커보드 ${s.checkerboard.cols}×${s.checkerboard.rows} ${s.checkerboard.square_mm}mm (${s.checkerboard.placement})`;
  const rec = s.trials.find((t) => t.state === 'recording');
  $('#stopBtn').hidden = !rec;
  $('#recInfo').textContent = rec ? `● ${rec.id} 녹화 중` : '';
  document.querySelectorAll('[data-trial]').forEach((b) => (b.disabled = !!rec || s.trials.some((t) => t.state === 'uploading')));
  $('#trialTable').innerHTML = '<tr><th>시행</th><th>종류</th><th>상태</th><th>동역학</th><th></th></tr>' + s.trials.map((t) => {
    const kin = t.motion_type && t.motion_type !== 'none' ? `${esc(state.kinetic[t.motion_type]?.label || t.motion_type)}: <span class="state ${t.kinetics_state || ''}">${STATE_KO[t.kinetics_state] || t.kinetics_state || '-'}</span>` : '-';
    const err = t.error ? `<div class="err">${esc(t.error)}</div>` : t.kinetics_error ? `<div class="err">동역학: ${esc(t.kinetics_error)}</div>` : '';
    return `<tr><td><b>${esc(t.id)}</b>${t.stale ? ' <span class="muted">(재보정 후 다시 처리 필요)</span>' : ''}${err}</td><td>${{ calibration: '보정', neutral: '중립', dynamic: '동작' }[t.type]}</td>
      <td class="state ${t.state}">${STATE_KO[t.state] || t.state}${t.stage ? ' · ' + esc(t.stage) : ''}</td><td>${kin}</td>
      <td>${t.state === 'done' || t.kinetics_state ? `<button data-res="${esc(t.id)}">결과</button>` : ''} ${['error', 'done'].includes(t.state) ? `<button data-re="${esc(t.id)}">재처리</button>` : ''}</td></tr>`;
  }).join('');
  document.querySelectorAll('[data-res]').forEach((b) => b.onclick = () => openResult(b.dataset.res));
  document.querySelectorAll('[data-re]').forEach((b) => b.onclick = () => api(`/api/sessions/${s.id}/trials/${b.dataset.re}/reprocess`, { method: 'POST' }).then(refresh).catch((e) => toast(e.message)));
}

// ---------- 조작 ----------
$('#sCam1').addEventListener('change', (e) => (e.target.dataset.touched = '1'));
$('#sCreate').onclick = async () => {
  try {
    const body = {
      name: $('#sName').value.trim(),
      subject: { height_m: +$('#sHeight').value, mass_kg: +$('#sMass').value, sex: $('#sSex').value },
      checkerboard: { cols: +$('#sCols').value, rows: +$('#sRows').value, square_mm: +$('#sSquare').value, placement: $('#sPlace').value },
      cameras: { Cam0: $('#sCam0').value, Cam1: $('#sCam1').value },
      pose_detector: $('#sPose').value,
    };
    if (body.cameras.Cam0 === body.cameras.Cam1) throw new Error('Cam0 과 Cam1 에 서로 다른 폰을 지정하세요.');
    state.session = await api('/api/sessions', { method: 'POST', body });
    refresh();
  } catch (e) { toast(e.message); }
};
document.querySelectorAll('[data-trial]').forEach((b) => b.onclick = async () => {
  const s = state.session;
  const type = b.dataset.trial;
  const body = { type };
  if (type === 'dynamic') {
    body.name = $('#tName').value.trim();
    body.motion_type = $('#tMotion').value;
    const need = state.kinetic[body.motion_type]?.needs;
    if (need === 'repetition') body.repetition = +$('#tRep').value;
    if (need === 'time_window' && $('#tT0').value && $('#tT1').value) body.time_window = [+$('#tT0').value, +$('#tT1').value];
  }
  try { await api(`/api/sessions/${s.id}/trials`, { method: 'POST', body }); refresh(); } catch (e) { toast(e.message); }
});
$('#stopBtn').onclick = async () => {
  const t = state.session.trials.find((x) => x.state === 'recording');
  try { await api(`/api/sessions/${state.session.id}/trials/${t.id}/stop`, { method: 'POST' }); refresh(); } catch (e) { toast(e.message); }
};
let intrCap = null;
$('#intrStart').onclick = async () => {
  try {
    intrCap = await api('/api/intrinsics/start', { method: 'POST', body: { device_id: $('#intrDevice').value, checkerboard: { cols: +$('#intrCols').value, rows: +$('#intrRows').value, square_mm: +$('#intrSquare').value } } });
    refresh();
  } catch (e) { toast(e.message); }
};
$('#intrStop').onclick = async () => {
  const cap = intrCap || state.intr.captures.find((c) => c.state === 'recording');
  if (!cap) return toast('녹화 중인 캡처가 없습니다.');
  try { await api(`/api/intrinsics/${cap.id}/stop`, { method: 'POST' }); intrCap = null; refresh(); } catch (e) { toast(e.message); }
};

// ---------- 결과 ----------
async function openResult(tid) {
  const s = state.session;
  const r = await api(`/api/sessions/${s.id}/trials/${tid}/results`);
  $('#resultView').hidden = false;
  $('#rvTitle').textContent = `${s.name} / ${tid}`;
  const notes = [];
  if (r.kinetics?.note) notes.push(r.kinetics.note);
  notes.push('관절각은 OpenCap 원본 파이프라인(삼각측량 → LSTM 마커 보강 → OpenSim 역기구학) 결과입니다. 갤럭시 렌즈 보정값은 이 서버에서 계산한 값입니다.');
  $('#rvNotes').innerHTML = notes.map((n) => `<div class="note">${esc(n)}</div>`).join('');
  // 관절각
  if (r.kinematics) {
    const cols = r.kinematics.columns, data = r.kinematics.data;
    const t = data.map((row) => row[0]);
    const series = {};
    cols.slice(1).forEach((c, i) => (series[c] = data.map((row) => row[i + 1])));
    const def = ['hip_flexion_r', 'hip_flexion_l', 'knee_angle_r', 'knee_angle_l', 'ankle_angle_r', 'ankle_angle_l'].filter((c) => c in series);
    chipChart('#kinChips', '#kinChart', t, series, def.length ? def : Object.keys(series).slice(0, 4), '°');
  }
  // 동역학
  $('#kinBox').hidden = !r.kinetics;
  if (r.kinetics) {
    const keys = Object.keys(r.kinetics.series);
    const label = { GRF_BW: '지면반력 (% 체중)', GRF: '지면반력 (N)', torques_BWht: '관절 모멘트 (% 체중×키)', torques: '관절 모멘트 (Nm)', muscle_activations: '근활성 (0–1)', muscle_forces: '근력 (N)', KAM_BWht: '무릎 내전 모멘트', MCF_BW: '내측 무릎 접촉력', coordinate_values: '시뮬레이션 관절각', coordinate_values_toTrack: '추적 대상 관절각' };
    $('#kinSeries').innerHTML = keys.map((k) => `<option value="${k}">${label[k] || k}</option>`).join('');
    const show = () => {
      const k = $('#kinSeries').value, sr = r.kinetics.series[k];
      const def = sr.labels.filter((l) => /_y_|knee|hip_flex|ankle/.test(l)).slice(0, 4);
      chipChart('#dynChips', '#dynChart', r.kinetics.time, sr.data, def.length ? def : sr.labels.slice(0, 3), sr.unit);
    };
    $('#kinSeries').onchange = show;
    show();
  }
  // 보정 이미지·파일
  const imgs = r.files.filter((f) => /\.(jpg|png)$/i.test(f) && /Calibration/i.test(f));
  $('#calImgs').innerHTML = imgs.map((f) => `<img src="/files/${f}" alt="">`).join('');
  $('#rvFiles').innerHTML = r.files.map((f) => `<li><a href="/files/${f}" download>${esc(f.split('/').slice(-3).join('/'))}</a></li>`).join('');
  $('#resultView').scrollIntoView({ behavior: 'smooth' });
}

function chipChart(chipSel, canvasSel, t, series, active, unit) {
  const on = new Set(active);
  const box = $(chipSel);
  const names = Object.keys(series);
  box.innerHTML = names.map((n, i) => `<span class="chip ${on.has(n) ? 'on' : ''}" style="color:${PALETTE[i % PALETTE.length]}" data-n="${esc(n)}">${esc(n)}</span>`).join('');
  const draw = () => drawChart($(canvasSel), t, names.map((n, i) => ({ y: series[n], color: PALETTE[i % PALETTE.length], on: on.has(n) })).filter((s) => s.on), unit);
  box.querySelectorAll('.chip').forEach((c) => c.onclick = () => { on.has(c.dataset.n) ? on.delete(c.dataset.n) : on.add(c.dataset.n); c.classList.toggle('on'); draw(); });
  draw();
}

function drawChart(c, t, series, unit) {
  const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const L = 48, T = 10, w = W - L - 12, h = H - 34;
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.y) if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const t0 = t[0] ?? 0, t1 = t[t.length - 1] ?? 1;
  const X = (x) => L + ((x - t0) / (t1 - t0 || 1)) * w, Y = (v) => T + (1 - (v - lo) / (hi - lo)) * h;
  const css = getComputedStyle(document.documentElement);
  g.strokeStyle = css.getPropertyValue('--line'); g.fillStyle = css.getPropertyValue('--muted'); g.font = '11px system-ui';
  for (let i = 0; i <= 4; i++) { const v = lo + (i / 4) * (hi - lo); g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + w, Y(v)); g.stroke(); g.fillText(v.toFixed(Math.abs(hi - lo) < 5 ? 2 : 0), 4, Y(v) + 4); }
  for (let i = 0; i <= 5; i++) { const x = t0 + (i / 5) * (t1 - t0); g.fillText(x.toFixed(2) + 's', X(x) - 14, H - 8); }
  g.fillText(unit || '', 4, 10);
  for (const s of series) {
    g.strokeStyle = s.color; g.lineWidth = 2; g.beginPath();
    let pen = false;
    s.y.forEach((v, i) => { if (v == null || !isFinite(v) || i >= t.length) { pen = false; return; } pen ? g.lineTo(X(t[i]), Y(v)) : g.moveTo(X(t[i]), Y(v)); pen = true; });
    g.stroke();
  }
}

refresh();
setInterval(refresh, 2000);
