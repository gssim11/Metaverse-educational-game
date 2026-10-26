"""PhysioCap Lab 서버 — 갤럭시 2대 동시 촬영을 지휘하고 OpenCap 파이프라인 작업을 큐에 넣는다.

흐름(OpenCap 과 같음): 기종 렌즈 보정(1회) → 세션 생성 → 체커보드 보정 → 중립 자세 → 동작 시행 → 동역학
실행: uvicorn app:app --host 0.0.0.0 --port 8000   (환경변수 PHYSIOCAP_DATA = 데이터 폴더)
"""
from __future__ import annotations

import os
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import layout as L
import meshes as M
import validation as VAL
import video as V
from store import Store, now_ms

DATA = Path(os.environ.get("PHYSIOCAP_DATA", "/data/physiocap"))
GEOMETRY = Path(os.environ.get("PHYSIOCAP_GEOMETRY", "/opt/opensim-geometry"))
DASHBOARD = Path(os.environ.get("PHYSIOCAP_DASHBOARD", Path(__file__).resolve().parent.parent / "dashboard"))
ONLINE_MS = 6000          # 마지막 폴링 후 이 시간 안이면 접속 중
START_DELAY_MS = 1500     # 녹화 명령 후 동시 시작까지 여유

app = FastAPI(title="PhysioCap Lab", version="0.1.0")
store = Store(DATA)


# ---------------------------------------------------------------- 모델
class DeviceRegister(BaseModel):
    device_id: str
    label: str = ""
    model: str = "android"
    width: int = 720
    height: int = 1280
    fps: int = 60


class Subject(BaseModel):
    height_m: float = Field(..., gt=0.5, lt=2.5)
    mass_kg: float = Field(..., gt=10, lt=300)
    sex: str = "m"
    id: str = "subject"


class Checkerboard(BaseModel):
    cols: int = Field(5, ge=3, description="가로 내부 코너 수")
    rows: int = Field(4, ge=3, description="세로 내부 코너 수")
    square_mm: float = Field(35, gt=5)
    placement: str = "backWall"


KINEMATICS_METHODS = ("augmenter", "keypoints")


class SessionCreate(BaseModel):
    name: str = ""
    subject: Subject
    checkerboard: Checkerboard = Checkerboard()
    cameras: dict[str, str] = Field(default_factory=dict, description="{'Cam0': device_id, 'Cam1': device_id}")
    pose_detector: str = "hrnet"
    opensim_model: str = "LaiUhlrich2022"
    # augmenter: OpenCap 기본(LSTM 마커 증강) / keypoints: B 방식(증강 없이 영상 키포인트로 직접 스케일링·역기구학)
    kinematics_method: str = "augmenter"


class TrialStart(BaseModel):
    type: str = "dynamic"  # calibration | neutral | dynamic
    name: str = ""
    motion_type: str = L.NO_KINETICS
    analysis: str = "auto"  # auto | gait | sts | none  (opencap-processing ActivityAnalyses)
    repetition: int | None = None
    time_window: list[float] | None = None


class KineticsRequest(BaseModel):
    motion_type: str
    repetition: int | None = None
    time_window: list[float] | None = None
    case: str = "0"


class ActivityRequest(BaseModel):
    analysis: str


ANALYSES = ("gait", "sts")


def resolve_analysis(analysis: str, motion_type: str) -> str:
    """auto: 보행 동역학 → 보행 지표, 앉았다 일어서기 → STS 지표."""
    if analysis in ANALYSES or analysis == "none":
        return analysis
    return {"walking": "gait", "sit_to_stand": "sts"}.get(motion_type, "none")


class IntrinsicsStart(BaseModel):
    device_id: str
    checkerboard: Checkerboard = Checkerboard()


# ---------------------------------------------------------------- 기기
def _device_public(d: dict) -> dict:
    return {k: d.get(k) for k in ("id", "label", "model", "width", "height", "fps", "last_seen", "offset_ms", "state", "message")} | {
        "online": now_ms() - int(d.get("last_seen") or 0) < ONLINE_MS
    }


@app.post("/api/devices/register")
def register(dev: DeviceRegister):
    d = store.update_device(dev.device_id, label=dev.label or dev.model, model=dev.model, width=dev.width,
                            height=dev.height, fps=dev.fps, last_seen=now_ms())
    return _device_public(d)


