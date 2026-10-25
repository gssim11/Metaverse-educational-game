# opencap-processing 원본(고정 커밋): OpenSim 4.5(conda) + CasADi 로 근육 구동 동역학 시뮬레이션
FROM condaforge/miniforge3:24.9.2-0
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git libopenblas-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN conda create -y -n oc python=3.11 && conda install -y -n oc -c opensim-org opensim=4.5=py311np123 && conda clean -afy
ARG OPENCAP_PROCESSING_REF=72b5416bf6172fe3d9b42b01e1a02252362b20fc
RUN git clone https://github.com/stanfordnmbl/opencap-processing.git /opencap-processing \
 && cd /opencap-processing && git checkout ${OPENCAP_PROCESSING_REF}
RUN conda run -n oc pip install --no-cache-dir -r /opencap-processing/requirements.txt
COPY server/layout.py server/store.py worker_kinetics/physiocap_kinetics_worker.py /opt/physiocap/
ENV PHYSIOCAP_DATA=/data/physiocap OPENCAP_PROCESSING_DIR=/opencap-processing \
    API_TOKEN=physiocap-local-no-cloud API_URL=http://127.0.0.1:9/
WORKDIR /opencap-processing
CMD ["conda", "run", "--no-capture-output", "-n", "oc", "python", "/opt/physiocap/physiocap_kinetics_worker.py"]
