#!/bin/sh
# Обёртка над tools/glb_convert.py: запускает конвертер в headless-режиме.
#
#   ./tools/convert.sh МОДЕЛЬ.glb
#   ./tools/convert.sh МОДЕЛЬ.glb out/МОДЕЛЬ.glb
#   ./tools/convert.sh МОДЕЛЬ.glb out.glb scale=0.01
#
# Форматы: fbx, obj, glb, gltf, stl, ply, dae, abc, usd/usda/usdc/usdz, blend.
# Текстуры читаются как есть (DDS поддерживается самим Blender), glTF-экспортёр
# сам перекодит их в PNG внутри .glb.
set -e

BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
HERE=$(cd "$(dirname "$0")" && pwd)

if [ ! -x "$BLENDER" ]; then
    echo "Blender не найден: $BLENDER" >&2
    echo "Укажи путь переменной BLENDER=/путь/к/Blender" >&2
    exit 1
fi

if [ $# -lt 1 ]; then
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi

if [ ! -f "$1" ]; then
    echo "нет такого файла: $1" >&2
    exit 1
fi

IN="$1"
if [ $# -ge 2 ] && [ "${2#--}" = "$2" ] && [ "${2#*=}" = "$2" ]; then
    OUT="$2"
    shift 2
else
    name=$(basename "$1")
    name="${name%.*}"
    OUT="$name.glb"
    shift
fi

exec "$BLENDER" -b --factory-startup \
    --python "$HERE/glb_convert.py" -- "$IN" "$OUT" "$@"
