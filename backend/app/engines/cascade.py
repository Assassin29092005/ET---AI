"""Impact cascade engine.

Given any cause node (a corridor closure, a country event, or a commodity
shock) this walks the India dependency graph and reports every downstream node
it reaches — commodities, Indian sectors, and macro variables — with a
severity score and the transmission path.

This is the "any cause anywhere -> everything affected in India" engine. It is
deterministic and explainable: severity is the product of edge weights along
the shortest/strongest path from the cause, with a per-hop decay so distant
second-order effects rank below direct hits.

The graph lives in data/fixtures/dependency_graph.json. The LLM narrative layer
consumes the structured output of resolve_cascade() to justify the chain.
"""

from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

_GRAPH_PATH = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "dependency_graph.json"
_PRICES_PATH = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "commodity_prices.json"

# Per-hop decay so a 4th-order macro effect doesn't outrank a direct commodity hit.
_HOP_DECAY = 0.85
# Below this accumulated severity an edge is not worth propagating further.
_MIN_SEVERITY = 0.02

# Per-commodity price reference: base spot, display unit, and shock elasticity
# (the fractional price move at severity 1.0). Base prices are overridden by the
# live commodity_prices.json where a series exists, so the cascade price matches
# the dashboard ticker. Elasticities are indicative planning factors (see
# docs/assumptions.md), tuned so a full Hormuz crude shock lands near +30%.
_PRICE_REF: dict[str, dict[str, Any]] = {
    "commodity:crude_oil": {"base": 82.0, "unit": "USD/bbl", "elasticity": 0.32, "series": "brent_crude_usd"},
    "commodity:lng": {"base": 14.5, "unit": "USD/MMBtu", "elasticity": 0.40, "series": "lng_jkm_usd"},
    "commodity:lpg": {"base": 640.0, "unit": "USD/t", "elasticity": 0.28, "series": None},
    "commodity:coking_coal": {"base": 295.0, "unit": "USD/t", "elasticity": 0.30, "series": "coking_coal_usd"},
    "commodity:thermal_coal": {"base": 130.0, "unit": "USD/t", "elasticity": 0.25, "series": None},
    "commodity:rare_earths": {"base": 78.0, "unit": "USD/kg NdPr", "elasticity": 0.50, "series": None},
    "commodity:lithium": {"base": 15.5, "unit": "USD/kg LCE", "elasticity": 0.35, "series": None},
    "commodity:cobalt": {"base": 28.0, "unit": "USD/kg", "elasticity": 0.42, "series": None},
    "commodity:nickel": {"base": 17.5, "unit": "USD/kg", "elasticity": 0.30, "series": None},
    "commodity:graphite": {"base": 0.85, "unit": "USD/kg", "elasticity": 0.40, "series": None},
    "commodity:manganese": {"base": 4.6, "unit": "USD/dmtu", "elasticity": 0.25, "series": None},
    "commodity:solar_pv": {"base": 0.105, "unit": "USD/W", "elasticity": 0.25, "series": None},
    "commodity:polysilicon": {"base": 6.8, "unit": "USD/kg", "elasticity": 0.35, "series": None},
    "commodity:uranium": {"base": 88.0, "unit": "USD/lb U3O8", "elasticity": 0.22, "series": None},
    "commodity:copper": {"base": 9.4, "unit": "USD/kg", "elasticity": 0.25, "series": None},
    "commodity:silver": {"base": 31.0, "unit": "USD/oz", "elasticity": 0.20, "series": None},
    "commodity:pgm": {"base": 980.0, "unit": "USD/oz", "elasticity": 0.30, "series": None},
    "commodity:rock_phosphate": {"base": 155.0, "unit": "USD/t", "elasticity": 0.35, "series": None},
    "commodity:potash": {"base": 320.0, "unit": "USD/t", "elasticity": 0.35, "series": None},
}


