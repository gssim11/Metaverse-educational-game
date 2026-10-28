// 정확도 검증 탭 — app.js 의 $, esc, api, PALETTE 를 함께 쓴다.
const ACT_KO = { walking: '보행', squats: '스쿼트', sit_to_stand: '앉았다 일어서기', drop_jump: '드롭 점프', other: '기타' };
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? '–' : (+v).toFixed(d));
let valCurrent = null;

async function valLoadTrials() {
  const sel = $('#valTrial');
  const keep = sel.value;
  const opts = [];
  for (const s of await api('/api/sessions')) {
    const full = await api('/api/sessions/' + s.id).catch(() => null);
    for (const t of full?.trials || []) {
      if (t.type === 'dynamic' && t.state === 'done') opts.push(`<option value="${esc(s.id)}|${esc(t.id)}">${esc(s.name || s.id)} · ${esc(t.id)}</option>`);
    }
  }
  sel.innerHTML = opts.join('') || '<option value="">완료된 동작 시행 없음</option>';
  if (keep) sel.value = keep;
}

async function valRefresh() {
  const list = await api('/api/validation');
  $('#valList').innerHTML = list.map((v) => {
    const s = v.kind === 'series' ? `MAE ${fmt(v.summary?.rotations_mae_mean)}${v.source === 'grf' ? ' %BW' : '°'}` : '고니오미터';
    return `<li data-vid="${esc(v.id)}" class="${valCurrent === v.id ? 'on' : ''}"><b>${esc(ACT_KO[v.activity] || v.activity)}</b> ${esc(v.label || '')} <span class="muted">${new Date(v.created).toLocaleString('ko-KR')} · ${s}</span></li>`;
  }).join('') || '<li class="muted">검증 기록이 없습니다</li>';
  document.querySelectorAll('#valList [data-vid]').forEach((li) => li.onclick = () => valShow(li.dataset.vid));
  const sm = await api('/api/validation/summary');
  const acts = Object.entries(sm.activities);
  $('#valSummary').innerHTML = acts.length ? `<table class="tbl"><tr><th>동작</th><th>관절</th><th>시행 수</th><th>PhysioCap MAE(°)</th><th>OpenCap 논문 MAE(°)</th></tr>` +
    acts.map(([a, v]) => Object.entries(v.columns).map(([c, x], i) => `<tr><td>${i ? '' : esc(ACT_KO[a] || a)}</td><td>${esc(c)}</td><td>${x.n_trials}</td><td>${fmt(x.mae_mean)}</td><td>${i ? '' : fmt(v.opencap_benchmark_mae, 1)}</td></tr>`).join('') +
      `<tr><td></td><td><b>회전 자유도 평균</b></td><td></td><td><b>${fmt(v.rotations_mae_mean)}</b></td><td><b>${fmt(v.opencap_benchmark_mae ?? sm.opencap_benchmark_mae_mean, 1)}</b></td></tr>`).join('') +
    `</table><p class="muted">OpenCap 값: Uhlrich 등 2023 (PLoS Comput Biol), 모캡 대비 회전 자유도 MAE. 기준 장비·대상자·구간이 다르면 직접 비교에 한계가 있습니다.</p>` : '아직 결과가 없습니다.';
}

