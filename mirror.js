// ── боковые зеркала: выпуклое (сферическое) отражение ───────────────────
// Схема «камера в точке стекла + дисторсия»: у каждого зеркала свой
// RenderTargetTexture и своя перспективная камера с широким FOV. Камера
// стоит почти в точке стекла и смотрит вдоль истинного отражённого луча
// (водитель→стекло, отражённый от плоскости стекла), поэтому центральный
// тексель — математически точное отражение, а широкий FOV даёт материал
// для бочкообразной дисторсии в шейдере (края сжимаются — как у реального
// выпуклого зеркала). Весь кузов исключён из рендера зеркал, так что
// никакие плоскости отсечения не нужны: лучи сквозь проём стекла честно
// долетают до мира позади машины.
// В список отрисовки идут все меши сцены, кроме стёкол и кузова.
//
// Подключается после map.js, работает на глобалах index.html:
//   setupMirrors({ root, meshes }) — один раз после загрузки модели
//   setMirrorsActive(on)          — вкл/выкл из applyCamMode
//   mirrorTick()                  — каждый кадр перед scene.render()

let MIRROR_RES = 2048;           // сторона RTT (меняется из окна зеркал)
let MIRROR_FOV = 1.75;           // ~100°: широкий угол выпуклого зеркала, рад
let MIRROR_DISTORT_K = 0.35;     // сила бочкообразной дисторсии (0 = плоское)
let MIRROR_SPREAD = 3.0;         // во сколько раз шире геометрического следа тянем картинку
let MIRROR_CAM_OFFSET = 1.3;     // камера — на продолжении отражённого луча за стеклом, м
const MIRROR_GLASS_OUT = 0.05;   // сдвиг точки стекла наружу от центра авто, м
const MIRROR_ANISO = 16;         // фильтрация при взгляде на зеркало под углом
const MIRROR_ADJ_DEG = 0.5;    // шаг регулировки зеркала, градусы за нажатие
const MIRROR_ADJ = MIRROR_ADJ_DEG * Math.PI / 180;   // то же в радианах
// Регулировка зеркал по умолчанию, градусы: поворот по горизонтали (← →) и
// наклон (↑ ↓). Левое чуть развёрнуто наружу, оба опущены — в салон видно
// дорогу, а не крышу. Все значения кратны шагу MIRROR_ADJ_DEG, поэтому
// подгонка к сетке шага их не сдвигает. Задаются в градусах, потому что
// ровно в градусах их показывает HUD.
const MIRROR_DEFAULT_DEG = {
  left:  { yaw: 1.0,  pitch: -9.5 },
  right: { yaw: 10.5, pitch: -7.5 },
};
const mirrorDefault = side => {
  const d = MIRROR_DEFAULT_DEG[side] || { yaw: 0, pitch: 0 };
  return { yaw: d.yaw * Math.PI / 180, pitch: d.pitch * Math.PI / 180 };
};

let mirrorEntries = [];   // { mesh, tex, mat, cam, srcMat, srcVC, side, center, baseNormal, yaw, pitch }
let mirrorPlates = null;  // Set мешей-стёкол: их нельзя рисовать в самом RTT
let mirrorNearMeshes = null; // Set деталей, перекрывающих обзор (находится трассировкой)
let mirrorList = null;    // общий список мешей для RTT
let mirrorListed = -1;    // сколько мешей было в сцене на прошлой сборке
let mirrorActive = false;
let mirrorAdjOn = false;  // режим регулировки направления зеркал
let mirrorAdjSide = 0;    // выбранное зеркало (индекс в mirrorEntries)

