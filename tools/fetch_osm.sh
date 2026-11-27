#!/bin/bash
# Экспорт реальных объектов инфраструктуры Басманного района (Москва)
# из OpenStreetMap через Overpass API (аналог overpass-turbo.eu).
# Результат: JSON-файлы в этой же папке (osm_*.json).
set -u

D="$(cd "$(dirname "$0")" && pwd)"
BBOX="55.7575,37.6520,55.7810,37.7180"   # bbox Басманного района

q_school='[out:json][timeout:25];(node["amenity"="school"]('"$BBOX"');way["amenity"="school"]('"$BBOX"'););out tags center 60;'
q_med='[out:json][timeout:25];(node["amenity"~"^(clinic|doctors|hospital)$"]('"$BBOX"');way["amenity"~"^(clinic|doctors|hospital)$"]('"$BBOX"'););out tags center 60;'
q_park='[out:json][timeout:25];(way["leisure"~"^(park|garden)$"]('"$BBOX"');relation["leisure"~"^(park|garden)$"]('"$BBOX"'););out tags center 40;'
q_transit='[out:json][timeout:25];(node["highway"="bus_stop"]('"$BBOX"');node["railway"="tram_stop"]('"$BBOX"');node["railway"="station"]('"$BBOX"'););out tags center 80;'
q_edu='[out:json][timeout:25];(node["amenity"~"^(university|college|library)$"]('"$BBOX"');way["amenity"~"^(university|college|library)$"]('"$BBOX"'););out tags center 40;'

fetch() {
  local name="$1" query="$2"
  local out="$D/osm_$name.json"
  local code i
  # Зеркала Overpass бывают перегружены (HTTP 504) — повторяем запрос с паузами.
  for i in 1 2 3 4 5 6 7 8; do
    code=$(curl -sG -m 60 -L -A 'Mozilla/5.0' -o "$out" -w '%{http_code}' \
          --data-urlencode "data=$query" \
          https://maps.mail.ru/osm/tools/overpass/api/interpreter)
    if [ "$code" = "200" ]; then break; fi
    sleep 8
  done
  echo "$name: HTTP $code, $(wc -c < "$out" | tr -d ' ') bytes"
  sleep 3
}

fetch school   "$q_school"
fetch medical  "$q_med"
fetch park     "$q_park"
fetch transit  "$q_transit"
fetch edu      "$q_edu"
echo "Done. Файлы: $D/osm_*.json"
