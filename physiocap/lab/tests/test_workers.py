"""워커가 OpenCap 원본 함수를 클라우드 버전과 같은 인자로 호출하는지, 결과 요약이 맞는지 (OpenCap 함수는 가짜로 대체)."""
import importlib
import json
import pickle
import sys
import types
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def core(tmp_path, monkeypatch):
    oc = tmp_path / "opencap-core"
    (oc / "CameraIntrinsics").mkdir(parents=True)
    (oc / "defaultOpenCapSettings.json").write_text('{"openpose": "1x736", "hrnet": 0.8}')
    data = tmp_path / "data"
    monkeypatch.setenv("OPENCAP_CORE_DIR", str(oc))
    monkeypatch.setenv("PHYSIOCAP_DATA", str(data))
    calls = []

    def fake_main(session, trialName, trial_id, **kw):
        calls.append((session, trialName, trial_id, kw))
        sd = data / "Data" / session
        if kw.get("extrinsicsTrial"):
            for cam in ("Cam0", "Cam1"):
                d = sd / "Videos" / cam / "InputMedia" / "calibration"
                d.mkdir(parents=True, exist_ok=True)
                for i in (0, 1):
                    pickle.dump({"soln": i, "cam": cam}, open(d / f"cameraIntrinsicsExtrinsics_soln{i}.pickle", "wb"))
        elif kw.get("scaleModel"):
            (sd / "OpenSimData" / "Model").mkdir(parents=True, exist_ok=True)
            (sd / "OpenSimData" / "Model" / "LaiUhlrich2022_scaled.osim").write_text("<osim/>")
        else:
            (sd / "OpenSimData" / "Kinematics").mkdir(parents=True, exist_ok=True)
            (sd / "OpenSimData" / "Kinematics" / f"{trial_id}.mot").write_text("endheader\ntime\n0\n")

    monkeypatch.setitem(sys.modules, "main", types.SimpleNamespace(main=fake_main))
    monkeypatch.setitem(sys.modules, "utils", types.SimpleNamespace(loadCameraParameters=lambda p: pickle.load(open(p, "rb"))))
    sys.path.insert(0, str(ROOT / "worker_core"))
    import physiocap_core_worker as w
    w = importlib.reload(w)
    return w, calls, data


def test_core_calls_match_opencap_cloud(core):
    w, calls, data = core
    import store
    intr = data / "intrinsics" / "SM-S921N_720x1280_60fps" / "Deployed"
    intr.mkdir(parents=True)
    (intr / "cameraIntrinsics.pickle").write_bytes(b"x")
    w.link_intrinsics()
    assert (w.OPENCAP_DIR / "CameraIntrinsics" / "SM-S921N_720x1280_60fps" / "Deployed" / "cameraIntrinsics.pickle").exists()

    out = w.run_core({"id": "j1", "session": "S1", "trial": "calibration", "trial_type": "calibration"})
    s, tn, tid, kw = calls[-1]
    assert (s, tn, tid) == ("S1", "calibration", "calibration")
    assert kw["extrinsicsTrial"] is True and kw["genericFolderNames"] is True and kw["imageUpsampleFactor"] == 4
    assert kw["dataDir"] == str(data) and kw["isDocker"] is True

    w.run_core({"id": "j2", "session": "S1", "trial": "neutral", "trial_type": "neutral", "pose_detector": "hrnet"})
    s, tn, tid, kw = calls[-1]
    assert (tn, tid) == ("neutral", "neutral") and kw["scaleModel"] is True
    assert kw["poseDetector"] == "hrnet" and kw["bbox_thr"] == 0.8
    opts = kw["calibrationOptions"]
    assert set(opts) == {"Cam0", "Cam1"} and [o["soln"] for o in opts["Cam0"]] == [0, 1]

    out = w.run_core({"id": "j3", "session": "S1", "trial": "squat", "trial_type": "dynamic", "pose_detector": "openpose"})
    s, tn, tid, kw = calls[-1]
    assert (tn, tid) == ("squat", "squat") and "scaleModel" not in kw
    assert kw["poseDetector"] == "OpenPose" and kw["resolutionPoseDetection"] == "1x736"
    assert out["mot"] == ["Data/S1/OpenSimData/Kinematics/squat.mot"]

    # 재보정 시 이전 외부 파라미터 삭제
    w.delete_calibration_files("S1")
    assert not list((data / "Data" / "S1" / "Videos").rglob("*soln*.pickle"))


def test_dynamic_requires_scaled_model(core):
    w, calls, data = core
    with pytest.raises(RuntimeError, match="중립"):
        w.run_core({"id": "j", "session": "S2", "trial": "walk", "trial_type": "dynamic"})


def test_kinetics_summary_and_call(tmp_path, monkeypatch):
    data = tmp_path / "data"
    monkeypatch.setenv("PHYSIOCAP_DATA", str(data))
    monkeypatch.setenv("OPENCAP_PROCESSING_DIR", str(tmp_path / "proc"))
    got = {}

    def fake_process(baseDir, dataFolder, sid, trial, motion, tw, rep, treadmill, side):
        got.update(dataFolder=dataFolder, sid=sid, trial=trial, motion=motion, tw=tw, rep=rep, treadmill=treadmill, side=side)
        return {"repetition": rep}

    def fake_run(baseDir, dataFolder, sid, settings, case, solveProblem, analyzeResults):
        d = Path(dataFolder) / sid / "OpenSimData" / "Dynamics" / "squat_rep1"
        d.mkdir(parents=True)
        t = np.linspace(0, 1, 5)
        res = {case: {"time": t, "GRF_BW": np.ones((6, 5)) * 50, "GRF_labels": ["GRF_x_r", "GRF_y_r", "GRF_z_r", "GRF_x_l", "GRF_y_l", "GRF_z_l"],
                      "torques_BWht": np.zeros((2, 5)), "torque_labels": ["knee_angle_r", "knee_angle_l"],
                      "muscle_activations": np.full((3, 4), 0.2), "muscles": ["a", "b", "c"], "iter": 120}}
        np.save(d / "optimaltrajectories.npy", res)

    monkeypatch.setitem(sys.modules, "utilsOpenSimAD", types.SimpleNamespace(processInputsOpenSimAD=fake_process))
    monkeypatch.setitem(sys.modules, "mainOpenSimAD", types.SimpleNamespace(run_tracking=fake_run))
    sys.path.insert(0, str(ROOT / "worker_kinetics"))
    import physiocap_kinetics_worker as k
    k = importlib.reload(k)
    mot = data / "Data" / "S1" / "OpenSimData" / "Kinematics" / "squat.mot"
    mot.parent.mkdir(parents=True)
    mot.write_text("x")
    out = k.run_kinetics({"id": "k1", "session": "S1", "trial": "squat", "motion_type": "squats", "repetition": 1, "time_window": None, "case": "0"})
    assert got == {"dataFolder": str(data / "Data"), "sid": "S1", "trial": "squat", "motion": "squats", "tw": None, "rep": 1, "treadmill": 0, "side": "all"}
    assert out["result_dir"] == "Data/S1/OpenSimData/Dynamics/squat_rep1" and out["iterations"] == 120
    summ = json.loads((data / "Data" / "S1" / "OpenSimData" / "Dynamics" / "squat" / "physiocap_summary.json").read_text())
    assert summ["series"]["GRF_BW"]["data"]["GRF_y_r"] == [50.0] * 5
    assert len(summ["series"]["muscle_activations"]["data"]["a"]) == 4
    assert "검증하지 않았다" in summ["note"]