// Шейдер выпуклого зеркала: проекция из широкоуольной камеры + бочка.
// worldViewProjection подставляет сам движок, reflectionMatrix (= P*V
// камеры зеркала) обновляем каждый кадр в tickMirrors.
BABYLON.Effect.ShadersStore["convexMirrorVertexShader"] = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vWorldPos;
varying vec2 vUv;
void main() {
  vec4 wp = worldViewProjection * vec4(position, 1.0);
  vWorldPos = (world * vec4(position, 1.0)).xyz;
  vUv = uv;
  gl_Position = wp;
}
`;
BABYLON.Effect.ShadersStore["convexMirrorFragmentShader"] = `
precision highp float;
varying vec3 vWorldPos;
varying vec2 vUv;
uniform mat4 reflectionMatrix;
uniform sampler2D mirrorSampler;
uniform float distortK;
uniform float spread;
uniform vec3 foot;
uniform vec3 edgeColor;
void main() {
  vec4 rp = reflectionMatrix * vec4(vWorldPos, 1.0);
  if (rp.w <= 0.0) { gl_FragColor = vec4(edgeColor, 1.0); return; }
  vec2 ndc = rp.xy / rp.w;
  // выпуклость: тянем выборку шире геометрического следа (spread) и давим
  // бочкой вокруг следа — в мелкое стекло влезает широкий угол
  vec2 rel = (ndc - foot.xy) * spread;
  float r2 = dot(rel, rel);
  vec2 uv = (foot.xy + rel * (1.0 + distortK * r2)) * 0.5 + 0.5;
  // клемп вместо отбрасывания: даже при неточном следе зеркало покажет
  // растянутое изображение, а не чёрный провал
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  gl_FragColor = vec4(texture2D(mirrorSampler, uv).rgb, 1.0);
}
`;

const MIRROR_BACK = new BABYLON.Vector3(0, 0, 1);   // локально назад
const MIRROR_FWD = new BABYLON.Vector3(0, 0, -1);   // локально вперёд
const MIRROR_NONE = [];
const _mA = BABYLON.Matrix.Identity();
const _mB = BABYLON.Matrix.Identity();
const _refl = BABYLON.Matrix.Identity();
const _v0 = new BABYLON.Vector3();
const _v1 = new BABYLON.Vector3();
const _v2 = new BABYLON.Vector3();
const _cr = new BABYLON.Vector3();
const _pt = new BABYLON.Vector3();
const _fuv = new BABYLON.Vector3();
const _nm = new BABYLON.Vector3();

function mirrorRes() {
  return MIRROR_RES;
}

// матрица меша в системе кузова: инверсия корня умножена на мирную матрицу
// меша. Результат кладём в _mB — отдельный объект, иначе Matrix.multiplyToRef
// испортит сам себя.
function toCarSpace(invRoot, mesh) {
  mesh.computeWorldMatrix(true);
  _mA.copyFrom(invRoot);
  _mA.multiplyToRef(mesh.getWorldMatrix(), _mB);
  return _mB;
}

function fillAabb(mesh, wm, box) {
  const bb = mesh.getBoundingInfo().boundingBox;
  for (let i = 0; i < 8; i++) {
    BABYLON.Vector3.TransformCoordinatesToRef(bb.vectors[i], wm, _v0);
    if (_v0.x < box.x[0]) box.x[0] = _v0.x;
    if (_v0.x > box.x[1]) box.x[1] = _v0.x;
    if (_v0.y < box.y[0]) box.y[0] = _v0.y;
    if (_v0.y > box.y[1]) box.y[1] = _v0.y;
    if (_v0.z < box.z[0]) box.z[0] = _v0.z;
    if (_v0.z > box.z[1]) box.z[1] = _v0.z;
  }
  return box;
}

function resetAabb(box) {
  box.x[0] = box.y[0] = box.z[0] = 1e9;
  box.x[1] = box.y[1] = box.z[1] = -1e9;
  return box;
}

// нормаль пластины по порядку обхода треугольников: у зеркала это точнее
// среднего по вершинам, потому что вершины там сглажены с рамкой.
function plateNormal(mesh) {
  const pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
  const idx = mesh.getIndices();
  const n = new BABYLON.Vector3();
  if (!pos || pos.length < 9) return null;
  const get = (i, out) => {
    out.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    return BABYLON.Vector3.TransformCoordinates(out, _mB);
  };
  if (idx && idx.length >= 3) {
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = get(idx[t], _v0), b = get(idx[t + 1], _v1), c = get(idx[t + 2], _v2);
      b.subtractToRef(a, _v0);
      c.subtractToRef(a, _v1);
      BABYLON.Vector3.CrossToRef(_v0, _v1, _cr);
      n.addInPlace(_cr);
    }
  } else {
    const nrm = mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind);
    if (!nrm) return null;
    for (let i = 0; i < pos.length; i += 3) n.addInPlace(new BABYLON.Vector3(nrm[i], nrm[i + 1], nrm[i + 2]));
  }
  const len = n.length();
  if (len < 1e-7) return null;
  n.scaleInPlace(1 / len);
  return { n, area: len / 2 };
}

// Стекло ищем геометрией, а не именем: в auto/car.glb это примитив 6
// передней двери (материал siyah.001 общий с дверью, имя у примитива
// не зеркальное). Признаки: маленькая плоская пластина, смотрит назад,
// висит сбоку в передней половине кузова на высоте двери.
function findMirrorPlates(root, meshes) {
  const invRoot = BABYLON.Matrix.Invert(root.getWorldMatrix());
  const body = resetAabb({ x: [0, 0], y: [0, 0], z: [0, 0] });
  const box = { x: [0, 0], y: [0, 0], z: [0, 0] };
  for (const m of meshes) {
    fillAabb(m, toCarSpace(invRoot, m), body);
  }
  const hw = Math.max(Math.abs(body.x[0]), Math.abs(body.x[1]));
  const h = body.y[1] - body.y[0], l = body.z[1] - body.z[0];
  if (!(hw > 0.3) || !(h > 0.3) || !(l > 1)) return [];

  const found = { "-1": null, "1": null };
  for (const m of meshes) {
    resetAabb(box);
    fillAabb(m, toCarSpace(invRoot, m), box);
    const cx = (box.x[0] + box.x[1]) / 2, cy = (box.y[0] + box.y[1]) / 2, cz = (box.z[0] + box.z[1]) / 2;
    if (Math.abs(cx) < hw * 0.72) continue;                       // не сбоку
    if (cy < body.y[0] + h * 0.12 || cy > body.y[0] + h * 0.88) continue;
    if (cz > body.z[0] + l * 0.5 || cz < body.z[0] + l * 0.04) continue;
    if (box.x[1] - box.x[0] > 0.6 || box.y[1] - box.y[0] > 0.6 || box.z[1] - box.z[0] > 0.6) continue;

    const plate = plateNormal(m);
    if (!plate || plate.area < 0.004 || plate.area > 0.25) continue;
    if (Math.abs(BABYLON.Vector3.Dot(plate.n, MIRROR_BACK)) < 0.7) continue;

    // плоскость: среднеквадратичное расстояние вершин до неё. У настоящего
    // стекла 0.001 м, у любой кривой детали кузова — сантиметры.
    const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const idx = m.getIndices();
    const count = pos.length / 3;
    const c = BABYLON.Vector3.Zero();
    for (let i = 0; i < count; i++) {
      _v0.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      c.addInPlace(BABYLON.Vector3.TransformCoordinates(_v0, _mB));
    }
    c.scaleInPlace(1 / count);
    let acc = 0;
    for (let i = 0; i < count; i++) {
      _v0.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      BABYLON.Vector3.TransformCoordinatesToRef(_v0, _mB, _v1);
      _v1.subtractInPlace(c);
      const d = BABYLON.Vector3.Dot(_v1, plate.n);
      acc += d * d;
    }
    if (Math.sqrt(acc / count) > 0.006) continue;

    const side = cx < 0 ? "-1" : "1";
    if (!found[side] || found[side].area < plate.area) found[side] = { mesh: m, normal: plate.n, center: c, area: plate.area };
  }
  return [found["-1"], found["1"]].filter(Boolean);
}

// список мешей для RTT. Пересобираем на месте и только когда сцена изменилась:
// присваивание нового массива заставляет RTT помечать submesh как
// загрязнённые, а это лишняя пересборка шейдеров.
function refreshMirrorList(force) {
  if (!mirrorEntries.length) return;
  const all = scene.meshes;
  if (!force && all.length === mirrorListed) return;
  mirrorListed = all.length;
  if (!mirrorList) {
    mirrorList = [];
    for (const e of mirrorEntries) e.tex.renderList = mirrorList;
  }
  mirrorList.length = 0;
  for (const m of all) {
    if (mirrorPlates.has(m)) continue;   // стекло в своё отражение не рисуем
    if (mirrorNearMeshes && mirrorNearMeshes.has(m)) continue;  // корпус зеркала
    mirrorList.push(m);
  }
}

function setMirrorsActive(on) {
  const want = !!on && mirrorEntries.length > 0;
  if (want === mirrorActive) return;
  mirrorActive = want;
  if (!mirrorActive) { mirrorAdjOn = false; mirrorHudShow(); }
  if (mirrorActive) refreshMirrorList(true);
  for (const e of mirrorEntries) {
    if (mirrorActive) {
      e.mesh.material = e.mat;
      // цвет вершин стекла в glTF задан чёрным — с ним отражение гаснет
      e.mesh.useVertexColors = false;
      e.mesh.isVisible = true;
      // setGlassOff гасит всё с «glass» в имени: наше стекло из салона
      // видеть обязано
      if (Array.isArray(glassOff)) {
        const i = glassOff.indexOf(e.mesh);
        if (i >= 0) glassOff.splice(i, 1);
      }
      e.tex.renderList = mirrorList;
    } else {
      e.mesh.material = e.srcMat;
      e.mesh.useVertexColors = e.srcVC;
      e.tex.renderList = MIRROR_NONE;   // пустой список: RTT только чистит кадр
    }
  }
}

function tickMirrors() {
  if (!mirrorActive || !mirrorEntries.length) return;
  const cock = (typeof cockpit !== "undefined") ? cockpit : null;
  if (!cock) return;
  const root = CAR.root;
  // матрица корня пересчитывается при отрисовке, а мы читаем её до scene.render()
  root.computeWorldMatrix(true);
  const wm = root.getWorldMatrix();
  // позиция и взгляд водителя в мире: камера салона смотрит вдоль локальной
  // +Z (поворот на π разворачивает её на нос кузова — см. drive())
  cock.computeWorldMatrix(true);
  const cwm = cock.getWorldMatrix();
  BABYLON.Vector3.TransformCoordinatesToRef(BABYLON.Vector3.Zero(), cwm, _v0);
  for (const e of mirrorEntries) {
    // точка стекла со сдвигом наружу от центра авто (в системе кузова +X —
    // левый борт): так захват шире и рамка меньше лезет в кадр
    _cr.copyFrom(e.center);
    _cr.x += (e.center.x < 0 ? MIRROR_GLASS_OUT : -MIRROR_GLASS_OUT);
    BABYLON.Vector3.TransformCoordinatesToRef(_cr, wm, _pt);
    // базовую нормаль доворачиваем в системе кузова напрямую: yaw — вокруг
    // вертикали, pitch — вокруг поперечной оси зеркала. Та же математика,
    // что была у плоского зеркала, — регулировка стрелками ведёт себя так же.
    const y = e.yaw, p = e.pitch;
    const b = e.baseNormal;
    const cosY = Math.cos(y), sinY = Math.sin(y);
    let nx = b.x * cosY + b.z * sinY;
    let nz = -b.x * sinY + b.z * cosY;
    const cosP = Math.cos(p), sinP = Math.sin(p);
    const ny = b.y * cosP - nz * sinP;
    nz = b.y * sinP + nz * cosP;
    _nm.set(nx, ny, nz);
    _nm.normalize();
    BABYLON.Vector3.TransformNormalToRef(_nm, wm, _nm);
    _nm.normalize();
    // падающий луч: водитель → стекло; отражённый — от стекла в мир.
    // Камера стоит на продолжении отражённого луча ЗА стеклом (со стороны
    // водителя, кузов из рендера исключён) и смотрит точно в центр стекла:
    // след стекла всегда в центре кадра, вырождения проекции нет, а лучи
    // сквозь проём стекла честно долетают до мира позади машины.
    // Центральный тексель — точное отражение, остальное давит бочка.
    _v1.copyFrom(_pt);
    _v1.subtractInPlace(_v0);
    _v1.normalize();
    _v2.copyFrom(_v1);
    _v2.addInPlace(_nm.scale(-2 * BABYLON.Vector3.Dot(_v1, _nm)));
    e.cam.position.copyFrom(_pt);
    e.cam.position.addInPlace(_v2.scale(-MIRROR_CAM_OFFSET));
    // обзор — напрямую через rotation, как у камеры салона: setTarget здесь
    // не даёт верной матрицы вида. _v2 — направление взгляда (единичное).
    e.cam.rotation.set(
      Math.atan2(-_v2.y, Math.hypot(_v2.x, _v2.z)),
      Math.atan2(_v2.x, _v2.z), 0);
    // матрица проекции для шейдера — ровно та, которой отрендерится RTT,
    // поэтому рассинхрона между текстурой и развёрткой нет по построению.
    // Порядок как у движка (view.multiply(projection)): A.multiply(B) в
    // Babylon даёт применение B после A.
    e.cam.getViewMatrix().multiplyToRef(e.cam.getProjectionMatrix(), _refl);
    e.m4.copyFrom(_refl);
    e.mat.setMatrix("reflectionMatrix", e.m4);
    // след центра стекла в NDC — центр бочки
    BABYLON.Vector3.TransformCoordinatesToRef(_pt, _refl, _fuv);
    e.fv.copyFrom(_fuv);
    e.mat.setVector3("foot", e.fv);
  }
  refreshMirrorList(false);
}

// ── регулировка направления зеркал ────────────────────────────────────
// M — включить режим, стрелки — доворот выбранного зеркала,
// L/R — выбрать левое/правое, K — сбросить. Работает в режиме «салон».
const MIRROR_YAW_MIN = -0.6, MIRROR_YAW_MAX = 0.6;
const MIRROR_PITCH_MIN = -0.35, MIRROR_PITCH_MAX = 0.35;

let mirrorHud = null;
function mirrorHudEl() {
  if (!mirrorHud) {
    // в index.html уже есть штатный #mirrorhud — используем его, а не клон
    mirrorHud = document.getElementById("mirrorhud");
    if (!mirrorHud) {
      mirrorHud = document.createElement("div");
      mirrorHud.id = "mirrorhud";
      mirrorHud.hidden = true;
      document.body.appendChild(mirrorHud);
    }
  }
  return mirrorHud;
}

function mirrorHudShow() {
  const el = mirrorHudEl();
  if (!mirrorAdjActive()) { el.hidden = true; return; }
  const e = mirrorEntries[mirrorAdjSide] || mirrorEntries[0];
  if (!e) { el.hidden = true; return; }
  el.hidden = false;
  const side = e.side === "left" ? "левое" : "правое";
  const y = (e.yaw / Math.PI * 180).toFixed(1), p = (e.pitch / Math.PI * 180).toFixed(1);
  el.textContent = "зеркало " + side + " (" + e.side + ") " +
    "· ← → " + y + "° · ↑ ↓ " + p + "° · L/R — выбор · K — сброс";
}

function mirrorAdjActive() {
  return mirrorActive && mirrorAdjOn && mirrorEntries.length > 0;
}

function mirrorAdjToggle() {
  if (!mirrorActive || !mirrorEntries.length) { mirrorAdjOn = false; mirrorHudShow(); return; }
  mirrorAdjOn = !mirrorAdjOn;
  mirrorHudShow();
}

function mirrorAdjPick(side) {
  for (let i = 0; i < mirrorEntries.length; i++) {
    if (mirrorEntries[i].side === side) { mirrorAdjSide = i; break; }
  }
  mirrorHudShow();
}

function mirrorAdjStep(dx, dy) {
  const e = mirrorEntries[mirrorAdjSide] || mirrorEntries[0];
  if (!e) return;
  // держим углы на сетке шага: накопление двоичной погрешности иначе
  // даёт 0.4999° вместо ровных 0.5° и ломает совпадение с HUD
  const snap = (v, lim) => {
    const n = Math.round(v / MIRROR_ADJ) * MIRROR_ADJ;
    return Math.min(lim[1], Math.max(lim[0], n));
  };
  e.yaw = snap(e.yaw + dx * MIRROR_ADJ, [MIRROR_YAW_MIN, MIRROR_YAW_MAX]);
  e.pitch = snap(e.pitch + dy * MIRROR_ADJ, [MIRROR_PITCH_MIN, MIRROR_PITCH_MAX]);
  mirrorHudShow();
}

function mirrorAdjReset() {
  const e = mirrorEntries[mirrorAdjSide] || mirrorEntries[0];
  if (!e) return;
  // сброс возвращает не нули, а штатную настройку этого зеркала
  const d = mirrorDefault(e.side);
  e.yaw = d.yaw;
  e.pitch = d.pitch;
  mirrorHudShow();
}

function setupMirrors(opts) {
  if (mirrorEntries.length) return;
  const root = opts.root;
  const plates = findMirrorPlates(root, opts.meshes);
  if (!plates.length) {
    console.warn("mirror.js: зеркала в модели не найдены");
    return;
  }
  mirrorPlates = new Set();
  const sides = ["left", "right"];
  plates.forEach((p, i) => {
    // широкоугольная камера зеркала: почти в точке стекла, смотрит вдоль
    // отражённого луча (цель уточняется каждый кадр в tickMirrors)
    const cam = new BABYLON.UniversalCamera("mirrorCam_" + sides[i], BABYLON.Vector3.Zero(), scene);
    cam.fov = MIRROR_FOV;
    cam.minZ = 0.1;
    cam.maxZ = 300;

    const tex = new BABYLON.RenderTargetTexture("mirrorTex_" + sides[i], mirrorRes(), scene, true);
    tex.activeCamera = cam;
    tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.samplingMode = BABYLON.Texture.TRILINEAR_SAMPLINGMODE;
    tex.anisotropicFilteringLevel = MIRROR_ANISO;
    tex.clearColor = new BABYLON.Color4(0.55, 0.72, 0.94, 1);
    tex.renderList = MIRROR_NONE;
    // нормаль обязана смотреть НА водителя (в глаза): разворачиваем знаковый
    // результат геометрического поиска по направлению на камеру салона.
    // Положение камеры салона — локальное (ребёнок корня), как и центр стекла.
    const n = p.normal.scale(-1);
    const eyeLocal = (typeof cockpit !== "undefined" && cockpit) ? cockpit.position : null;
    if (eyeLocal) {
      _v0.copyFrom(eyeLocal);
      _v0.subtractInPlace(p.center);
      if (BABYLON.Vector3.Dot(n, _v0) < 0) n.scaleInPlace(-1);
    } else if (BABYLON.Vector3.Dot(n, MIRROR_FWD) < 0) n.scaleInPlace(-1);

    const mat = new BABYLON.ShaderMaterial("mirrorMat_" + sides[i], scene,
      { vertex: "convexMirror", fragment: "convexMirror" },
      {
        attributes: ["position", "uv"],
        uniforms: ["world", "worldViewProjection", "reflectionMatrix", "distortK", "spread", "foot", "edgeColor"],
        samplers: ["mirrorSampler"],
      });
    mat.setTexture("mirrorSampler", tex);
    mat.setFloat("distortK", MIRROR_DISTORT_K);
    mat.setFloat("spread", MIRROR_SPREAD);
    mat.setVector3("foot", BABYLON.Vector3.Zero());
    mat.setColor3("edgeColor", new BABYLON.Color3(0.02, 0.02, 0.03));
    // стекло модели одностороннее и смотрит назад, поэтому в салоне мы видим
    // его изнанку — шейдер обязан рисоваться с обеих сторон
    mat.backFaceCulling = false;

    mirrorPlates.add(p.mesh);
    const side = p.center.x < 0 ? "right" : "left";
    const entry = {
      mesh: p.mesh, tex, mat, cam,
      srcMat: p.mesh.material, srcVC: p.mesh.useVertexColors,
      side,
      center: p.center.clone(), baseNormal: n.clone(),
      // свои объекты под uniform-ы: общие темпы на всех записях приводили к
      // тому, что оба зеркала семплировали по матрице последнего (левого)
      m4: new BABYLON.Matrix(), fv: new BABYLON.Vector3(),
      yaw: mirrorDefault(side).yaw, pitch: mirrorDefault(side).pitch,
    };
    // страховка регистрации RTT: если движок сам её не подхватил,
    // без этого текстура никогда не рендерится
    if (scene.customRenderTargets.indexOf(tex) < 0) scene.customRenderTargets.push(tex);
    mirrorEntries.push(entry);
  });
  // Вырезаем ровно те детали, что перекрывают обзор: из номинальной точки
  // камеры трассируем сетку лучей через зону стекла; всё своё, во что упёрлись
  // в пределах полметра за стеклом, — из отражений вон (корпус зеркала,
  // кромка двери вокруг стекла). Остальное железо и мир остаются видимыми.
  mirrorNearMeshes = new Set();
  {
    const carSet = new Set(opts.meshes);
    const cock2 = (typeof cockpit !== "undefined" && cockpit) ? cockpit : null;
    if (cock2) {
      root.computeWorldMatrix(true);
      const rwm = root.getWorldMatrix();
      cock2.computeWorldMatrix(true);
      const cwm2 = cock2.getWorldMatrix();
      for (const m of carSet) m.computeWorldMatrix(true);
      const eyeW = BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.Zero(), cwm2);
      const upW = new BABYLON.Vector3(0, 1, 0);
      for (const e of mirrorEntries) {
        const gw = BABYLON.Vector3.TransformCoordinates(e.center, rwm);
        // та же математика, что в tickMirrors: нормаль с доворотом,
        // отражённый луч, точка камеры
        const y = e.yaw, p = e.pitch, b = e.baseNormal;
        const cosY = Math.cos(y), sinY = Math.sin(y);
        let nx = b.x * cosY + b.z * sinY, nz = -b.x * sinY + b.z * cosY;
        const cosP = Math.cos(p), sinP = Math.sin(p);
        const nw = new BABYLON.Vector3(nx, b.y * cosP - nz * sinP, b.y * sinP + nz * cosP);
        nw.normalize();
        BABYLON.Vector3.TransformNormalToRef(nw, rwm, nw);
        nw.normalize();
        const din = gw.subtract(eyeW);
        din.normalize();
        const dout = din.add(nw.scale(-2 * BABYLON.Vector3.Dot(din, nw)));
        const campos = gw.add(dout.scale(-MIRROR_CAM_OFFSET));
        const cg = BABYLON.Vector3.Distance(campos, gw);
        // базис в плоскости стекла для сетки лучей
        const lat = BABYLON.Vector3.Cross(dout, upW);
        if (lat.lengthSquared() < 1e-6) lat.set(1, 0, 0);
        lat.normalize();
        const ver = BABYLON.Vector3.Cross(lat, dout);
        ver.normalize();
        const offs = [[0, 0]];
        for (let k = 0; k < 4; k++) {
          const a = k / 4 * Math.PI * 2;
          offs.push([Math.cos(a) * 0.03, Math.sin(a) * 0.03]);
        }
        for (const [oa, ob] of offs) {
          const tgt = gw.add(lat.scale(oa)).add(ver.scale(ob));
          const dir = tgt.subtract(campos);
          dir.normalize();
          const ray = new BABYLON.Ray(campos.clone(), dir.clone(), cg + 0.6);
          const hits = scene.multiPickWithRay(ray, () => true) || [];
          for (const h of hits) {
            const m = h.pickedMesh;
            if (m && carSet.has(m) && !mirrorPlates.has(m) && h.distance < cg + 0.6)
              mirrorNearMeshes.add(m);
          }
        }
      }
    }
  }
  refreshMirrorList(true);
  setMirrorsActive(CAR.mode === 1);
}

function disposeMirrors() {
  for (const e of mirrorEntries) {
    e.mesh.material = e.srcMat;
    e.mesh.useVertexColors = e.srcVC;
    e.mat.dispose();
    e.tex.dispose();
    e.cam.dispose();
  }
  mirrorEntries = [];
  mirrorPlates = null;
  mirrorNearMeshes = null;
  mirrorList = null;
  mirrorListed = -1;
  mirrorActive = false;
}

// ── крутилки из окна зеркал (index.html) ────────────────────────────────
// Значения для подписи в окне.
function mirrorTunables() {
  return {
    res: MIRROR_RES,
    fovDeg: Math.round(MIRROR_FOV * 180 / Math.PI),
    distortK: MIRROR_DISTORT_K,
    spread: MIRROR_SPREAD,
    camOffset: MIRROR_CAM_OFFSET,
  };
}
// Применить FOV/бочку/разлёт/вынос ко всем зеркалам (кадр подхватит сам).
function applyMirrorTunables() {
  for (const e of mirrorEntries) {
    e.cam.fov = MIRROR_FOV;
    e.mat.setFloat("distortK", MIRROR_DISTORT_K);
    e.mat.setFloat("spread", MIRROR_SPREAD);
  }
}
function setMirrorFovDeg(deg) {
  MIRROR_FOV = deg * Math.PI / 180;
  applyMirrorTunables();
}
function setMirrorDistortK(k) {
  MIRROR_DISTORT_K = k;
  applyMirrorTunables();
}
function setMirrorSpread(s) {
  MIRROR_SPREAD = s;
  applyMirrorTunables();
}
function setMirrorCamOffset(m) {
  MIRROR_CAM_OFFSET = m;   // tick читает переменную каждый кадр
}
// Разрешение: текстуру проще пересоздать, чем тянуть. Состояние зеркал
// (вкл/выкл, список мешей) сохраняется.
function setMirrorRes(res) {
  res = Math.max(64, Math.round(res));
  if (res === MIRROR_RES) return;
  MIRROR_RES = res;
  for (const e of mirrorEntries) {
    const old = e.tex;
    const tex = new BABYLON.RenderTargetTexture(old.name, mirrorRes(), scene, true);
    tex.activeCamera = e.cam;
    tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.samplingMode = BABYLON.Texture.TRILINEAR_SAMPLINGMODE;
    tex.anisotropicFilteringLevel = MIRROR_ANISO;
    tex.clearColor = new BABYLON.Color4(0.55, 0.72, 0.94, 1);
    tex.renderList = mirrorActive ? (mirrorList || MIRROR_NONE) : MIRROR_NONE;
    if (scene.customRenderTargets.indexOf(tex) < 0) scene.customRenderTargets.push(tex);
    e.tex = tex;
    e.mat.setTexture("mirrorSampler", tex);
    try { old.dispose(); } catch (err) {}
  }
  refreshMirrorList(true);
}

mirrorTick = tickMirrors;
