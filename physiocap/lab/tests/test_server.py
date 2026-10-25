"""서버 전체 흐름: 기기 등록 → 렌즈 보정 → 세션 → 보정/중립/동작 시행 → 영상 정규화 → 작업 큐 → 동역학 연결."""
import importlib
import json
import pickle
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def make_video(path: Path, w=1280, h=720, fps=60, secs=1.2, rotate=90):
    """갤럭시처럼 가로 센서로 찍고 회전 메타데이터(90°)를 붙인 영상."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".raw.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={w}x{h}:rate={fps}",
                    "-t", str(secs), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(tmp)], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-display_rotation", str(rotate), "-i", str(tmp), "-c", "copy", str(path)], check=True)
    return path


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PHYSIOCAP_DATA", str(tmp_path / "data"))
    import store, layout, video, app as appmod  # noqa: F401
    importlib.reload(store)
    appmod = importlib.reload(appmod)
    # 업로드 후 처리 스레드를 동기 실행으로 바꿔 테스트를 결정적으로
    monkeypatch.setattr(appmod.threading, "Thread", lambda target, args=(), daemon=None: type("T", (), {"start": lambda self: target(*args)})())
    return appmod, TestClient(appmod.app), tmp_path


def register(client, did, model="SM-S921N"):
    r = client.post("/api/devices/register", json={"device_id": did, "label": did, "model": model, "width": 720, "height": 1280, "fps": 60})
    assert r.status_code == 200
    client.get(f"/api/devices/{did}/poll", params={"offset_ms": 0})


def upload(client, did, video, **form):
    with open(video, "rb") as f:
        r = client.post("/api/upload", data={"device_id": did, **form}, files={"file": ("v.mp4", f, "video/mp4")})
    assert r.status_code == 200, r.text


def run_fake_worker(appmod, kinds, outputs_fn=None, ok=True):
    import store as st
    j = st.claim_job(appmod.DATA, kinds)
    assert j, f"no job of {kinds}"
    if outputs_fn:
        outputs_fn(j)
    st.finish_job(appmod.DATA, j, ok=ok, error=None if ok else "boom", outputs={"x": 1})
    appmod.sync_jobs()
    appmod.sync_intrinsics()
    return j


def test_full_flow(env, tmp_path):
    appmod, c, _ = env
    register(c, "phoneA"); register(c, "phoneB")
    assert {d["id"] for d in c.get("/api/devices").json() if d["online"]} == {"phoneA", "phoneB"}

    # 렌즈 보정 없이 세션 보정 시행 → 거부
    s = c.post("/api/sessions", json={"name": "t1", "subject": {"height_m": 1.7, "mass_kg": 65}, "cameras": {"Cam0": "phoneA", "Cam1": "phoneB"}}).json()
    r = c.post(f"/api/sessions/{s['id']}/trials", json={"type": "calibration"})
    assert r.status_code == 409 and "렌즈 보정" in r.json()["detail"]

    # 렌즈 보정 캡처 → 업로드 → 정규화 → intrinsics 작업
    cap = c.post("/api/intrinsics/start", json={"device_id": "phoneA"}).json()
    assert c.get("/api/devices/phoneA/poll").json()["command"]["purpose"] == "intrinsics"
    c.post(f"/api/intrinsics/{cap['id']}/stop")
    upload(c, "phoneA", make_video(tmp_path / "in.mp4"), purpose="intrinsics", capture_id=cap["id"], start_device_ms=0, fps=60)
    caps = c.get("/api/intrinsics").json()["captures"]
    assert caps[0]["state"] == "queued" and caps[0]["model"] == "SM-S921N_720x1280_60fps"
    norm = appmod.DATA / "IntrinsicCaptures" / cap["id"] / f"{cap['id']}.mov"
    import video
    info = video.probe(norm)
    assert (info["width"], info["height"], info["rotation"]) == (720, 1280, 0)

    def write_intr(j):
        d = appmod.DATA / "intrinsics" / j["camera_model"] / "Deployed"
        d.mkdir(parents=True)
        pickle.dump({"intrinsicMat": [[1]]}, open(d / "cameraIntrinsics.pickle", "wb"))
    run_fake_worker(appmod, {"intrinsics"}, write_intr)
    assert c.get("/api/intrinsics").json()["models"] == ["SM-S921N_720x1280_60fps"]

    # 순서 강제: 중립 전에 동작 시행 불가
    assert c.post(f"/api/sessions/{s['id']}/trials", json={"type": "dynamic"}).status_code == 409

    # 체커보드 보정 시행: 동시 녹화 명령 → 정지 → 두 대 업로드(시작 시각 다름) → 정규화·트림 → core 작업
    t = c.post(f"/api/sessions/{s['id']}/trials", json={"type": "calibration"}).json()
    cmdA = c.get("/api/devices/phoneA/poll").json()["command"]
    cmdB = c.get("/api/devices/phoneB/poll").json()["command"]
    assert cmdA["action"] == cmdB["action"] == "record" and cmdA["start_at_server_ms"] == cmdB["start_at_server_ms"]
    assert {cmdA["cam"], cmdB["cam"]} == {"Cam0", "Cam1"}
    c.post(f"/api/sessions/{s['id']}/trials/calibration/stop")
    v = make_video(tmp_path / "cal.mp4", secs=1.5)
    upload(c, "phoneA", v, session=s["id"], trial="calibration", cam="Cam0", start_device_ms=1000, fps=59.94)
    upload(c, "phoneB", v, session=s["id"], trial="calibration", cam="Cam1", start_device_ms=1300, fps=60)
    ss = c.get(f"/api/sessions/{s['id']}").json()
    tt = ss["trials"][0]
    assert tt["state"] == "queued", tt
    assert tt["video"]["Cam0"]["trim_s"] == 0.3 and tt["video"]["Cam1"]["trim_s"] == 0.0
    vp = appmod.DATA / "Data" / s["id"] / "Videos" / "Cam0" / "InputMedia" / "calibration" / "calibration.mov"
    assert vp.exists()
    import yaml
    meta = yaml.safe_load(open(appmod.DATA / "Data" / s["id"] / "sessionMetadata.yaml"))
    assert meta["iphoneModel"] == {"Cam0": "SM-S921N_720x1280_60fps", "Cam1": "SM-S921N_720x1280_60fps"}
    assert meta["checkerBoard"]["placement"] == "backWall" and meta["height_m"] == 1.7
    j = run_fake_worker(appmod, {"core"})
    assert j["trial_type"] == "calibration"
    assert c.get(f"/api/sessions/{s['id']}").json()["trials"][0]["state"] == "done"

    # 중립 → 동작(스쿼트, 동역학 자동 연결)
    for typ, body in (("neutral", {"type": "neutral"}), ("dynamic", {"type": "dynamic", "name": "squat", "motion_type": "squats", "repetition": 1})):
        t = c.post(f"/api/sessions/{s['id']}/trials", json=body).json()
        c.post(f"/api/sessions/{s['id']}/trials/{t['id']}/stop")
        for did, cam in (("phoneA", "Cam0"), ("phoneB", "Cam1")):
            upload(c, did, v, session=s["id"], trial=t["id"], cam=cam, start_device_ms=0, fps=60)

        def mot(j, tid=t["id"]):
            if j["trial_type"] == "dynamic":
                p = appmod.DATA / "Data" / s["id"] / "OpenSimData" / "Kinematics" / f"{tid}.mot"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("Coordinates\nversion=1\nnRows=2\nnColumns=3\ninDegrees=yes\nendheader\ntime\tknee_angle_r\thip_flexion_r\n0\t10\t5\n0.0167\t12\t6\n")
        run_fake_worker(appmod, {"core"}, mot)
    ss = c.get(f"/api/sessions/{s['id']}").json()
    sq = next(t for t in ss["trials"] if t["id"] == "squat")
    assert sq["state"] == "done" and sq["kinetics_state"] == "queued"
    kj = run_fake_worker(appmod, {"kinetics"})
    assert kj["motion_type"] == "squats" and kj["repetition"] == 1
    sq = next(t for t in c.get(f"/api/sessions/{s['id']}").json()["trials"] if t["id"] == "squat")
    assert sq["kinetics_state"] == "done"
    res = c.get(f"/api/sessions/{s['id']}/trials/squat/results").json()
    assert res["kinematics"]["columns"][:2] == ["time", "knee_angle_r"] and len(res["kinematics"]["data"]) == 2


def test_landscape_rejected(env, tmp_path):
    appmod, c, _ = env
    register(c, "a"); register(c, "b")
    for did in ("a", "b"):
        model = appmod.L.camera_model_key("SM-S921N", 720, 1280, 60)
        d = appmod.DATA / "intrinsics" / model / "Deployed"
        d.mkdir(parents=True, exist_ok=True)
        (d / "cameraIntrinsics.pickle").write_bytes(b"x")
    s = c.post("/api/sessions", json={"subject": {"height_m": 1.7, "mass_kg": 65}, "cameras": {"Cam0": "a", "Cam1": "b"}}).json()
    c.post(f"/api/sessions/{s['id']}/trials", json={"type": "calibration"})
    c.post(f"/api/sessions/{s['id']}/trials/calibration/stop")
    v = make_video(tmp_path / "land.mp4", rotate=0)  # 회전 없음 = 가로
    for did, cam in (("a", "Cam0"), ("b", "Cam1")):
        upload(c, did, v, session=s["id"], trial="calibration", cam=cam, start_device_ms=0, fps=60)
    t = c.get(f"/api/sessions/{s['id']}").json()["trials"][0]
    assert t["state"] == "error" and "가로" in t["error"]


def test_file_access_is_sandboxed(env):
    _, c, _ = env
    assert c.get("/files/../devices.json").status_code == 404
    assert c.get("/files/devices.json").status_code == 404


def test_analysis_resolution():
    import app
    assert app.resolve_analysis("auto", "walking") == "gait"
    assert app.resolve_analysis("auto", "sit_to_stand") == "sts"
    assert app.resolve_analysis("auto", "squats") == "none"
    assert app.resolve_analysis("sts", "none") == "sts"


def test_activity_enqueued_before_kinetics(env, tmp_path):
    appmod, c, _ = env
    register(c, "a"); register(c, "b")
    model = appmod.L.camera_model_key("SM-S921N", 720, 1280, 60)
    d = appmod.DATA / "intrinsics" / model / "Deployed"
    d.mkdir(parents=True, exist_ok=True)
    (d / "cameraIntrinsics.pickle").write_bytes(b"x")
    s = c.post("/api/sessions", json={"subject": {"height_m": 1.7, "mass_kg": 65}, "cameras": {"Cam0": "a", "Cam1": "b"}}).json()
    v = make_video(tmp_path / "v.mp4")
    for body in ({"type": "calibration"}, {"type": "neutral"}, {"type": "dynamic", "name": "walk1", "motion_type": "walking", "time_window": [1, 2]}):
        t = c.post(f"/api/sessions/{s['id']}/trials", json=body).json()
        c.post(f"/api/sessions/{s['id']}/trials/{t['id']}/stop")
        for did, cam in (("a", "Cam0"), ("b", "Cam1")):
            upload(c, did, v, session=s["id"], trial=t["id"], cam=cam, start_device_ms=0, fps=60)
        run_fake_worker(appmod, {"core"})
    walk = next(t for t in c.get(f"/api/sessions/{s['id']}").json()["trials"] if t["id"] == "walk1")
    assert walk["analysis"] == "gait" and walk["activity_state"] == "queued" and walk["kinetics_state"] == "queued"
    import store as st
    first = st.claim_job(appmod.DATA, {"activity", "kinetics"})
    assert first["kind"] == "activity" and first["analysis"] == "gait"  # 짧은 지표 분석이 먼저
    st.finish_job(appmod.DATA, first, ok=True, outputs={})
    appmod.sync_jobs()
    walk = next(t for t in c.get(f"/api/sessions/{s['id']}").json()["trials"] if t["id"] == "walk1")
    assert walk["activity_state"] == "done"
    # 수동 실행: 운동학 없으면 거부
    assert c.post(f"/api/sessions/{s['id']}/trials/walk1/activity", json={"analysis": "sts"}).status_code == 409
    assert c.post(f"/api/sessions/{s['id']}/trials/walk1/activity", json={"analysis": "bad"}).status_code == 400
