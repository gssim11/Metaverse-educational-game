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
import video as V
from store import Store, now_ms

DATA = Path(os.environ.get("PHYSIOCAP_DATA", "/data/physiocap"))
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


class SessionCreate(BaseModel):
    name: str = ""
    subject: Subject
    checkerboard: Checkerboard = Checkerboard()
    cameras: dict[str, str] = Field(default_factory=dict, description="{'Cam0': device_id, 'Cam1': device_id}")
    pose_detector: str = "hrnet"
    opensim_model: str = "LaiUhlrich2022"


class TrialStart(BaseModel):
    type: str = "dynamic"  # calibration | neutral | dynamic
    name: str = ""
    motion_type: str = L.NO_KINETICS
    repetition: int | None = None
    time_window: list[float] | None = None


class KineticsRequest(BaseModel):
    motion_type: str
    repetition: int | None = None
    time_window: list[float] | None = None
    case: str = "0"


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
    sid = L.safe_name(body.name or time.strftime("S%Y%m%d_%H%M%S")) + "_" + uuid.uuid4().hex[:4]
    s = {
        "id": sid, "name": body.name or sid, "created": now_ms(),
        "subject": body.subject.model_dump(), "checkerboard": body.checkerboard.model_dump(),
        "pose_detector": body.pose_detector, "opensim_model": body.opensim_model,
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
                            pose_detector=s.get("pose_detector", "hrnet"))

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
                    if j["state"] == "done" and t["type"] == "dynamic" and t.get("motion_type", L.NO_KINETICS) in L.KINETIC_MOTIONS:
                        p = t.get("kinetics_params") or {}
                        _enqueue_kinetics(s["id"], t["id"], t["motion_type"], p.get("repetition"), p.get("time_window"))
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
    dyn = L.dynamics_dir(DATA, sid, tid) / "physiocap_summary.json"
    if dyn.exists():
        out["kinetics"] = _read(dyn)
    for p in sorted(sd.rglob("*")):
        if p.is_file() and p.suffix.lower() in (".mot", ".trc", ".osim", ".json", ".jpg", ".png", ".csv", ".yaml", ".npy", ".sto") and (tid in p.parts or tid in p.stem or p.parent.name in ("Model", "CalibrationImages")):
            out["files"].append(str(p.relative_to(DATA)))
    return out


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
