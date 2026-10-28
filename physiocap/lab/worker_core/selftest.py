"""설치 자가 검증: OpenCap 공식 테스트 세션(opencap-test-data, 실제 iPhone 2대 영상)을
PhysioCap 워커로 처리하고 OpenCap 기준 결과(OutputReference)와 비교한다.

  docker compose run --rm core python3.8 /workspace/physiocap/selftest.py

비교 함수와 허용 오차는 opencap-core/tests/test_main.py 의 것을 그대로 쓴다
(마커 궤적 TRC: 절대오차 1e-3, 관절각 MOT: 지정 구간 비교).
GPU 포즈 인식은 미리 계산된 HRNet 결과(pkl)를 써서 건너뛴다 — 포즈 인식 외 전 과정
(동기화·삼각측량·LSTM 마커 보강·OpenSim 역기구학)을 검증한다.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

OPENCAP = Path(os.environ.get("OPENCAP_CORE_DIR", "/workspace"))
TEST_DATA = Path(os.environ.get("OPENCAP_TEST_DATA", "/data/opencap-test-data"))
TEST_DATA_REF = os.environ.get("OPENCAP_TEST_DATA_REF", "main")

# test_main.py 의 매개변수와 같은 구간(t0, tf)
TRIALS = [("walk", 1.0, 5.0), ("squats", 3.0, 8.0)]


def ensure_test_data() -> None:
    if (TEST_DATA / "Data" / "sync_2-cameras" / "sessionMetadata.yaml").exists():
        return
    print("OpenCap 테스트 데이터 받는 중 (약 500 MB)…", flush=True)
    subprocess.run(["git", "clone", "--depth", "1", "--branch", TEST_DATA_REF,
                    "https://github.com/stanfordnmbl/opencap-test-data.git", str(TEST_DATA)], check=True)


def main() -> int:
    ensure_test_data()
    # opencap-core 테스트 모듈이 찾는 위치에 연결
    link = OPENCAP / "tests" / "opencap-test-data"
    if link.is_dir() and not any(link.iterdir()):
        link.rmdir()
    if not link.exists():
        os.symlink(TEST_DATA, link, target_is_directory=True)
    sys.path[:0] = [str(OPENCAP / "tests"), str(OPENCAP), str(Path(__file__).resolve().parent)]

    data = Path(tempfile.mkdtemp(prefix="physiocap-selftest-"))
    os.environ["PHYSIOCAP_DATA"] = str(data)
    import physiocap_core_worker as w  # PHYSIOCAP_DATA 설정 후 import
    w.DATA = data
    from conftest import SYNC_2CAM_DIR
    from test_main import compare_mot_files, compare_trc, prepare_test_session

    session = "selftest_sync_2-cameras"
    ok = True
    for trial, t0, tf in TRIALS:
        sd = data / "Data" / session
        shutil.rmtree(sd, ignore_errors=True)
        prepare_test_session(SYNC_2CAM_DIR, str(sd), trial, ["Cam0", "Cam1"], "OutputPkl_mmpose_0.8",
                             scaled_model_name="LaiUhlrich2022_scaled.osim")
        start = time.time()
        try:
            out = w.run_core({"id": f"selftest-{trial}", "session": session, "trial": trial,
                              "trial_type": "dynamic", "pose_detector": "hrnet"})
            compare_trc(str(sd / "MarkerData" / "PostAugmentation" / f"{trial}.trc"),
                        os.path.join(SYNC_2CAM_DIR, "OutputReference", f"{trial}.trc"))
            ref_mot = os.path.join(SYNC_2CAM_DIR, "OutputReference", f"{trial}.mot")
            if os.path.exists(ref_mot):
                compare_mot_files(str(sd / "OpenSimData" / "Kinematics" / f"{trial}.mot"), ref_mot, t0, tf)
            print(f"[PASS] {trial}: OpenCap 기준 결과와 일치 ({time.time() - start:.0f}s) {out.get('mot')}", flush=True)
        except Exception as e:  # noqa: BLE001
            ok = False
            print(f"[FAIL] {trial}: {e!r}", flush=True)
    shutil.rmtree(data, ignore_errors=True)
    print("자가 검증 " + ("통과" if ok else "실패"), flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
