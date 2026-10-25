# Third-party files in this folder

These files are redistributed **unmodified** under the Apache License, Version 2.0.
A copy of the license is in [`LICENSE-Apache-2.0.txt`](LICENSE-Apache-2.0.txt).

| Path | What it is | Source | License |
|---|---|---|---|
| `tasks-vision/vision_bundle.mjs`, `tasks-vision/wasm/*` | MediaPipe Tasks Vision runtime, version 1.1.1 (see `tasks-vision/VERSION`) | npm package `@mediapipe/tasks-vision@1.1.1` — https://www.npmjs.com/package/@mediapipe/tasks-vision | Apache-2.0 (declared in the package's `package.json`) |
| `models/pose_landmarker_lite.task`, `models/pose_landmarker_full.task` | MediaPipe Pose Landmarker models (BlazePose GHUM 3D), float16 | https://storage.googleapis.com/mediapipe-models/pose_landmarker/ | Apache-2.0 (stated in Google's model card "BlazePose GHUM 3D") |

MediaPipe is developed by Google. Model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf

The model card lists 3D pose measurements (angles/distances) and fitness among intended uses, and lists
applications requiring metric-accurate depth, multiple people in an image, and any form of surveillance or
identity recognition as out of scope.

`scripts/fetch-assets.sh` re-downloads these files from the same sources.
