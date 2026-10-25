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
sys.path.insert(0, str(Path(__file__).resolve().parent))

import layout as L  # noqa: E402
from store import claim_job, finish_job, update_running  # noqa: E402

# 결과 요약에 넣을 항목: (키, 라벨 키, 단위 설명)
SERIES = [
    ("GRF_BW", "GRF_labels", "% 체중"),
    ("GRF", "GRF_labels", "N"),
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


def loop() -> None:
    print("PhysioCap kinetics worker ready", DATA, flush=True)
    while True:
        job = claim_job(DATA, {"kinetics"})
        if not job:
            time.sleep(1.0)
            continue
        print("job", job["id"], job["session"], job["trial"], job["motion_type"], flush=True)
        try:
            finish_job(DATA, job, ok=True, outputs=run_kinetics(job))
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            msg = e.args[0] if e.args and isinstance(e.args[0], str) else repr(e)
            finish_job(DATA, job, ok=False, error=msg[:2000], traceback=traceback.format_exc()[-6000:])


if __name__ == "__main__":
    loop()
