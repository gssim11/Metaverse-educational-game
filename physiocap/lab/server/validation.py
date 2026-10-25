"""정확도 검증 통계: PhysioCap 결과 vs 기준 장비(모캡·IMU·고니오미터·지면반력판).

- 시계열 비교: 교차상관으로 시간 맞춤 → 관절별 편향·MAE·RMSE·최대오차·상관·Bland–Altman 일치한계
- 이산값 비교(예: 고니오미터로 잰 최대 굴곡각): 편향·MAE·일치한계 + ICC(2,1)·ICC(3,1) 과 95% 신뢰구간

근거: Bland & Altman 1986 (Lancet 1:307–310, 일치한계 = 편향 ± 1.96 SD),
      Shrout & Fleiss 1979 (Psychol Bull 86:420–428, ICC 정의),
      Koo & Li 2016 (J Chiropr Med 15:155–163, ICC 형태 선택·해석 기준),
      OpenCap: Uhlrich et al. 2023 (PLoS Comput Biol 19:e1011462, 관절각 MAE 4.5°).
"""
from __future__ import annotations

import csv
import io
import math
from pathlib import Path

import numpy as np

import layout as L

# OpenCap 논문 표(2대 카메라, HRNet) 동작별 회전 자유도 MAE(°) — PubMed Central 원문에서 확인한 값
OPENCAP_BENCHMARK_MAE_DEG = {"walking": 4.1, "squats": 4.1, "sit_to_stand": 4.7, "drop_jump": 5.1, "mean": 4.5}
OPENCAP_BENCHMARK_GRF_MAE_BW = 6.2  # 지면반력 MAE(% 체중), 같은 논문 요약

# PhysioCap 모바일(폰 1대) CSV 열 → OpenSim 좌표 이름, 부호
MOBILE_TO_OPENSIM = {
    "kneeFlexR": ("knee_angle_r", 1), "kneeFlexL": ("knee_angle_l", 1),
    "hipFlexR": ("hip_flexion_r", 1), "hipFlexL": ("hip_flexion_l", 1),
    "hipAddR": ("hip_adduction_r", 1), "hipAddL": ("hip_adduction_l", 1),
    "hipRotR": ("hip_rotation_r", 1), "hipRotL": ("hip_rotation_l", 1),
    "ankleDfR": ("ankle_angle_r", 1), "ankleDfL": ("ankle_angle_l", 1),
    "lumbarFlex": ("lumbar_extension", -1), "lumbarBend": ("lumbar_bending", 1),
    "pelvicObliq": ("pelvis_list", 1), "elbowFlexR": ("elbow_flex_r", 1), "elbowFlexL": ("elbow_flex_l", 1),
}

TRANSLATIONS = ("pelvis_tx", "pelvis_ty", "pelvis_tz")


# ---------------------------------------------------------------- 파일 읽기
def read_table(text: str, name: str = "") -> dict:
    """.mot/.sto(OpenSim) 또는 .csv 내용 → {"time": [...], "cols": {이름: [...]}}.

    CSV 는 time·time_s·t 열(없으면 첫 열)을 시간으로 쓴다. PhysioCap 모바일 각도 CSV 는 OpenSim 이름·부호로 바꾼다.
    """
    text = text.lstrip("\ufeff")
    if name.lower().endswith((".mot", ".sto")) or "endheader" in text[:4000].lower():
        m = L.read_mot_text(text)
        cols, data = m["columns"], np.array(m["data"], dtype=float)
    else:
        rows = list(csv.reader(io.StringIO(text)))
        cols = [c.strip() for c in rows[0]]
        data = np.array([[float(x) if x.strip() not in ("", "nan", "NaN") else np.nan for x in r]
                         for r in rows[1:] if r and any(x.strip() for x in r)], dtype=float)
    if data.ndim != 2 or data.shape[0] < 2:
        raise ValueError("데이터 행이 부족합니다.")
    tcol = next((i for i, c in enumerate(cols) if c.lower() in ("time", "time_s", "t", "sec", "seconds")), 0)
    out = {"time": data[:, tcol].tolist(), "cols": {}}
    mobile = any(c in MOBILE_TO_OPENSIM for c in cols)
    for i, c in enumerate(cols):
        if i == tcol:
            continue
        if mobile:
            if c in MOBILE_TO_OPENSIM:
                nm, sign = MOBILE_TO_OPENSIM[c]
                out["cols"][nm] = (sign * data[:, i]).tolist()
        else:
            out["cols"][c] = data[:, i].tolist()
    return out


