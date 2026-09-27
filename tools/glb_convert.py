"""Универсальный конвертер 3D-моделей в GLB через Blender.

Зачем отдельный скрипт: bexport.py заточен под GTA V (YFT через Sollumz, правка
GTA-шейдеров, клонирование wheel_lf на кости скелета). Для обычной модели из папки
он не подходит, а писать импорт и экспорт заново каждый раз не хочется.

DDS специально не декодируется: Blender умеет читать DDS сам, а glTF-экспортёр
перекодирует картинки в PNG при экспорте. Скрипт только чинит пути к текстурам.

Запуск:
    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        --python tools/glb_convert.py -- МОДЕЛЬ.glb [options]

Опции (--ключ=значение):
    scale=ЧИСЛО          масштаб импорта, по умолчанию 1.0
    apply=1              применить модификаторы (по умолчанию 1)
    triangulate=1        триангулировать (по умолчанию 0)
    animations=1         выгружать анимацию (по умолчанию 0)
    cameras=1            выгружать камеры (по умолчанию 0)
    lights=1             выгружать свет (по умолчанию 0)
    image_format=ФОРМАТ   AUTO | PNG | JPEG (по умолчанию AUTO)
    png=ПАПКА            перекодировать текстуры в PNG и сложить в эту папку
    repair=0             не чинить материалы без Principled BSDF (по умолчанию 1)

Примеры:
    ... -- ./models/car.fbx out/car.glb
    ... -- ./models/robot.glb out/robot.glb scale=0.01
    ... -- ./models/level.dae out/level.glb triangulate=1
"""
import os
import sys

import bpy
from mathutils import Vector

# Blender прокидывает пользовательские аргументы после "--"
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

SUPPORTED = {
    ".fbx": ["import_scene.fbx"],
    ".obj": ["wm.obj_import", "import_scene.obj"],
    ".stl": ["wm.stl_import", "import_scene.stl"],
    ".ply": ["wm.ply_import", "import_scene.ply"],
    ".dae": ["wm.collada_import", "import_scene.collada"],
    ".gltf": ["import_scene.gltf"],
    ".glb": ["import_scene.gltf"],
    ".abc": ["wm.alembic_import"],
    ".usd": ["wm.usd_import"],
    ".usda": ["wm.usd_import"],
    ".usdc": ["wm.usd_import"],
    ".usdz": ["wm.usd_import"],
    ".blend": ["wm.open_mainfile"],
}
# 3ds в Blender нет как импортируемого формата, а .3ds-оператор не пережить -
# поэтому честно отказываем, а не гадаем с именем оператора.


def opts():
    out = {}
    for a in ARGS[2:]:
        if "=" not in a:
            continue
        k, v = a.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def flag(o, name, default):
    return o.get(name, str(default)) not in ("0", "false", "no", "")


def run(opname, **kw):
    """Вызывает bpy.ops.<opname>, если такой оператор есть в этой сборке."""
    parts = opname.split(".")
    node = bpy.ops
    for p in parts[:-1]:
        node = getattr(node, p, None)
        if node is None:
            return False
    fn = getattr(node, parts[-1], None)
    if fn is None:
        return False
    try:
        fn(**kw)
        return True
    except Exception as e:
        print("  оператор %s не сработал: %s" % (opname, e), flush=True)
        return False


def import_model(path, scale):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
        return
    if ext not in SUPPORTED:
        raise SystemExit(
            "Формат %s не поддерживается этим конвертером.\n"
            "Поддерживаются: %s\n"
            "Для .3ds, .max, .skp, .blend1 и прочего сначала переведите модель "
            "в FBX/OBJ/GLB (Blender, Assimp, CloudCompare)." % (ext, ", ".join(sorted(SUPPORTED)))
        )
    for opname in SUPPORTED[ext]:
        if run(opname, filepath=path, global_scale=scale) if opname == "import_scene.fbx" \
           else run(opname, filepath=path):
            print("импорт через %s" % opname, flush=True)
            return
    raise SystemExit("не удалось импортировать %s ни одним из операторов: %s"
                     % (path, ", ".join(SUPPORTED[ext])))


