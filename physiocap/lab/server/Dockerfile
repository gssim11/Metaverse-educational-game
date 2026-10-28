# PhysioCap Lab 서버 (세션 지휘·업로드·영상 정규화·대시보드)
FROM python:3.11-slim
# apt 설치 중 시간대(tzdata) 등 대화형 질문으로 멈추지 않게
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ /app/
# 3D 뷰어용 OpenSim 뼈 메시(opensim-models/Geometry). 실패해도 빌드 계속(선 골격으로 대체)
RUN python fetch_geometry.py /opt/opensim-geometry || true
COPY dashboard/ /dashboard/
ENV PHYSIOCAP_DATA=/data/physiocap PHYSIOCAP_DASHBOARD=/dashboard PHYSIOCAP_GEOMETRY=/opt/opensim-geometry
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
