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

설치가 끝나면 아래 자가 검증을 돌려 보세요. OpenCap 공식 테스트 세션(실제 iPhone 2대 영상, 약 500 MB)을 이 PC의 워커로 처리하고, OpenCap 기준 결과와 OpenCap 자체 테스트 기준으로 비교합니다. GPU 포즈 인식은 미리 계산된 HRNet 결과로 건너뛰고, 나머지 단계(동기화, 삼각측량, LSTM 마커 보강, OpenSim 역기구학)를 검증합니다.

```bash
docker compose run --rm core python3.8 /workspace/physiocap/selftest.py
```

개발 환경(CPU, GPU 없음)에서 돌린 결과는 다음과 같습니다.

- **squats**: OpenCap 기준 결과와 일치합니다(마커 궤적 오차 1e-3 이내, 관절각 기준 통과).
- **walk**: 마커 궤적은 일치합니다. 관절각은 왼쪽 어깨 회전(`arm_rot_l`) RMSE가 0.54°로 OpenCap 테스트 기준 0.5°를 조금 넘었습니다. 하지만 같은 환경에서 OpenCap 원본 테스트(`tests/test_main.py`)를 직접 돌려도 똑같이 실패합니다. PhysioCap 워커의 출력은 OpenCap `main()`을 직접 호출한 결과와 최대 차이 0.0으로 같았습니다. 전체 관절의 RMSE 중앙값은 0.086°입니다.

동역학도 같은 환경에서 끝까지 돌려 확인했습니다. 위 squats 결과(첫 번째 반복, 3.2초 구간)로 opencap-processing의 근육 구동 시뮬레이션을 실행했습니다.

- IPOPT가 551회 반복 끝에 "Optimal Solution Found"로 수렴했습니다. CPU 4코어에서 약 61분 걸렸습니다.
- 지면반력, 관절 모멘트 33개, 근활성·근력 80개, 무릎 내전 모멘트, 내측 무릎 접촉력이 나왔습니다.
- 수직 지면반력 합의 평균은 체중의 99.6%로, 스쿼트에서 기대되는 값(약 체중)과 맞았습니다.

학과 PC에서도 동역학은 CPU로 계산하므로, 시행 하나에 수십 분이 걸린다고 보세요.

### GPU 없는 노트북에서 돌리기 (CPU 모드)

NVIDIA GPU가 없는 PC(예: Intel 내장 그래픽만 있는 노트북)에서는 `docker-compose.cpu.yml`을 씁니다. 포즈 인식이 OpenCap 원래 루프 대신 `mmpose_cpu/loop_mmpose_cpu.py`로 돌아가며, 모델(Faster R-CNN + HRNet-w48)과 임계값은 같고 계산 장치만 CPU입니다. 나머지 단계는 GPU 구성과 같습니다. 대신 느립니다.

Windows 노트북 준비(처음 한 번):

1. 관리자 PowerShell에서 `wsl --install` 실행 후 재부팅
2. Docker Desktop 설치(WSL2 사용 설정), 실행해 두기
3. 디스크 여유 60GB 이상(이미지가 크고, 포즈 인식 이미지만 압축 상태로 8.5GB)

설치와 실행(PowerShell):

```powershell
cd $env:USERPROFILE\Documents\Cowork\PhysioCap\physiocap\lab
docker compose -f docker-compose.cpu.yml up -d --build      # 처음 빌드는 1시간 이상
docker compose -f docker-compose.cpu.yml run --rm mmpose python /mmpose/benchmark_pose.py   # 이 PC의 포즈 인식 속도
docker compose -f docker-compose.cpu.yml run --rm core python3.8 /workspace/physiocap/selftest.py   # 자가 검증
```

속도 시험은 OpenCap 공식 시험 영상 앞 60프레임을 처리하고, 프레임당 시간과 시행 길이별 예상 처리 시간(카메라 2대)을 보여 줍니다. 결과가 느리면 시행을 짧게 나눠 찍으세요(예: 스쿼트 유지 한 번 = 한 시행). 동역학은 GPU 구성에서도 CPU로 계산하므로 시행당 수십 분 걸립니다.

GPU 구성과 CPU 구성은 같은 데이터 볼륨을 쓰므로, 나중에 GPU PC로 옮길 때는 `docker compose -f docker-compose.cpu.yml down` 후 GPU 구성으로 다시 올리면 됩니다.

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
8. **3D 재생**: 결과 화면 위쪽에서 OpenSim 근골격 모델(뼈 메시 79개)이 실제 움직임대로 재생됩니다.
   - 드래그로 회전, 휠로 확대합니다. 정면·측면·위 시점, 0.25~1배속, 골반 따라가기를 쓸 수 있습니다.
   - 관절각 그래프를 누르면 3D가 그 시점으로 이동하고, 재생 중에는 그래프에 현재 시점 선이 표시됩니다.
   - 동역학 결과가 있으면 압력중심(COP)에서 지면반력 화살표를 그립니다. 분홍은 오른발, 하늘색은 왼발이고, 길이 1 m가 체중 1배입니다. OpenCap 웹 뷰어에는 없는 기능입니다.
   - 뼈 메시는 서버 이미지를 빌드할 때 OpenSim 공식 저장소(opensim-models/Geometry)에서 받습니다. 받지 못하면 선 골격으로 표시합니다.
