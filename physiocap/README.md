# PhysioCap — 갤럭시(Android) 폰 한 대로 하는 동작분석

iPhone 전용인 OpenCap을 대신해 Android 폰에서 쓸 수 있도록 만든 온디바이스 동작분석 앱입니다. 카메라로 사람을 찍으면 MediaPipe Pose Landmarker가 매 프레임 신체 기준점 33개(2D 위치와 3D 추정 좌표)를 계산하고, 관절각, 반복 분할, 보행·균형 지표를 바로 보여 줍니다. 영상은 서버로 전송되지 않습니다.

## OpenCap과의 비교

| 항목 | OpenCap (Stanford) | PhysioCap |
|---|---|---|
| 기기 | iPhone/iPad 2대 이상 + 체커보드 보정. 단안 베타(OpenCap Monocular)도 iPhone 전용 | Android 폰 1대, 보정 없음 |
| 처리 위치 | 클라우드 서버 (결과까지 수 분) | 폰 내부, 실시간 |
| 인터넷 | 필요 | 필요 없음 (APK·웹 모두 엔진과 모델을 저장소에 포함) |
| 결과 | OpenSim 역기구학 관절각, 근골격 시뮬레이션 기반 관절 모멘트·근력·지면반력 | 관절각, 반복·이벤트 분할, 보행·균형·STS 지표, 대칭지수, 이전 기록 대비 변화 |
| 정확도 | 마커 기반 모캡 대비 관절각 MAE 4.5°[^1], 단안 버전 회전 자유도 MAE 4.8°[^2] | 따로 검증하지 않음. 카메라 쪽(깊이 방향) 움직임과 회전 정확도가 낮음 |
| 연구용 내보내기 | OpenSim 모델·모션 파일 | OpenSim TRC(마커 궤적), 각도 CSV, 좌표 CSV, JSON |

정리하면, PhysioCap은 **즉시성·접근성·오프라인·Android 지원**에서는 OpenCap보다 낫습니다. 반면 **근골격 동역학(관절 모멘트·근력)과 검증된 3D 정확도**에서는 OpenCap에 못 미칩니다. 연구용으로 3D 역기구학이 필요하면 TRC를 내보내 PC의 OpenSim에서 Scale → Inverse Kinematics로 이어서 처리하세요.

## 기능

- **검사 프로토콜 6종**
  - 스쿼트: 반복 자동 분할, 반복마다 최대 무릎·고관절 굴곡, 체간 기울기, 무릎 FPPA(정면 외반 각도), 하강·상승 시간
  - 앉았다 일어서기: 5회 시간, 30초 횟수, 자동 종료 모드
  - 보행(측면): 분속수, 걸음 시간과 변동계수, 걸음 길이·보행 속도(축척 추정), 좌우 무릎 굴곡 대칭
  - 한발 서기: 유지 시간, 골반 흔들림(SD, 궤적 속도), 골반 경사, 체간 측방 기울기
  - 관절가동범위(ROM), 자유 동작
- **실시간 화면**: 스켈레톤 오버레이, 관절각 표시, 반복 카운터, 음성 카운트, 카운트다운 셀프 촬영
- **기존 영상 분석**: 갤러리 영상(슬로우 모션 포함)을 15/30/60 fps로 한 프레임씩 분석
- **결과 화면**: 오버레이 재생, 그래프(누르면 해당 시점으로 이동), 반복별 표, ROM 요약, 이전 기록 대비 변화
- **신호 처리**: 30 Hz 균일 리샘플링, 짧은 결측 보간, 2차 Butterworth 영위상 저역통과(기본 6 Hz), 실시간은 One-Euro 필터
- **내보내기**: 각도 CSV, 랜드마크 CSV, OpenSim TRC, 결과 JSON, 오버레이 영상(webm), 요약 텍스트 공유
- **기기 내 기록 보관**(IndexedDB)

## 설치 (갤럭시)

1. 이 저장소의 **Actions → PhysioCap Android APK** 실행 결과에서 `PhysioCap-apk` 아티팩트를 받습니다(zip 안에 `PhysioCap-debug.apk`).
2. 폰에서 APK를 열고 "출처를 알 수 없는 앱 설치"를 허용해 설치합니다.
3. 첫 실행 때 카메라 권한을 허용합니다.

APK 없이 쓰려면 `web/` 폴더를 HTTPS로 호스팅(Vercel, GitHub Pages 등)한 뒤 갤럭시 Chrome에서 열고 "홈 화면에 추가"를 누르면 PWA로 설치됩니다. 첫 접속 때 엔진과 모델(약 29MB)을 기기에 캐시하며, "오프라인 사용 준비 완료" 안내가 뜬 뒤에는 인터넷 없이 동작합니다. Heavy 모델은 저장소에 없어 처음 선택할 때만 인터넷이 필요합니다.

## 촬영 요령

- 폰을 삼각대나 선반에 고정하고 전신(머리~발끝)이 화면에 들어오게 2.5~4 m 떨어집니다.
- 시상면 지표(무릎·고관절 굴곡, 보행)는 **측면**, 무릎 외반(FPPA)·골반 경사·한발 서기는 **정면**에서 찍습니다.
- 몸에 붙는 옷, 밝고 단순한 배경이 정확도를 높입니다.
- 설정에서 키를 입력하면 거리·흔들림(cm, m/s) 축척이 Winter 인체 분절 비율(대퇴 0.245H + 하퇴 0.246H)로 보정됩니다.

## 개발

```bash
cd physiocap
npm test                      # 분석 엔진 단위 테스트 (합성 골격 데이터)
bash scripts/fetch-assets.sh  # web/vendor 갱신용 (저장소에 이미 포함됨). MP_VERSION=… 으로 버전 변경, INCLUDE_HEAVY=1 이면 heavy 포함
node scripts/serve.mjs 8080   # http://localhost:8080
cd android && ./gradlew assembleDebug   # Android SDK 필요
```

구조

```
physiocap/
  web/                 앱 본체 (PWA 겸 APK assets)
    js/analysis.js     관절각·필터·검사별 지표·CSV/TRC (순수 함수, Node에서 테스트)
    js/pose.js         MediaPipe 래퍼 (로컬 번들 우선, 없으면 CDN)
    js/app.js          화면·촬영·영상 분석·결과·내보내기
  android/             WebView 셸 (카메라 권한, 파일 선택, 다운로드 저장, 공유, TTS)
  tests/               단위 테스트
```

## 한계

- 단일 카메라 3D 좌표는 학습된 체형 사전지식에 기반한 추정치라 깊이 방향 오차가 큽니다. 시상면 각도는 측면 촬영, 전두면 각도는 정면 촬영에서만 해석하세요.
- 고관절 굴곡은 체간-대퇴 사이 각, 발목 배측굴곡은 하퇴-발(발목→엄지발가락) 각에서 90°를 뺀 값으로, 고니오미터 정의와 기준이 다를 수 있습니다.
- 경고 표시(FPPA 10° 초과, 대칭지수 15% 초과, 걸음 시간 변동계수 5% 초과)는 눈에 띄게 하려는 참고 기준이며 진단 기준이 아닙니다.
- 이 앱의 수치는 마커 기반 모캡과 비교 검증하지 않았습니다. 교육·선별용으로 사용하세요.

## 참고

[^1]: Uhlrich SD, Falisse A, Kidziński Ł, et al. OpenCap: Human movement dynamics from smartphone videos. *PLoS Comput Biol.* 2023;19(10):e1011462. doi:10.1371/journal.pcbi.1011462
[^2]: OpenCap Monocular, arXiv:2603.24733 (2026). https://arxiv.org/abs/2603.24733
