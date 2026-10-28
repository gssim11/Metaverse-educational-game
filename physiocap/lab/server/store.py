"""파일 기반 저장소: 세션·기기·작업(job) 상태를 JSON 으로 보관한다.

작업 큐는 디렉터리 3개(queue → running → done)로 이뤄지며, 워커 컨테이너가 같은 볼륨을 보고
파일 이름 바꾸기(원자적 rename)로 작업을 가져간다. 데이터베이스 서버가 필요 없다.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

_lock = threading.RLock()


def now_ms() -> int:
    return int(time.time() * 1000)


_last_job_ms = 0


def _next_job_ms() -> int:
    """작업 ID 앞부분(ms). 같은 ms 에 여러 작업을 넣어도 넣은 순서대로 정렬되도록 항상 증가시킨다."""
    global _last_job_ms
    with _lock:
        _last_job_ms = max(now_ms(), _last_job_ms + 1)
        return _last_job_ms


def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{uuid.uuid4().hex[:6]}.tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _read_json(path: Path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


class Store:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        for d in ("Data", "uploads", "intrinsics", "IntrinsicCaptures", "jobs/queue", "jobs/running", "jobs/done"):
            (self.root / d).mkdir(parents=True, exist_ok=True)

    # ---------- 기기 ----------
    @property
    def _devices_path(self) -> Path:
        return self.root / "devices.json"

    def devices(self) -> dict:
        return _read_json(self._devices_path, {}) or {}

    def update_device(self, device_id: str, **fields) -> dict:
        with _lock:
            devs = self.devices()
            d = devs.get(device_id, {"id": device_id, "seq": 0, "command": None, "offsets": []})
            d.update(fields)
            devs[device_id] = d
            _write_json(self._devices_path, devs)
            return d

    def send_command(self, device_id: str, command: dict) -> dict:
        with _lock:
            devs = self.devices()
            if device_id not in devs:
                raise KeyError(device_id)
            d = devs[device_id]
            d["seq"] = int(d.get("seq", 0)) + 1
            d["command"] = {**command, "seq": d["seq"], "issued_ms": now_ms()}
            _write_json(self._devices_path, devs)
            return d["command"]

    # ---------- 세션 ----------
    def _session_path(self, sid: str) -> Path:
        return self.root / "Data" / sid / "physiocap_session.json"

    def sessions(self) -> list[dict]:
        out = []
        for p in sorted((self.root / "Data").glob("*/physiocap_session.json")):
            s = _read_json(p)
            if s:
                out.append(s)
        return sorted(out, key=lambda s: s.get("created", 0), reverse=True)

    def session(self, sid: str) -> dict | None:
        return _read_json(self._session_path(sid))

    def save_session(self, s: dict) -> dict:
        with _lock:
            s["updated"] = now_ms()
            _write_json(self._session_path(s["id"]), s)
        return s

    def mutate_session(self, sid: str, fn) -> dict:
        with _lock:
            s = self.session(sid)
            if s is None:
                raise KeyError(sid)
            fn(s)
            return self.save_session(s)

    # ---------- 작업 큐 ----------
    def enqueue(self, kind: str, **params) -> dict:
        job = {"id": f"{_next_job_ms()}_{uuid.uuid4().hex[:8]}", "kind": kind, "state": "queued",
               "created": now_ms(), **params}
        _write_json(self.root / "jobs" / "queue" / f"{job['id']}.json", job)
        return job

    def job(self, job_id: str) -> dict | None:
        for d in ("done", "running", "queue"):
            j = _read_json(self.root / "jobs" / d / f"{job_id}.json")
            if j:
                return j
        return None


# ---------- 워커 쪽 도우미 (워커 컨테이너에서도 이 파일을 그대로 import 한다) ----------
def claim_job(root: str | Path, kinds: set[str]) -> dict | None:
    """가장 오래된 대기 작업 하나를 가져온다(rename 이 성공한 워커만 소유)."""
    q = Path(root) / "jobs" / "queue"
    for p in sorted(q.glob("*.json")):
        j = _read_json(p)
        if not j or j.get("kind") not in kinds:
            continue
        dst = Path(root) / "jobs" / "running" / p.name
        try:
            os.replace(p, dst)
        except FileNotFoundError:
            continue  # 다른 워커가 먼저 가져감
        j["state"] = "running"
        j["started"] = now_ms()
        _write_json(dst, j)
        return j
    return None


def update_running(root: str | Path, job: dict, **fields) -> None:
    job.update(fields)
    _write_json(Path(root) / "jobs" / "running" / f"{job['id']}.json", job)


def finish_job(root: str | Path, job: dict, ok: bool, error: str | None = None, **result) -> None:
    job.update(result)
    job["state"] = "done" if ok else "error"
    job["finished"] = now_ms()
    if error:
        job["error"] = error
    src = Path(root) / "jobs" / "running" / f"{job['id']}.json"
    _write_json(Path(root) / "jobs" / "done" / f"{job['id']}.json", job)
    try:
        src.unlink()
    except FileNotFoundError:
        pass


def requeue_orphans(root: str | Path, kinds: set[str]) -> list[str]:
    """워커 시작 시 호출: 이전 실행이 끝내지 못하고 running 에 남긴 작업을 queue 로 되돌린다.

    종류(kind)마다 워커가 하나뿐이라는 전제(docker-compose 기본값)에서만 안전하다.
    """
    moved = []
    for p in sorted((Path(root) / "jobs" / "running").glob("*.json")):
        j = _read_json(p)
        if not j or j.get("kind") not in kinds:
            continue
        j["state"] = "queued"
        j["requeued"] = int(j.get("requeued", 0)) + 1
        j.pop("started", None)
        _write_json(Path(root) / "jobs" / "queue" / p.name, j)
        try:
            p.unlink()
        except FileNotFoundError:
            pass
        moved.append(j["id"])
    return moved
