"""서버 이미지 빌드 때 OpenSim 공식 저장소에서 뼈 메시를 받는다.

  python fetch_geometry.py /opt/opensim-geometry

받지 못해도 빌드는 계속된다(3D 뷰어는 선 골격으로 대신 그린다).
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

from meshes import MODEL_MESHES

REF = "master"
BASE = f"https://raw.githubusercontent.com/opensim-org/opensim-models/{REF}/Geometry/"


def main(dst: str) -> int:
    out = Path(dst)
    out.mkdir(parents=True, exist_ok=True)
    ok = 0
    for name in MODEL_MESHES:
        p = out / name
        if p.exists() and p.stat().st_size > 0:
            ok += 1
            continue
        try:
            with urllib.request.urlopen(BASE + name, timeout=60) as r:
                p.write_bytes(r.read())
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"warning: {name}: {e}", file=sys.stderr)
    print(f"OpenSim geometry: {ok}/{len(MODEL_MESHES)} files in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/opt/opensim-geometry"))
