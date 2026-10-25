# opencap-processing 원본(고정 커밋): OpenSim 4.5(conda) + CasADi 로 근육 구동 동역학 시뮬레이션
FROM condaforge/miniforge3:24.9.2-0
# apt 설치 중 시간대(tzdata) 등 대화형 질문으로 멈추지 않게
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git curl libopenblas-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN conda create -y -n oc python=3.11 && conda install -y -n oc -c opensim-org opensim=4.5=py311np123 && conda clean -afy
ARG OPENCAP_PROCESSING_REF=72b5416bf6172fe3d9b42b01e1a02252362b20fc
RUN git clone https://github.com/stanfordnmbl/opencap-processing.git /opencap-processing \
 && cd /opencap-processing && git checkout ${OPENCAP_PROCESSING_REF}
RUN conda run -n oc pip install --no-cache-dir -r /opencap-processing/requirements.txt
# OpenSimAD 외부 라이브러리: opencap-processing 이 첫 실행 때 SourceForge 에서 받는 것을 미리 넣어
# 처리 PC 가 인터넷 없이도(또는 SourceForge 장애 때도) 동역학을 돌릴 수 있게 한다.
RUN mkdir -p /opencap-processing/UtilsDynamicSimulations/OpenSimAD/opensimAD-install \
 && curl -fsSL --retry 4 -o /tmp/linux.tar.gz "https://sourceforge.net/projects/opensimad/files/linux.tar.gz/download" \
 && tar -xf /tmp/linux.tar.gz -C /opencap-processing/UtilsDynamicSimulations/OpenSimAD/opensimAD-install \
 && rm /tmp/linux.tar.gz \
 && test -d /opencap-processing/UtilsDynamicSimulations/OpenSimAD/opensimAD-install/linux/lib
COPY server/layout.py server/store.py worker_kinetics/physiocap_kinetics_worker.py /opt/physiocap/
ENV PHYSIOCAP_DATA=/data/physiocap OPENCAP_PROCESSING_DIR=/opencap-processing \
    API_TOKEN=physiocap-local-no-cloud API_URL=http://127.0.0.1:9/
WORKDIR /opencap-processing
CMD ["conda", "run", "--no-capture-output", "-n", "oc", "python", "/opt/physiocap/physiocap_kinetics_worker.py"]
