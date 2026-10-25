"""opencap-processing 워커: 근육 구동 동역학 시뮬레이션(OpenSimAD + CasADi)으로
지면반력·관절 모멘트·근활성을 계산한다. example_kinetics.py 와 같은 함수·인자를 쓴다.

kinematics(.mot)·스케일 모델·sessionMetadata.yaml 이 이미 <DATA>/Data/<session>/ 에 있으므로
OpenCap 클라우드에서 내려받지 않는다(processInputsOpenSimAD 는 파일이 있으면 다운로드를 건너뜀).
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

PROC_DIR = Path(os.environ.get("OPENCAP_PROCESSING_DIR", "/opencap-processing"))
DATA = Path(os.environ.get("PHYSIOCAP_DATA", "/data/physiocap"))
sys.path.insert(0, str(PROC_DIR))
sys.path.insert(0, str(PROC_DIR / "UtilsDynamicSimulations" / "OpenSimAD"))
sys.path.insert(0, str(PROC_DIR / "ActivityAnalyses"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import layout as L  # noqa: E402
from store import claim_job, finish_job, requeue_orphans, update_running  # noqa: E402

# 결과 요약에 넣을 항목: (키, 라벨 키, 단위 설명)
SERIES = [
    ("GRF_BW", "GRF_labels", "% 체중"),
    ("GRF", "GRF_labels", "N"),
    ("COP", "COP_labels", "m"),  # 압력중심(지면 좌표) — 3D 뷰어의 지면반력 화살표 위치
    ("torques_BWht", "torque_labels", "% 체중×키"),
    ("torques", "torque_labels", "Nm"),
    ("muscle_activations", "muscles", "0–1"),
    ("muscle_forces", "muscles", "N"),
    ("KAM_BWht", "KAM_labels", "% 체중×키"),
    ("MCF_BW", "MCF_labels", "체중 배수"),
    ("coordinate_values", "coordinates", "도 또는 m"),
    ("coordinate_values_toTrack", "coordinates", "도 또는 m"),
]


def _to_list(x):
    import numpy as np
    a = np.asarray(x, dtype=float)
    return np.where(np.isfinite(a), a, None).tolist()


def summarize(result: dict, case: str) -> dict:
    """optimaltrajectories.npy[case] → 대시보드용 JSON (시간축 + 항목별 {라벨: 값 배열})."""
    import numpy as np
    out = {"case": case, "time": _to_list(np.ravel(result["time"])), "series": {}, "iterations": int(result.get("iter", -1))}
    nt = len(out["time"])
    for key, lab_key, unit in SERIES:
        if key not in result or lab_key not in result:
            continue
        arr = np.asarray(result[key], dtype=float)
        labels = list(result[lab_key])
        if arr.ndim == 1:
            arr = arr[None, :]
        if arr.shape[0] != len(labels) and arr.shape[1] == len(labels):
            arr = arr.T
        if arr.shape[0] != len(labels):
            continue
        # 시간축 길이가 다르면(제어 격자 vs 상태 격자) 앞쪽부터 맞춘다
        n = min(arr.shape[1], nt)
        out["series"][key] = {"unit": unit, "labels": labels, "data": {lab: _to_list(arr[i, :n]) for i, lab in enumerate(labels)}}
    return out


def run_kinetics(job: dict) -> dict:
    import numpy as np
    from mainOpenSimAD import run_tracking
    from utilsOpenSimAD import processInputsOpenSimAD

    sid, tid = job["session"], job["trial"]
    case = str(job.get("case", "0"))
    data_folder = str(DATA / "Data")
    if not L.kinematics_mot(DATA, sid, tid).exists():
        raise RuntimeError("관절각(.mot)이 없습니다. 운동학 처리를 먼저 하세요.")
    tw = job.get("time_window") or None
    rep = job.get("repetition")
    update_running(DATA, job, stage="입력 준비(근육 경로·접촉 모델·외부 함수 빌드)")
    settings = processInputsOpenSimAD(str(PROC_DIR), data_folder, sid, tid, job["motion_type"],
                                      tw, rep, 0, "all")
    update_running(DATA, job, stage="최적 제어 문제 풀이 중(수 분~수십 분)")
    run_tracking(str(PROC_DIR), data_folder, sid, settings, case=case, solveProblem=True, analyzeResults=True)
    # mainOpenSimAD: 반복 번호를 주면 Dynamics/<trial>_rep<n>/ 에 저장
    res_dir = L.dynamics_dir(DATA, sid, tid if rep is None else f"{tid}_rep{rep}")
    npy = res_dir / "optimaltrajectories.npy"
    if not npy.exists():
        cands = list((L.session_dir(DATA, sid) / "OpenSimData" / "Dynamics").rglob("optimaltrajectories.npy"))
        if not cands:
            raise RuntimeError("시뮬레이션 결과(optimaltrajectories.npy)가 없습니다. 최적화가 수렴하지 않았을 수 있습니다.")
        npy = cands[0]
        res_dir = npy.parent
    allres = np.load(npy, allow_pickle=True).item()
    summary = summarize(allres[case], case)
    summary.update(motion_type=job["motion_type"], repetition=rep, time_window=tw,
                   note="OpenCap 저자들은 이 동역학 예제 설정의 생체역학적 타당성을 검증하지 않았다고 밝혔습니다(example_kinetics.py).")
    L.dynamics_dir(DATA, sid, tid).mkdir(parents=True, exist_ok=True)
    with open(L.dynamics_dir(DATA, sid, tid) / "physiocap_summary.json", "w") as f:
        json.dump(summary, f, ensure_ascii=False)
    return {"result_dir": str(res_dir.relative_to(DATA)), "series": sorted(summary["series"]), "iterations": summary["iterations"]}


# ---------------------------------------------------------------- 동작 지표 분석 (opencap-processing/ActivityAnalyses)
# compute_<이름> 메서드 이름 그대로. example_gait_analysis.py / example_sts_analysis.py 의 기본 목록 + 나머지 스칼라 지표
GAIT_SCALARS = ["gait_speed", "stride_length", "step_length", "step_length_symmetry", "step_width", "cadence",
                "stance_time", "swing_time", "single_support_time", "double_support_time",
                "midswing_dorsiflexion_angle", "midswing_ankle_heigh_dif"]
STS_SCALARS = ["rise_time", "sts_time", "torso_orientation", "torso_angular_velocity",
               "torso_orientation_liftoff", "torso_angular_velocity_liftoff"]


def mirror_opencap_download_layout(sid: str, tid: str) -> None:
    """OpenCap 클라우드에서 내려받은 세션과 같은 위치에 파일을 둔다.

    클라우드는 MarkerData/PostAugmentation/<trial>.trc 와 Settings_<trial>.yaml 을 올리고,
    opencap-processing 은 이를 MarkerData/<trial>.trc, MarkerData/Settings/settings_<trial>.yaml 로 받아 쓴다.
    """
    import shutil
    sd = L.session_dir(DATA, sid)
    src = sd / "MarkerData" / "PostAugmentation" / f"{tid}.trc"
    if not src.exists():
        raise RuntimeError("보강된 마커 데이터(TRC)가 없습니다. 운동학 처리를 먼저 하세요.")
    shutil.copy2(src, sd / "MarkerData" / f"{tid}.trc")
    st = sd / "MarkerData" / "PostAugmentation" / f"Settings_{tid}.yaml"
    if st.exists():
        (sd / "MarkerData" / "Settings").mkdir(parents=True, exist_ok=True)
        shutil.copy2(st, sd / "MarkerData" / "Settings" / f"settings_{tid}.yaml")


def _num(v):
    import numpy as np
    if isinstance(v, dict):  # 예: step_length → {'r': .., 'l': ..}
        return {str(k): _num(x) for k, x in v.items()}
    a = np.asarray(v, dtype=float)
    if a.ndim == 0:
        return float(a) if np.isfinite(a) else None
    return [float(x) if np.isfinite(x) else None for x in a.ravel()]


def _scalars(obj, names) -> dict:
    out = {}
    for n in names:
        try:
            mean = obj.compute_scalars([n])[n]
            entry = {"value": _num(mean["value"]), "units": mean["units"]}
            try:
                entry["per_cycle"] = _num(obj.compute_scalars([n], return_all=True)[n]["value"])
            except Exception:  # noqa: BLE001
                pass
            out[n] = entry
        except Exception as e:  # noqa: BLE001  — 한 지표가 실패해도 나머지는 계산
            out[n] = {"value": None, "units": "", "error": str(e)[:200]}
    return out


def _curves(norm: dict) -> dict:
    cols = list(norm["mean"].columns)
    keep = [c for c in cols if c != "time"]
    return {"x": list(range(101)), "mean": {c: _num(norm["mean"][c]) for c in keep},
            "sd": {c: _num(norm["sd"][c]) for c in keep} if norm.get("sd") is not None else None}


def run_activity(job: dict) -> dict:
    sid, tid, kind = job["session"], job["trial"], job["analysis"]
    sd = str(L.session_dir(DATA, sid))
    mirror_opencap_download_layout(sid, tid)
    update_running(DATA, job, stage=f"{kind} 지표 분석")
    out = {"analysis": kind, "trial": tid, "source": "opencap-processing ActivityAnalyses"}
    if kind == "gait":
        from gait_analysis import gait_analysis
        out["legs"] = {}
        for leg in ("r", "l"):
            try:
                g = gait_analysis(sd, tid, leg=leg, lowpass_cutoff_frequency_for_coordinate_values=6, n_gait_cycles=-1)
                ev = g.gaitEvents
                out["legs"][leg] = {
                    "n_cycles": int(g.nGaitCycles),
                    "scalars": _scalars(g, GAIT_SCALARS),
                    "curves": _curves(g.get_coordinates_normalized_time()),
                    "events": {"names": list(ev.get("eventNamesIpsilateral", [])),
                               "times": _num(ev["ipsilateralTime"]) if "ipsilateralTime" in ev else None},
                }
            except Exception as e:  # noqa: BLE001
                out["legs"][leg] = {"error": str(e)[:500]}
        if all("error" in v for v in out["legs"].values()):
            raise RuntimeError("보행 주기를 찾지 못했습니다: " + out["legs"]["r"]["error"])
    elif kind == "sts":
        from sts_analysis import sts_analysis
        s = sts_analysis(sd, tid, n_sts_cycles=-1, lowpass_cutoff_frequency_for_coordinate_values=6)
        t = s.coordinateValues["time"].to_numpy()
        ev = {k: [float(t[i]) for i in s.stsEvents[k]] for k in ("startRisingIdx", "endRisingIdx", "sittingIdx", "forwardLeanIdx") if k in s.stsEvents}
        out.update(n_cycles=int(s.n_sts_cycles), scalars=_scalars(s, STS_SCALARS), events=ev)
    else:
        raise ValueError(f"unknown analysis {kind}")
    dst = L.session_dir(DATA, sid) / "OpenSimData" / "Activity" / tid
    dst.mkdir(parents=True, exist_ok=True)
    with open(dst / "physiocap_activity.json", "w") as f:
        json.dump(out, f, ensure_ascii=False)
    return {"analysis": kind, "file": str((dst / "physiocap_activity.json").relative_to(DATA))}


def loop() -> None:
    print("PhysioCap kinetics worker ready", DATA, flush=True)
    orphans = requeue_orphans(DATA, {"activity", "kinetics"})  # 컨테이너 재시작으로 중단된 작업을 다시 대기열로
    if orphans:
        print("requeued interrupted jobs", orphans, flush=True)
    while True:
        job = claim_job(DATA, {"activity", "kinetics"})
        if not job:
            time.sleep(1.0)
            continue
        print("job", job["id"], job["kind"], job["session"], job["trial"], job.get("motion_type") or job.get("analysis"), flush=True)
        try:
            outputs = run_activity(job) if job["kind"] == "activity" else run_kinetics(job)
            finish_job(DATA, job, ok=True, outputs=outputs)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            msg = e.args[0] if e.args and isinstance(e.args[0], str) else repr(e)
            finish_job(DATA, job, ok=False, error=msg[:2000], traceback=traceback.format_exc()[-6000:])


if __name__ == "__main__":
    loop()
