"""3D 뷰어: VTP 메시 변환(ASCII·압축 바이너리), 메시/재생 데이터 API."""
import base64
import importlib
import json
import struct
import zlib

import pytest
from fastapi.testclient import TestClient

ASCII_VTP = """<?xml version="1.0"?>
<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian">
 <PolyData><Piece NumberOfPoints="4" NumberOfPolys="1">
  <Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 1 1 0 0 1 0</DataArray></Points>
  <Polys>
   <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2 3</DataArray>
   <DataArray type="Int32" Name="offsets" format="ascii">4</DataArray>
  </Polys>
 </Piece></PolyData>
</VTKFile>"""


def _b64_compressed(fmt, values):
    raw = struct.pack("<" + fmt * len(values), *values)
    comp = zlib.compress(raw)
    header = struct.pack("<IIII", 1, len(raw), len(raw), len(comp))
    return base64.b64encode(header + comp).decode()


def binary_vtp():
    pts = [0, 0, 0, 2, 0, 0, 0, 2, 0]
    return f"""<?xml version="1.0"?>
<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian" header_type="UInt32" compressor="vtkZLibDataCompressor">
 <PolyData><Piece NumberOfPoints="3" NumberOfPolys="1">
  <Points><DataArray type="Float32" NumberOfComponents="3" format="binary">{_b64_compressed('f', pts)}</DataArray></Points>
  <Polys>
   <DataArray type="Int32" Name="connectivity" format="binary">{_b64_compressed('i', [0, 1, 2])}</DataArray>
   <DataArray type="Int32" Name="offsets" format="binary">{_b64_compressed('i', [3])}</DataArray>
  </Polys>
 </Piece></PolyData>
</VTKFile>"""


def test_parse_vtp_ascii_quad_is_triangulated(tmp_path):
    import meshes
    p = tmp_path / "q.vtp"
    p.write_text(ASCII_VTP)
    m = meshes.parse_vtp(p)
    assert m["positions"][:6] == [0, 0, 0, 1, 0, 0]
    assert m["indices"] == [0, 1, 2, 0, 2, 3]


def test_parse_vtp_compressed_binary(tmp_path):
    import meshes
    p = tmp_path / "b.vtp"
    p.write_text(binary_vtp())
    m = meshes.parse_vtp(p)
    assert m["positions"] == [0, 0, 0, 2, 0, 0, 0, 2, 0]
    assert m["indices"] == [0, 1, 2]


def test_model_mesh_list_covers_opencap_model():
    import meshes
    assert len(meshes.MODEL_MESHES) == 79 and "hat_skull.vtp" in meshes.MODEL_MESHES
    assert all(meshes.SAFE_MESH.match(n) for n in meshes.MODEL_MESHES)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    geo = tmp_path / "geo"
    geo.mkdir()
    (geo / "r_femur.vtp").write_text(ASCII_VTP)
    monkeypatch.setenv("PHYSIOCAP_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("PHYSIOCAP_GEOMETRY", str(geo))
    import store, app as appmod
    importlib.reload(store)
    appmod = importlib.reload(appmod)
    return appmod, TestClient(appmod.app)


def test_geometry_endpoint(client):
    appmod, c = client
    r = c.get("/api/geometry/r_femur.vtp")
    assert r.status_code == 200 and r.json()["indices"] == [0, 1, 2, 0, 2, 3]
    assert (appmod.DATA / "geometry_cache" / "r_femur.vtp.json").exists()  # 캐시
    assert c.get("/api/geometry/missing.vtp").status_code == 404
    assert c.get("/api/geometry/..%2Fsecret.vtp").status_code == 404


def test_visualizer_endpoint(client):
    appmod, c = client
    s = {"id": "S", "name": "S", "created": 0, "subject": {}, "checkerboard": {}, "cameras": {},
         "trials": [{"id": "squats", "type": "dynamic", "state": "done"}]}
    appmod.store.save_session(s)
    assert c.get("/api/sessions/S/trials/squats/visualizer").status_code == 404
    assert c.get("/api/sessions/S/trials/squats/results").json()["has_visualizer"] is False
    p = appmod.DATA / "Data" / "S" / "VisualizerJsons" / "squats" / "squats.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"time": [0, 0.1], "bodies": {"pelvis": {"attachedGeometries": ["r_pelvis.vtp"], "scaleFactors": [1, 1, 1],
                                                                        "rotation": [[0, 0, 0]] * 2, "translation": [[0, 1, 0]] * 2}}}))
    assert c.get("/api/sessions/S/trials/squats/results").json()["has_visualizer"] is True
    assert c.get("/api/sessions/S/trials/squats/visualizer").json()["time"] == [0, 0.1]
