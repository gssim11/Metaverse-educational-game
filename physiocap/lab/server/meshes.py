"""OpenSim 뼈 메시(.vtp, VTK PolyData) → 웹 3D 뷰어용 JSON {positions, indices}.

메시 파일은 저장소에 넣지 않는다. 서버 이미지 빌드 때 OpenSim 공식 저장소(opensim-models/Geometry)에서
받아 PHYSIOCAP_GEOMETRY 폴더에 두고(fetch_geometry.py), 요청이 오면 변환해 캐시한다.
"""
from __future__ import annotations

import base64
import json
import re
import struct
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

SAFE_MESH = re.compile(r"^[A-Za-z0-9_\-]+\.vtp$")

# OpenCap 기본 모델(LaiUhlrich2022)의 뼈 메시 — VisualizerJson 의 attachedGeometries 와 같다
_HAND = ["pisiform", "lunate", "scaphoid", "triquetrum", "hamate", "capitate", "trapezoid", "trapezium",
         "metacarpal2", "index_proximal", "index_medial", "index_distal", "metacarpal3", "middle_proximal",
         "middle_medial", "middle_distal", "metacarpal4", "ring_proximal", "ring_medial", "ring_distal",
         "metacarpal5", "little_proximal", "little_medial", "little_distal", "metacarpal1", "thumb_proximal", "thumb_distal"]
MODEL_MESHES = (
    ["r_pelvis.vtp", "l_pelvis.vtp", "sacrum.vtp"]
    + [f"{s}_{b}.vtp" for s in ("r", "l") for b in ("femur", "tibia", "fibula", "talus", "foot", "bofoot")]
    + ["hat_spine.vtp", "hat_jaw.vtp", "hat_skull.vtp", "hat_ribs_scap.vtp"]
    + [f"{b}_{s}v.vtp" for s in ("r", "l") for b in ("humerus", "ulna", "radius")]
    + [f"{b}_{s}vs.vtp" for s in ("r", "l") for b in _HAND]
)


def _array(da: ET.Element, appended: bytes | None, header_type: str, compressed: bool) -> list[float]:
    fmt = da.get("format", "ascii")
    typ = da.get("type", "Float32")
    code = {"Float32": "f", "Float64": "d", "Int32": "i", "Int64": "q", "UInt32": "I", "UInt64": "Q", "Int8": "b", "UInt8": "B"}[typ]
    if fmt == "ascii":
        return [float(x) if code in "fd" else int(x) for x in (da.text or "").split()]
    hsz = 8 if header_type == "UInt64" else 4
    hcode = "Q" if hsz == 8 else "I"
    if fmt == "binary":
        raw = base64.b64decode("".join((da.text or "").split()))
    elif fmt == "appended" and appended is not None:
        raw = appended[int(da.get("offset", 0)):]
    else:
        raise ValueError(f"unsupported DataArray format {fmt}")
    if compressed:
        nb = struct.unpack("<" + hcode, raw[:hsz])[0]
        hdr = struct.unpack("<" + hcode * (3 + nb), raw[: hsz * (3 + nb)])
        sizes = hdr[3:]
        pos = hsz * (3 + nb)
        data = b""
        for s in sizes:
            data += zlib.decompress(raw[pos:pos + s])
            pos += s
    else:
        n = struct.unpack("<" + hcode, raw[:hsz])[0]
        data = raw[hsz:hsz + n]
    size = struct.calcsize(code)
    return list(struct.unpack("<" + code * (len(data) // size), data[: len(data) // size * size]))


def parse_vtp(path: str | Path) -> dict:
    """정점 좌표와 삼각형 인덱스(다각형은 부채꼴로 삼각분할)."""
    root = ET.parse(path).getroot()
    compressed = root.get("compressor") is not None
    header_type = root.get("header_type", "UInt32")
    appended = None
    ap = root.find("AppendedData")
    if ap is not None and ap.text:
        enc = ap.get("encoding", "base64")
        txt = ap.text.strip().lstrip("_")
        appended = base64.b64decode(txt) if enc == "base64" else txt.encode("latin1")
    piece = root.find("PolyData/Piece")
    pts = _array(piece.find("Points/DataArray"), appended, header_type, compressed)
    polys = piece.find("Polys")
    conn = offs = []
    for da in polys.findall("DataArray") if polys is not None else []:
        if da.get("Name") == "connectivity":
            conn = _array(da, appended, header_type, compressed)
        elif da.get("Name") == "offsets":
            offs = _array(da, appended, header_type, compressed)
    idx, start = [], 0
    for end in offs:
        face = conn[start:int(end)]
        for k in range(1, len(face) - 1):
            idx += [int(face[0]), int(face[k]), int(face[k + 1])]
        start = int(end)
    return {"positions": [round(v, 5) for v in pts], "indices": idx}


def mesh_json(geometry_dir: str | Path, cache_dir: str | Path, name: str) -> dict | None:
    if not SAFE_MESH.match(name):
        return None
    cache = Path(cache_dir) / (name + ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    src = Path(geometry_dir) / name
    if not src.exists():
        return None
    m = parse_vtp(src)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(m, separators=(",", ":")))
    return m
