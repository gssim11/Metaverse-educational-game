# opencap-core 원본(고정 커밋) + PhysioCap 작업 연결 스크립트
# 기반 이미지와 의존성은 opencap-core/docker/Dockerfile 과 같다.
FROM stanfordnmbl/opensim-python:4.3
# apt 설치 중 시간대(tzdata) 등 대화형 질문으로 멈추지 않게
ARG DEBIAN_FRONTEND=noninteractive
RUN apt update && apt install --no-install-recommends -y ffmpeg git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG OPENCAP_CORE_REF=e5d29f12e725a2e14e6e4e85617834685f738753
RUN git clone https://github.com/stanfordnmbl/opencap-core.git /workspace \
 && cd /workspace && git checkout ${OPENCAP_CORE_REF}
WORKDIR /workspace
RUN pip3 install --upgrade pip --no-cache-dir && pip3 install -r requirements.txt --no-cache-dir
COPY server/layout.py server/store.py worker_core/physiocap_core_worker.py worker_core/keypoint_mode.py worker_core/selftest.py /workspace/physiocap/
# DOCKERCOMPOSE=1: 포즈 인식을 mmpose/openpose 컨테이너와 /data 볼륨으로 주고받는 opencap-core 의 도커 모드
# API_TOKEN: OpenCap 클라우드를 쓰지 않으므로 import 시 로그인 프롬프트가 뜨지 않게 하는 자리표시 값
ENV DOCKERCOMPOSE=1 PHYSIOCAP_DATA=/data/physiocap OPENCAP_CORE_DIR=/workspace \
    API_TOKEN=physiocap-local-no-cloud API_URL=http://127.0.0.1:9/
CMD ["python3.8", "/workspace/physiocap/physiocap_core_worker.py"]
