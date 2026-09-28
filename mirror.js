// ── боковые зеркала: настоящее отражение сцены ─────────────────────────
// Схема как в simulator2: у каждого стекла своя MirrorTexture, плоскость
// зеркала пересчитывается каждый кадр из положения кузова, в список
// отрисовки идут все меши сцены, кроме самих стёкол.
//
// Отличие от референса одно и обязательное: нормаль плоскости смотрит
// в сторону водителя, а не назад. Babylon при отрисовке зеркала режет
// сцену плоскостью clipPlane и выкидывает фрагменты, у которых
// dot(n, p) + d > 0, то есть оставляет ту половину, куда нормаль НЕ
// смотрит. Отражённая камера видит именно эту половину, поэтому
// нормаль должна быть развёрнута к водителю — с «назад» зеркало пустое.
//
// Подключается после editor.js, работает на глобалах index.html:
//   setupMirrors({ root, meshes }) — один раз после загрузки модели
//   setMirrorsActive(on)          — вкл/выкл из applyCamMode
//   mirrorTick()                  — каждый кадр перед scene.render()

const MIRROR_RES = 2048;       // сторона RTT: запас, чтобы зеркало не мылилось
const MIRROR_LEVEL = 0.92;      // стекло чуть гасит отражение
const MIRROR_ANISO = 16;        // фильтрация при взгляде на зеркало под углом
const MIRROR_ADJ_DEG = 0.5;    // шаг регулировки зеркала, градусы за нажатие
const MIRROR_ADJ = MIRROR_ADJ_DEG * Math.PI / 180;   // то же в радианах

let mirrorEntries = [];   // { mesh, tex, mat, srcMat, srcVC, point, normal, baseNormal, yaw, pitch }
let mirrorPlates = null;  // Set мешей-стёкол: их нельзя рисовать в самом RTT
let mirrorList = null;    // общий список мешей для RTT
let mirrorListed = -1;    // сколько мешей было в сцене на прошлой сборке
let mirrorActive = false;
let mirrorAdjOn = false;  // режим регулировки направления зеркал
let mirrorAdjSide = 0;    // выбранное зеркало (индекс в mirrorEntries)

const MIRROR_BACK = new BABYLON.Vector3(0, 0, 1);   // локально назад
const MIRROR_FWD = new BABYLON.Vector3(0, 0, -1);   // локально вперёд
const MIRROR_NONE = [];
const _mA = BABYLON.Matrix.Identity();
const _mB = BABYLON.Matrix.Identity();
const _v0 = new BABYLON.Vector3();
const _v1 = new BABYLON.Vector3();
const _v2 = new BABYLON.Vector3();
const _cr = new BABYLON.Vector3();
const _pt = new BABYLON.Vector3();
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
  const root = CAR.root;
  // матрица корня пересчитывается при отрисовке, а мы читаем её до scene.render()
  root.computeWorldMatrix(true);
  const wm = root.getWorldMatrix();
  for (const e of mirrorEntries) {
    BABYLON.Vector3.TransformCoordinatesToRef(e.center, wm, _pt);
    // базовую нормаль доворачиваем в системе кузова напрямую: yaw — вокруг
    // вертикали, pitch — вокруг поперечной оси зеркала (TransformNormalToRef
    // с кватернионом в Babylon 9 падает — крутим вручную)
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
    BABYLON.Plane.FromPositionAndNormalToRef(_pt, _nm, e.tex.mirrorPlane);
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
    mirrorHud = document.createElement("div");
    mirrorHud.id = "mirrorhud";
    mirrorHud.hidden = true;
    const cam = document.getElementById("cam");
    if (cam) cam.after(mirrorHud);
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
  e.yaw = 0;
  e.pitch = 0;
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
  const res = mirrorRes();
  const sides = ["left", "right"];
  plates.forEach((p, i) => {
    const tex = new BABYLON.MirrorTexture("mirrorTex_" + sides[i], res, scene, true);
    // RenderTargetTexture по умолчанию PROJECTION_MODE: в шейдере координаты
    // фрагмента считаются как reflectionMatrix * (view * worldPos), то есть
    // ровно тот texel, куда этот фрагмент попал в отражённую камеру.
    tex.coordinatesMode = BABYLON.Texture.PROJECTION_MODE;
    tex.level = MIRROR_LEVEL;
    tex.anisotropicFilteringLevel = MIRROR_ANISO;
    tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    tex.samplingMode = BABYLON.Texture.TRILINEAR_SAMPLINGMODE;
    tex.clearColor = new BABYLON.Color4(0.02, 0.02, 0.03, 1);
    tex.renderList = MIRROR_NONE;
    // плоскость сразу с нормалью к водителю: так она и будет жить дальше
    const n = p.normal.scale(-1);
    if (BABYLON.Vector3.Dot(n, MIRROR_FWD) < 0) n.scaleInPlace(-1);
    tex.mirrorPlane = BABYLON.Plane.FromPositionAndNormal(p.center, n);

    const mat = new BABYLON.StandardMaterial("mirrorMat_" + sides[i], scene);
    mat.reflectionTexture = tex;
    mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor = new BABYLON.Color3(0.01, 0.01, 0.012);
    mat.disableLighting = true;
    // стекло модели одностороннее и смотрит назад, поэтому в салоне мы видим
    // его изнанку — без двусторонности зеркала просто не было бы видно
    mat.backFaceCulling = false;

    mirrorPlates.add(p.mesh);
    mirrorEntries.push({
      mesh: p.mesh, tex, mat,
      srcMat: p.mesh.material, srcVC: p.mesh.useVertexColors,
      side: p.center.x < 0 ? "right" : "left",
      center: p.center.clone(), baseNormal: n.clone(),
      yaw: 0, pitch: 0,
    });
  });
  refreshMirrorList(true);
  setMirrorsActive(CAR.mode === 1);
}

function disposeMirrors() {
  for (const e of mirrorEntries) {
    e.mesh.material = e.srcMat;
    e.mesh.useVertexColors = e.srcVC;
    e.mat.dispose();
    e.tex.dispose();
  }
  mirrorEntries = [];
  mirrorPlates = null;
  mirrorList = null;
  mirrorListed = -1;
  mirrorActive = false;
}

mirrorTick = tickMirrors;
