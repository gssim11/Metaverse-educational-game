"""opencap-core 워커: PhysioCap 서버의 작업 큐에서 core/intrinsics 작업을 가져와 OpenCap 원본 함수로 처리한다.

opencap-core 컨테이너(/workspace = opencap-core 저장소) 안에서 실행된다.
OpenCap 코드는 수정하지 않고, 클라우드 버전(utilsServer.processTrial)과 같은 인자로 main() 을 호출한다.
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import sys
import time
import traceback
from pathlib import Path

OPENCAP_DIR = Path(os.environ.get("OPENCAP_CORE_DIR", "/workspace"))
DATA = Path(os.environ.get("PHYSIOCAP_DATA", "/data/physiocap"))
sys.path.insert(0, str(OPENCAP_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import layout as L  # noqa: E402
from store import claim_job, finish_job, requeue_orphans, update_running  # noqa: E402

DEFAULT_SETTINGS = json.loads((OPENCAP_DIR / "defaultOpenCapSettings.json").read_text()) if (OPENCAP_DIR / "defaultOpenCapSettings.json").exists() else {"openpose": "1x736", "hrnet": 0.8}


def link_intrinsics() -> None:
    """서버가 만든 갤럭시 렌즈 보정값을 opencap-core 가 찾는 위치(CameraIntrinsics/<기종>)에 연결."""
    src_root = DATA / "intrinsics"
    dst_root = OPENCAP_DIR / "CameraIntrinsics"
    if not src_root.exists():
        return
    for d in src_root.iterdir():
        dst = dst_root / d.name
        if not dst.exists():
            os.symlink(d, dst, target_is_directory=True)


def pose_settings(detector: str) -> dict:
    det = (detector or "hrnet").lower()
    if det == "openpose":
        return {"poseDetector": "OpenPose", "resolutionPoseDetection": DEFAULT_SETTINGS.get("openpose", "1x736"), "bbox_thr": 0.8}
    return {"poseDetector": "hrnet", "resolutionPoseDetection": "default", "bbox_thr": float(DEFAULT_SETTINGS.get("hrnet", 0.8))}


def delete_calibration_files(session: str) -> None:
    """utilsServer.deleteCalibrationFiles 와 같은 동작: 이전 외부 파라미터를 지운다."""
    vids = L.session_dir(DATA, session) / "Videos"
    for p in glob.glob(str(vids / "Cam*" / "cameraIntrinsicsExtrinsics*.pickle")):
        os.remove(p)
    for p in vids.rglob("cameraIntrinsicsExtrinsics_soln*.pickle"):
        p.unlink()
    shutil.rmtree(L.session_dir(DATA, session) / "CalibrationImages", ignore_errors=True)


def calibration_options(session: str) -> dict | None:
    from utils import loadCameraParameters
    files = L.calibration_solution_files(DATA, session)
    if not files:
        return None
    return {cam: [loadCameraParameters(str(p)) for p in sorted(ps)] for cam, ps in files.items()}


def list_outputs(session: str, trial: str) -> dict:
    sd = L.session_dir(DATA, session)
    rel = lambda p: str(Path(p).relative_to(DATA))  # noqa: E731
    out = {
        "trc": [rel(p) for p in sd.glob(f"MarkerData/**/{trial}*.trc")],
        "mot": [rel(p) for p in sd.glob(f"OpenSimData/Kinematics/{trial}*.mot")],
        "model": [rel(p) for p in sd.glob("OpenSimData/Model/*.osim")],
        "calibration_images": [rel(p) for p in sd.glob("CalibrationImages/*.jpg")],
        "visualizer": [rel(p) for p in sd.glob(f"VisualizerJsons/{trial}/*.json")],
    }
    return {k: v for k, v in out.items() if v}


def run_core(job: dict) -> dict:
    from main import main

    sid, tid, ttype = job["session"], job["trial"], job["trial_type"]
    ps = pose_settings(job.get("pose_detector", "hrnet"))
    common = dict(isDocker=True, imageUpsampleFactor=4, genericFolderNames=True, cameras_to_use=["all"], dataDir=str(DATA))
    update_running(DATA, job, stage=f"{ttype}: OpenCap 처리 중")
    if ttype == "calibration":
        delete_calibration_files(sid)
        main(sid, L.CALIBRATION, L.CALIBRATION, extrinsicsTrial=True, **common)
    elif ttype == "neutral":
        main(sid, L.NEUTRAL, L.NEUTRAL, extrinsicsTrial=False, scaleModel=True,
             calibrationOptions=calibration_options(sid), **ps, **common)
        if not L.scaled_model_exists(DATA, sid):
            raise RuntimeError("체형 스케일링 모델이 만들어지지 않았습니다.")
    elif ttype == "dynamic":
        if not L.scaled_model_exists(DATA, sid):
            raise RuntimeError("스케일링된 모델이 없습니다. 중립 자세를 먼저 처리하세요.")
        main(sid, tid, tid, extrinsicsTrial=False, **ps, **common)
        if not L.kinematics_mot(DATA, sid, tid).exists():
            raise RuntimeError("관절각(.mot) 결과가 만들어지지 않았습니다.")
    else:
        raise ValueError(f"unknown trial_type {ttype}")
    return list_outputs(sid, tid)


def run_intrinsics(job: dict) -> dict:
    """main_calcIntrinsics.py 와 같은 계산: 체커보드를 비춘 영상에서 렌즈 내부 파라미터 평균."""
    import numpy as np
    from utilsChecker import computeAverageIntrinsics, saveCameraParameters

    cb = job["checkerboard"]
    params = {"dimensions": (int(cb["cols"]), int(cb["rows"])), "squareSize": float(cb["square_mm"])}
    update_running(DATA, job, stage="렌즈 보정 계산 중")
    cam_avg, cam_list, comparisons, model = computeAverageIntrinsics(
        str(DATA / "IntrinsicCaptures"), [job["capture_id"]], params, nImages=50,
        cameraModel=job["camera_model"], videoType=".mov")
    dst = L.intrinsics_dir(DATA, job["camera_model"]) / "cameraIntrinsics.pickle"
    saveCameraParameters(str(dst), cam_avg)
    link_intrinsics()
    K = np.asarray(cam_avg["intrinsicMat"]).tolist()
    return {"camera_model": job["camera_model"], "intrinsicMat": K,
            "distortion": np.asarray(cam_avg.get("distortion", [])).ravel().tolist(),
            "imageSize": np.asarray(cam_avg.get("imageSize", [])).ravel().tolist()}


def short_error(e: BaseException) -> str:
    # OpenCap 은 (사용자용 메시지, 개발자용 traceback) 두 개를 Exception 인자로 넘긴다
    if e.args and isinstance(e.args[0], str):
        return e.args[0][:2000]
    return repr(e)[:2000]


def loop() -> None:
    link_intrinsics()
    print("PhysioCap core worker ready", DATA, flush=True)
    orphans = requeue_orphans(DATA, {"core", "intrinsics"})  # 컨테이너 재시작으로 중단된 작업을 다시 대기열로
    if orphans:
        print("requeued interrupted jobs", orphans, flush=True)
    while True:
        job = claim_job(DATA, {"core", "intrinsics"})
        if not job:
            time.sleep(1.0)
            continue
        print("job", job["id"], job["kind"], job.get("trial_type"), flush=True)
        try:
            link_intrinsics()
            outputs = run_core(job) if job["kind"] == "core" else run_intrinsics(job)
            finish_job(DATA, job, ok=True, outputs=outputs)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            finish_job(DATA, job, ok=False, error=short_error(e), traceback=traceback.format_exc()[-6000:])


if __name__ == "__main__":
    loop()
