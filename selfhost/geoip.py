"""Offline IP-to-country lookup. No visitor IP is sent to a third party."""

import ipaddress
import os
import re

try:
    import maxminddb
except ImportError:
    maxminddb = None

READER = None
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")


def initialize():
    global READER
    if maxminddb is None:
        raise RuntimeError("maxminddb package is not installed")
    path = os.getenv("VM_GEOIP_DB", "/var/lib/vibemetrics/geoip/dbip-country-lite.mmdb")
    if not os.path.isfile(path):
        raise RuntimeError("GeoIP country database is missing")
    READER = maxminddb.open_database(path)


def country_code(value):
    if READER is None:
        return "ZZ"
    try:
        address = ipaddress.ip_address(value)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        if not address.is_global:
            return "ZZ"
        record = READER.get(address.compressed) or {}
        country = record.get("country") or record.get("registered_country") or {}
        code = str(country.get("iso_code", "")).upper()
        return code if COUNTRY_RE.fullmatch(code) else "ZZ"
    except (ValueError, TypeError, OSError):
        return "ZZ"