@app.get("/api/devices/{device_id}/poll")
def poll(device_id: str, offset_ms: float | None = None, state: str | None = None, message: str | None = None):
    """폰이 0.5초마다 호출. offset_ms = (서버시각 - 기기시각) 추정값(기기가 왕복시간 보정해 계산)."""
    devs = store.devices()
    if device_id not in devs:
        raise HTTPException(404, "unregistered device")
    fields = {"last_seen": now_ms()}
    if offset_ms is not None:
        fields["offset_ms"] = float(offset_ms)
    if state is not None:
        fields["state"] = state
    if message is not None:
        fields["message"] = message[:200]
    d = store.update_device(device_id, **fields)
    return {"server_ms": now_ms(), "command": d.get("command")}


@app.get("/api/time")
def server_time():
    return {"server_ms": now_ms()}


@app.get("/api/devices")
def devices():
    return sorted((_device_public(d) for d in store.devices().values()), key=lambda d: d["label"] or d["id"])


# ---------------------------------------------------------------- 세션
def _camera_model(dev: dict) -> str:
    return L.camera_model_key(dev.get("model", "android"), dev.get("width", 720), dev.get("height", 1280), dev.get("fps", 60))


@app.post("/api/sessions")
def create_session(body: SessionCreate):
    if len(body.cameras) < 2:
        raise HTTPException(400, "카메라(폰)를 2대 이상 지정해야 합니다.")
    devs = store.devices()
    for cam, did in body.cameras.items():
        if not cam.startswith("Cam") or did not in devs:
            raise HTTPException(400, f"{cam}: 등록되지 않은 기기 {did}")
    if body.checkerboard.placement not in ("backWall", "ground"):
        raise HTTPException(400, "체커보드 위치는 backWall(세워 둠) 또는 ground(바닥)")
    if body.kinematics_method not in KINEMATICS_METHODS:
        raise HTTPException(400, "관절각 계산 방식은 augmenter(OpenCap 기본) 또는 keypoints(B 방식)")
    if body.kinematics_method == "keypoints" and "shoulder" in body.opensim_model:
        raise HTTPException(400, "B 방식(키포인트)은 어깨 모델을 지원하지 않습니다.")
    sid = L.safe_name(body.name or time.strftime("S%Y%m%d_%H%M%S")) + "_" + uuid.uuid4().hex[:4]
    s = {
        "id": sid, "name": body.name or sid, "created": now_ms(),
        "subject": body.subject.model_dump(), "checkerboard": body.checkerboard.model_dump(),
        "pose_detector": body.pose_detector, "opensim_model": body.opensim_model,
        "kinematics_method": body.kinematics_method,
        "cameras": {cam: {"device_id": did, "label": devs[did].get("label"), "model": _camera_model(devs[did])}
                    for cam, did in sorted(body.cameras.items())},
        "trials": [],
    }
    store.save_session(s)
    return s


@app.get("/api/sessions")
def list_sessions():
    return [{k: s[k] for k in ("id", "name", "created") if k in s} | {"trials": len(s.get("trials", []))} for s in store.sessions()]


@app.get("/api/sessions/{sid}")
def get_session(sid: str):
    s = store.session(sid)
    if not s:
        raise HTTPException(404, "no session")
    return s


def _trial(s: dict, tid: str) -> dict:
    for t in s["trials"]:
        if t["id"] == tid:
            return t
    raise HTTPException(404, "no trial")


def _missing_intrinsics(s: dict) -> list[str]:
    return sorted({c["model"] for c in s["cameras"].values() if not (L.intrinsics_dir(DATA, c["model"]) / "cameraIntrinsics.pickle").exists()})


