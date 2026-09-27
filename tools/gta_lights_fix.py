#!/usr/bin/env python3
"""Приводит фонари GTA 5 к правильному цвету в готовом GLB.

В чём была настоящая проблема. В YFT материал линз один на все фонари -
vehiclelights128, и в нём цвет НЕ переносится ни в baseColor, ни в emissive
осмысленно: baseColorTexture отсутствует, baseColorFactor белый, а атлас
vehiclelights.png приклеен как emissiveTexture с emissiveFactor 0.5. Движок GTA
рисует линзы шейдером vehicle_lightsemissive, который в glTF просто нет, поэтому
фонари выходят серыми.

Где на самом деле цвет. Важно: атлас НЕ серый. В тех UV, которые реально
сэмплят фонари, он уже цветной - проверено попиксельно по геометрии Sultan:

    группа          средний RGB атласа     R:G:B
    taillight       0.320 0.044 0.043       1.00 : 0.14 : 0.13   (красный)
    brakelight      0.503 0.027 0.009       1.00 : 0.05 : 0.02   (красный)
    indicator       0.390 0.121 0.003       1.00 : 0.31 : 0.01   (янтарный)
    headlight       0.338 0.330 0.379       0.89 : 0.87 : 1.00   (белый)
    reversinglight  0.377 0.393 0.465       0.81 : 0.85 : 1.00   (белый)
    extralight      0.427 0.422 0.412       1.00 : 0.99 : 0.96   (белый)

То есть цвет линзы уже запечён в атлас - его достаточно перенести в baseColor.
Умножать атлас на цвет из carcols нельзя: получится двойная окраска (красный
на красном), и именно это делает наивный "атлас × baseColorFactor".

Поэтому по умолчанию инструмент НЕ красит ничего, а только переносит атлас из
emissive в baseColor с белым множителем - цвет приходит сам, из атласа, ровно
так же, как это делает gtax.dev. Режим --tint carcols оставлен для редкого
случая, когда у машины атлас серый и цвет действительно приходит только из
carcols.meta; применять его на цветном атласе нельзя.

    python3 tools/gta_lights_fix.py web/car.glb web/car_lights.glb
    python3 tools/gta_lights_fix.py in.glb out.glb --alpha 0.85
    python3 tools/gta_lights_fix.py in.glb out.glb --tint carcols

Blender не нужен: это правка JSON внутри контейнера, геометрия не пересобирается.
"""
import argparse
import json
import os
import struct
import sys

# Пресеты carcols для lightSettings=0. Используются только в --tint carcols.
# В линейном пространстве, как их хранит carcols.meta.
CARCOLS = {
    "taillight":      (0.820, 0.055, 0.060),
    "brakelight":     (0.900, 0.070, 0.075),
    "indicator":      (0.950, 0.520, 0.090),
    "headlight":      (0.930, 0.945, 0.980),
    "reversinglight": (0.900, 0.920, 0.940),
    "extralight":     (0.940, 0.940, 0.890),
}

# car.*.emissive.on из visualsettings.dat / 100 - множитель к карте.
GTA_EMISSIVE = {
    "taillight": 2.00, "brakelight": 2.40, "indicator": 2.50,
    "headlight": 1.80, "reversinglight": 0.35, "extralight": 3.50,
}

LAMP_WORDS = ("taillight", "brakelight", "indicator", "headlight",
              "reversinglight", "extralight")


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise SystemExit("не GLB: %s" % path)
    off, js, bin_ = 12, None, b""
    while off < len(data):
        if off + 8 > len(data):
            break
        ln, ty = struct.unpack_from("<II", data, off)
        off += 8
        chunk = data[off:off + ln]
        off += ln + (-ln % 4)
        if ty == 0x4E4F534A:
            js = json.loads(chunk)
        elif ty == 0x004E4942:
            bin_ = chunk
    if js is None:
        raise SystemExit("в GLB нет JSON-чанка")
    return js, bytearray(bin_)


def write_glb(path, js, bin_):
    js = dict(js)
    js["buffers"] = [{"byteLength": len(bin_)}]
    js_enc = json.dumps(js, separators=(",", ":")).encode("utf-8")
    js_pad = b" " * (-len(js_enc) % 4)
    bin_pad = b"\x00" * (-len(bin_) % 4)
    # по спецификации GLB длина чанка включает выравнивающий паддинг
    js_len = len(js_enc) + len(js_pad)
    bin_len = len(bin_) + len(bin_pad)
    total = 12 + 8 + js_len + 8 + bin_len
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", js_len, 0x4E4F534A) + js_enc + js_pad)
        f.write(struct.pack("<II", bin_len, 0x004E4942) + bin_ + bin_pad)


def group_of(name):
    low = name.lower()
    for w in sorted(LAMP_WORDS, key=len, reverse=True):
        if w in low:
            return w
    return None


def find_lamp_meshes(js):
    """mesh index -> группа ламп, по именам нод, которые на них ссылаются."""
    out = {}
    for nd in js.get("nodes", []):
        if "mesh" not in nd:
            continue
        g = group_of(nd.get("name", ""))
        if g:
            out.setdefault(nd["mesh"], g)
    return out


def mesh_names(js):
    names = {}
    for nd in js.get("nodes", []):
        if "mesh" in nd:
            names.setdefault(nd["mesh"], nd.get("name", ""))
    return names


