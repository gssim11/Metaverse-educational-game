"""정확도 검증 통계와 API 테스트."""
import json

import numpy as np
import pytest

import validation as V
from test_server import env, register  # noqa: F401  (fixture 재사용)


def mot_text(t, cols: dict) -> str:
    names = list(cols)
    head = ["x.mot", "version=1", f"nRows={len(t)}", f"nColumns={len(names) + 1}", "inDegrees=yes", "endheader",
            "\t".join(["time"] + names)]
    rows = ["\t".join([f"{t[i]:.5f}"] + [f"{cols[c][i]:.5f}" for c in names]) for i in range(len(t))]
    return "\n".join(head + rows) + "\n"


def knee(t):
    return 30 + 25 * np.sin(2 * np.pi * 0.8 * t) + 8 * np.sin(2 * np.pi * 2.1 * t)


# ---------------------------------------------------------------- 통계
def test_icc_matches_shrout_fleiss_table():
    # Shrout & Fleiss 1979 표 2 예제(대상 6 × 평가자 4): ICC(2,1)=0.29, ICC(3,1)=0.71
    sf = [[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]]
    r = V.icc_matrix(sf)
    assert r["icc2_1"]["value"] == pytest.approx(0.29, abs=0.005)
    assert r["icc3_1"]["value"] == pytest.approx(0.71, abs=0.005)
    # 신뢰구간: pingouin 0.15.x 출력과 대조한 값 (ICC(A,1) [0.02, 0.76], ICC(C,1) [0.34, 0.95])
    assert r["icc2_1"]["ci"] == pytest.approx([0.02, 0.76], abs=0.005)
    assert r["icc3_1"]["ci"] == pytest.approx([0.34, 0.95], abs=0.005)


def test_agreement_known_bias():
    rng = np.random.default_rng(0)
    ref = rng.normal(50, 10, 4000)
    test = ref + 2.0 + rng.normal(0, 1.0, 4000)
    a = V.agreement(test - ref, test, ref)
    assert a["bias"] == pytest.approx(2.0, abs=0.1)
    assert a["sd"] == pytest.approx(1.0, abs=0.05)
    assert a["loa_high"] - a["loa_low"] == pytest.approx(2 * 1.96 * a["sd"])
    assert a["rmse"] ** 2 == pytest.approx(a["bias"] ** 2 + a["sd"] ** 2 * (a["n"] - 1) / a["n"], rel=1e-6)


def test_alignment_recovers_lag_and_error():
    # 기준 장비가 PhysioCap 보다 1.25초 늦게 녹화를 시작 → 기준 시각 τ 의 자세 = PhysioCap 시각 τ+1.25 의 자세
    t = np.arange(0, 8, 0.01)
    lag = 1.25
    test = {"time": t.tolist(), "cols": {"knee_angle_r": knee(t).tolist()}}
    rt = np.arange(0, 8, 1 / 120)  # 모캡 120 Hz
    rng = np.random.default_rng(1)
    ref = {"time": rt.tolist(), "cols": {"knee_angle_r": (knee(rt + lag) - 3.0 + rng.normal(0, 0.5, rt.size)).tolist()}}
    res = V.compare_series(test, ref, align_on="knee_angle_r", max_lag_s=3)
    assert res["alignment"]["lag_s"] == pytest.approx(lag, abs=0.01)
    k = res["columns"]["knee_angle_r"]
    assert k["bias"] == pytest.approx(3.0, abs=0.1)
    assert k["mae"] == pytest.approx(3.0, abs=0.15)
    assert len(k["ba"]) <= 300
    # 영점(정적 차이) 제거 옵션이면 편향이 사라진다
    res2 = V.compare_series(test, ref, align_on="knee_angle_r", max_lag_s=3, remove_offset=True)
    assert abs(res2["columns"]["knee_angle_r"]["bias"]) < 0.05


def test_read_table_mobile_csv_mapping_and_mot():
    csv = "﻿time_s,kneeFlexR,lumbarFlex,fppaR\n0,10,5,1\n0.1,12,6,\n0.2,14,7,2\n"
    d = V.read_table(csv, "a_angles.csv")
    assert d["cols"]["knee_angle_r"] == [10, 12, 14]
    assert d["cols"]["lumbar_extension"] == [-5, -6, -7]  # 굴곡(+) → OpenSim 신전(+) 부호 반전
    assert "fppaR" not in d["cols"]  # OpenSim 대응이 없는 2D 지표는 제외
    m = V.read_table(mot_text([0, 0.1, 0.2], {"pelvis_tx": [0, 0.01, 0.02]}), "x.mot")
    assert m["cols"]["pelvis_tx"] == [0, 0.01, 0.02]


def test_sample_size_inverse():
    n = V.n_for_loa_precision(sd=3.0, halfwidth=1.0)
    assert V.loa_ci_halfwidth(3.0, n) <= 1.0 < V.loa_ci_halfwidth(3.0, n - 1)