@app.post("/api/sessions/{sid}/trials")
def start_trial(sid: str, body: TrialStart):
    s = get_session(sid)
    if any(t["state"] in ("recording", "uploading") for t in s["trials"]):
        raise HTTPException(409, "녹화 중이거나 업로드 중인 시행이 있습니다.")
    done = {t["type"] for t in s["trials"] if t["state"] == "done"}
    if body.type == "calibration":
        miss = _missing_intrinsics(s)
        if miss:
            raise HTTPException(409, "렌즈 보정이 안 된 기종이 있습니다: " + ", ".join(miss))
        tid = L.CALIBRATION
    elif body.type == "neutral":
        if "calibration" not in done:
            raise HTTPException(409, "체커보드 보정을 먼저 완료하세요.")
        tid = L.NEUTRAL
    elif body.type == "dynamic":
        if "neutral" not in done:
            raise HTTPException(409, "중립 자세(체형 스케일링)를 먼저 완료하세요.")
        if body.motion_type != L.NO_KINETICS and body.motion_type not in L.KINETIC_MOTIONS:
            raise HTTPException(400, "알 수 없는 동작 종류")
        if body.analysis not in ("auto", "none") + ANALYSES:
            raise HTTPException(400, "analysis 는 auto | gait | sts | none")
        base = L.safe_name(body.name or body.motion_type or "trial")
        tid, n = base, 1
        while any(t["id"] == tid for t in s["trials"]):
            n += 1
            tid = f"{base}_{n}"
    else:
        raise HTTPException(400, "type 은 calibration | neutral | dynamic")

    start_at = now_ms() + START_DELAY_MS
    trial = {"id": tid, "type": body.type, "state": "recording", "created": now_ms(), "start_at_ms": start_at,
             "motion_type": body.motion_type if body.type == "dynamic" else L.NO_KINETICS,
             "kinetics_params": {"repetition": body.repetition, "time_window": body.time_window},
             "analysis": resolve_analysis(body.analysis, body.motion_type) if body.type == "dynamic" else "none",
             "uploads": {}, "error": None, "jobs": {}}

    def add(s_):
        s_["trials"] = [t for t in s_["trials"] if t["id"] != tid]  # 보정·중립은 다시 찍으면 덮어씀
        s_["trials"].append(trial)
        if body.type == "calibration":  # 보정을 다시 하면 이후 단계도 다시 해야 함
            for t in s_["trials"]:
                if t["type"] != "calibration" and t["state"] == "done":
                    t["stale"] = True

    store.mutate_session(sid, add)
    for cam, c in s["cameras"].items():
        store.send_command(c["device_id"], {"action": "record", "purpose": "trial", "session": sid, "trial": tid,
                                            "cam": cam, "start_at_server_ms": start_at})
    return trial


@app.post("/api/sessions/{sid}/trials/{tid}/stop")
def stop_trial(sid: str, tid: str):
    s = get_session(sid)
    t = _trial(s, tid)
    if t["state"] != "recording":
        raise HTTPException(409, "녹화 중이 아닙니다.")
    for cam, c in s["cameras"].items():
        store.send_command(c["device_id"], {"action": "stop", "session": sid, "trial": tid, "cam": cam})

    def upd(s_):
        _trial(s_, tid).update(state="uploading", stopped_ms=now_ms())

    return store.mutate_session(sid, upd)


@app.post("/api/upload")
def upload(device_id: str = Form(...), purpose: str = Form("trial"), session: str = Form(""), trial: str = Form(""),
           cam: str = Form(""), capture_id: str = Form(""), start_device_ms: float = Form(...),
           fps: float = Form(60), file: UploadFile = File(...)):
    dev = store.devices().get(device_id)
    if not dev:
        raise HTTPException(404, "unregistered device")
    offset = float(dev.get("offset_ms") or 0)
    start_server = start_device_ms + offset
    ext = Path(file.filename or "v.mp4").suffix or ".mp4"
    if purpose == "intrinsics":
        dst = DATA / "uploads" / "_intrinsics" / L.safe_name(capture_id) / f"raw{ext}"
    else:
        dst = DATA / "uploads" / L.safe_name(session) / L.safe_name(trial) / f"{L.safe_name(cam)}{ext}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(dst, "wb") as f:
        shutil.copyfileobj(file.file, f, length=1024 * 1024)
    store.update_device(device_id, command=None, state="idle", message="업로드 완료")
    info = {"file": str(dst), "start_server_ms": start_server, "fps": fps, "device_id": device_id, "uploaded_ms": now_ms()}
    if purpose == "intrinsics":
        _intrinsics_uploaded(capture_id, info)
        return {"ok": True}

    def upd(s_):
        t = _trial(s_, trial)
        t["uploads"][cam] = info

    s = store.mutate_session(session, upd)
    t = _trial(s, trial)
    if set(t["uploads"]) >= set(s["cameras"]):
        threading.Thread(target=prepare_and_enqueue, args=(session, trial), daemon=True).start()
    return {"ok": True}