@lru_cache(maxsize=1)
def _live_base_prices() -> dict[str, float]:
    """Override static base prices with the latest commodity_prices.json values."""
    if not _PRICES_PATH.exists():
        return {}
    try:
        data = json.loads(_PRICES_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out: dict[str, float] = {}
    for cid, ref in _PRICE_REF.items():
        series_key = ref.get("series")
        if not series_key:
            continue
        series = data.get(series_key)
        if isinstance(series, list) and series:
            last = series[-1].get("value")
            if isinstance(last, (int, float)):
                out[cid] = float(last)
    return out


def _price_impact(commodity_id: str, severity: float) -> dict[str, Any] | None:
    """Current -> projected spot price for an affected commodity."""
    ref = _PRICE_REF.get(commodity_id)
    if not ref:
        return None
    base = _live_base_prices().get(commodity_id, ref["base"])
    uplift_pct = severity * ref["elasticity"] * 100.0
    projected = base * (1.0 + uplift_pct / 100.0)
    decimals = 2 if base < 100 else (1 if base < 10000 else 0)
    return {
        "currentPrice": round(base, decimals),
        "projectedPrice": round(projected, decimals),
        "priceUpliftPct": round(uplift_pct, 1),
        "unit": ref["unit"],
    }


# Indian-unit metric reference for sectors. type "mult" = cost rises
# multiplicatively with severity; "index_down" = an index that falls (demand).
# base values are indicative FY26 planning figures (see docs/assumptions.md).
_SECTOR_METRIC: dict[str, dict[str, Any]] = {
    "sector:fuel_retail": {"base": 92.0, "unit": "Rs/L diesel", "elasticity": 0.22, "type": "mult"},
    "sector:transport": {"base": 100.0, "unit": "freight cost index", "elasticity": 0.18, "type": "mult"},
    "sector:aviation": {"base": 96.5, "unit": "Rs/L ATF", "elasticity": 0.30, "type": "mult"},
    "sector:petrochem": {"base": 78.0, "unit": "Rs/kg naphtha", "elasticity": 0.24, "type": "mult"},
    "sector:fertilizer": {"base": 1350.0, "unit": "Rs/bag DAP", "elasticity": 0.18, "type": "mult"},
    "sector:power": {"base": 4.6, "unit": "Rs/kWh gen cost", "elasticity": 0.16, "type": "mult"},
    "sector:city_gas": {"base": 76.0, "unit": "Rs/kg CNG", "elasticity": 0.20, "type": "mult"},
    "sector:steel": {"base": 52000.0, "unit": "Rs/t HRC", "elasticity": 0.17, "type": "mult"},
    "sector:construction": {"base": 100.0, "unit": "input cost index", "elasticity": 0.12, "type": "mult"},
    "sector:auto": {"base": 100.0, "unit": "input cost index", "elasticity": 0.11, "type": "mult"},
    "sector:ev_battery": {"base": 8500.0, "unit": "Rs/kWh cell", "elasticity": 0.20, "type": "mult"},
    "sector:grid_storage": {"base": 9000.0, "unit": "Rs/kWh", "elasticity": 0.18, "type": "mult"},
    "sector:wind": {"base": 650.0, "unit": "Rs lakh/MW capex", "elasticity": 0.14, "type": "mult"},
    "sector:solar_build": {"base": 11.0, "unit": "Rs/W module", "elasticity": 0.18, "type": "mult"},
    "sector:electronics_defence": {"base": 100.0, "unit": "component cost index", "elasticity": 0.16, "type": "mult"},
    "sector:agriculture": {"base": 100.0, "unit": "input cost index", "elasticity": 0.15, "type": "mult"},
    "sector:food": {"base": 100.0, "unit": "food price index", "elasticity": 0.13, "type": "mult"},
    "sector:fmcg": {"base": 100.0, "unit": "rural demand index", "elasticity": 0.10, "type": "index_down"},
    "sector:electricity": {"base": 6.6, "unit": "Rs/kWh tariff", "elasticity": 0.12, "type": "mult"},
}

# Indian macro metrics. "bps" = a percentage moved additively by severity;
# "crore" = a rupee-crore impact accumulated; "fx" = INR/USD multiplicative.
_MACRO_METRIC: dict[str, dict[str, Any]] = {
    "macro:cpi": {"base": 5.1, "unit": "% CPI", "maxBps": 120, "type": "bps", "sign": 1},
    "macro:wpi": {"base": 2.8, "unit": "% WPI", "maxBps": 160, "type": "bps", "sign": 1},
    "macro:inr": {"base": 84.7, "unit": "INR/USD", "elasticity": 0.05, "type": "fx"},
    "macro:gdp": {"base": 6.5, "unit": "% GDP growth", "maxBps": 70, "type": "bps", "sign": -1},
    "macro:fiscal": {"base": 0.0, "unit": "Rs crore subsidy", "maxCrore": 32000, "type": "crore"},
    "macro:current_account": {"base": 1.2, "unit": "% GDP CAD", "maxBps": 45, "type": "bps", "sign": 1},
}


def _metric_impact(node_id: str, kind: str, severity: float) -> dict[str, Any] | None:
    """Current -> projected Indian-unit metric for a sector or macro node."""
    ref = (_SECTOR_METRIC if kind == "sector" else _MACRO_METRIC).get(node_id)
    if not ref:
        return None

    # For FX rate, check if we have a live baseline available
    base = float(ref["base"])
    if kind == "macro" and node_id == "macro:inr":
        # Try to get live FX rate from scenarios.BASELINE
        try:
            from app.engines import scenarios
            live_fx = scenarios.BASELINE.get("inr_per_usd")
            if live_fx is not None:
                base = float(live_fx)
        except (ImportError, KeyError, ValueError, TypeError):
            # Fall back to hardcoded base if live value unavailable
            pass

    mtype = ref["type"]

    if mtype == "mult":
        projected = base * (1.0 + severity * ref["elasticity"])
        dec = 2 if base < 100 else (1 if base < 10000 else 0)
        pct = severity * ref["elasticity"] * 100.0
        return {
            "current": round(base, dec),
            "projected": round(projected, dec),
            "unit": ref["unit"],
            "deltaLabel": f"+{pct:.0f}%",
            "direction": "up",
        }
    if mtype == "index_down":
        projected = base * (1.0 - severity * ref["elasticity"])
        pct = severity * ref["elasticity"] * 100.0
        return {
            "current": round(base, 0),
            "projected": round(projected, 0),
            "unit": ref["unit"],
            "deltaLabel": f"-{pct:.0f}%",
            "direction": "down",
        }
    if mtype == "bps":
        bps = severity * ref["maxBps"] * ref.get("sign", 1)
        projected = base + bps / 100.0
        sign = "+" if bps >= 0 else ""
        return {
            "current": round(base, 1),
            "projected": round(projected, 1),
            "unit": ref["unit"],
            "deltaLabel": f"{sign}{bps:.0f} bps",
            "direction": "up" if bps >= 0 else "down",
        }
    if mtype == "fx":
        projected = base * (1.0 + severity * ref["elasticity"])
        return {
            "current": round(base, 1),
            "projected": round(projected, 1),
            "unit": ref["unit"],
            "deltaLabel": f"+{(projected - base):.1f}",
            "direction": "up",
        }
    if mtype == "crore":
        impact = severity * ref["maxCrore"]
        return {
            "current": 0,
            "projected": round(impact, 0),
            "unit": ref["unit"],
            "deltaLabel": f"+Rs {impact:,.0f} cr",
            "direction": "up",
        }
    return None


@dataclass
class CascadeNode:
    """A node reached by the cascade, with how it was reached."""

    id: str
    kind: str  # cause | commodity | sector | macro
    label: str
    severity: float  # 0-1 accumulated transmission strength
    hop: int  # distance from the cause in edges
    via: list[str] = field(default_factory=list)  # mechanism strings along the path
    path: list[str] = field(default_factory=list)  # node ids from cause to here
    lag_days: int = 0  # cumulative lag along the path


@dataclass
class CascadeResult:
    cause_id: str
    cause_label: str
    nodes: list[CascadeNode]
    edges_used: list[dict[str, Any]]

    def by_kind(self, kind: str) -> list[CascadeNode]:
        return sorted(
            [n for n in self.nodes if n.kind == kind],
            key=lambda n: n.severity,
            reverse=True,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "causeId": self.cause_id,
            "causeLabel": self.cause_label,
            "affectedCommodities": [_node_dict(n) for n in self.by_kind("commodity")],
            "sectorImpacts": [_node_dict(n) for n in self.by_kind("sector")],
            "macroImpacts": [_node_dict(n) for n in self.by_kind("macro")],
            "edgesUsed": self.edges_used,
            "nodeCount": len(self.nodes),
        }


def _node_dict(n: CascadeNode) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": n.id,
        "label": n.label,
        "kind": n.kind,
        "severity": round(n.severity, 3),
        "hop": n.hop,
        "via": n.via,
        "path": n.path,
        "lagDays": n.lag_days,
    }
    if n.kind == "commodity":
        price = _price_impact(n.id, n.severity)
        if price:
            out["price"] = price
            # unified metric shape so the UI renders all three kinds the same way
            out["metric"] = {
                "current": price["currentPrice"],
                "projected": price["projectedPrice"],
                "unit": price["unit"],
                "deltaLabel": f"+{price['priceUpliftPct']:.0f}%",
                "direction": "up",
            }
    elif n.kind in ("sector", "macro"):
        metric = _metric_impact(n.id, n.kind, n.severity)
        if metric:
            out["metric"] = metric
    return out