def find_lamp_material(js, meshes):
    """Общий материал линз и индекс атласа (emissiveTexture, иначе baseColorTexture)."""
    mats = set()
    for mi in meshes:
        for pr in js["meshes"][mi]["primitives"]:
            if "material" in pr:
                mats.add(pr["material"])
    if len(mats) != 1:
        raise SystemExit("у фонарей ожидался один материал, а их %d: %s"
                         % (len(mats), sorted(mats)))
    mi = mats.pop()
    mat = js["materials"][mi]
    tex = mat.get("emissiveTexture") or mat.get("baseColorTexture")
    if not tex:
        raise SystemExit("у материала %r нет текстуры" % mat.get("name"))
    img = js["images"][tex["index"]]
    if "uri" in img:
        raise SystemExit("атлас лежит во внешнем файле (%s), а не в GLB" % img["uri"])
    return mi, tex["index"]


def set_lens(mat, js, tex_idx, color, alpha, emissive):
    """Переводит линзу на правильную схему: атлас в baseColor, множитель цвета."""
    pbr = mat.setdefault("pbrMetallicRoughness", {})
    pbr["baseColorTexture"] = {"index": tex_idx}
    r, g, b = color
    pbr["baseColorFactor"] = [r, g, b, alpha]

    if emissive == "gta":
        # GTA рисует линзу через шейдер линз; в glTF это emissive с силой из
        # visualsettings.dat. Атлас нужен и там, и в base - так эмиссия не съедает
        # диффузный цвет стекла.
        mat["emissiveTexture"] = {"index": tex_idx}
        mat["emissiveFactor"] = [1.0, 1.0, 1.0]
    else:
        mat.pop("emissiveTexture", None)
        mat["emissiveFactor"] = [0.0, 0.0, 0.0]

    if alpha >= 0.999:
        mat["alphaMode"] = "OPAQUE"
        mat.pop("alphaCutoff", None)
    else:
        mat["alphaMode"] = "BLEND"
    return mat


def main():
    ap = argparse.ArgumentParser(
        description="Правильный цвет фонарей GTA 5 в готовом GLB.")
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--alpha", type=float, default=1.0,
                    help="непрозрачность линзы, по умолчанию 1.0 (OPAQUE). "
                         "0.32 - как в исходном YFT, стекло полупрозрачное")
    ap.add_argument("--tint", choices=("none", "carcols"), default="none",
                    help="none (по умолчанию) - цвет берётся из самого атласа, "
                         "так верно для машин с цветным атласом; "
                         "carcols - домножить на цвет из carcols.meta, только "
                         "для машин с СЕРЫМ атласом, иначе двойная окраска")
    ap.add_argument("--emissive", choices=("off", "gta"), default="off",
                    help="off - линзы не светятся; "
                         "gta - свечение с силами из visualsettings.dat")
    ap.add_argument("--prefix", default="lamp",
                    help="префикс имён материалов для --tint carcols")
    a = ap.parse_args()

    js, bin_ = read_glb(a.input)
    lamps = find_lamp_meshes(js)
    if not lamps:
        raise SystemExit("фонари не найдены: ни один меш не назван как lamp")
    old_idx, tex_idx = find_lamp_material(js, lamps)
    src = js["materials"][old_idx]
    groups = sorted(set(lamps.values()))

    if a.tint == "none":
        # Один материал на все фонари: атлас самодостаточен по цвету.
        m = json.loads(json.dumps(src))
        m["name"] = "%s_vehiclelights" % a.prefix
        set_lens(m, js, tex_idx, (1.0, 1.0, 1.0), a.alpha, a.emissive)
        js["materials"][old_idx] = m
        targets = {g: old_idx for g in groups}
        print("режим none: цвет линз берётся из атласа, множитель белый")
    else:
        targets = {}
        for g in groups:
            targets[g] = len(js["materials"])
            m = json.loads(json.dumps(src))
            m["name"] = "%s_%s" % (a.prefix, g)
            strength = GTA_EMISSIVE[g] if a.emissive == "gta" else 0.0
            set_lens(m, js, tex_idx, CARCOLS[g], a.alpha, a.emissive)
            if a.emissive == "gta" and strength:
                js.setdefault("extensionsUsed", []).append(
                    "KHR_materials_emissive_strength")
                js.setdefault("extensions", {})[
                    "KHR_materials_emissive_strength"] = {"emissiveStrength": strength}
            js["materials"].append(m)
        print("режим carcols: атлас ДОМНОЖЕН на цвет - применять только "
              "к серому атласу, иначе двойная окраска")

    switched = 0
    for mi, g in lamps.items():
        for pr in js["meshes"][mi]["primitives"]:
            if pr.get("material") == old_idx:
                pr["material"] = targets[g]
                switched += 1

    # У vehiclelights128 в YFT назначен ещё и кузов (bodyshell, bumper, chassis) -
    # там он отвечает за отражения. Материал трогаем на месте, индексы не плывут.
    names = mesh_names(js)
    others = sorted({names.get(i, "mesh#%d" % i)
                     for i, mesh in enumerate(js["meshes"])
                     if i not in lamps
                     and any(pr.get("material") == old_idx for pr in mesh["primitives"])})
    print("материал %r переписан; он же остаётся на: %s"
          % (src.get("name"), ", ".join(others) if others else "-"))

    write_glb(a.output, js, bin_)

    print("групп фонарей: %d, переключено примитивов: %d" % (len(groups), switched))
    print("атлас: изображение #%d -> baseColorTexture" % tex_idx)
    print("эмиссия: %s, альфа: %.2f (%s)"
          % (a.emissive, a.alpha, "OPAQUE" if a.alpha >= 0.999 else "BLEND"))
    for g in groups:
        if a.tint == "carcols":
            r, gg, b = CARCOLS[g]
            print("  %-14s множитель (%.3f, %.3f, %.3f)  материал %r"
                  % (g, r, gg, b, "%s_%s" % (a.prefix, g)))
    print("записано: %s (%d байт)" % (a.output, os.path.getsize(a.output)))


if __name__ == "__main__":
    sys.exit(main())