def prepare_and_enqueue(sid: str, tid: str) -> None:
    """모든 카메라 업로드 완료 → 영상 정규화 → sessionMetadata.yaml → opencap-core 작업 등록."""
    try:
        s = store.session(sid)
        t = _trial(s, tid)
        store.mutate_session(sid, lambda s_: _trial(s_, tid).update(state="preparing"))
        fps = V.nominal_fps(min(float(u.get("fps") or 60) for u in t["uploads"].values()))
        trims = V.common_start_trims({cam: u["start_server_ms"] for cam, u in t["uploads"].items()})
        cams = {}
        for cam, u in sorted(t["uploads"].items()):
            dst = L.trial_video_path(DATA, sid, cam, tid)
            if dst.parent.exists():
                shutil.rmtree(dst.parent)
            info = V.normalize(u["file"], dst, fps=fps, trim_s=trims[cam])
            if info["width"] > info["height"]:
                raise RuntimeError(f"{cam} 영상이 가로입니다. 폰을 세로로 세워 촬영하세요.")
            dev = store.devices().get(u["device_id"], {})
            model = L.camera_model_key(dev.get("model", "android"), info["width"], info["height"], fps)
            cams[cam] = {"model": model, "trim_s": round(trims[cam], 3), "fps": fps, "size": [info["width"], info["height"]]}
        missing = [c["model"] for c in cams.values() if not (L.intrinsics_dir(DATA, c["model"]) / "cameraIntrinsics.pickle").exists()]
        if missing:
            raise RuntimeError("이 녹화 설정의 렌즈 보정값이 없습니다: " + ", ".join(sorted(set(missing))))
        meta = L.build_session_metadata(s["subject"], s["checkerboard"], cams, s.get("pose_detector", "hrnet"), s.get("opensim_model", "LaiUhlrich2022"))
        L.write_session_metadata(DATA, sid, meta)
        job = store.enqueue("core", session=sid, trial=tid, trial_type=t["type"], cameras=sorted(cams),
                            pose_detector=s.get("pose_detector", "hrnet"),
                            opensim_model=s.get("opensim_model", "LaiUhlrich2022"),
                            kinematics_method=s.get("kinematics_method", "augmenter"))

        def upd(s_):
            tt = _trial(s_, tid)
            tt.update(state="queued", video=cams)
            tt["jobs"]["core"] = job["id"]

        store.mutate_session(sid, upd)
    except Exception as e:  # noqa: BLE001
        store.mutate_session(sid, lambda s_: _trial(s_, tid).update(state="error", error=str(e)))


@app.post("/api/sessions/{sid}/trials/{tid}/reprocess")
def reprocess(sid: str, tid: str):
    s = get_session(sid)
    t = _trial(s, tid)
    if set(t["uploads"]) < set(s["cameras"]):
        raise HTTPException(409, "업로드가 끝나지 않았습니다.")
    threading.Thread(target=prepare_and_enqueue, args=(sid, tid), daemon=True).start()
    return {"ok": True}


@app.post("/api/sessions/{sid}/trials/{tid}/kinetics")
def request_kinetics(sid: str, tid: str, body: KineticsRequest):
    s = get_session(sid)
    t = _trial(s, tid)
    if t["type"] != "dynamic":
        raise HTTPException(400, "동작 시행만 동역학을 계산할 수 있습니다.")
    if not L.kinematics_mot(DATA, sid, tid).exists():
        raise HTTPException(409, "운동학(관절각) 처리가 먼저 끝나야 합니다.")
    if body.motion_type not in L.KINETIC_MOTIONS:
        raise HTTPException(400, "알 수 없는 동작 종류")
    job = _enqueue_kinetics(sid, tid, body.motion_type, body.repetition, body.time_window, body.case)
    return job


@app.post("/api/sessions/{sid}/trials/{tid}/activity")
def request_activity(sid: str, tid: str, body: ActivityRequest):
    s = get_session(sid)
    t = _trial(s, tid)
    if t["type"] != "dynamic" or body.analysis not in ANALYSES:
        raise HTTPException(400, "동작 시행에 gait 또는 sts 분석만 할 수 있습니다.")
    if not L.kinematics_mot(DATA, sid, tid).exists():
        raise HTTPException(409, "운동학(관절각) 처리가 먼저 끝나야 합니다.")
    return _enqueue_activity(sid, tid, body.analysis)


