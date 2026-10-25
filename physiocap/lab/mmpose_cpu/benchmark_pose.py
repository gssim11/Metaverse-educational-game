"""이 PC에서 포즈 인식이 얼마나 걸리는지 재는 시험.

OpenCap 공식 시험 영상(iPhone, 1280x720, 60fps 스쿼트) 앞부분 N프레임을 CPU(또는 GPU)로 처리하고
프레임당 시간과, 실제 시행 길이별 예상 처리 시간을 출력한다. 연구 자료는 쓰지 않는다.

실행:  docker compose -f docker-compose.cpu.yml run --rm mmpose python /mmpose/benchmark_pose.py
"""
import json
import os
import sys
import time
import urllib.request

import cv2
import torch

from utilsMMpose import detection_inference, pose_inference

DEVICE = os.environ.get("PHYSIOCAP_POSE_DEVICE", "cpu")
BATCH = int(os.environ.get("PHYSIOCAP_POSE_BATCH", "8" if DEVICE == "cpu" else "64"))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 60
if DEVICE == "cpu":
    torch.set_num_threads(max(1, os.cpu_count() or 1))

URL = ("https://raw.githubusercontent.com/stanfordnmbl/opencap-test-data/"
       "63546b73ab2a3c6dd6c95a05d66e0527bab873c7/Data/sync_2-cameras/Videos/Cam0/InputMedia/squats/squats.mov")
work = "/tmp/physiocap_bench"
os.makedirs(work, exist_ok=True)
src = os.path.join(work, "squats.mov")
if not os.path.isfile(src):
    print("Downloading OpenCap test video (10 MB)...", flush=True)
    urllib.request.urlretrieve(URL, src)

cap = cv2.VideoCapture(src)
fps = cap.get(cv2.CAP_PROP_FPS) or 60
w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
clip = os.path.join(work, "clip.mp4")
out = cv2.VideoWriter(clip, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
n = 0
while n < N:
    ok, frame = cap.read()
    if not ok:
        break
    out.write(frame)
    n += 1
out.release()
cap.release()

with open("/mmpose/defaultOpenCapSettings.json") as f:
    thr = json.load(f)["hrnet"]
print(f"device={DEVICE} batch={BATCH} threads={torch.get_num_threads()} frames={n} ({w}x{h})", flush=True)
t0 = time.time()
detection_inference("/mmpose/faster_rcnn_r50_fpn_coco.py",
                    "/mmpose/faster_rcnn_r50_fpn_1x_coco_20200130-047c8118.pth",
                    clip, os.path.join(work, "box.pkl"), device=DEVICE)
t1 = time.time()
pose_inference("/mmpose/hrnet_w48_coco_wholebody_384x288_dark_plus.py",
               "/mmpose/hrnet_w48_coco_wholebody_384x288_dark-f5726563_20200918.pth",
               clip, os.path.join(work, "box.pkl"), os.path.join(work, "human.pkl"), "",
               device=DEVICE, batch_size=BATCH, bbox_thr=thr, visualize=False)
t2 = time.time()

per = (t2 - t0) / max(n, 1)
print(f"\nPerson detection: {t1 - t0:.1f} s, pose: {t2 - t1:.1f} s  ->  {per:.2f} s per frame (includes model loading)")
print("Estimated pose time for one trial with 2 cameras (other steps add a few minutes):")
for sec in (5, 10, 30):
    for f in (60, 30):
        print(f"  {sec:>3} s video at {f} fps: about {per * sec * f * 2 / 60:.0f} min")