# ---------------------------------------------------------------- 시간 맞춤
def align(test: dict, ref: dict, column: str, max_lag_s: float = 5.0, step_s: float = 0.005) -> dict:
    """시간 차이 lag(초) 추정: 기준 장비 시각 τ 가 PhysioCap 시각 τ + lag 에 해당.

    lag 후보마다 기준 신호를 PhysioCap 시간축(t - lag)에 보간하고, 평균을 뺀 상관계수가 최대인 lag 를 고른다.
    """
    tt = np.asarray(test["time"], float)
    a = np.asarray(test["cols"][column], float)
    rt = np.asarray(ref["time"], float)
    b = np.asarray(ref["cols"][column], float)
    okb = np.isfinite(b)
    best, best_r = 0.0, -np.inf
    for lag in np.arange(-max_lag_s, max_lag_s + 1e-12, step_s):
        bi = np.interp(tt - lag, rt[okb], b[okb], left=np.nan, right=np.nan)
        m = np.isfinite(bi) & np.isfinite(a)
        if m.sum() < 20 or (tt[m][-1] - tt[m][0]) < 1.0:  # 1초 이상 겹쳐야 함
            continue
        x, y = a[m] - a[m].mean(), bi[m] - bi[m].mean()
        den = math.sqrt(float((x * x).sum() * (y * y).sum()))
        r = float((x * y).sum() / den) if den else -np.inf
        if r > best_r:
            best, best_r = float(lag), r
    return {"lag_s": round(best, 4), "r": best_r, "column": column}


# ---------------------------------------------------------------- 시계열 비교
def agreement(diff: np.ndarray, test: np.ndarray, ref: np.ndarray) -> dict:
    d = diff[np.isfinite(diff)]
    n = int(d.size)
    if n < 2:
        return {"n": n}
    bias = float(d.mean())
    sd = float(d.std(ddof=1))
    ok = np.isfinite(test) & np.isfinite(ref)
    r = float(np.corrcoef(test[ok], ref[ok])[0, 1]) if ok.sum() > 2 and np.std(test[ok]) > 0 and np.std(ref[ok]) > 0 else None
    return {"n": n, "bias": bias, "sd": sd, "mae": float(np.abs(d).mean()), "rmse": float(np.sqrt((d ** 2).mean())),
            "max_abs": float(np.abs(d).max()), "loa_low": bias - 1.96 * sd, "loa_high": bias + 1.96 * sd, "r": r}


def compare_series(test: dict, ref: dict, columns: list[str] | None = None, align_on: str | None = None,
                   window: list[float] | None = None, fs: float = 100.0, max_lag_s: float = 5.0,
                   remove_offset: bool = False, unit: str = "deg", ba_points: int = 300) -> dict:
    """관절별 일치도. 각도 단위는 입력 그대로(.mot inDegrees=yes 면 도), 평행이동(pelvis_t*)은 m → mm 로 보고.

    unit 은 회전 열의 단위 이름(지면반력 비교면 "%BW"). ba_points 는 Bland–Altman 그림용으로 남길 점 수.
    """
    common = [c for c in (columns or sorted(set(test["cols"]) & set(ref["cols"]))) if c in test["cols"] and c in ref["cols"]]
    if not common:
        raise ValueError("두 파일에 공통 관절(열) 이름이 없습니다.")
    al = None
    lag = 0.0
    if align_on:
        al = align(test, ref, align_on, max_lag_s=max_lag_s)
        lag = al["lag_s"]
    t0 = max(test["time"][0], ref["time"][0] + lag)
    t1 = min(test["time"][-1], ref["time"][-1] + lag)
    if window:
        t0, t1 = max(t0, window[0]), min(t1, window[1])
    if t1 - t0 < 0.2:
        raise ValueError("겹치는 시간 구간이 너무 짧습니다(정렬 기준 관절·구간을 확인하세요).")
    tt = np.arange(t0, t1 + 1e-9, 1.0 / fs)
    per = {}
    for c in common:
        a = np.interp(tt, np.asarray(test["time"]), np.asarray(test["cols"][c], float), left=np.nan, right=np.nan)
        b = np.interp(tt - lag, np.asarray(ref["time"]), np.asarray(ref["cols"][c], float), left=np.nan, right=np.nan)
        if remove_offset:  # 정적 자세 차이(영점) 제거 후 동적 오차만 보려는 경우
            b = b + (np.nanmean(a) - np.nanmean(b))
        scale = 1000.0 if c in TRANSLATIONS else 1.0
        res = agreement((a - b) * scale, a * scale, b * scale)
        res["unit"] = "mm" if c in TRANSLATIONS else unit
        ok = np.isfinite(a) & np.isfinite(b)
        if ok.any() and ba_points:
            idx = np.flatnonzero(ok)[np.linspace(0, ok.sum() - 1, min(ba_points, int(ok.sum()))).astype(int)]
            res["ba"] = [[round(float((a[i] + b[i]) / 2 * scale), 3), round(float((a[i] - b[i]) * scale), 3)] for i in idx]
        per[c] = res
    rot = [v["mae"] for c, v in per.items() if v.get("mae") is not None and c not in TRANSLATIONS]
    tra = [v["mae"] for c, v in per.items() if v.get("mae") is not None and c in TRANSLATIONS]
    return {"alignment": al, "window": [float(t0), float(t1)], "fs": fs, "columns": per,
            "summary": {"rotations_mae_mean": float(np.mean(rot)) if rot else None, "n_rotations": len(rot),
                        "translations_mae_mean_mm": float(np.mean(tra)) if tra else None}}


