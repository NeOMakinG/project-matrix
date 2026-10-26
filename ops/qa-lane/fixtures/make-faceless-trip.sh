#!/usr/bin/env bash
# Regenerates ops/qa-lane/fixtures/faceless-trip/: twenty landscape photos with no person in them, for
# an agent QA lane that needs "a trip with photos without faces" (Travel Journal films). Needs
# curl, ImageMagick 7 (`magick`) and exiftool; run on a workstation, review, commit the output.
#
# Source: Lorem Picsum (https://picsum.photos), photos from Unsplash under the Unsplash License
# (free to use, modify and redistribute). The ids below were checked by eye: no person, no face.
#
# Why they are prepared like this:
# - Real landscapes: the film picker only offers frames its on-device labeller reads as scenery
#   (sky, mountain, forest, ...) and drops abstract or object frames; synthetic drawings fail it.
# - Re-encoded to 1600x1200 with a full camera EXIF block: the importer drops photos under 1400 px
#   on the long edge (messaging re-encodes) and photos without camera-body EXIF.
# - GPS in Porto and dates 14-16 Feb 2025: far from the emulator library's home (Barcelona) and
#   from its other trips, so the app builds one 3-day trip "Porto, Feb 2025" from them.
set -euo pipefail
out="$(cd "$(dirname "$0")" && pwd)/faceless-trip"
mkdir -p "$out" && rm -f "$out"/*.jpg
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# picsum id|day|time
shots=(10\|14\|09:05 11\|14\|10:10 15\|14\|11:40 16\|14\|13:15 17\|14\|15:10 28\|14\|17:00 29\|14\|18:25
  33\|15\|09:20 37\|15\|10:35 46\|15\|12:25 110\|15\|14:00 116\|15\|15:30 118\|15\|17:10
  124\|16\|09:35 128\|16\|10:50 135\|16\|12:40 92\|16\|14:05 84\|16\|16:05 122\|16\|17:30 101\|16\|18:45)
lon=6100
for s in "${shots[@]}"; do
  IFS='|' read -r id day time <<<"$s"
  curl -fsSL -m 60 -o "$tmp/src.jpg" "https://picsum.photos/id/$id/1600/1200"
  f="$tmp/out.jpg"
  # Decode and re-encode: nothing of the downloaded file but its pixels survives.
  magick "$tmp/src.jpg" -auto-orient -strip -resize 1600x1200^ -gravity center -extent 1600x1200 \
    -quality 72 "$f"
  lon=$((lon + 170))
  stamp="2025:02:${day} ${time}:00"
  # Orientation#=1 is the number: a bare -Orientation=1 goes through exiftool's print conversion
  # and wrote 3 (Rotate 180), so the app showed every photo upside down.
  exiftool -q -q -overwrite_original -Make=Apple "-Model=iPhone 17 Pro Max" -LensMake=Apple \
    "-LensModel=iPhone 17 Pro Max back camera 6.765mm f/1.78" -ExposureTime=1/250 -FNumber=1.78 \
    -ISO=50 -FocalLength=6.765 -Orientation#=1 "-DateTimeOriginal=$stamp" "-CreateDate=$stamp" \
    -OffsetTimeOriginal=+00:00 -GPSLatitude=41.1496 -GPSLatitudeRef=N \
    "-GPSLongitude=8.$lon" -GPSLongitudeRef=W "$f"
  # The lane names device files after these: ^[a-z][a-z0-9._-]{0,37}$ (FIXTURE in agent-qa-lane.ts).
  mv "$f" "$out/img_202502${day}_${time/:/}00_qa.jpg"
done
ls -l "$out"
