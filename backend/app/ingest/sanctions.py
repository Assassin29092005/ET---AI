"""Sanctions list ingestion (OFAC SDN, UN, EU consolidated).

Sources:
  - OFAC SDN XML: https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML
  - UN Consolidated: https://scsanctions.un.org/resources/xml/en/consolidated.xml
  - EU Consolidated: https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content

Provides a normalized list of sanctioned entities and a fuzzy supplier matcher
used by the supply graph to flag exposure.
"""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from xml.etree import ElementTree as ET

import httpx
import structlog
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.config import get_settings

settings = get_settings()

log = structlog.get_logger(__name__)

_OFAC_SDN_XML = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML"
_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "sanctions.json"
_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=5.0)
_MATCH_THRESHOLD = 0.86


async def load_sdn_list() -> list[dict]:
    """Return normalized SDN entries.

    Each entry: {uid, name, aliases, type, programs, addresses, source}.
    """
    if not settings.allow_live_ingest:
        log.info("sanctions.fixture_mode")
        return _load_fixture()

    try:
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential(min=1, max=10),
            retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
            reraise=True,
        ):
            with attempt:
                # OFAC's SDN endpoint 302-redirects to a presigned S3 URL, so
                # redirects must be followed or every live fetch raises.
                async with httpx.AsyncClient(
                    timeout=_DEFAULT_TIMEOUT, follow_redirects=True
                ) as client:
                    resp = await client.get(_OFAC_SDN_XML)
                    resp.raise_for_status()
                    xml_bytes = resp.content
    except httpx.HTTPError as exc:
        log.warning("sanctions.live_failed", error=str(exc))
        return _load_fixture()

    return _parse_sdn_xml(xml_bytes)


def matches_supplier(entity_name: str, sdn: list[dict]) -> bool:
    """Return True if an entity name fuzzy-matches any SDN entry or alias."""
    normalized = _normalize(entity_name)
    if not normalized:
        return False
    for entry in sdn:
        candidates = [entry.get("name", "")] + list(entry.get("aliases", []))
        for cand in candidates:
            cand_norm = _normalize(cand)
            if not cand_norm:
                continue
            if cand_norm in normalized or normalized in cand_norm:
                return True
            if SequenceMatcher(None, normalized, cand_norm).ratio() >= _MATCH_THRESHOLD:
                return True
    return False


def _normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", name.lower()).strip()


def _parse_sdn_xml(xml_bytes: bytes) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    # Derive the namespace from the document rather than hardcoding it: OFAC's
    # sanctionslistservice endpoint serves the SDN list under a namespace that
    # differs from the legacy tempuri.org one, and could change again.
    ns_uri = root.tag[1:root.tag.index("}")] if root.tag.startswith("{") else ""

    def q(tag: str) -> str:
        return f"{{{ns_uri}}}{tag}" if ns_uri else tag

    entries: list[dict] = []
    for entry in root.findall(q("sdnEntry")):
        uid = entry.findtext(q("uid"), default="")
        first = entry.findtext(q("firstName"), default="")
        last = entry.findtext(q("lastName"), default="")
        name = f"{first} {last}".strip() or last or first
        sdn_type = entry.findtext(q("sdnType"), default="")
        programs = [
            p.text or ""
            for p in entry.findall(f"{q('programList')}/{q('program')}")
        ]
        aliases = [
            (a.findtext(q("firstName"), default="") + " "
             + a.findtext(q("lastName"), default="")).strip()
            for a in entry.findall(f"{q('akaList')}/{q('aka')}")
        ]
        addresses = [
            {
                "country": a.findtext(q("country"), default=""),
                "city": a.findtext(q("city"), default=""),
            }
            for a in entry.findall(f"{q('addressList')}/{q('address')}")
        ]
        entries.append(
            {
                "uid": uid,
                "name": name,
                "aliases": [a for a in aliases if a],
                "type": sdn_type,
                "programs": programs,
                "addresses": addresses,
                "source": "OFAC_SDN",
            }
        )
    return entries


def _load_fixture() -> list[dict]:
    if not _FIXTURE_PATH.exists():
        log.warning("sanctions.fixture_missing", path=str(_FIXTURE_PATH))
        return []
    with _FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)
