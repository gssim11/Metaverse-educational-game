"""OpenCap(opencap-core / opencap-processing)이 기대하는 폴더 규격을 만드는 함수 모음.

서버와 워커가 같은 규칙을 쓰도록 이 파일 하나에 모았다.

  <DATA>/Data/<session>/sessionMetadata.yaml
  <DATA>/Data/<session>/Videos/Cam0/InputMedia/<trial>/<trial>.mov
  <DATA>/Data/<session>/Videos/Cam0/cameraIntrinsicsExtrinsics.pickle   (보정 후 생성)
  <DATA>/Data/<session>/OpenSimData/Model/*.osim                          (중립 자세 후 생성)
  <DATA>/Data/<session>/OpenSimData/Kinematics/<trial>.mot               (동작 시행 후 생성)
  <DATA>/Data/<session>/OpenSimData/Dynamics/<trial>/optimaltrajectories.npy (동역학 후 생성)
  <DATA>/intrinsics/<camera_model>/Deployed/cameraIntrinsics.pickle      (기종 렌즈 보정)
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import yaml

# OpenCap 클라우드와 같은 시행 이름 규칙
CALIBRATION = "calibration"
NEUTRAL = "neutral"

# opencap-processing 의 동역학 프리셋 (example_kinetics.py)
KINETIC_MOTIONS = {
    "squats": {"label": "스쿼트", "needs": "repetition"},
    "sit_to_stand": {"label": "앉았다 일어서기", "needs": "repetition"},
    "walking": {"label": "보행", "needs": "time_window"},
    "jumping": {"label": "점프", "needs": "time_window"},
    "drop_jump": {"label": "드롭 점프", "needs": "time_window"},
    "running": {"label": "달리기", "needs": "time_window"},
    "other": {"label": "기타(일반 설정)", "needs": "time_window"},
}
NO_KINETICS = "none"

# 관절각 계산 방식별로 분석·표시에서 빼는 관절. B 방식(keypoints)의 거골하 각도는 키포인트로 발의
# 안쪽·바깥쪽 기울기를 정할 수 없어 거의 0°에 고정된다(lab/README.md B 방식 절). 원본 .mot 에는
# 동역학 시뮬레이션 입력으로 남겨 두고, 결과 화면·정확도 검증·동역학 요약에서만 뺀다.
EXCLUDED_COORDINATES = {"keypoints": ("subtalar_angle_r", "subtalar_angle_l")}


def excluded_coordinates(kinematics_method: str | None) -> tuple[str, ...]:
    return EXCLUDED_COORDINATES.get(kinematics_method or "augmenter", ())


def is_excluded(name: str, excluded) -> bool:
    """관절각 이름 또는 그 관절의 모멘트·시뮬레이션 라벨(예: subtalar_angle_r_moment)이 제외 대상인지."""
    return any(name == c or name.startswith(c + "_") for c in excluded)


def drop_coordinates(mot: dict, excluded) -> dict:
    """read_mot 결과 {columns, data} 에서 제외 관절 열을 뺀다."""
    keep = [i for i, c in enumerate(mot["columns"]) if not is_excluded(c, excluded)]
    return {"columns": [mot["columns"][i] for i in keep], "data": [[row[i] for i in keep] for row in mot["data"]]}

SAFE = re.compile(r"[^A-Za-z0-9_\-]")


def safe_name(s: str, fallback: str = "x") -> str:
    """경로에 쓸 수 있는 이름(영문·숫자·_·-)."""
    out = SAFE.sub("_", (s or "").strip())[:64].strip("_")
    return out or fallback


def camera_model_key(model: str, width: int, height: int, fps: int) -> str:
    """렌즈 보정값은 기종·해상도·프레임률(=센서 크롭 모드)마다 다르므로 함께 묶는다."""
    w, h = sorted([int(width), int(height)])
    return f"{safe_name(model, 'android')}_{w}x{h}_{int(round(fps))}fps"


def session_dir(data_root: str | Path, session: str) -> Path:
    return Path(data_root) / "Data" / safe_name(session)


def trial_video_path(data_root, session: str, cam: str, trial: str, ext: str = ".mov") -> Path:
    return session_dir(data_root, session) / "Videos" / cam / "InputMedia" / trial / f"{trial}{ext}"


def intrinsics_dir(data_root, camera_model: str) -> Path:
    return Path(data_root) / "intrinsics" / camera_model / "Deployed"


def build_session_metadata(subject: dict, checkerboard: dict, cameras: dict, pose_detector: str = "hrnet",
                           opensim_model: str = "LaiUhlrich2022", augmenter: str = "LSTM") -> dict:
    """opencap-core defaultSessionMetadata.yaml 과 같은 키 구조.

    cameras: {"Cam0": {"model": "<camera_model_key>"}, ...}
    checkerboard: {"cols": 내부 코너 가로 수, "rows": 내부 코너 세로 수, "square_mm": 한 칸 길이, "placement": "backWall"|"ground"}
    """
    placement = checkerboard.get("placement", "backWall")
    if placement not in ("backWall", "ground"):
        raise ValueError("checkerboard placement must be backWall or ground")
    meta = {
        "calibrationSettings": {"overwriteDeployedIntrinsics": False, "saveSessionIntrinsics": False},
        "checkerBoard": {
            "black2BlackCornersWidth_n": int(checkerboard["cols"]),
            "black2BlackCornersHeight_n": int(checkerboard["rows"]),
            "placement": placement,
            "squareSideLength_mm": float(checkerboard["square_mm"]),
        },
        "gender_mf": subject.get("sex", "m"),
        "height_m": float(subject["height_m"]),
        "mass_kg": float(subject["mass_kg"]),
        "subjectID": safe_name(subject.get("id", "subject")),
        # OpenCap 은 키 이름이 iphoneModel 이지만 값은 CameraIntrinsics/<값>/Deployed 폴더 이름으로만 쓰인다.
        "iphoneModel": {cam: info["model"] for cam, info in sorted(cameras.items())},
        "markerAugmentationSettings": {"markerAugmenterModel": augmenter},
        "openSimModel": opensim_model,
        "posemodel": pose_detector,
    }
    return meta


def write_session_metadata(data_root, session: str, meta: dict) -> Path:
    d = session_dir(data_root, session)
    d.mkdir(parents=True, exist_ok=True)
    p = d / "sessionMetadata.yaml"
    with open(p, "w") as f:
        yaml.safe_dump(meta, f, sort_keys=True)
    return p


def calibration_solution_files(data_root, session: str) -> dict[str, list[Path]]:
    """보정 시행에서 opencap-core 가 남긴 외부 파라미터 후보(soln0/soln1)를 카메라별로 찾는다."""
    out: dict[str, list[Path]] = {}
    vids = session_dir(data_root, session) / "Videos"
    if not vids.exists():
        return out
    for cam in sorted(p.name for p in vids.iterdir() if p.is_dir() and p.name.startswith("Cam")):
        files = sorted((vids / cam).rglob("cameraIntrinsicsExtrinsics_soln*.pickle"))
        if files:
            out[cam] = files
    return out


def kinematics_mot(data_root, session: str, trial: str) -> Path:
    return session_dir(data_root, session) / "OpenSimData" / "Kinematics" / f"{trial}.mot"


def dynamics_dir(data_root, session: str, trial: str) -> Path:
    return session_dir(data_root, session) / "OpenSimData" / "Dynamics" / trial


def scaled_model_exists(data_root, session: str) -> bool:
    d = session_dir(data_root, session) / "OpenSimData" / "Model"
    return d.exists() and any(d.glob("*.osim"))


def read_mot(path: str | os.PathLike) -> dict:
    """OpenSim .mot/.sto 를 {columns, data} 로 읽는다 (헤더 'endheader' 이후 탭 구분)."""
    with open(path) as f:
        return read_mot_text(f.read())


def read_mot_text(text: str) -> dict:
    lines = text.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.strip().lower() == "endheader") + 1
    except StopIteration:
        start = 0
    cols = [c.strip() for c in lines[start].split("\t")] if start < len(lines) else []
    data = []
    for l in lines[start + 1:]:
        if not l.strip():
            continue
        try:
            data.append([float(x) for x in l.split()])
        except ValueError:
            continue
    return {"columns": cols, "data": data}
