# PhysioCap Lab — 갤럭시 2대 + GPU PC로 돌리는 OpenCap 파이프라인

OpenCap(Stanford)과 같은 처리를 Android(갤럭시) 폰으로 할 수 있게 만든 연구실용 구성입니다. 처리 코드는 OpenCap 원본(`opencap-core`, `opencap-processing`, Apache 2.0)을 **고정 커밋 그대로** 사용합니다. 새로 만든 부분은 세 가지입니다.

- 갤럭시 촬영 앱 "연구실 모드"
- 촬영을 지휘하는 서버와 대시보드
- 갤럭시 기종별 렌즈 보정

| 단계 | 하는 일 | 사용하는 코드 |
|---|---|---|
| 촬영 | 대시보드 명령으로 두 폰이 같은 시각에 녹화 시작. 세로 720p, 초점 고정, 손떨림 보정 끔, 가능하면 60fps | PhysioCap 연구실 모드 |
| 영상 정리 | 회전 적용, 고정 프레임률 변환, 두 영상 시작점 맞춤 | PhysioCap 서버(ffmpeg) |
| 렌즈 보정 | 기종·해상도·프레임률마다 1회, 체커보드 영상으로 내부 파라미터 계산 | opencap-core `computeAverageIntrinsics` |
| 카메라 보정 | 체커보드로 두 카메라의 위치·방향 계산 | opencap-core `main(extrinsicsTrial=True)` |
| 중립 자세 | 포즈 인식 → 동기화 → 삼각측량 → LSTM 마커 보강 → OpenSim 스케일링 | opencap-core `main(scaleModel=True)` |
| 동작 시행 | 같은 과정 → OpenSim 역기구학(관절각 .mot) | opencap-core `main()` |
| 동역학 | 근육 구동 시뮬레이션 → 지면반력·관절 모멘트·근활성·근력 | opencap-processing `processInputsOpenSimAD` + `run_tracking` |

## 준비물

- **GPU PC**: NVIDIA GPU. OpenCap 문서 기준 최소 4GB, 기본 설정은 8GB 이상입니다.
  - Ubuntu 22.04 이상을 권장합니다. Windows는 WSL2와 Docker Desktop으로 돌립니다.
  - NVIDIA 드라이버, Docker, NVIDIA Container Toolkit이 필요합니다.
  - 디스크 여유는 40GB 이상이 필요합니다(이미지와 데이터).
- **갤럭시 폰 2대**: PhysioCap APK를 설치합니다. 같은 기종이면 렌즈 보정을 한 번만 하면 됩니다.
- **삼각대 2개**
- **체커보드**: A4에 인쇄해 단단한 판에 붙입니다. OpenCap 기본은 내부 코너 5×4, 한 칸 35mm입니다.
- PC와 폰이 같은 Wi-Fi(공유기)에 있어야 합니다.

## 설치 (GPU PC, 처음 한 번)

```bash
git clone <이 저장소> && cd <저장소>/physiocap/lab
docker compose up -d --build        # 처음 빌드는 30분~1시간 (OpenCap 이미지·모델 다운로드)
docker compose ps                    # server, core, mmpose, kinetics 가 running 이면 정상
```

브라우저에서 `http://localhost:8000` 을 엽니다. 폰은 `http://<PC 내부 IP>:8000` 으로 접속하므로 PC 방화벽에서 8000번 포트를 허용하세요.

## 사용 순서

1. **폰 연결**: 두 폰에서 PhysioCap 앱 → **연구실 모드**를 엽니다. 대시보드 "폰 연결" 탭에 PC 주소를 넣으면 나오는 QR을 스캔합니다.
2. **렌즈 보정** (기종마다 1회):
   - "렌즈 보정" 탭에서 폰을 고르고 녹화를 시작합니다.
   - 체커보드를 폰 앞 0.5~2 m에서 여러 각도로 기울이며 화면 구석구석에 30~60초 비춥니다.
   - 정지·업로드를 누르면 렌즈 값이 계산됩니다. 같은 기종의 다른 폰은 다시 할 필요가 없습니다.