def _enqueue_activity(sid, tid, analysis):
    job = store.enqueue("activity", session=sid, trial=tid, analysis=analysis)

    def upd(s_):
        tt = _trial(s_, tid)
        tt["jobs"]["activity"] = job["id"]
        tt.update(analysis=analysis, activity_state="queued", activity_error=None)

    store.mutate_session(sid, upd)
    return job


def _enqueue_kinetics(sid, tid, motion_type, repetition, time_window, case="0"):
    job = store.enqueue("kinetics", session=sid, trial=tid, motion_type=motion_type, repetition=repetition,
                        time_window=time_window, case=case)

    def upd(s_):
        tt = _trial(s_, tid)
        tt["jobs"]["kinetics"] = job["id"]
        tt["kinetics_state"] = "queued"
        tt["motion_type"] = motion_type
        tt["kinetics_params"] = {"repetition": repetition, "time_window": time_window}

    store.mutate_session(sid, upd)
    return job


# ---------------------------------------------------------------- 작업 상태 동기화
def sync_jobs() -> None:
    """워커가 남긴 작업 상태를 세션에 반영하고, 운동학이 끝난 동작 시행은 동역학 작업을 이어서 넣는다."""
    for s in store.sessions():
        for t in s.get("trials", []):
            core_id = t.get("jobs", {}).get("core")
            if core_id and t["state"] in ("queued", "processing"):
                j = store.job(core_id)
                if not j:
                    continue
                if j["state"] == "running":
                    store.mutate_session(s["id"], lambda s_, tid=t["id"], st=j.get("stage"): _trial(s_, tid).update(state="processing", stage=st))
                elif j["state"] in ("done", "error"):
                    def fin(s_, tid=t["id"], j=j):
                        tt = _trial(s_, tid)
                        tt.update(state=j["state"], error=j.get("error"), outputs=j.get("outputs"), stage=None, stale=False)
                    store.mutate_session(s["id"], fin)
                    # 지표 분석(수 초)을 동역학(수십 분)보다 먼저 큐에 넣는다
                    if j["state"] == "done" and t["type"] == "dynamic" and t.get("analysis") in ANALYSES:
                        _enqueue_activity(s["id"], t["id"], t["analysis"])
                    if j["state"] == "done" and t["type"] == "dynamic" and t.get("motion_type", L.NO_KINETICS) in L.KINETIC_MOTIONS:
                        p = t.get("kinetics_params") or {}
                        _enqueue_kinetics(s["id"], t["id"], t["motion_type"], p.get("repetition"), p.get("time_window"))
            act_id = t.get("jobs", {}).get("activity")
            if act_id and t.get("activity_state") in ("queued", "processing"):
                j = store.job(act_id)
                if j and j["state"] == "running":
                    store.mutate_session(s["id"], lambda s_, tid=t["id"]: _trial(s_, tid).update(activity_state="processing"))
                elif j and j["state"] in ("done", "error"):
                    store.mutate_session(s["id"], lambda s_, tid=t["id"], j=j: _trial(s_, tid).update(
                        activity_state=j["state"], activity_error=j.get("error")))
            kin_id = t.get("jobs", {}).get("kinetics")
            if kin_id and t.get("kinetics_state") in ("queued", "processing"):
                j = store.job(kin_id)
                if not j:
                    continue
                if j["state"] == "running":
                    store.mutate_session(s["id"], lambda s_, tid=t["id"]: _trial(s_, tid).update(kinetics_state="processing"))
                elif j["state"] in ("done", "error"):
                    store.mutate_session(s["id"], lambda s_, tid=t["id"], j=j: _trial(s_, tid).update(
                        kinetics_state=j["state"], kinetics_error=j.get("error"), kinetics_outputs=j.get("outputs")))


def _sync_loop():
    while True:
        try:
            sync_jobs()
            sync_intrinsics()
        except Exception as e:  # noqa: BLE001
            print("sync error", e)
        time.sleep(2)


@app.on_event("startup")
def _start_sync():
    if os.environ.get("PHYSIOCAP_NO_SYNC") != "1":
        threading.Thread(target=_sync_loop, daemon=True).start()


