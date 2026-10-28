"""갤럭시 녹화 파일 → OpenCap 입력 규격(.mov, 세로 정방향, 고정 프레임률, 공통 시작점) 변환."""
from __future__ import annotations

import json
import subprocess
from fractions import Fraction
from pathlib import Path


def probe(path: str | Path) -> dict:
    """ffprobe 결과에서 필요한 값만: width/height(회전 적용 후), fps, duration, rotation."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    meta = json.loads(out)
    v = next(s for s in meta["streams"] if s.get("codec_type") == "video")
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(round(float(sd["rotation"])))
    if "rotate" in (v.get("tags") or {}):
        rot = int(v["tags"]["rotate"])
    w, h = int(v["width"]), int(v["height"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    rate = v.get("avg_frame_rate") or "0/0"
    if rate in ("0/0", "0/1"):
        rate = v.get("r_frame_rate") or "0/1"
    try:
        fps = float(Fraction(rate))
    except (ZeroDivisionError, ValueError):
        fps = 0.0
    dur = float(meta.get("format", {}).get("duration") or v.get("duration") or 0)
    return {"width": w, "height": h, "fps": fps, "duration": dur, "rotation": rot}


def nominal_fps(measured: float) -> int:
    """가변 프레임률 녹화의 평균값을 가장 가까운 표준 값으로."""
    for f in (24, 25, 30, 48, 50, 60, 120, 240):
        if abs(measured - f) <= max(1.5, f * 0.06):
            return f
    return int(round(measured)) or 30


def common_start_trims(starts_server_ms: dict[str, float]) -> dict[str, float]:
    """카메라별 녹화 시작 시각(서버 시계, ms) → 앞부분에서 잘라낼 초. 가장 늦게 시작한 카메라에 맞춘다."""
    latest = max(starts_server_ms.values())
    return {cam: max(0.0, (latest - t) / 1000.0) for cam, t in starts_server_ms.items()}


def normalize(src: str | Path, dst: str | Path, fps: int, trim_s: float = 0.0, crf: int = 17) -> dict:
    """재인코딩: 회전 메타데이터를 실제 화소에 적용(세로 정방향), 고정 프레임률, 소리 제거, H.264 .mov."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if trim_s > 0:
        cmd += ["-ss", f"{trim_s:.3f}"]
    cmd += [
        "-i", str(src),
        "-vf", f"fps={int(fps)}",
        "-c:v", "libx264", "-preset", "fast", "-crf", str(crf), "-pix_fmt", "yuv420p",
        "-an", "-metadata:s:v:0", "rotate=0",
        str(dst),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    info = probe(dst)
    if info["rotation"]:
        raise RuntimeError(f"normalized video still has rotation {info['rotation']}")
    return info