9. **동작 지표**: OpenCap 의 `opencap-processing/ActivityAnalyses` 를 그대로 실행합니다. 시행을 만들 때 "지표 분석"을 고르거나(자동이면 보행 동역학은 보행 지표, 앉았다 일어서기는 STS 지표), 결과 화면에서 직접 실행합니다.
   - **보행** (`gait_analysis`, 오른발·왼발 기준 주기 각각): 보행 속도, 활보장, 보장, 보장 대칭, 보폭 너비, 분속수, 입각기·유각기 시간, 단하지·양하지 지지(%), 유각 중기 배측굴곡, 유각 중기 발목 높이 차, 보행 주기 정규화(0–100%) 관절각 평균 ± 표준편차, 발뒤꿈치 닿기(HS)·발끝 떼기(TO) 시점
   - **앉았다 일어서기** (`sts_analysis`): 일어서기 시간, 1회 시간, 이륙 전·이륙 시 체간 기울기와 각속도(회차별), 숙임·일어서기 시작·기립 완료·앉음 시점
   - 이벤트 시점은 관절각 그래프에 점선으로 표시됩니다. 지표 분석(수 초)은 동역학(수십 분)보다 먼저 실행됩니다.
10. **정확도 검증**: "정확도 검증" 탭에서 기준 장비 결과와 비교합니다. 절차·판정 기준·표본 수는 [VALIDATION.md](VALIDATION.md)를 보세요.
    - 시계열: 3D 모캡 IK(.mot), IMU, 지면반력판 파일을 올리면 시간 차이를 자동으로 맞추고 관절별 편향·MAE·RMSE·95% 일치한계를 계산합니다. Bland–Altman 그림도 그립니다.
    - 이산값: 고니오미터 기록지(CSV)를 올리면 항목별 일치한계와 ICC(2,1)·ICC(3,1)(95% 신뢰구간)를 계산합니다.
    - 누적 요약표는 동작별 MAE를 OpenCap 논문 값과 나란히 보여 줍니다. 모바일 앱 각도 CSV도 같은 방식으로 비교할 수 있습니다.