# ---------------------------------------------------------------- 결과
@app.get("/api/sessions/{sid}/trials/{tid}/results")
def results(sid: str, tid: str):
    s = get_session(sid)
    t = _trial(s, tid)
    sd = L.session_dir(DATA, sid)
    out = {"trial": t, "files": []}
    mot = L.kinematics_mot(DATA, sid, tid)
    if mot.exists():
        out["kinematics"] = L.read_mot(mot)
    out["has_visualizer"] = _visualizer_path(sid, tid) is not None
    act = L.session_dir(DATA, sid) / "OpenSimData" / "Activity" / tid / "physiocap_activity.json"
    if act.exists():
        out["activity"] = _read(act)
    dyn = L.dynamics_dir(DATA, sid, tid) / "physiocap_summary.json"
    if dyn.exists():
        out["kinetics"] = _read(dyn)
    for p in sorted(sd.rglob("*")):
        if p.is_file() and p.suffix.lower() in (".mot", ".trc", ".osim", ".json", ".jpg", ".png", ".csv", ".yaml", ".npy", ".sto") and (tid in p.parts or tid in p.stem or p.parent.name in ("Model", "CalibrationImages")):
            out["files"].append(str(p.relative_to(DATA)))
    return out


def _visualizer_path(sid: str, tid: str) -> Path | None:
    p = L.session_dir(DATA, sid) / "VisualizerJsons" / tid / f"{tid}.json"
    return p if p.exists() else None


@app.get("/api/sessions/{sid}/trials/{tid}/visualizer")
def visualizer(sid: str, tid: str):
    """OpenCap 이 만든 3D 재생 데이터(분절별 위치·회전, 붙은 메시 이름, 축척)."""
    get_session(sid)
    p = _visualizer_path(sid, tid)
    if not p:
        raise HTTPException(404, "3D 재생 데이터가 없습니다.")
    return FileResponse(p, media_type="application/json")


@app.get("/api/geometry/{name}")
def geometry(name: str):
    """OpenSim 뼈 메시(.vtp) → {positions, indices}. 없으면 404 (뷰어는 선 골격으로 대체)."""
    m = M.mesh_json(GEOMETRY, DATA / "geometry_cache", name)
    if m is None:
        raise HTTPException(404, "mesh not available")
    return JSONResponse(m, headers={"Cache-Control": "public, max-age=604800"})


def _read(p: Path):
    import json
    with open(p) as f:
        return json.load(f)


@app.get("/files/{path:path}")
def files(path: str):
    p = (DATA / path).resolve()
    if not str(p).startswith(str((DATA / "Data").resolve())) or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p)


# ---------------------------------------------------------------- 정확도 검증 (VALIDATION.md)
def _val_dir() -> Path:
    d = DATA / "validation"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _floats(s: str) -> list[float] | None:
    s = (s or "").strip()
    if not s:
        return None
    v = [float(x) for x in s.replace(";", ",").split(",") if x.strip()]
    if len(v) != 2 or v[1] <= v[0]:
        raise HTTPException(400, "구간은 '시작,끝'(초) 형식이어야 합니다.")
    return v


def _upload_text(f: UploadFile) -> str:
    raw = f.file.read(50 * 1024 * 1024 + 1)
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(413, "파일이 너무 큽니다(50MB 이하).")
    return raw.decode("utf-8-sig", errors="replace")


def _lab_series(sid: str, tid: str, source: str) -> dict:
    if source == "grf":
        p = L.dynamics_dir(DATA, sid, tid) / "physiocap_summary.json"
        if not p.exists():
            raise HTTPException(409, "이 시행의 동역학 결과가 없습니다.")
        return VAL.series_from_summary(_read(p), "GRF_BW")
    mot = L.kinematics_mot(DATA, sid, tid)
    if not mot.exists():
        raise HTTPException(409, "이 시행의 관절각(.mot)이 없습니다.")
    return VAL.read_table(mot.read_text(), mot.name)


def _save_validation(rec: dict) -> dict:
    import json
    rec["id"] = "val_" + time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]
    rec["created"] = now_ms()
    (_val_dir() / f"{rec['id']}.json").write_text(json.dumps(rec, ensure_ascii=False))
    return rec