def test_aggregate_against_benchmark():
    recs = [{"kind": "series", "source": "kinematics", "activity": "walking",
             "result": {"columns": {"knee_angle_r": {"mae": m}, "pelvis_tx": {"mae": 20}}}} for m in (3.0, 5.0)]
    a = V.aggregate(recs)["activities"]["walking"]
    assert a["columns"]["knee_angle_r"] == {"mae_mean": 4.0, "n_trials": 2}
    assert "pelvis_tx" not in a["columns"]
    assert a["opencap_benchmark_mae"] == 4.1


# ---------------------------------------------------------------- API
def _session_with_kinematics(appmod, c, t, cols):
    register(c, "a"); register(c, "b")
    s = c.post("/api/sessions", json={"subject": {"height_m": 1.7, "mass_kg": 65}, "cameras": {"Cam0": "a", "Cam1": "b"}}).json()
    p = appmod.L.kinematics_mot(appmod.DATA, s["id"], "walk1")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(mot_text(t, cols))
    return s["id"]


def test_validation_api_series_and_discrete(env):  # noqa: F811
    appmod, c, _ = env
    t = np.arange(0, 6, 0.01)
    sid = _session_with_kinematics(appmod, c, t, {"knee_angle_r": knee(t), "hip_flexion_r": 0.5 * knee(t)})
    ref = mot_text(t, {"knee_angle_r": knee(t) + 2.0, "hip_flexion_r": 0.5 * knee(t) - 1.0})
    r = c.post("/api/validation/series", data={"session": sid, "trial": "walk1", "activity": "walking", "align_on": "knee_angle_r"},
               files={"reference": ("mocap.mot", ref.encode(), "text/plain")})
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["result"]["columns"]["knee_angle_r"]["bias"] == pytest.approx(-2.0, abs=0.02)
    assert v["result"]["columns"]["hip_flexion_r"]["mae"] == pytest.approx(1.0, abs=0.02)
    assert c.get("/api/validation").json()[0]["id"] == v["id"]
    summ = c.get("/api/validation/summary").json()
    assert summ["activities"]["walking"]["opencap_benchmark_mae"] == 4.1

    # 고니오미터 기록지: 시계열에서 최대값 추출 vs 직접 입력한 test_value
    kmax = float(knee(t).max())
    sheet = "subject,session,trial,coordinate,mode,t_start,t_end,reference_deg,test_value\n"
    sheet += f"P01,{sid},walk1,knee_angle_r,max,0,6,{kmax + 1:.3f},\n"
    for i, (tv, rv) in enumerate([(40, 42), (55, 54), (70, 73), (90, 88)]):
        sheet += f"P0{i + 2},,,knee_angle_r,max,,,{rv},{tv}\n"
    r = c.post("/api/validation/discrete", files={"sheet": ("g.csv", sheet.encode(), "text/csv")})
    assert r.status_code == 200, r.text
    g = r.json()["result"]["groups"]["knee_angle_r|max"]
    assert g["n"] == 5 and g["points"][0]["test"] == pytest.approx(kmax, abs=0.01)
    assert g["icc"]["icc2_1"]["value"] > 0.9

    # 잘못된 입력은 400, 없는 결과는 404, 삭제 가능
    bad = c.post("/api/validation/series", data={"session": sid, "trial": "walk1"},
                 files={"reference": ("x.csv", b"time,other\n0,1\n1,2\n", "text/csv")})
    assert bad.status_code == 400
    assert c.get("/api/validation/../../etc").status_code == 404
    assert c.delete(f"/api/validation/{v['id']}").json() == {"ok": True}
    assert c.get(f"/api/validation/{v['id']}").status_code == 404


def test_requeue_orphans(tmp_path):
    import store as st
    root = tmp_path / "d"
    s = st.Store(root)
    a = s.enqueue("core", session="S", trial="t")
    b = s.enqueue("kinetics", session="S", trial="t")
    ja = st.claim_job(root, {"core"})
    jb = st.claim_job(root, {"kinetics"})
    assert ja["id"] == a["id"] and jb["id"] == b["id"]
    # core 워커만 재시작 → core 작업만 대기열로 돌아가고 kinetics 작업(다른 워커가 처리 중)은 그대로
    assert st.requeue_orphans(root, {"core", "intrinsics"}) == [a["id"]]
    assert (root / "jobs" / "running" / f"{b['id']}.json").exists()
    again = st.claim_job(root, {"core"})
    assert again["id"] == a["id"] and again["requeued"] == 1
    assert json.loads((root / "jobs" / "running" / f"{a['id']}.json").read_text())["state"] == "running"