# ---------------------------------------------------------------- 이산값 비교 + ICC
def _f_ppf(q: float, d1: float, d2: float) -> float:
    from scipy.stats import f
    return float(f.ppf(q, d1, d2))


def icc(test: list[float], ref: list[float], alpha: float = 0.05) -> dict:
    """두 측정법(PhysioCap vs 기준 장비)의 ICC."""
    return icc_matrix(np.column_stack([np.asarray(test, float), np.asarray(ref, float)]), alpha)


def icc_matrix(Y, alpha: float = 0.05) -> dict:
    """대상 n × 측정자 k 행렬의 ICC. ICC(2,1)=두 방향 무작위·절대 일치, ICC(3,1)=두 방향 혼합·일관성 (Shrout & Fleiss 1979)."""
    Y = np.asarray(Y, float)
    Y = Y[np.all(np.isfinite(Y), axis=1)]
    n, k = Y.shape
    if n < 3:
        return {"n": n}
    gm = Y.mean()
    ssr = k * ((Y.mean(axis=1) - gm) ** 2).sum()
    ssc = n * ((Y.mean(axis=0) - gm) ** 2).sum()
    sst = ((Y - gm) ** 2).sum()
    sse = sst - ssr - ssc
    msr, msc, mse = ssr / (n - 1), ssc / (k - 1), sse / ((n - 1) * (k - 1))
    out = {"n": int(n)}
    # ICC(3,1)
    i31 = (msr - mse) / (msr + (k - 1) * mse)
    fo = msr / mse if mse > 0 else math.inf
    fl = fo / _f_ppf(1 - alpha / 2, n - 1, (n - 1) * (k - 1))
    fu = fo * _f_ppf(1 - alpha / 2, (n - 1) * (k - 1), n - 1)
    out["icc3_1"] = {"value": float(i31), "ci": [float((fl - 1) / (fl + k - 1)), float((fu - 1) / (fu + k - 1))]}
    # ICC(2,1) — 신뢰구간은 McGraw & Wong 의 근사 자유도
    i21 = (msr - mse) / (msr + (k - 1) * mse + k * (msc - mse) / n)
    a = k * i21 / (n * (1 - i21))
    b = 1 + k * i21 * (n - 1) / (n * (1 - i21))
    v = (a * msc + b * mse) ** 2 / ((a * msc) ** 2 / (k - 1) + (b * mse) ** 2 / ((n - 1) * (k - 1)))
    fl2 = _f_ppf(1 - alpha / 2, n - 1, v)
    fu2 = _f_ppf(1 - alpha / 2, v, n - 1)
    lo = n * (msr - fl2 * mse) / (fl2 * (k * msc + (k * n - k - n) * mse) + n * msr)
    hi = n * (fu2 * msr - mse) / (k * msc + (k * n - k - n) * mse + n * fu2 * msr)
    out["icc2_1"] = {"value": float(i21), "ci": [float(lo), float(hi)]}
    out["interpretation"] = interpret_icc(out["icc2_1"]["ci"][0], out["icc2_1"]["ci"][1])
    return out


def interpret_icc(lo: float, hi: float) -> str:
    """Koo & Li 2016: 95% 신뢰구간 기준 <0.5 낮음, 0.5–0.75 보통, 0.75–0.9 좋음, >0.9 매우 좋음."""
    def cat(x):
        return "낮음" if x < 0.5 else "보통" if x < 0.75 else "좋음" if x < 0.9 else "매우 좋음"
    a, b = cat(lo), cat(hi)
    return a if a == b else f"{a}~{b}"