@app.post("/api/validation/series")
def validation_series(reference: UploadFile = File(...), test_file: UploadFile | None = File(None),
                      session: str = Form(""), trial: str = Form(""), source: str = Form("kinematics"),
                      activity: str = Form("other"), label: str = Form(""), align_on: str = Form(""),
                      window: str = Form(""), columns: str = Form(""), remove_offset: bool = Form(False),
                      max_lag_s: float = Form(5.0)):
    """기준 장비 시계열(.mot/.sto/.csv) vs PhysioCap(랩 시행 또는 모바일 내보내기 파일)."""
    if source not in ("kinematics", "grf"):
        raise HTTPException(400, "source 는 kinematics 또는 grf")
    try:
        ref = VAL.read_table(_upload_text(reference), reference.filename or "")
        if test_file is not None and test_file.filename:
            test = VAL.read_table(_upload_text(test_file), test_file.filename)
            origin = {"file": test_file.filename}
        elif session and trial:
            get_session(session)
            test = _lab_series(session, trial, source)
            origin = {"session": session, "trial": trial}
        else:
            raise HTTPException(400, "랩 시행(session·trial) 또는 비교할 파일을 지정하세요.")
        cols = [c.strip() for c in columns.split(",") if c.strip()] or None
        res = VAL.compare_series(test, ref, columns=cols, align_on=align_on.strip() or None, window=_floats(window),
                                 max_lag_s=max_lag_s, remove_offset=remove_offset,
                                 unit="%BW" if source == "grf" else "deg")
    except (ValueError, KeyError, IndexError) as e:
        raise HTTPException(400, f"비교할 수 없습니다: {e}")
    return _save_validation({"kind": "series", "source": source, "activity": activity, "label": label,
                             "reference": reference.filename, "test": origin, "result": res,
                             "options": {"align_on": align_on, "window": window, "columns": columns,
                                         "remove_offset": remove_offset}})


@app.post("/api/validation/discrete")
def validation_discrete(sheet: UploadFile = File(...), label: str = Form(""), activity: str = Form("other")):
    """고니오미터 기록지(templates/goniometer_record.csv) → 항목별 편향·MAE·LoA·ICC.

    행마다 test_value 가 있으면 그 값을, 없으면 session·trial 의 관절각 시계열에서 mode(at/max/min/mean)로 값을 뽑는다.
    """
    import csv
    import io
    rows = list(csv.DictReader(io.StringIO(_upload_text(sheet))))
    if not rows:
        raise HTTPException(400, "기록지에 행이 없습니다.")
    cache: dict = {}
    groups: dict[str, list[dict]] = {}
    for i, r in enumerate(rows, start=2):
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        try:
            coord, mode = r["coordinate"], (r.get("mode") or "max").lower()
            ref_v = float(r["reference_deg"])
            if r.get("test_value"):
                tv = float(r["test_value"])
            else:
                key = (r["session"], r["trial"])
                if key not in cache:
                    get_session(r["session"])
                    cache[key] = _lab_series(r["session"], r["trial"], "kinematics")
                t0 = float(r["t_start"]) if r.get("t_start") else None
                t1 = float(r["t_end"]) if r.get("t_end") else None
                win = [t0, t1] if (t0 is not None and t1 is not None) else None
                tv = VAL.value_at(cache[key], coord, mode, t=t0, window=None if mode == "at" else win)
        except HTTPException:
            raise
        except (KeyError, ValueError, TypeError) as e:
            raise HTTPException(400, f"{i}행을 읽을 수 없습니다: {e}")
        groups.setdefault(f"{coord}|{mode}", []).append({"subject": r.get("subject", ""), "test": tv, "ref": ref_v})
    res = {}
    for g, items in groups.items():
        res[g] = VAL.compare_discrete(VAL.average_repeats(items))
        res[g]["unit"] = "deg"
    return _save_validation({"kind": "discrete", "source": "kinematics", "activity": activity, "label": label,
                             "reference": sheet.filename, "result": {"groups": res}})


@app.get("/api/validation")
def validation_list():
    import json
    out = []
    for p in sorted(_val_dir().glob("val_*.json"), reverse=True):
        try:
            r = json.loads(p.read_text())
        except ValueError:
            continue
        brief = {k: r.get(k) for k in ("id", "kind", "source", "activity", "label", "reference", "test", "created")}
        if r.get("kind") == "series":
            brief["summary"] = r["result"]["summary"]
        out.append(brief)
    return out


@app.get("/api/validation/summary")
def validation_summary():
    import json
    recs = []
    for p in _val_dir().glob("val_*.json"):
        try:
            recs.append(json.loads(p.read_text()))
        except ValueError:
            pass
    return VAL.aggregate(recs)


@app.get("/api/validation/{vid}")
def validation_get(vid: str):
    p = _val_dir() / f"{L.safe_name(vid)}.json"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="application/json")