3. **세션 만들기**: 키, 체중, Cam0/Cam1 폰, 체커보드 규격과 위치를 입력합니다.
4. **체커보드 보정**: 두 폰을 삼각대에 세로로 세우고 1~2초 녹화합니다.
   - 피험자를 사이에 두고 약 30~45° 벌려 3~4 m 거리에 둡니다.
   - 체커보드가 두 화면 모두에 또렷이 보여야 합니다.
5. **중립 자세**: 체커보드를 치웁니다. 피험자는 정면을 보고 팔을 몸에서 약간 떼고 3~5초 서 있습니다.
6. **동작 시행**: 시행 이름과 동역학 동작 종류를 고르고 녹화를 시작/정지합니다.
   - 스쿼트·앉았다 일어서기는 분석할 반복 번호를 정합니다.
   - 보행·점프는 시뮬레이션할 구간을 정합니다(2초 이하 권장).
   - 관절각 처리가 끝나면 동역학이 자동으로 이어집니다.
7. **결과**: 시행의 "결과" 버튼을 누르면 관절각과 동역학 그래프가 나옵니다. OpenSim 모델, .mot, .trc, 보정 이미지를 내려받을 수 있습니다.

촬영 요령은 OpenCap의 [best practices](https://www.opencap.ai/best-pratices)와 같습니다. 두 영상의 동기화가 실패하면, 시작할 때 한 손을 어깨 위로 빠르게 들었다 내리면 됩니다(OpenCap 권장 방법).

## OpenCap과 같은 점·다른 점

- **같은 점**: 보정, 포즈 인식(HRNet), 동기화, 삼각측량, 마커 보강(LSTM), OpenSim 스케일링·역기구학, 동역학 코드와 설정이 OpenCap 원본 그대로입니다.
- **다른 점 1 (렌즈 보정)**: OpenCap은 iPhone 기종별 렌즈 값을 연구진이 미리 측정해 둡니다. 갤럭시는 이 시스템에서 직접 측정합니다. 측정 품질이 결과 정확도에 직접 영향을 줍니다.
- **다른 점 2 (녹화 조건)**: iPhone OpenCap 앱은 녹화 설정을 Apple API로 고정합니다. 연구실 모드는 Android Camera2로 초점을 고정하고 손떨림 보정을 끕니다. 고정 초점을 지원하지 않는 기종은 화면에 표시됩니다.
- **검증 범위**: OpenCap 논문의 정확도(관절각 MAE 4.5°)는 iPhone으로 얻은 값입니다. 갤럭시 구성의 정확도는 따로 검증해야 합니다.
- **동역학**: OpenCap 저자들은 동역학 예제 설정의 생체역학적 타당성을 검증하지 않았다고 밝혔습니다(`example_kinetics.py`).

## 문제 해결

- **"렌즈 보정이 안 된 기종"**: 그 폰으로 렌즈 보정을 먼저 하세요. 프레임률(60/30fps)이 바뀌면 다른 설정으로 취급됩니다.
- **"영상이 가로입니다"**: 폰을 세로로 세워 촬영하세요.
- **로그 보기**: `docker compose logs -f core`, `docker compose logs -f kinetics`
- **데이터 위치**: Docker 볼륨 `physiocap-lab_physiocap-data`의 `/data/physiocap/Data/<세션>/`. 폴더 구조가 OpenCap과 같아 opencap-processing 예제 스크립트도 그대로 쓸 수 있습니다.

## 개발

```bash
cd physiocap/lab
python3 -m pytest tests          # 서버·워커 테스트 (OpenCap 함수는 가짜로 대체)
PHYSIOCAP_DATA=/tmp/pc uvicorn --app-dir server app:app --port 8000
```

라이선스 고지는 `NOTICE`를 보세요.
