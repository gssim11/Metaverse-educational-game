"""OpenCap 포즈 인식(HRNet) 루프의 CPU판 — NVIDIA GPU가 없는 PC(노트북)용.

opencap-core(고정 커밋 e5d29f1)의 mmpose/loop_mmpose.py 와 같은 일을 한다.
같은 모델(Faster R-CNN 사람 검출 + HRNet-w48 전신 관절), 같은 임계값(defaultOpenCapSettings.json 의 hrnet),
같은 입출력 파일(/mmpose/data/video_mmpose.mov → output_mmpose/human.pkl)을 쓴다. 다른 점은 두 가지뿐이다.
  1) 시작할 때 GPU가 없으면 종료하던 검사를 하지 않는다.
  2) 계산 장치를 PHYSIOCAP_POSE_DEVICE(기본 "cpu")로 정하고, CPU에서는 한 번에 처리하는 묶음을 줄인다.
모델과 계산식은 그대로이므로 결과는 GPU판과 같은 방법으로 얻은 값이다(부동소수점 차이 정도는 날 수 있음).
"""
import json
import logging
import os
import shutil
import time

import torch

from utilsMMpose import detection_inference, pose_inference

logging.basicConfig(level=logging.INFO)

DEVICE = os.environ.get("PHYSIOCAP_POSE_DEVICE", "cpu")
BATCH = int(os.environ.get("PHYSIOCAP_POSE_BATCH", "8" if DEVICE == "cpu" else "64"))
if DEVICE == "cpu":
    torch.set_num_threads(max(1, os.cpu_count() or 1))

video_path = "/mmpose/data/video_mmpose.mov"
output_dir = "/mmpose/data/output_mmpose"

with open("/mmpose/defaultOpenCapSettings.json") as f:
    bbox_thr = json.load(f)["hrnet"]
model_config_person = "/mmpose/faster_rcnn_r50_fpn_coco.py"
model_ckpt_person = "/mmpose/faster_rcnn_r50_fpn_1x_coco_20200130-047c8118.pth"
model_config_pose = "/mmpose/hrnet_w48_coco_wholebody_384x288_dark_plus.py"
model_ckpt_pose = "/mmpose/hrnet_w48_coco_wholebody_384x288_dark-f5726563_20200918.pth"

if os.path.isfile(video_path):
    os.remove(video_path)

logging.info("PhysioCap mmpose (device=%s, batch=%d, threads=%d). Waiting for data...",
             DEVICE, BATCH, torch.get_num_threads())

while True:
    if not os.path.isfile(video_path):
        time.sleep(0.1)
        continue

    logging.info("Processing mmpose...")
    if os.path.isdir(output_dir):
        shutil.rmtree(output_dir)
    os.makedirs(output_dir)

    try:
        t0 = time.time()
        bboxPath = os.path.join(output_dir, "box.pkl")
        detection_inference(model_config_person, model_ckpt_person, video_path, bboxPath, device=DEVICE)
        t1 = time.time()
        pklPath = os.path.join(output_dir, "human.pkl")
        pose_inference(model_config_pose, model_ckpt_pose, video_path, bboxPath, pklPath, "",
                       device=DEVICE, batch_size=BATCH, bbox_thr=bbox_thr, visualize=False)
        logging.info("mmpose: detection %.0f s, pose %.0f s", t1 - t0, time.time() - t1)
        if os.path.isfile(video_path):
            os.remove(video_path)
        if os.path.isfile(bboxPath):
            os.remove(bboxPath)
        logging.info("mmpose: Done. Cleaning up")
    except Exception:
        logging.exception("mmpose: Pose detection failed.")
        if os.path.isfile(video_path):
            os.remove(video_path)