촬영 요령은 OpenCap의 [best practices](https://www.opencap.ai/best-pratices)와 같습니다. 두 영상의 동기화가 실패하면, 시작할 때 한 손을 어깨 위로 빠르게 들었다 내리면 됩니다(OpenCap 권장 방법).

## OpenCap과 같은 점·다른 점

- **같은 점**: 보정, 포즈 인식(HRNet), 동기화, 삼각측량, 마커 보강(LSTM), OpenSim 스케일링·역기구학, 동역학 코드와 설정이 OpenCap 원본 그대로입니다(기본 방식 기준. 선택 사항인 B 방식은 아래 절 참고).
- **다른 점 1 (렌즈 보정)**: OpenCap은 iPhone 기종별 렌즈 값을 연구진이 미리 측정해 둡니다. 갤럭시는 이 시스템에서 직접 측정합니다. 측정 품질이 결과 정확도에 직접 영향을 줍니다.
- **다른 점 2 (녹화 조건)**: iPhone OpenCap 앱은 녹화 설정을 Apple API로 고정합니다. 연구실 모드는 Android Camera2로 초점을 고정하고 손떨림 보정을 끕니다. 고정 초점을 지원하지 않는 기종은 화면에 표시됩니다.
- **검증 범위**: OpenCap 논문의 정확도(관절각 MAE 4.5°)는 iPhone으로 얻은 값입니다. 갤럭시 구성의 정확도는 따로 검증해야 합니다.
- **동역학**: OpenCap 저자들은 동역학 예제 설정의 생체역학적 타당성을 검증하지 않았다고 밝혔습니다(`example_kinetics.py`).

## B 방식: 마커 증강 없이 관절각 계산 (선택)

세션을 만들 때 **관절각 계산**을 "B 방식 (키포인트 직접 역기구학)"으로 고르면, LSTM 마커 증강 단계를 건너뜁니다. 대신 삼각측량한 영상 키포인트 20개로 바로 OpenSim 스케일링·역기구학을 합니다. 기본값은 OpenCap 그대로입니다. 방식은 세션 단위로 정하며, 같은 세션의 중립 자세와 동작 시행은 같은 방식으로 처리됩니다.

- **바뀌는 것**: 마커 증강(키포인트 → 해부학 마커 43개 신경망 예측)을 쓰지 않습니다. 스케일링·역기구학 설정은 opencap-core에 이미 들어 있는 키포인트용 파일(`Setup_scaling_LaiUhlrich2022_mmpose.xml`, `Setup_IK_mmpose.xml`, `LaiUhlrich2022_markers_mmpose.xml`)을 씁니다.
- **추가한 것**: 허리 3축과 거골하 관절에 0° 쪽으로 아주 약한 제약(`worker_core/keypoint_mode.py`의 `REGULARIZATION`)을 겁니다. 키포인트의 골반 점(좌·우 엉덩이와 그 중점)이 한 직선 위에 있어서, 골반 앞뒤 기울기와 허리 굴곡을 나눌 수 없기 때문입니다. 제약이 없으면 시험 영상 걷기에서 골반 기울기가 프레임 사이 최대 40°씩 튀었습니다.
- **바뀌지 않는 것**: 보정, 포즈 인식, 동기화, 삼각측량, OpenSim 모델, 동역학은 기본 방식과 같습니다. OpenCap 코드는 수정하지 않고, 처리 중에만 함수 네 개를 바꿔 끼웁니다.
- **어깨 모델**은 B 방식에서 지원하지 않습니다.

### 시험 결과 (OpenCap 결과와의 차이)

OpenCap 공식 시험 자료(opencap-test-data `sync_2-cameras`, iPhone 2대, 피험자 1명)를 두 방식으로 처리했습니다. 처리 범위는 중립 자세 스케일링부터 걷기·스쿼트 역기구학까지입니다. 아래 값은 OpenCap 기준 결과(`OutputReference`)와의 RMSE이며, 모션캡처 대비 오차가 **아닙니다**.

| 시행 | 하지·골반 15개 자유도 평균 | 골반 기울기 | 고관절 굴곡(우) | 무릎(우) | 발목(우) | 허리 굴곡 |
|---|---|---|---|---|---|---|
| 걷기 | 3.5° | 2.3° | 2.8° | 3.0° | 3.7° | 3.4° |
| 스쿼트 | 3.3° | 6.3° | 5.3° | 4.3° | 3.3° | 7.3° |

같은 조건에서 기본 방식은 기준 결과와 0.2° 이내로 일치했습니다. 이로써 시험 절차가 맞고, B 방식을 쓴 뒤 원래 함수가 복원되는 것도 확인했습니다.

해석할 때 주의할 점이 셋 있습니다.
- 제약 가중치는 위 두 시행에서 고른 값이라 과적합일 수 있습니다.
- OpenCap 결과 자체도 모션캡처 대비 평균 4.5° 정도의 오차가 있습니다(논문 값). 따라서 B 방식의 실제 정확도는 이 표만으로 알 수 없습니다.
- 스쿼트처럼 몸통을 많이 숙이는 동작에서는 골반 기울기와 허리 굴곡의 차이가 커집니다.

실제 정확도는 `VALIDATION.md` 절차(고니오미터·모션캡처 비교)로 두 방식을 같은 피험자에게 적용해 확인해야 합니다.

특허 관련: B 방식은 마커 증강을 쓰지 않는 구성일 뿐입니다. 특정 특허를 회피한다는 법적 판단은 아닙니다. 상용화 전에 변리사의 청구항 검토가 필요합니다.

## 문제 해결

- **"렌즈 보정이 안 된 기종"**: 그 폰으로 렌즈 보정을 먼저 하세요. 프레임률(60/30fps)이 바뀌면 다른 설정으로 취급됩니다.
- **"영상이 가로입니다"**: 폰을 세로로 세워 촬영하세요.
- **처리가 멈춘 것 같을 때**: 처리 중에 워커 컨테이너가 재시작되면, 그 작업은 워커가 다시 켜질 때 자동으로 대기열로 돌아가 처음부터 다시 처리됩니다(`requeued interrupted jobs` 로그).
- **로그 보기**: `docker compose logs -f core`, `docker compose logs -f kinetics`
- **데이터 위치**: Docker 볼륨 `physiocap-lab_physiocap-data`의 `/data/physiocap/Data/<세션>/`. 폴더 구조가 OpenCap과 같아 opencap-processing 예제 스크립트도 그대로 쓸 수 있습니다.

## 개발

```bash
cd physiocap/lab
python3 -m pytest tests          # 서버·워커 테스트 (OpenCap 함수는 가짜로 대체)
PHYSIOCAP_DATA=/tmp/pc uvicorn --app-dir server app:app --port 8000
```

라이선스 고지는 `NOTICE`를 보세요.