async function valShow(id) {
  valCurrent = id;
  const v = await api('/api/validation/' + id);
  $('#valDetail').hidden = false;
  $('#valTitle').textContent = `${ACT_KO[v.activity] || v.activity} ${v.label || ''}`;
  const al = v.result.alignment;
  $('#valMeta').textContent = [`기준: ${v.reference}`, v.test?.trial ? `PhysioCap: ${v.test.session} · ${v.test.trial}` : v.test?.file ? `PhysioCap: ${v.test.file}` : '',
    al ? `시간 차 ${fmt(al.lag_s, 3)}초 (r=${fmt(al.r, 3)})` : '', v.result.window ? `구간 ${fmt(v.result.window[0])}–${fmt(v.result.window[1])}초` : ''].filter(Boolean).join(' · ');
  let rows, ba;
  if (v.kind === 'series') {
    rows = Object.entries(v.result.columns).map(([c, x]) => ({ name: c, ...x }));
    $('#valTable').innerHTML = '<tr><th>열</th><th>n</th><th>편향</th><th>MAE</th><th>RMSE</th><th>최대</th><th>95% 일치한계</th><th>r</th></tr>' +
      rows.map((x) => `<tr data-ba="${esc(x.name)}"><td>${esc(x.name)} <span class="muted">${esc(x.unit)}</span></td><td>${x.n}</td><td>${fmt(x.bias)}</td><td>${fmt(x.mae)}</td><td>${fmt(x.rmse)}</td><td>${fmt(x.max_abs)}</td><td>${fmt(x.loa_low)} ~ ${fmt(x.loa_high)}</td><td>${fmt(x.r, 3)}</td></tr>`).join('');
    ba = (name) => { const x = v.result.columns[name]; return { name, pts: x.ba || [], x }; };
  } else {
    rows = Object.entries(v.result.groups).map(([g, x]) => ({ name: g.replace('|', ' · '), key: g, ...x }));
    $('#valTable').innerHTML = '<tr><th>항목</th><th>n</th><th>편향</th><th>MAE</th><th>95% 일치한계</th><th>ICC(2,1) [95% CI]</th><th>해석</th></tr>' +
      rows.map((x) => `<tr data-ba="${esc(x.key)}"><td>${esc(x.name)}</td><td>${x.n}</td><td>${fmt(x.bias)}</td><td>${fmt(x.mae)}</td><td>${fmt(x.loa_low)} ~ ${fmt(x.loa_high)}</td><td>${fmt(x.icc?.icc2_1?.value, 3)} [${fmt(x.icc?.icc2_1?.ci?.[0], 2)}, ${fmt(x.icc?.icc2_1?.ci?.[1], 2)}]</td><td>${esc(x.icc?.interpretation || '')}</td></tr>`).join('');
    ba = (key) => { const x = v.result.groups[key]; return { name: key.replace('|', ' · '), pts: x.points.map((p) => [(p.test + p.ref) / 2, p.test - p.ref]), x }; };
  }
  const pick = (k) => { const b = ba(k); $('#valBaName').textContent = '· ' + b.name; drawBA($('#valBa'), b.pts, b.x); document.querySelectorAll('#valTable [data-ba]').forEach((r) => r.classList.toggle('on', r.dataset.ba === k)); };
  document.querySelectorAll('#valTable [data-ba]').forEach((r) => { r.style.cursor = 'pointer'; r.onclick = () => pick(r.dataset.ba); });
  const first = document.querySelector('#valTable [data-ba]');
  if (first) pick(first.dataset.ba);
  valRefresh();
}

function drawBA(c, pts, x) {
  const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  if (!pts.length) return;
  const L = 48, T = 10, w = W - L - 12, h = H - 34;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]).concat([x.loa_low, x.loa_high, 0].filter(isFinite));
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const px = (x1 - x0) * 0.05 || 1, py = (y1 - y0) * 0.1 || 1; x0 -= px; x1 += px; y0 -= py; y1 += py;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * w, Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * h;
  const css = getComputedStyle(document.documentElement);
  g.strokeStyle = css.getPropertyValue('--line'); g.fillStyle = css.getPropertyValue('--muted'); g.font = '11px system-ui';
  for (let i = 0; i <= 4; i++) { const v = y0 + (i / 4) * (y1 - y0); g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + w, Y(v)); g.stroke(); g.fillText(v.toFixed(1), 4, Y(v) + 4); }
  for (let i = 0; i <= 5; i++) { const v = x0 + (i / 5) * (x1 - x0); g.fillText(v.toFixed(0), X(v) - 8, H - 8); }
  g.fillStyle = PALETTE[0] + 'aa';
  for (const [a, b] of pts) { g.beginPath(); g.arc(X(a), Y(b), 2.5, 0, 7); g.fill(); }
  const line = (v, dash, color, label) => {
    if (!isFinite(v)) return;
    g.save(); g.setLineDash(dash); g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + w, Y(v)); g.stroke();
    g.fillStyle = color; g.fillText(`${label} ${v.toFixed(2)}`, L + w - 110, Y(v) - 4); g.restore();
  };
  line(x.bias, [], PALETTE[1], '편향');
  line(x.loa_high, [5, 4], PALETTE[2], '+1.96SD');
  line(x.loa_low, [5, 4], PALETTE[2], '−1.96SD');
}

$('#valTestFrom').onchange = (e) => { const f = e.target.value === 'file'; $('#valFileLbl').hidden = !f; $('#valTrialLbl').hidden = f; };

async function valSubmit(form, url, extra) {
  $('#valErr').textContent = '';
  const fd = new FormData(form);
  if (extra) extra(fd);
  try {
    const r = await fetch(url, { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail || r.statusText));
    await valShow(j.id);
  } catch (e) { $('#valErr').textContent = e.message; }
}

$('#valSeriesForm').onsubmit = (e) => {
  e.preventDefault();
  valSubmit(e.target, '/api/validation/series', (fd) => {
    const fromFile = fd.get('testFrom') === 'file';
    fd.delete('testFrom');
    if (fromFile) return;
    fd.delete('test_file');
    const [sid, tid] = ($('#valTrial').value || '|').split('|');
    fd.set('session', sid); fd.set('trial', tid);
  });
};
$('#valDiscreteForm').onsubmit = (e) => { e.preventDefault(); valSubmit(e.target, '/api/validation/discrete'); };

document.querySelector('.tabs button[data-tab="validation"]').addEventListener('click', () => { valLoadTrials().catch(() => {}); valRefresh().catch((e) => ($('#valErr').textContent = e.message)); });
