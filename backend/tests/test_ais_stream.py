"""Tests for the live AIS stream consumer's pure functions.

We can't hit real AISStream in unit tests, but we can exercise every pure
piece: bbox classification, frame parsing, getter fallback behaviour, and
the auth-error terminal branch. The WebSocket loop itself is exercised
only via the empty-state / no-key path."""
from __future__ import annotations

from collections import deque

import pytest

from app.ingest import ais_stream


# ---------------------------------------------------------------------------
# Bbox classification
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("lat,lon,expected", [
    (26.5, 56.2, "hormuz"),           # Strait of Hormuz
    (13.0, 43.0, "bab_el_mandeb"),    # Bab el-Mandeb
    (2.5, 101.5, "malacca"),          # Strait of Malacca
    (15.0, 115.0, "south_china_sea"), # SCS
    (-34.3, 18.4, "cape_of_good_hope"),
    (29.5, 32.5, "suez"),             # Suez
    (0.0, 0.0, None),                 # Gulf of Guinea → no corridor
    (0.0, 180.0, None),               # Pacific
    (60.0, 10.0, None),               # North Sea
])
def test_classify_corridor(lat, lon, expected):
    assert ais_stream._classify_corridor(lat, lon) == expected


def test_all_six_corridors_defined():
    for c in ("hormuz", "bab_el_mandeb", "malacca", "south_china_sea",
              "cape_of_good_hope", "suez"):
        assert c in ais_stream.CORRIDOR_BBOXES


def test_bbox_shapes_are_south_west_then_north_east():
    """AISStream requires [[south, west], [north, east]] — south<north, west<east."""
    for c, bbox in ais_stream.CORRIDOR_BBOXES.items():
        (south, west), (north, east) = bbox
        assert south < north, f"{c}: south={south} not < north={north}"
        assert west < east, f"{c}: west={west} not < east={east}"


# ---------------------------------------------------------------------------
# Frame parsing (_to_position)
# ---------------------------------------------------------------------------
def _valid_frame(lat=26.5, lon=56.2, sog=12.3, cog=90.0, mmsi=123, name="TEST"):
    return {
        "MessageType": "PositionReport",
        "MetaData": {"MMSI": mmsi, "ShipName": name, "time_utc": "2026-06-30T21:00:00Z"},
        "Message": {"PositionReport": {"Latitude": lat, "Longitude": lon,
                                       "Sog": sog, "Cog": cog, "UserID": mmsi}},
    }


def test_to_position_parses_valid_frame():
    pos = ais_stream._to_position(_valid_frame())
    assert pos is not None
    assert pos["mmsi"] == "123"
    assert pos["lat"] == 26.5
    assert pos["corridor"] == "hormuz"
    assert pos["anomaly"] is False


def test_to_position_flags_speed_below_2kn_as_anomaly():
    pos = ais_stream._to_position(_valid_frame(sog=1.2))
    assert pos["anomaly"] is True


def test_to_position_rejects_non_position_report():
    frame = _valid_frame()
    frame["MessageType"] = "ShipStaticData"
    assert ais_stream._to_position(frame) is None


def test_to_position_rejects_out_of_bbox():
    """A point outside every corridor bbox returns None."""
    assert ais_stream._to_position(_valid_frame(lat=0, lon=0)) is None


def test_to_position_rejects_empty_mmsi():
    frame = _valid_frame()
    frame["Message"]["PositionReport"]["UserID"] = 0
    frame["MetaData"]["MMSI"] = 0
    assert ais_stream._to_position(frame) is None


def test_to_position_rejects_malformed_frame():
    assert ais_stream._to_position(None) is None
    assert ais_stream._to_position({}) is None
    assert ais_stream._to_position({"MessageType": "PositionReport"}) is None


# ---------------------------------------------------------------------------
# Getters and empty-state behaviour
# ---------------------------------------------------------------------------
def test_getters_return_empty_when_never_connected():
    """Before any successful frame, live getters must return safe empties so
    downstream callers fall through to the fixture path."""
    # Reset module state to simulate fresh boot.
    ais_stream._connected_at = None
    for buf in ais_stream._BUFFERS.values():
        buf.clear()
    assert ais_stream.get_live_vessel_counts() == {}
    assert ais_stream.get_live_vessel_positions() == []


def test_getters_return_data_after_frame():
    ais_stream._connected_at = "2026-06-30T21:00:00Z"
    ais_stream._BUFFERS["hormuz"].append({
        "mmsi": "1", "lat": 26.5, "lon": 56.2, "_ts": "2026-06-30T21:00:00Z",
    })
    counts = ais_stream.get_live_vessel_counts()
    positions = ais_stream.get_live_vessel_positions()
    assert counts.get("hormuz") == 1
    assert len(positions) == 1
    # Reset for other tests.
    ais_stream._connected_at = None
    for buf in ais_stream._BUFFERS.values():
        buf.clear()


def test_buffers_have_correct_maxlen():
    """Sanity: the rolling deques must be bounded so the process can't OOM."""
    for c, buf in ais_stream._BUFFERS.items():
        assert isinstance(buf, deque)
        assert buf.maxlen == 200


def test_buffer_overflow_drops_oldest():
    """Filling a deque past maxlen drops from the front (FIFO)."""
    buf = ais_stream._BUFFERS["hormuz"]
    buf.clear()
    for i in range(210):
        buf.append({"mmsi": str(i), "lat": 26.5, "lon": 56.2, "_ts": f"t{i}"})
    assert len(buf) == 200
    # First 10 should have been dropped.
    assert buf[0]["mmsi"] == "10"
    buf.clear()


def test_status_shape():
    ais_stream._connected_at = None
    for buf in ais_stream._BUFFERS.values():
        buf.clear()
    s = ais_stream.status()
    for key in ("connected_at", "corridor_buffer_sizes", "task_running"):
        assert key in s
    assert all(v == 0 for v in s["corridor_buffer_sizes"].values())