def fix_texture_paths(model_dir):
    """Импортеры часто оставляют относительные пути, которые экспортёр не найдёт."""
    fixed = 0
    for img in bpy.data.images:
        if img.source not in {'FILE', 'SEQUENCE'} or img.packed_file:
            continue
        fp = bpy.data.filepath and os.path.dirname(bpy.data.filepath)
        if not img.filepath:
            continue
        if not os.path.isabs(img.filepath):
            base = model_dir
            if fp and os.path.exists(os.path.join(fp, img.filepath)):
                base = fp
            new = os.path.normpath(os.path.join(base, img.filepath))
            if os.path.exists(new):
                img.filepath = new
                fixed += 1
    if fixed:
        print("исправлено путей к текстурам:", fixed, flush=True)


def repair_materials():
    """Часть импортеров создаёт материалы с нод-деревом, где Principled никуда не подключён,
    и такой материал экспортируется пустым. Подключаем выход."""
    fixed = 0
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            mat.use_nodes = True
            fixed += 1
            continue
        nt = mat.node_tree
        bsdf = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"), None)
        out = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeOutputMaterial"), None)
        if bsdf is None or out is None:
            continue
        if not any(l.to_node == out for l in nt.links):
            nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
            fixed += 1
    if fixed:
        print("починено материалов:", fixed, flush=True)


def report():
    mn = Vector((1e9,) * 3)
    mx = Vector((-1e9,) * 3)
    tris = meshes = 0
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        meshes += 1
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
    size = mx - mn
    print("мешей=%d  треугольников=%d  материалов=%d  изображений=%d"
          % (meshes, tris, len(bpy.data.materials), len(bpy.data.images)), flush=True)
    print("габарит: %.3f x %.3f x %.3f м" % (size.x, size.z, size.y), flush=True)
    print("центр: (%.3f, %.3f, %.3f)" % tuple((mn + mx) / 2), flush=True)
    return meshes


def main():
    if len(ARGS) < 2:
        raise SystemExit(__doc__)
    src, dst = ARGS[0], ARGS[1]
    o = opts()
    if not os.path.exists(src):
        raise SystemExit("нет такого файла: %s" % src)
    out_dir = os.path.dirname(os.path.abspath(dst))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    print("=== %s -> %s ===" % (src, dst), flush=True)
    import_model(src, float(o.get("scale", 1.0)))

    if flag(o, "png", 0):
        # текстуры перекодировать в PNG и положить рядом с результатом
        png_dir = o["png"]
        os.makedirs(png_dir, exist_ok=True)
        for img in bpy.data.images:
            if img.source == 'FILE' and os.path.exists(img.filepath):
                img.filepath_raw = os.path.join(png_dir, os.path.splitext(os.path.basename(img.filepath))[0] + ".png")
                img.file_format = 'PNG'
                img.save()

    fix_texture_paths(os.path.dirname(os.path.abspath(src)))
    if flag(o, "repair", 1):
        repair_materials()
    if flag(o, "triangulate", 0):
        for o2 in bpy.data.objects:
            if o2.type == 'MESH' and o2.data.polygons:
                try:
                    bpy.context.view_layer.objects.active = o2
                    bpy.ops.object.modifier_add(type='TRIANGULATE')
                    bpy.ops.object.modifier_apply(modifier="Triangulate")
                except Exception as e:
                    print("  триангуляция не удалась:", e, flush=True)
    report()

    kw = dict(
        filepath=dst,
        export_format='GLB',
        use_selection=False,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials='EXPORT',
        export_image_format=o.get("image_format", "AUTO").upper(),
        export_cameras=flag(o, "cameras", 0),
        export_lights=flag(o, "lights", 0),
        export_animations=flag(o, "animations", 0),
        export_extras=False,
    )
    # apply вынесен отдельно: в разных версиях экспортёра он называется по-разному
    if "export_apply" in bpy.ops.export_scene.gltf.get_rna_type().properties.keys():
        kw["export_apply"] = flag(o, "apply", 1)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError as e:
        # набор параметров зависит от версии экспортёра - откатываемся на базовый
        print("часть параметров не поддержана (%s), экспортирую базовым набором" % e, flush=True)
        bpy.ops.export_scene.gltf(
            filepath=dst, export_format='GLB', use_selection=False,
            export_yup=True, export_texcoords=True, export_normals=True,
            export_materials='EXPORT', export_image_format='AUTO')

    print("EXPORTED %s (%d байт)" % (dst, os.path.getsize(dst)), flush=True)


main()