@lru_cache(maxsize=1)
def _load_graph() -> dict[str, Any]:
    if not _GRAPH_PATH.exists():
        raise FileNotFoundError(f"dependency graph missing at {_GRAPH_PATH}")
    return json.loads(_GRAPH_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _adjacency() -> dict[str, list[dict[str, Any]]]:
    graph = _load_graph()
    adj: dict[str, list[dict[str, Any]]] = {}
    for e in graph.get("edges", []):
        adj.setdefault(e["from"], []).append(e)
    return adj


@lru_cache(maxsize=1)
def _node_index() -> dict[str, dict[str, Any]]:
    graph = _load_graph()
    idx: dict[str, dict[str, Any]] = {}
    for cause in graph.get("causes", []):
        idx[cause["id"]] = {"kind": "cause", **cause}
    for c in graph.get("commodities", []):
        idx[c["id"]] = {"kind": "commodity", **c}
    for s in graph.get("sectors", []):
        idx[s["id"]] = {"kind": "sector", **s}
    for m in graph.get("macro", []):
        idx[m["id"]] = {"kind": "macro", **m}
    return idx


def list_causes() -> list[dict[str, Any]]:
    """All cause nodes the user can pick as the origin of a cascade."""
    graph = _load_graph()
    return [
        {
            "id": c["id"],
            "type": c.get("type", "cause"),
            "label": c["label"],
            "region": c.get("region", ""),
            "description": c.get("description", ""),
        }
        for c in graph.get("causes", [])
    ]


def cause_id_for_corridor(corridor: str) -> str:
    """Map a frontend corridor code (e.g. 'hormuz') to its cause node id."""
    return f"corridor:{corridor}"


def cause_id_for_commodity(commodity: str) -> str:
    """Map a commodity code to its node id (commodity shocks can be causes too)."""
    return f"commodity:{commodity}"


def resolve_cascade(cause_id: str, intensity: float = 1.0) -> CascadeResult:
    """Walk the dependency graph from cause_id and collect every node reached.

    Args:
        cause_id: a node id present in the graph (corridor:*, country:*, or
            commodity:* — a commodity can itself be the origin of a shock).
        intensity: 0-1 scalar applied to the cause's outbound severity.

    Returns:
        CascadeResult with every reachable India-side node, scored by the
        strongest transmission path (max-product over paths, with hop decay).
    """
    idx = _node_index()
    adj = _adjacency()

    if cause_id not in idx:
        raise KeyError(f"unknown cause node: {cause_id}")

    intensity = max(0.0, min(1.0, intensity))
    cause = idx[cause_id]

    # best[node_id] -> CascadeNode currently holding the strongest path to it
    best: dict[str, CascadeNode] = {}
    edges_used: dict[str, dict[str, Any]] = {}

    start = CascadeNode(
        id=cause_id,
        kind=cause["kind"],
        label=cause.get("label", cause_id),
        severity=intensity,
        hop=0,
        via=[],
        path=[cause_id],
        lag_days=0,
    )
    best[cause_id] = start

    # Dijkstra-like relaxation maximising the product of edge weights with decay.
    queue: deque[CascadeNode] = deque([start])
    while queue:
        cur = queue.popleft()
        for edge in adj.get(cur.id, []):
            target = edge["to"]
            if target not in idx:
                continue
            decay = _HOP_DECAY ** cur.hop
            new_sev = cur.severity * float(edge.get("weight", 0.0)) * decay
            if new_sev < _MIN_SEVERITY:
                continue
            existing = best.get(target)
            if existing is not None and existing.severity >= new_sev:
                continue
            tnode = idx[target]
            node = CascadeNode(
                id=target,
                kind=tnode["kind"],
                label=tnode.get("label", target),
                severity=new_sev,
                hop=cur.hop + 1,
                via=cur.via + [edge.get("mechanism", "")],
                path=cur.path + [target],
                lag_days=cur.lag_days + int(edge.get("lagDays", 0)),
            )
            best[target] = node
            edge_key = f"{edge['from']}->{edge['to']}"
            edges_used[edge_key] = {
                "from": edge["from"],
                "to": edge["to"],
                "weight": edge.get("weight", 0.0),
                "mechanism": edge.get("mechanism", ""),
                "lagDays": edge.get("lagDays", 0),
            }
            queue.append(node)

    nodes = [n for n in best.values() if n.id != cause_id]
    return CascadeResult(
        cause_id=cause_id,
        cause_label=cause.get("label", cause_id),
        nodes=nodes,
        edges_used=list(edges_used.values()),
    )


def cascade_summary_for_llm(result: CascadeResult) -> dict[str, Any]:
    """Compact structured payload the LLM narrative layer reasons over."""
    def _comm(n: CascadeNode) -> dict[str, Any]:
        d: dict[str, Any] = {"commodity": n.label, "severity": round(n.severity, 2), "lagDays": n.lag_days}
        price = _price_impact(n.id, n.severity)
        if price:
            d["currentPrice"] = price["currentPrice"]
            d["projectedPrice"] = price["projectedPrice"]
            d["priceUpliftPct"] = price["priceUpliftPct"]
            d["unit"] = price["unit"]
        return d

    return {
        "cause": result.cause_label,
        "affectedCommodities": [_comm(n) for n in result.by_kind("commodity")],
        "sectorImpacts": [
            {
                "sector": n.label,
                "severity": round(n.severity, 2),
                "lagDays": n.lag_days,
                "transmission": " -> ".join(n.via) if n.via else "",
            }
            for n in result.by_kind("sector")
        ],
        "macroImpacts": [
            {"variable": n.label, "severity": round(n.severity, 2), "lagDays": n.lag_days}
            for n in result.by_kind("macro")
        ],
    }


__all__ = [
    "CascadeNode",
    "CascadeResult",
    "resolve_cascade",
    "list_causes",
    "cause_id_for_corridor",
    "cause_id_for_commodity",
    "cascade_summary_for_llm",
]