def average_repeats(rows: list[dict]) -> list[dict]:
    """같은 대상자의 반복 측정을 평균해 대상자당 한 쌍으로 만든다.

    반복 측정을 서로 다른 사람처럼 세면 n 과 ICC 가 부풀려진다. subject 가 빈 행은 각각 독립으로 둔다.
    """
    out: dict[str, dict] = {}
    for i, r in enumerate(rows):
        key = r.get("subject") or f"_row{i}"
        o = out.setdefault(key, {"label": r.get("subject", ""), "t": [], "r": []})
        o["t"].append(float(r["test"]))
        o["r"].append(float(r["ref"]))
    return [{"label": o["label"], "test": float(np.mean(o["t"])), "ref": float(np.mean(o["r"])), "repeats": len(o["t"])}
            for o in out.values()]


def compare_discrete(rows: list[dict]) -> dict:
    """rows: [{"label":…, "test":…, "ref":…}] (같은 측정 항목끼리 묶어서 호출)."""
    t = np.array([r["test"] for r in rows], float)
    ref = np.array([r["ref"] for r in rows], float)
    res = agreement(t - ref, t, ref)
    res["icc"] = icc(t.tolist(), ref.tolist())
    res["points"] = [{"label": r.get("label", ""), "test": float(a), "ref": float(b), "repeats": r.get("repeats", 1)}
                     for r, a, b in zip(rows, t, ref)]
    return res


def loa_ci_halfwidth(sd: float, n: int) -> float:
    """일치한계의 95% 신뢰구간 반폭 근사: 1.96 × √(3 SD²/n) (Bland & Altman 1986)."""
    return 1.96 * math.sqrt(3 * sd * sd / n)


def n_for_loa_precision(sd: float, halfwidth: float) -> int:
    """일치한계 신뢰구간 반폭을 halfwidth 이하로 만들 데 필요한 쌍 수(위 근사식을 n 에 대해 푼 값)."""
    return int(math.ceil(3 * (1.96 * sd / halfwidth) ** 2))


def value_at(series: dict, column: str, mode: str, t: float | None = None, window: list[float] | None = None) -> float:
    """시계열에서 고니오미터 비교용 값 하나: at(시점), max, min, mean (구간 내)."""
    tt = np.asarray(series["time"], float)
    y = np.asarray(series["cols"][column], float)
    if window:
        m = (tt >= window[0]) & (tt <= window[1])
        tt, y = tt[m], y[m]
    if mode == "at":
        return float(np.interp(t, tt, y))
    fn = {"max": np.nanmax, "min": np.nanmin, "mean": np.nanmean}[mode]
    return float(fn(y))


def series_from_summary(summary: dict, key: str = "GRF_BW") -> dict:
    """동역학 요약(physiocap_summary.json)의 한 항목 → read_table 과 같은 형태."""
    item = summary["series"][key]
    t = summary["time"]
    cols = {lab: list(v)[:len(t)] for lab, v in item["data"].items()}
    n = min([len(t)] + [len(v) for v in cols.values()])
    return {"time": list(t)[:n], "cols": {k: v[:n] for k, v in cols.items()}}


def aggregate(results: list[dict]) -> dict:
    """여러 시행의 시계열 비교 결과 → 동작·관절별 평균 MAE (OpenCap 논문 값과 나란히)."""
    by: dict[str, dict[str, list[float]]] = {}
    for r in results:
        if r.get("kind") != "series" or r.get("source") != "kinematics":
            continue
        act = r.get("activity") or "other"
        for c, v in r["result"]["columns"].items():
            if v.get("mae") is not None and c not in TRANSLATIONS:
                by.setdefault(act, {}).setdefault(c, []).append(v["mae"])
    out = {}
    for act, cols in by.items():
        per = {c: {"mae_mean": float(np.mean(v)), "n_trials": len(v)} for c, v in sorted(cols.items())}
        allm = [x["mae_mean"] for x in per.values()]
        out[act] = {"columns": per, "rotations_mae_mean": float(np.mean(allm)) if allm else None,
                    "opencap_benchmark_mae": OPENCAP_BENCHMARK_MAE_DEG.get(act)}
    return {"activities": out, "opencap_benchmark_mae_mean": OPENCAP_BENCHMARK_MAE_DEG["mean"],
            "opencap_benchmark_grf_mae_bw": OPENCAP_BENCHMARK_GRF_MAE_BW}
