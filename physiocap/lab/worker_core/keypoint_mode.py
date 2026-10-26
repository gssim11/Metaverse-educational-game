"""B 방식(키포인트 직접 역기구학): LSTM 마커 증강 없이 관절각을 계산한다.

OpenCap 기본(augmenter) 흐름
  포즈 인식 → 동기화 → 삼각측량(영상 키포인트 3D) → LSTM 마커 증강(키포인트 → 해부학 마커 43개)
  → 증강 마커로 스케일링·역기구학
B 방식(keypoints) 흐름
  포즈 인식 → 동기화 → 삼각측량(영상 키포인트 3D) → 그 키포인트 자체로 스케일링·역기구학

OpenCap 코드는 고치지 않는다. main() 이 실행되는 동안만 main 모듈 안의 네 함수를 바꿔 끼운다.
  augmentTRC         → 증강하지 않고 키포인트 TRC 를 그대로 복사(바닥 높이 맞춤만 같은 방식으로 적용)
  getScaleTimeRange  → 정지 구간을 증강 마커 대신 키포인트로 찾음
  runScaleTool       → 키포인트용 스케일링 설정(Setup_scaling_LaiUhlrich2022_mmpose.xml)
                       + 엉덩이 키포인트 마커 위치를 Pose2Sim 값으로 바꾼 마커 세트
  runIKTool          → 키포인트 궤적에 저역통과 필터(4차 Butterworth 6 Hz, 양방향) 후
                       키포인트용 역기구학 설정(Setup_IK_mmpose.xml) + 약한 관절각 제약(아래 REGULARIZATION)
두 설정 파일과 키포인트 마커 세트(LaiUhlrich2022_markers_mmpose.xml)는 opencap-core 저장소에 이미 들어 있는 파일이다.

Pose2Sim(BSD-3-Clause, perfanalytics/pose2sim)에서 가져온 것 두 가지:
  - 엉덩이 마커 위치: 영상 키포인트의 "엉덩이"는 고관절 중심보다 바깥·뒤쪽에 찍힌다. Pose2Sim 의 COCO-133 마커 세트
    (OpenSim_Setup/Markers_Coco133.xml, 커밋 084d822)의 골반 좌표계 위치를 쓴다. 두 모델 모두 Rajagopal 계열이라
    골반 좌표계가 같다고 보고 그대로 옮겼다.
  - 역기구학 전 3D 궤적 필터: Pose2Sim 기본 설정(Butterworth 4차, 6 Hz)과 같다.
엄지발가락 마커 추가와 Pose2Sim 식 균등 마커 가중치도 시험했지만 OpenCap 결과와의 차이가 줄지 않아 넣지 않았다.

약한 관절각 제약이 필요한 이유: 영상 키포인트 중 골반 점(좌·우 엉덩이, 그 중점)은 한 직선 위에 있어
골반 앞뒤 기울기와 허리 굴곡을 나눌 정보가 없다. 제약이 없으면 이 둘이 프레임마다 크게 튄다
(OpenCap 시험 영상 걷기에서 골반 기울기가 프레임 사이 최대 40°). 그래서 허리·거골하 관절에 0° 쪽으로
아주 약한 가중치를 준다. 가중치는 opencap-test-data 의 걷기·스쿼트 2개 시행에서 OpenCap 결과와의
차이가 가장 작은 값으로 골랐다(lab/README.md 의 B 방식 절 참고). 시행 2개로 고른 값이므로
본 검증 자료로 다시 확인해야 한다.

같은 세션의 중립 자세와 동작 시행은 반드시 같은 방식으로 처리해야 한다
(스케일링된 모델의 마커 세트가 방식마다 다르기 때문). 그래서 방식은 세션 단위로 정한다.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
from contextlib import contextmanager

AUGMENTER = "augmenter"
KEYPOINTS = "keypoints"
METHODS = (AUGMENTER, KEYPOINTS)

SCALE_SETUP = ("Scaling", "Setup_scaling_LaiUhlrich2022_mmpose.xml")
IK_SETUP = ("IK", "Setup_IK_mmpose.xml")
MARKER_SET = "LaiUhlrich2022_markers_mmpose.xml"
# 엉덩이 키포인트의 골반 좌표계 위치(m). Pose2Sim Markers_Coco133.xml 의 LHip/RHip 값. midHip 은 두 점의 중점.
HIP_MARKERS = {
    "RHip": (-0.063927444458007812, -0.081343112945556642, 0.10540640790244724),
    "LHip": (-0.063927444458007812, -0.081343112945556642, -0.10540640790244724),
    "midHip": (-0.063927444458007812, -0.081343112945556642, 0.0),
}
FILTER_HZ = 6.0
FILTER_ORDER = 4
# 관절각 제약 가중치(목표값 0°). 마커 가중치(5~60, 단위 m)에 비해 아주 작다.
REGULARIZATION = {
    "lumbar_extension": 0.001,
    "lumbar_bending": 0.01,
    "lumbar_rotation": 0.01,
    "subtalar_angle_r": 0.01,
    "subtalar_angle_l": 0.01,
}


def ik_setup_with_regularization(base_setup: str, out_path: str, weights: dict = REGULARIZATION) -> str:
    """OpenCap 의 키포인트 역기구학 설정에 관절각 제약(IKCoordinateTask)을 덧붙인 사본을 만든다."""
    with open(base_setup) as f:
        xml = f.read()
    tasks = "".join(
        f'<IKCoordinateTask name="{c}"><apply>true</apply><weight>{w}</weight>'
        f"<value_type>manual_value</value_type><value>0</value></IKCoordinateTask>\n"
        for c, w in weights.items() if w > 0)
    if "</objects>" not in xml:
        raise ValueError(f"역기구학 설정 형식이 예상과 다릅니다: {base_setup}")
    with open(out_path, "w") as f:
        f.write(xml.replace("</objects>", tasks + "</objects>", 1))
    return out_path


def keypoint_marker_set(xml: str, locations: dict = HIP_MARKERS) -> str:
    """OpenCap 키포인트 마커 세트 XML 에서 지정한 마커의 위치(location)만 바꾼다."""
    for name, (x, y, z) in locations.items():
        pat = re.compile(r'(<Marker name="' + re.escape(name) + r'">.*?<location>)[^<]*(</location>)', re.S)
        xml, n = pat.subn(lambda m: f"{m.group(1)}{x} {y} {z}{m.group(2)}", xml, count=1)
        if n != 1:
            raise ValueError(f"마커 세트에 {name} 이(가) 없습니다.")
    return xml


def lowpass_trc(src: str, dst: str, cutoff_hz: float = FILTER_HZ, order: int = FILTER_ORDER) -> bool:
    """TRC 의 모든 좌표에 양방향 Butterworth 저역통과 필터를 건다. 걸 수 없으면(짧음·결측·낮은 샘플링) 그대로 복사."""
    import numpy as np
    from scipy.signal import butter, filtfilt

    lines = open(src).read().splitlines()
    header, rows = lines[:5], [l.split("\t") for l in lines[5:] if l.strip()]
    try:
        data = np.array([[float(v) for v in r] for r in rows])
    except ValueError:
        data = None
    b, a = (None, None)
    if data is not None and data.ndim == 2 and len(data) > 3 * (order + 1) and not np.isnan(data).any():
        fs = 1.0 / float(np.mean(np.diff(data[:, 1])))
        if fs > 2 * cutoff_hz:
            b, a = butter(order, cutoff_hz / (fs / 2))
    if b is None:
        shutil.copyfile(src, dst)
        return False
    data[:, 2:] = filtfilt(b, a, data[:, 2:], axis=0)
    with open(dst, "w") as f:
        f.write("\n".join(header) + "\n")
        for r in data:
            f.write("\t".join([str(int(r[0])), f"{r[1]:.6f}"] + [f"{v:.6f}" for v in r[2:]]) + "\n")
    return True


def check_supported(method: str, opensim_model: str) -> None:
    if method not in METHODS:
        raise ValueError(f"알 수 없는 관절각 계산 방식: {method}")
    if method == KEYPOINTS and "shoulder" in (opensim_model or ""):
        raise ValueError("B 방식(키포인트)은 어깨 모델(LaiUhlrich2022_shoulder)을 지원하지 않습니다.")


def passthrough_trc(pathInputTRCFile, subject_mass, subject_height, pathOutputTRCFile, augmenterDir,
                    augmenterModelName="LSTM", augmenter_model="v0.3", offset=True):
    """augmentTRC 와 같은 인자·반환값. 마커를 늘리지 않고, 바닥 높이 맞춤만 같은 방식으로 한다.

    OpenCap 은 증강 마커의 최저 높이를 바닥으로 보고 0.01 m 위에 오도록 옮긴다.
    여기서는 키포인트(발뒤꿈치·발끝 포함)의 최저 높이를 쓴다.
    """
    import numpy as np
    import utilsDataman

    trc = utilsDataman.TRCFile(pathInputTRCFile)
    ys = np.concatenate([np.asarray(trc.marker(m))[:, 1] for m in trc.marker_names])
    min_y_pos = float(np.nanmin(ys))
    if offset:
        trc.offset("y", -(min_y_pos - 0.01))
    trc.write(pathOutputTRCFile)
    return min_y_pos


@contextmanager
def keypoint_pipeline(main_module, opensim_pipeline_dir):
    """main_module(opencap-core 의 main.py) 실행 중에만 B 방식 함수로 바꿔 끼운다."""
    names = ("augmentTRC", "getScaleTimeRange", "runScaleTool", "runIKTool")
    orig = {n: getattr(main_module, n) for n in names}
    scale_setup = os.path.join(opensim_pipeline_dir, *SCALE_SETUP)
    ik_setup = os.path.join(opensim_pipeline_dir, *IK_SETUP)

    def scale_time_range(pathTRCFile, **kw):
        kw["withOpenPoseMarkers"] = True  # 정지 구간을 키포인트로 찾는다
        return orig["getScaleTimeRange"](pathTRCFile, **kw)

    def run_scale(_generic_setup, pathGenericModel, *args, **kw):
        # runScaleTool 은 마커 세트를 일반 모델과 같은 폴더의 LaiUhlrich2022_markers_mmpose.xml 에서 읽는다.
        # 그래서 임시 폴더에 일반 모델 사본과 엉덩이 위치를 바꾼 마커 세트를 두고 그 사본으로 스케일링한다.
        model_dir = os.path.dirname(pathGenericModel)
        tmp = tempfile.mkdtemp(prefix="physiocap_kp_")
        try:
            generic = os.path.join(tmp, os.path.basename(pathGenericModel))
            shutil.copyfile(pathGenericModel, generic)
            with open(os.path.join(model_dir, MARKER_SET)) as f:
                xml = keypoint_marker_set(f.read())
            with open(os.path.join(tmp, MARKER_SET), "w") as f:
                f.write(xml)
            return orig["runScaleTool"](scale_setup, generic, *args, **kw)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def run_ik(_generic_setup, pathScaledModel, pathTRCFile, pathOutputFolder, *args, **kw):
        os.makedirs(pathOutputFolder, exist_ok=True)
        setup = ik_setup_with_regularization(ik_setup, os.path.join(pathOutputFolder, "Setup_IK_keypoints_generic.xml"))
        name = os.path.splitext(os.path.basename(pathTRCFile))[0]
        filtered = os.path.join(pathOutputFolder, f"{name}_keypoints_filtered.trc")
        lowpass_trc(pathTRCFile, filtered)
        kw.setdefault("IKFileName", name)  # 결과 파일 이름은 원래 시행 이름(<시행>.mot) 그대로
        return orig["runIKTool"](setup, pathScaledModel, filtered, pathOutputFolder, *args, **kw)

    patched = {"augmentTRC": passthrough_trc, "getScaleTimeRange": scale_time_range,
               "runScaleTool": run_scale, "runIKTool": run_ik}
    for n, f in patched.items():
        setattr(main_module, n, f)
    try:
        yield
    finally:
        for n, f in orig.items():
            setattr(main_module, n, f)