@app.delete("/api/validation/{vid}")
def validation_delete(vid: str):
    p = _val_dir() / f"{L.safe_name(vid)}.json"
    if not p.exists():
        raise HTTPException(404)
    p.unlink()
    return {"ok": True}


# ---------------------------------------------------------------- 렌즈 보정(기종별 1회)
def _captures_path() -> Path:
    return DATA / "IntrinsicCaptures" / "captures.json"


def _captures() -> dict:
    import json
    try:
        return json.loads(_captures_path().read_text())
    except (FileNotFoundError, ValueError):
        return {}


def _save_captures(c: dict) -> None:
    import json
    _captures_path().write_text(json.dumps(c, ensure_ascii=False, indent=1))


_cap_lock = threading.Lock()


@app.post("/api/intrinsics/start")
def intrinsics_start(body: IntrinsicsStart):
    dev = store.devices().get(body.device_id)
    if not dev:
        raise HTTPException(404, "unregistered device")
    cid = "cap_" + time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]
    with _cap_lock:
        c = _captures()
        c[cid] = {"id": cid, "device_id": body.device_id, "model": _camera_model(dev), "state": "recording",
                  "checkerboard": body.checkerboard.model_dump(), "created": now_ms()}
        _save_captures(c)
    store.send_command(body.device_id, {"action": "record", "purpose": "intrinsics", "capture_id": cid,
                                        "start_at_server_ms": now_ms() + 800})
    return c[cid]


@app.post("/api/intrinsics/{cid}/stop")
def intrinsics_stop(cid: str):
    with _cap_lock:
        c = _captures()
        if cid not in c:
            raise HTTPException(404)
        c[cid]["state"] = "uploading"
        _save_captures(c)
    store.send_command(c[cid]["device_id"], {"action": "stop", "purpose": "intrinsics", "capture_id": cid})
    return c[cid]


def _intrinsics_uploaded(cid: str, info: dict) -> None:
    def work():
        with _cap_lock:
            c = _captures()
            cap = c.get(cid)
        if not cap:
            return
        try:
            meta = V.probe(info["file"])
            fps = V.nominal_fps(float(info.get("fps") or meta["fps"] or 60))
            dst = DATA / "IntrinsicCaptures" / cid / f"{cid}.mov"
            norm = V.normalize(info["file"], dst, fps=fps)
            dev = store.devices().get(cap["device_id"], {})
            model = L.camera_model_key(dev.get("model", "android"), norm["width"], norm["height"], fps)
            job = store.enqueue("intrinsics", capture_id=cid, camera_model=model, checkerboard=cap["checkerboard"])
            upd = {"state": "queued", "model": model, "job": job["id"]}
        except Exception as e:  # noqa: BLE001
            upd = {"state": "error", "error": str(e)}
        with _cap_lock:
            c = _captures()
            c[cid].update(upd)
            _save_captures(c)

    threading.Thread(target=work, daemon=True).start()


def sync_intrinsics() -> None:
    with _cap_lock:
        c = _captures()
        changed = False
        for cap in c.values():
            if cap.get("job") and cap["state"] in ("queued", "processing"):
                j = store.job(cap["job"])
                if j and j["state"] == "running" and cap["state"] != "processing":
                    cap["state"] = "processing"
                    changed = True
                elif j and j["state"] in ("done", "error"):
                    cap.update(state=j["state"], error=j.get("error"), result=j.get("outputs"))
                    changed = True
        if changed:
            _save_captures(c)


@app.get("/api/intrinsics")
def intrinsics_list():
    models = []
    root = DATA / "intrinsics"
    if root.exists():
        for d in sorted(root.iterdir()):
            if (d / "Deployed" / "cameraIntrinsics.pickle").exists():
                models.append(d.name)
    return {"models": models, "captures": sorted(_captures().values(), key=lambda x: x["created"], reverse=True)}


# ---------------------------------------------------------------- 기타
@app.get("/api/health")
def health():
    q = {d: len(list((DATA / "jobs" / d).glob("*.json"))) for d in ("queue", "running", "done")}
    return {"ok": True, "data": str(DATA), "jobs": q, "kinetic_motions": L.KINETIC_MOTIONS}


@app.exception_handler(KeyError)
def _keyerror(_, exc):
    return JSONResponse({"detail": f"not found: {exc}"}, status_code=404)


if DASHBOARD.exists():
    app.mount("/", StaticFiles(directory=DASHBOARD, html=True), name="dashboard")