def test_pilot_example_sheet_averages_repeats(env):  # noqa: F811
    from pathlib import Path
    _, c, _ = env
    p = Path(__file__).resolve().parent.parent / "dashboard" / "templates" / "pilot_goniometer_example.csv"
    r = c.post("/api/validation/discrete", data={"activity": "squats"}, files={"sheet": (p.name, p.read_bytes(), "text/csv")})
    assert r.status_code == 200, r.text
    groups = r.json()["result"]["groups"]
    assert set(groups) == {"knee_angle_r|mean", "hip_flexion_r|mean", "ankle_angle_r|mean"}
    for g in groups.values():
        assert g["n"] == 8  # 8명 × 3회 → 대상자당 한 쌍
        assert all(pt["repeats"] == 3 for pt in g["points"])
    rows = [x for x in V.average_repeats([{"subject": "A", "test": 1, "ref": 2}, {"subject": "A", "test": 3, "ref": 4}, {"subject": "", "test": 5, "ref": 5}])]
    assert rows[0] == {"label": "A", "test": 2.0, "ref": 3.0, "repeats": 2} and len(rows) == 2


def test_jobs_claimed_in_enqueue_order(tmp_path):
    import store as st
    s = st.Store(tmp_path / "q")
    ids = [s.enqueue("activity" if i % 2 else "kinetics", n=i)["id"] for i in range(50)]  # 같은 ms 안에 연속으로
    assert ids == sorted(ids)
    got = [st.claim_job(tmp_path / "q", {"activity", "kinetics"})["n"] for _ in range(50)]
    assert got == list(range(50))


def test_icc_not_computable_cases():
    """분산이 0인 경우: NaN 대신 None 과 사유를 돌려준다."""
    # 1) 모든 값이 같음
    r = V.icc([290, 290, 290], [290, 290, 290])
    assert r["icc2_1"]["value"] is None and r["icc3_1"]["value"] is None and "모든 측정값이 같" in r["interpretation"]
    # 2) 대상자 간 차이 없음(방법 간 차이만 있음)
    r = V.icc([292, 292, 292], [290, 290, 290])
    assert r["icc2_1"]["value"] is None and "대상자 간" in r["interpretation"]
    # 3) 두 방법의 차이가 모든 대상자에서 같음(오차 분산 0): ICC 값은 있고 신뢰구간만 계산 불가
    r = V.icc([12, 22, 32, 42], [10, 20, 30, 40])
    assert r["icc3_1"]["value"] == pytest.approx(1.0) and r["icc3_1"]["ci"] == [None, None]
    assert 0 < r["icc2_1"]["value"] < 1 and r["icc2_1"]["ci"] == [None, None] and "신뢰구간 계산 불가" in r["interpretation"]
    # 어떤 경우든 표준 JSON 으로 직렬화 가능해야 한다
    for t, ref in (([290] * 3, [290] * 3), ([292] * 3, [290] * 3), ([12, 22, 32, 42], [10, 20, 30, 40])):
        json.dumps(V.compare_discrete([{"test": a, "ref": b} for a, b in zip(t, ref)]), allow_nan=False)
    # 정상 자료는 이전과 같다
    r = V.icc([10, 21, 29, 42, 50], [11, 20, 31, 40, 52])
    assert r["icc2_1"]["value"] > 0.9 and None not in r["icc2_1"]["ci"] and "note" not in r


def test_json_safe():
    out = V.json_safe({"a": float("nan"), "b": [1.0, float("inf"), np.float64(2.5)], "c": {"d": np.int64(3)}, "e": "x"})
    assert out == {"a": None, "b": [1.0, None, 2.5], "c": {"d": 3}, "e": "x"}


def test_discrete_api_when_icc_not_computable(env):
    """모든 측정값이 같은 기록지도 500 오류 없이 결과를 돌려주고, 이전 버전이 NaN 으로 저장한 파일도 읽힌다."""
    appmod, c, _ = env
    sheet = "subject,coordinate,mode,reference_deg,test_value\n" + "".join(f"P{i},knee_angle_r,max,90,90\n" for i in range(3))
    r = c.post("/api/validation/discrete", files={"sheet": ("g.csv", sheet.encode(), "text/csv")})
    assert r.status_code == 200
    g = r.json()["result"]["groups"]["knee_angle_r|max"]
    assert g["icc"]["icc2_1"]["value"] is None and "계산 불가" in g["icc"]["interpretation"]
    vid = r.json()["id"]
    assert c.get(f"/api/validation/{vid}").status_code == 200
    # 이전 버전 파일(NaN 그대로 저장)
    old = appmod.DATA / "validation" / "val_old.json"
    old.write_text('{"id": "val_old", "kind": "series", "source": "kinematics", "activity": "walking", '
                   '"result": {"summary": {"rotations_mae_mean": NaN}, "columns": {"knee_angle_r": {"mae": NaN}}}}')
    assert c.get("/api/validation/val_old").json()["result"]["summary"]["rotations_mae_mean"] is None
    assert c.get("/api/validation").status_code == 200
    assert c.get("/api/validation/summary").status_code == 200
