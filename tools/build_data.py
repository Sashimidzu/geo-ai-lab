#!/usr/bin/env python3
# ══════════════════════════════════════════════════════════════
#  build_data.py — сборка data/data.json из выгрузок Overpass API
#  (файлы tools/osm_*.json, полученные скриптом fetch_osm.sh).
#
#  Оставляет реальные объекты Якутска с названиями,
#  распределяет их по типам и округляет координаты.
# ══════════════════════════════════════════════════════════════

import json
import re
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
OUT = ROOT / "data" / "data.json"

# Центр карты (площадь Ленина, Якутск) — для сортировки «ближние первыми»
CENTER = (62.0355, 129.6800)

# Карта исходных значений OSM → типы приложения
SCHOOL_TAGS = ("school",)
MEDICAL_TAGS = ("clinic", "doctors", "hospital")
PARK_TAGS = ("park", "garden")
EDU_TAGS = ("university", "college", "library")
TRANSIT_TAGS = ("bus_stop", "tram_stop", "station", "subway_entrance")

TYPE_LABELS = {
    "school": "Школа / лицей",
    "medical": "Поликлиника / больница",
    "park": "Парк / сквер",
    "transport": "Остановка транспорта",
    "education": "Вуз / библиотека",
}

# Русские подписи для значений amenity из OSM
AMENITY_RU = {
    "library": "Библиотека",
    "university": "Университет",
    "college": "Колледж",
    "school": "Образовательное учреждение",
}

TYPE_LIMITS = {  # чтобы карта не была перегружена однотипными точками
    "school": 5,
    "medical": 4,
    "park": 4,
    "transport": 8,
    "education": 5,
}


def load(name):
    p = TOOLS / f"osm_{name}.json"
    if not p.exists():
        print(f"⚠ нет файла {p}", file=sys.stderr)
        return []
    d = json.loads(p.read_text(encoding="utf-8"))
    return d.get("elements", [])


def center_of(el):
    """Координаты: у node — свои, у way/relation — поле center из out center."""
    if el.get("type") == "node":
        return el.get("lat"), el.get("lon")
    c = el.get("center") or {}
    return c.get("lat"), c.get("lon")


def dist_to_center(lat, lon):
    R = 6371000
    import math

    la1, lo1 = map(math.radians, CENTER)
    la2, lo2 = map(math.radians, (lat, lon))
    a = (
        math.sin((la2 - la1) / 2) ** 2
        + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    )
    return 2 * R * math.asin(math.sqrt(a))


def addr_of(tags):
    parts = []
    if tags.get("addr:street"):
        parts.append(tags["addr:street"])
    if tags.get("addr:housenumber"):
        parts.append(tags["addr:housenumber"])
    return ", ".join(parts) if parts else ""


def norm_name(name):
    """Убирает вариантные названия через ';', берёт первое."""
    return name.split(";")[0].strip()


objects = []
seen_names = set()
seen_ids = set()


def add_element(el, app_type, extra_desc=None, suffix=""):
    tags = el.get("tags", {}) or {}
    name = norm_name(tags.get("name") or tags.get("official_name") or "")
    if not name:
        return
    lat, lon = center_of(el)
    if lat is None or lon is None:
        return
    key = (app_type, name.lower())
    if key in seen_names or el.get("id") in seen_ids:
        return
    seen_names.add(key)
    seen_ids.add(el.get("id"))

    addr = addr_of(tags)
    desc = extra_desc or ""

    # описания по типам, если не задано явно
    if not desc:
        if app_type == "school":
            desc = tags.get("operator") or "Образовательное учреждение"
        elif app_type == "medical":
            desc = "Медицинское учреждение"
        elif app_type == "park":
            desc = "Зелёная зона Якутска"
        elif app_type == "transport":
            lines = tags.get("route_ref") or tags.get("ref") or ""
            desc = f"Маршруты: {lines}" if lines else "Остановка общественного транспорта"
        elif app_type == "education":
            desc = AMENITY_RU.get(tags.get("amenity", ""), "Учебное заведение")

    if suffix and suffix not in name:
        name = f"{name} {suffix}"

    objects.append(
        {
            "id": f"osm-{app_type}-{el.get('id')}",
            "name": name,
            "type": app_type,
            "address": addr or "Якутск, Республика Саха (Якутия)",
            "lat": round(float(lat), 6),
            "lng": round(float(lon), 6),
            "description": desc,
        }
    )


# ── Школы ──────────────────────────────────────────────
for el in load("school"):
    tags = el.get("tags", {}) or {}
    is_school = tags.get("amenity") in SCHOOL_TAGS
    grade = tags.get("isced:level", "")
    add_element(
        el,
        "school",
        extra_desc=("Образовательное учреждение" + (f", ISCED {grade}" if grade else ""))
        if is_school
        else None,
    )

# ── Медицина ───────────────────────────────────────────
for el in load("medical"):
    add_element(el, "medical")

# ── Парки ──────────────────────────────────────────────
for el in load("park"):
    tags = el.get("tags", {}) or {}
    add_element(
        el,
        "park",
        extra_desc=tags.get("name") and "Зелёная зона Якутска" or None,
    )

# ── Транспорт ──────────────────────────────────────────
for el in load("transit"):
    tags = el.get("tags", {}) or {}
    t = tags.get("highway") == "bus_stop" or tags.get("railway") in (
        "tram_stop",
        "station",
    )
    if not t:
        continue
    # названия остановок часто совпадают — добавляем тип в скобках при дублях
    base = norm_name(tags.get("name") or "")
    add_element(el, "transport")

# ── Вузы / библиотеки ──────────────────────────────────
for el in load("edu"):
    add_element(el, "education")

# ── СВФУ им. М.К. Аммосова — знаковый объект Якутска ───
# (в выгрузке OSM главный корпус не попал в выборку по amenity,
#  добавляем его отдельно по данным OSM: way 966350337)
if not any("Аммосова" in o["name"] and o["type"] == "education" for o in objects):
    objects.append(
        {
            "id": "osm-education-svfu",
            "name": "СВФУ им. М.К. Аммосова",
            "type": "education",
            "address": "улица Кулаковского, 48",
            "lat": 62.021699,
            "lng": 129.710591,
            "description": "Университет, учебно-лабораторный корпус",
        }
    )

# ── Балансировка по типам: ближайшие к центру района ────
final = []
for app_type, limit in TYPE_LIMITS.items():
    group = [o for o in objects if o["type"] == app_type]
    group.sort(key=lambda o: dist_to_center(o["lat"], o["lng"]))
    final.extend(group[:limit])

final.sort(key=lambda o: (o["type"], o["name"]))

# ── Запись результата ──────────────────────────────────
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(
    json.dumps(
        {
            "meta": {
                "district": "Якутск, Республика Саха (Якутия)",
                "source": "OpenStreetMap (Overpass API), ODbL",
                "center": {"lat": CENTER[0], "lng": CENTER[1]},
                "generated": "etap 1 — сбор данных",
            },
            "objects": final,
        },
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)

by_type = {}
for o in final:
    by_type[o["type"]] = by_type.get(o["type"], 0) + 1
print(f"✅ data/data.json: {len(final)} объектов")
for t, n in by_type.items():
    print(f"   {TYPE_LABELS[t]}: {n}")
