/*
 * editor.js — модуль редактирования площадки.
 *
 * Подключается классическим <script> ПОСЛЕ основного inline-скрипта index.html.
 * Классические скрипты делят глобальную лексическую область, поэтому отсюда видны
 * scene, engine, BABYLON, canvas, cam, shadow, CAR, ground, GROUND_SIZE, meshes,
 * clamp, applyCamMode, resetCar.
 *
 * Отличия от исходного приложения, к которым пришлось приспособиться:
 *   — машина это CAR.root, а не меш car; курс и скорость это CAR.yaw и CAR.v;
 *   — камера называется cam, генератор теней — shadow;
 *   — площадка не имеет фиксированного размера: земля едет за машиной, поэтому
 *     границы ставки считаются от точки, где машина встала при входе в правку;
 *   — высоты под колёсами и наклоны берёт не сам модуль, а хук surfaceProbe:
 *     index.html спрашивает опору под четырьмя колёсами рейкастом, поэтому эстакады
 *     работают как настоящий подъём, а не как стена.
 */

const STEP = 0.25;                              // шаг привязки, м
const MAP_HALF = GROUND_SIZE / 2 - 6;           // половина площадки: земля 320 м, отступ от края
let parkX = 0, parkZ = 0;                       // центр ставки — там, где стоит машина
const snapX = (v) => clampSnap(v, parkX - MAP_HALF, parkX + MAP_HALF);
const snapZ = (v) => clampSnap(v, parkZ - MAP_HALF, parkZ + MAP_HALF);
const cellKey = (x, z) => x.toFixed(2) + "," + z.toFixed(2);
const est = (id) => document.getElementById(id);
const clampSnap = (v, a, b) => Math.max(a, Math.min(b, Math.round(v / STEP) * STEP));

const countEl = est("count");
const hintline = est("hintline");
const finishLineBtn = est("finishLineBtn");
const editTypeSel = null;                        // тип выбирается галереей, селекта нет

// габариты машины для проверки попаданий: модель Renault Symbol
const CAR_HALF_W = 0.88, CAR_HALF_L = 2.05;

// ── конусы ────────────────────────────────────────────────────────────
const coneNodes = [];
const occupied = new Set();
const matBase = new BABYLON.StandardMaterial("coneBase", scene);
matBase.diffuseColor = new BABYLON.Color3(0.85, 0.26, 0.08);
matBase.specularColor = new BABYLON.Color3(0, 0, 0);
const matBody = new BABYLON.StandardMaterial("coneBody", scene);
matBody.diffuseColor = new BABYLON.Color3(1, 0.43, 0);
matBody.specularColor = new BABYLON.Color3(0, 0, 0);
const matStripe = new BABYLON.StandardMaterial("coneStripe", scene);
matStripe.diffuseColor = new BABYLON.Color3(1, 1, 1);
matStripe.specularColor = new BABYLON.Color3(0, 0, 0);

function createCone() {
  const node = new BABYLON.TransformNode("cone", scene);
  node.rotationQuaternion = BABYLON.Quaternion.Identity();
  const base = BABYLON.MeshBuilder.CreateBox("coneBaseM", { width:0.25, depth:0.25, height:0.035 }, scene);
  base.parent = node; base.position.y = 0.0175; base.material = matBase; base.metadata = { isCone:true };
  const body = BABYLON.MeshBuilder.CreateCylinder("coneBodyM",
    { diameterTop:0.04, diameterBottom:0.19, height:0.45, tessellation:24 }, scene);
  body.parent = node; body.position.y = 0.26; body.material = matBody; body.metadata = { isCone:true };
  const stripe = BABYLON.MeshBuilder.CreateCylinder("coneStripeM",
    { diameterTop:0.10, diameterBottom:0.14, height:0.11, tessellation:24 }, scene);
  stripe.parent = node; stripe.position.y = 0.255; stripe.material = matStripe; stripe.metadata = { isCone:true };
  for (const m of [base, body, stripe]) shadow.addShadowCaster(m);
  coneNodes.push(node);
  return node;
}

function addConeAt(x, z) {
  const k = cellKey(x, z);
  if (occupied.has(k)) return null;
  occupied.add(k);
  const n = createCone();
  // конус стоит на опоре: если под ним эстакада, поднимаем на её высоту
  n.position.set(x, surfaceHeight(x, z), z);
  n.userData = { cellKey:k, knocked:false };
  updateCount();
  saveCones();
  return n;
}

function deleteCone(n) {
  occupied.delete(n.userData.cellKey);
  n.getChildMeshes().forEach((m) => shadow.removeShadowCaster(m));
  const i = coneNodes.indexOf(n);
  if (i >= 0) coneNodes.splice(i, 1);
  n.dispose();
  updateCount();
  saveCones();
}

function clearCones() { [...coneNodes].forEach(deleteCone); }
function updateCount() { countEl.textContent = coneNodes.length; }

// ── сохранение конусов в localStorage ─────────────────────────────────
const STORE_CONES = "gta4_editor_cones";
function saveCones() {
  try {
    localStorage.setItem(STORE_CONES, JSON.stringify(coneNodes.map((n) => [
      Math.round(n.position.x * 1e4) / 1e4, Math.round(n.position.z * 1e4) / 1e4,
    ])));
  } catch (e) {}
}
function loadCones() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_CONES) || "[]");
    if (Array.isArray(data)) {
      for (const p of data) {
        if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") addConeAt(p[0], p[1]);
      }
    }
  } catch (e) {}
}

// ── линии: разметка, бордюр, забор, эстакада ──────────────────────────
const DRAW_TYPES = ["lines", "curb", "fence", "estacada"];
const LINE_KEY = { lines:"gta4_map_lines", curb:"gta4_map_curbs", fence:"gta4_map_fences", estacada:"gta4_map_estacadas" };
const LINE_WIDTH = { lines:0.1, curb:0.25, fence:0.05 };
const LINE_H = { lines:0.006, curb:0.30, fence:1.7 };
const LINE_Y = { lines:0.0042, curb:0.15, fence:0.85 };
const EST_SLOPE = 0.16, EST_L2 = 5, EST_W = 4, FENCE_STEP = 3.2, EST_MAX_H = 3.2;
let drawSeq = 0;

const countLinesEl = est("countLines"), countCurbEl = est("countCurb");
const countFenceEl = est("countFence"), countEstacadaEl = est("countEstacada");
const FINISH_LABELS = {
  lines:"Завершить линию", curb:"Завершить бордюр",
  fence:"Завершить забор", estacada:"Завершить эстакаду",
};

const matLine = new BABYLON.StandardMaterial("lineMat", scene);
matLine.diffuseColor = new BABYLON.Color3(1, 1, 1);
matLine.specularColor = new BABYLON.Color3(0.15, 0.15, 0.15);
const matCurb = new BABYLON.StandardMaterial("curbMat", scene);
matCurb.diffuseColor = new BABYLON.Color3(1, 1, 1);
matCurb.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
const matPost = new BABYLON.StandardMaterial("postMat", scene);
matPost.diffuseColor = new BABYLON.Color3(0.42, 0.46, 0.5);
matPost.specularColor = new BABYLON.Color3(0.4, 0.4, 0.42);
matPost.specularPower = 64;
const matRail = new BABYLON.StandardMaterial("railMat", scene);
matRail.diffuseColor = new BABYLON.Color3(0.88, 0.9, 0.92);
matRail.specularColor = new BABYLON.Color3(0.5, 0.5, 0.5);
matRail.specularPower = 128;

const matRamp = new BABYLON.StandardMaterial("rampMat", scene);
matRamp.specularColor = new BABYLON.Color3(0.06, 0.06, 0.08);
matRamp.specularPower = 16;
matRamp.backFaceCulling = false;
const rampTex = new BABYLON.DynamicTexture("rampTex", { width:256, height:256 }, scene, true);
{
  const t = rampTex.getContext();
  t.fillStyle = "rgb(62,62,64)";
  t.fillRect(0, 0, 256, 256);
  // зерно крупными блоками: однопиксельный шум съедается мипмаппингом
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, v = 64 + (Math.random() * 26 - 13);
    t.fillStyle = "rgb(" + (v | 0) + "," + (v | 0) + "," + (v | 0) + ")";
    t.fillRect(x, y, 2, 2);
  }
  for (let i = 0; i < 110; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 1.5 + Math.random() * 4;
    const v = 66 + (Math.random() * 22 - 11);
    t.fillStyle = "rgba(" + (v | 0) + "," + (v | 0) + "," + (v | 0) + ",0.4)";
    t.beginPath(); t.arc(x, y, r, 0, Math.PI * 2); t.fill();
  }
  for (let i = 0; i < 20; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const l = 12 + Math.random() * 34, a = Math.random() * Math.PI;
    t.strokeStyle = "rgba(18,18,18,0.35)";
    t.lineWidth = 1;
    t.beginPath(); t.moveTo(x, y); t.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); t.stroke();
  }
  rampTex.update();
  // DynamicTexture по умолчанию CLAMP — без WRAP текстура не повторяется по длине
  rampTex.wrapU = rampTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
}
matRamp.diffuseTexture = rampTex;

const matRampPrev = new BABYLON.StandardMaterial("rampPrevMat", scene);
matRampPrev.diffuseColor = new BABYLON.Color3(0.8, 0.9, 1);
matRampPrev.alpha = 0.5;
matRampPrev.specularColor = new BABYLON.Color3(0, 0, 0);
matRampPrev.backFaceCulling = false;
const matSegPrev = new BABYLON.StandardMaterial("segPrevMat", scene);
matSegPrev.diffuseColor = new BABYLON.Color3(1, 1, 1);
matSegPrev.alpha = 0.55;
matSegPrev.specularColor = new BABYLON.Color3(0, 0, 0);

const previewSeg = BABYLON.MeshBuilder.CreateBox("linePrev", { width:1, height:1, depth:1 }, scene);
previewSeg.material = matSegPrev;
previewSeg.isVisible = false;
previewSeg.isPickable = false;

const drawStore = {};
for (const t of DRAW_TYPES) drawStore[t] = { polys:[], groups:[] };
let openLine = null;
let rampPreviewGroup = null;
const segRotY = (dx, dz) => Math.atan2(dx, dz);

function makeFenceSegment(ax, az, dx, dz, L) {
  const n = Math.max(1, Math.round(L / FENCE_STEP));
  const g = new BABYLON.TransformNode("fenceSeg" + (drawSeq++), scene);
  const ry = segRotY(dx, dz);
  const cx = ax + dx / 2, cz = az + dz / 2;
  for (const rh of [0.8, 1.5]) {
    const rail = BABYLON.MeshBuilder.CreateBox("fenceRail" + (drawSeq++),
      { width:0.06, height:0.06, depth:L }, scene);
    rail.parent = g;
    rail.position.set(cx, rh, cz);
    rail.rotation.y = ry;
    rail.isPickable = true;
    rail.receiveShadows = true;
    rail.material = matRail;
    rail.metadata = { isLine:true, stype:"fence", group:g };
  }
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const post = BABYLON.MeshBuilder.CreateBox("fencePost" + (drawSeq++),
      { width:0.08, height:1.7, depth:0.08 }, scene);
    post.parent = g;
    post.position.set(ax + dx * t, 0.85, az + dz * t);
    post.isPickable = true;
    post.receiveShadows = true;
    post.material = matPost;
    post.metadata = { isLine:true, stype:"fence", group:g };
  }
  g.position.set(0, 0, 0);
  return g;
}

// Эстакада: подъём EST_SLOPE, вершина длиной L2, спуск. Вершина — рабочая поверхность,
// поэтому меч помечен isSurface и участвует в рейкастах опоры из index.html.
function buildRampMesh(D, h, name, L2) {
  L2 = L2 === undefined ? EST_L2 : L2;
  const hw = EST_W / 2, yb = -0.08, L = D + L2 + D;
  const pos = [
    hw,0,0,      hw,h,D,       hw,h,D+L2,  hw,0,L,    hw,yb,L,   hw,yb,0,
    -hw,0,0,     -hw,h,D,      -hw,h,D+L2, -hw,0,L,   -hw,yb,L,  -hw,yb,0,
  ];
  const idx = [
    0,1,7, 0,7,6,   1,2,8, 1,8,7,   2,3,9, 2,9,8,
    3,4,10, 3,10,9, 4,5,11, 4,11,10, 5,0,6, 5,6,11,
    0,1,2, 0,2,3, 0,3,4, 0,4,5,   6,11,10, 6,10,9, 6,9,8, 6,8,7,
  ];
  const m = new BABYLON.Mesh(name, scene);
  const vd = new BABYLON.VertexData();
  vd.positions = pos;
  vd.indices = idx;
  const norms = new Float32Array(pos.length);
  BABYLON.VertexData.ComputeNormals(pos, idx, norms);
  vd.normals = norms;
  const uvs = [];
  for (let i = 0; i < pos.length; i += 3) uvs.push(pos[i + 2] * 0.5, pos[i] * 0.5 + 0.5);
  vd.uvs = uvs;
  vd.applyToMesh(m);
  return m;
}

function buildRampCurbs(g, sides, D, L2, h) {
  for (const sx of sides) {
    const mk = (z1, z2, y1, y2) => {
      const Ls = Math.hypot(z2 - z1, y2 - y1) || 0.05;
      const curb = BABYLON.MeshBuilder.CreateBox("rampCurb" + (drawSeq++),
        { width:0.24, height:0.4, depth:Ls + 0.08 }, scene);
      const py = (z2 - z1) / Ls, pz = -(y2 - y1) / Ls;
      curb.parent = g;
      curb.position.set(sx, (y1 + y2) / 2 + py * 0.2, (z1 + z2) / 2 + pz * 0.2);
      curb.rotation.x = Math.atan2(-(y2 - y1), z2 - z1);
      curb.material = matCurb;
      curb.isPickable = false;
      curb.receiveShadows = true;
      curb.metadata = { isLine:true, stype:"estacada", group:g };
    };
    mk(-0.06, D + 0.06, 0, h);
    mk(D - 0.06, D + L2 + 0.06, h, h);
    mk(D + L2 - 0.06, D + L2 + D + 0.06, h, 0);
  }
}

function makeRampSegment(ax, az, dx, dz, D, h) {
  const g = new BABYLON.TransformNode("rampSeg" + (drawSeq++), scene);
  const poly = buildRampMesh(D, h, "rampSurface" + (drawSeq++));
  poly.parent = g;
  poly.material = matRamp;
  poly.isPickable = true;
  poly.receiveShadows = true;
  poly.metadata = { isLine:true, stype:"estacada", group:g, isSurface:true };
  buildRampCurbs(g, [-EST_W / 2 + 0.12, EST_W / 2 - 0.12], D, EST_L2, h);
  g.position.set(ax, 0, az);
  g.rotation.y = segRotY(dx, dz);
  return g;
}

function makeLineSegment(type, a, b) {
  const ax = a[0], az = a[1], bx = b[0], bz = b[1];
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < 1e-4) return null;
  if (type === "fence") return makeFenceSegment(ax, az, dx, dz, L);
  if (type === "estacada") return makeRampSegment(ax, az, dx, dz, L, Math.min(L * EST_SLOPE, 3.2));
  const w = LINE_WIDTH[type], h = LINE_H[type], y = LINE_Y[type];
  const seg = BABYLON.MeshBuilder.CreateBox("drawSeg" + (drawSeq++), { width:w, height:h, depth:L }, scene);
  seg.position.set((ax + bx) / 2, y, (az + bz) / 2);
  seg.rotation.y = segRotY(dx, dz);
  seg.material = type === "curb" ? matCurb : matLine;
  seg.isPickable = true;
  seg.receiveShadows = true;
  seg.metadata = { isLine:true, stype:type };
  return seg;
}

// ── ведение линии ────────────────────────────────────────────────────
function updateCounts() {
  countLinesEl.textContent = drawStore.lines.polys.length;
  countCurbEl.textContent = drawStore.curb.polys.length;
  countFenceEl.textContent = drawStore.fence.polys.length;
  countEstacadaEl.textContent = drawStore.estacada.polys.length;
}
function syncFinishBtn() {
  const show = editType !== "cones" && mode === "place" && !!openLine;
  finishLineBtn.style.display = show ? "" : "none";
  finishLineBtn.textContent = FINISH_LABELS[editType] || "Завершить";
}
const pickGround = () => scene.pick(scene.pointerX, scene.pointerY, (m) => m.name === "ground");
const pickCone = () => scene.pick(scene.pointerX, scene.pointerY, (m) => m.metadata && m.metadata.isCone);
const pickLine = () => scene.pick(scene.pointerX, scene.pointerY, (m) => m.metadata && m.metadata.isLine);

function updateLinePreview() {
  if (!openLine) return;
  if (editType === "estacada") { updateRampPreview(); return; }
  const last = openLine.pts[openLine.pts.length - 1];
  const p = last ? pickGround() : null;
  if (!p || !p.hit || !last) { previewSeg.isVisible = false; return; }
  const sx = snapX(p.pickedPoint.x), sz = snapZ(p.pickedPoint.z);
  const dx = sx - last[0], dz = sz - last[1];
  const L = Math.hypot(dx, dz);
  if (L > 1e-4) {
    previewSeg.position.set((sx + last[0]) / 2, LINE_Y[editType], (sz + last[1]) / 2);
    previewSeg.scaling.set(LINE_WIDTH[editType], LINE_H[editType], L);
    previewSeg.rotation.y = Math.atan2(dx, dz);
    previewSeg.isVisible = true;
  } else previewSeg.isVisible = false;
}
function hideLinePreview() {
  previewSeg.isVisible = false;
  if (rampPreviewGroup) { const old = rampPreviewGroup; rampPreviewGroup = null; old.dispose(); }
}
function updateRampPreview() {
  if (rampPreviewGroup) { const old = rampPreviewGroup; rampPreviewGroup = null; old.dispose(); }
  const last = openLine && openLine.pts.length ? openLine.pts[openLine.pts.length - 1] : null;
  const p = last ? pickGround() : null;
  if (!p || !p.hit) return;
  const sx = snapX(p.pickedPoint.x), sz = snapZ(p.pickedPoint.z);
  const dx = sx - last[0], dz = sz - last[1];
  const D = Math.hypot(dx, dz);
  if (D <= 1e-4) return;
  const h = Math.min(D * EST_SLOPE, 3.2);
  const g = new BABYLON.TransformNode("rampPrev" + (drawSeq++), scene);
  const poly = buildRampMesh(D, h, "rampPrevMesh" + (drawSeq++));
  poly.parent = g;
  poly.material = matRampPrev;
  poly.isPickable = false;
  g.position.set(last[0], 0, last[1]);
  g.rotation.y = segRotY(dx, dz);
  rampPreviewGroup = g;
}
function startOpenLine() { openLine = { pts:[], groups:[] }; syncFinishBtn(); }
function addLinePoint(x, z) {
  if (!openLine) startOpenLine();
  const last = openLine.pts[openLine.pts.length - 1];
  if (last && last[0] === x && last[1] === z) return;
  openLine.pts.push([x, z]);
  if (last) {
    const s = makeLineSegment(editType, last, [x, z]);
    if (s) openLine.groups.push(s);
  }
  updateLinePreview();
}
function finishLine() {
  if (!openLine) return;
  if (openLine.pts.length >= 2) {
    drawStore[editType].polys.push(openLine.pts);
    drawStore[editType].groups.push(openLine.groups);
  } else {
    for (const g of openLine.groups) { try { g.dispose(); } catch (e) {} }
  }
  openLine = null;
  hideLinePreview();
  syncFinishBtn();
  saveDraw(editType);
  updateCounts();
}
function saveDraw(type) {
  try { localStorage.setItem(LINE_KEY[type], JSON.stringify(drawStore[type].polys)); } catch (e) {}
}
function pushPolyline(type, pts) {
  const groups = [];
  for (let i = 1; i < pts.length; i++) {
    const s = makeLineSegment(type, pts[i - 1], pts[i]);
    if (s) groups.push(s);
  }
  drawStore[type].polys.push(pts);
  drawStore[type].groups.push(groups);
}
function loadDraw(type) {
  try {
    const d = JSON.parse(localStorage.getItem(LINE_KEY[type]) || "[]");
    if (Array.isArray(d)) {
      for (const poly of d) {
        if (!Array.isArray(poly)) continue;
        const pts = poly.filter((p) => Array.isArray(p) && p.length === 2 &&
          typeof p[0] === "number" && typeof p[1] === "number");
        if (pts.length >= 2) pushPolyline(type, pts);
      }
    }
    updateCounts();
  } catch (e) {}
}
function findDrawPolyline(mesh) {
  const group = mesh.metadata && mesh.metadata.group;
  for (const t of DRAW_TYPES) {
    const arr = drawStore[t].groups;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].indexOf(mesh) >= 0) return { type:t, i };
      if (group && arr[i].indexOf(group) >= 0) return { type:t, i };
    }
  }
  return null;
}
function deletePolylineFromMesh(mesh) {
  const f = findDrawPolyline(mesh);
  if (!f) return;
  for (const g of drawStore[f.type].groups[f.i]) { try { g.dispose(); } catch (e) {} }
  drawStore[f.type].groups.splice(f.i, 1);
  drawStore[f.type].polys.splice(f.i, 1);
  updateCounts();
  saveDraw(f.type);
}
function clearDraw() {
  finishLine();
  for (const t of DRAW_TYPES) {
    for (const arr of drawStore[t].groups) for (const g of arr) { try { g.dispose(); } catch (e) {} }
    drawStore[t].polys.length = 0;
    drawStore[t].groups.length = 0;
    saveDraw(t);
  }
  updateCounts();
}
finishLineBtn.addEventListener("click", finishLine);

// ── опора и препятствия для машины ───────────────────────────────────
// Луч идёт из точки над опорой: из самой точки колеса на подъёме он ушёл бы
// под эстакаду и машина провалилась. Вниз берём с запасом на спуск.
// Окно луча как в рабочем проекте: луч идёт из car.y + 2 на 6 метров вниз,
// поэтому на гребне и на стыках настила он всегда начинается выше поверхности.
// Эстакада выше 2 м над кузовом в это окно не попадает и опорой не считается.
const SURF_UP = 2, SURF_DOWN = 4;
const surfRay = new BABYLON.Ray(new BABYLON.Vector3(), new BABYLON.Vector3(0, -1, 0), SURF_UP + SURF_DOWN);
const isSurfaceMesh = (m) => m === ground || (m.metadata && m.metadata.isSurface);

// Нормаль эстакады считаем аналитически по её профилю: нормаль грани меша
// вычисляется из порядка вершин и на таком меше не совпадает с уклоном.
function rampNormalAt(x, z, hitY) {
  const hw = EST_W / 2;
  for (const poly of drawStore.estacada.polys) {
    for (let i = 0; i < poly.length - 1; i++) {
      const ax = poly[i][0], az = poly[i][1], bx = poly[i + 1][0], bz = poly[i + 1][1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-4) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const rx = x - ax, rz = z - az;
      const u = rx * ux + rz * uz, v = rx * -uz + rz * ux;
      if (v < -hw || v > hw || u < 0 || u > L + EST_L2 + L) continue;
      const h = Math.min(L * EST_SLOPE, EST_MAX_H);
      let yt, g;
      if (u <= L) { yt = u / L * h; g = h / L; }
      else if (u <= L + EST_L2) { yt = h; g = 0; }
      else { yt = h * (1 - (u - L - EST_L2) / L); g = -h / L; }
      if (Math.abs(yt - hitY) > 0.35) continue;   // луч попал в землю, а не в эстакаду
      const nx = -g * ux, nz = -g * uz, inv = 1 / Math.hypot(nx, 1, nz);
      return { nx:nx * inv, ny:inv, nz:nz * inv };
    }
  }
  return null;
}

function probeSurface(x, z, fromY) {
  surfRay.origin.set(x, fromY + SURF_UP, z);
  surfRay.direction.set(0, -1, 0);
  surfRay.length = SURF_UP + SURF_DOWN;
  const p = scene.pickWithRay(surfRay, isSurfaceMesh);
  if (!p.hit) return null;
  const y = p.pickedPoint.y;
  const r = rampNormalAt(x, z, y);
  return r ? { y, nx:r.nx, ny:r.ny, nz:r.nz } : { y, nx:0, ny:1, nz:0 };
}
function surfaceHeight(x, z) {
  const h = probeSurface(x, z, 1.5);
  return h ? Math.max(0, h.y) : 0;
}

// Бордюры, заборы и бока эстакады: машина не проходит сквозь них, но въезд
// вдоль оси эстакады пропускаем — там подъём ловит рейкаст опоры.
function carPointInBands(px, pz, y, dx, dz) {
  const list = [["curb", LINE_WIDTH.curb + 0.18], ["fence", 0.4]];
  try {
    for (const [t, hw] of list) {
      for (const poly of drawStore[t].polys) {
        for (let i = 0; i < poly.length - 1; i++) {
          const ax = poly[i][0], az = poly[i][1], bx = poly[i + 1][0], bz = poly[i + 1][1];
          const LL = Math.hypot(bx - ax, bz - az);
          if (LL < 1e-4) continue;
          const ux = (bx - ax) / LL, uz = (bz - az) / LL;
          const px2 = -uz, py2 = ux;
          const rx = px - ax, rz = pz - az;
          const u = rx * ux + rz * uz, v = rx * px2 + rz * py2;
          if (u > -hw && u < LL + hw && Math.abs(v) < hw) return true;
        }
      }
    }
    if (dx === 0 && dz === 0) return false;
    const hw = EST_W / 2, L2 = EST_L2;
    for (const p of drawStore.estacada.polys) {
      const ax = p[0][0], az = p[0][1], bx = p[1][0], bz = p[1][1];
      const LL = Math.hypot(bx - ax, bz - az);
      if (LL < 1e-4) continue;
      const ux = (bx - ax) / LL, uz = (bz - az) / LL;
      const px2 = -uz, py2 = ux;
      const rx = px - ax, rz = pz - az;
      const u = rx * ux + rz * uz, v = rx * px2 + rz * py2;
      if (u < 0 || u > LL + L2 + LL || Math.abs(v) >= hw) continue;
      const dU = dx * ux + dz * uz, dV = dx * px2 + dz * py2;
      if (Math.abs(dV) <= 2 * Math.abs(dU)) continue;   // едем вдоль оси — это въезд
      const h = Math.min(LL * EST_SLOPE, 3.2);
      let yt;
      if (u <= LL) yt = u / LL * h;
      else if (u <= LL + L2) yt = h;
      else yt = h * (1 - (u - LL - L2) / LL);
      if (yt - y > 0.05) return true;                   // поверхность выше колёс
    }
  } catch (e) {}
  return false;
}
function obstacleBlocked(x, z, y, dx, dz) {
  // пять точек кузова: четыре угла и середина переднего бампера
  const pts = [[-0.85,-2.1],[0.85,-2.1],[-0.85,2.1],[0.85,2.1],[0,2.15]];
  const c = Math.cos(CAR.yaw), s = Math.sin(CAR.yaw);
  for (const p of pts) {
    // локальные координаты кузова: +X вправо, -Z вперёд
    const wx = x + p[0] * c + p[1] * s;
    const wz = z - p[0] * s + p[1] * c;
    if (carPointInBands(wx, wz, y, dx, dz)) return true;
  }
  return false;
}

// ── конусы: удар и падение ───────────────────────────────────────────
const flying = [];
const LYING_Y = 0.12;
const carHits = (px, pz) => {
  const dx = px - CAR.root.position.x, dz = pz - CAR.root.position.z;
  const c = Math.cos(CAR.yaw), s = Math.sin(CAR.yaw);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= CAR_HALF_W && Math.abs(lz) <= CAR_HALF_L;
};
function knockCone(node, carPos) {
  const ud = node.userData;
  ud.knocked = true;
  const d = node.position.subtract(carPos);
  d.y = 0;
  const dl = d.length();
  const dir = dl < 1e-6 ? new BABYLON.Vector3(Math.sin(CAR.yaw), 0, Math.cos(CAR.yaw)) : d.scale(1 / dl);
  const sign = Math.sign(CAR.v) || 1;
  const mv = new BABYLON.Vector3(Math.sin(CAR.yaw), 0, Math.cos(CAR.yaw));
  const lat = new BABYLON.Vector3(Math.cos(CAR.yaw), 0, -Math.sin(CAR.yaw));
  const power = 1.6 + Math.abs(CAR.v) * 0.9;
  ud.vel = mv.scale(power * 0.75 * sign)
    .add(lat.scale(BABYLON.Vector3.Dot(lat, dir) * power))
    .add(new BABYLON.Vector3(0, power * 0.6 + Math.random() * 0.3, 0));
  ud.ang = Math.random() * Math.PI * 2;
  ud.spin = (Math.random() * 8 + 5) * (Math.random() < 0.5 ? 1 : -1);
  node.position.y = surfaceHeight(node.position.x, node.position.z) + 0.4;
  flying.push(node);
}
function landCone(n) {
  n.userData.vel = null;
  const ra = Math.random() * Math.PI * 2;
  n.rotationQuaternion = BABYLON.Quaternion.RotationAxis(
    new BABYLON.Vector3(Math.cos(ra), 0, Math.sin(ra)), Math.PI / 2 * (0.9 + Math.random() * 0.2));
  n.position.y = surfaceHeight(n.position.x, n.position.z) + LYING_Y;
}
function updateFlights(dt) {
  for (let i = flying.length - 1; i >= 0; i--) {
    const n = flying[i], ud = n.userData;
    if (!ud || !ud.vel) continue;
    const v = ud.vel;
    const drag = Math.max(0, 1 - 0.9 * dt);
    v.x *= drag; v.z *= drag;
    v.y -= 9.8 * dt;
    ud.ang += ud.spin * dt;
    n.position.addInPlace(v.scale(dt));
    const hl = Math.sqrt(v.x * v.x + v.z * v.z);
    const axis = hl > 0.1 ? new BABYLON.Vector3(-v.z / hl, 0, v.x / hl) : new BABYLON.Vector3(1, 0, 0);
    n.rotationQuaternion = BABYLON.Quaternion.RotationAxis(axis, ud.ang)
      .multiply(BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, ud.ang * 0.35));
    const floor = surfaceHeight(n.position.x, n.position.z) + 0.1;
    if (n.position.y <= floor && v.y <= 0) {
      n.position.y = floor;
      if (v.y < -0.4) { v.y = -v.y * 0.35; v.x *= 0.55; v.z *= 0.55; }
      else { v.y = 0; v.x *= 0.7; v.z *= 0.7; }
      if (Math.abs(v.x) < 0.12 && Math.abs(v.z) < 0.12 && Math.abs(v.y) < 0.15) {
        landCone(n);
        flying.splice(i, 1);
      }
    }
  }
}
function checkCollisions() {
  const p = CAR.root.position;
  for (const node of coneNodes) {
    const ud = node.userData;
    if (!ud || ud.knocked || node === dragging) continue;
    if (carHits(node.position.x, node.position.z)) knockCone(node, p);
  }
}

// ── курсор и режимы ──────────────────────────────────────────────────
const preview = BABYLON.MeshBuilder.CreateTorus("conePreview",
  { diameter:0.4, thickness:0.04, tessellation:28 }, scene);
const matPreview = new BABYLON.StandardMaterial("conePreviewMat", scene);
matPreview.diffuseColor = new BABYLON.Color3(1, 0.43, 0);
matPreview.emissiveColor = new BABYLON.Color3(1, 0.43, 0);
matPreview.alpha = 0.85;
matPreview.specularColor = new BABYLON.Color3(0, 0, 0);
preview.material = matPreview;
preview.isVisible = false;
preview.isPickable = false;

let mode = "place", dragging = null, dragOldKey = null, editOn = false;
let prevCamMode = 0;

const HINTS = {
  place:"Клик по площадке — поставить конус (шаг 0,25 м)",
  move:"Зажми конус и перетащи в новый узел",
  delete:"Клик по конусу — удалить",
};
const DRAWHINTS = {
  lines:{ place:"Кликай по площадке: точки соединяются в белую линию. «Завершить линию» — начать новую",
          move:"Перемещение разметки не поддерживается", delete:"Клик по разметке — удалить" },
  curb:{ place:"Кликай по площадке: точки соединяются в бетонный бордюр",
         move:"Перемещение бордюра не поддерживается", delete:"Клик по бордюру — удалить" },
  fence:{ place:"Кликай по площадке: точки соединяются в забор",
          move:"Перемещение забора не поддерживается", delete:"Клик по забору — удалить" },
  estacada:{ place:"Первый клик — начало подъёма, второй — вершина. «Завершить» — поставить эстакаду",
             move:"Перемещение эстакады не поддерживается", delete:"Клик по эстакаде — удалить" },
};
const CURSORS = { place:"crosshair", move:"grab", delete:"pointer" };
let editType = "cones";
const typeIco = est("typeIco"), typeName = est("typeName");
const TYPE_NAMES = { cones:"Конус", lines:"Разметка", curb:"Бордюр", fence:"Забор", estacada:"Эстакада" };
const TYPE_ICONS = {
  cones:'<svg viewBox="0 0 24 24"><path d="M12 2.6 15.8 21H8.2Z" fill="#ff8c3b" stroke="#1a1200" stroke-width="1.1" stroke-linejoin="round"/><ellipse cx="12" cy="14.4" rx="2.4" ry="1.1" fill="#fff" stroke="#1a1200" stroke-width=".8"/></svg>',
  lines:'<svg viewBox="0 0 24 24"><rect x="3" y="10.3" width="4" height="1.7" rx=".85" fill="#fff"/><rect x="10" y="10.3" width="4" height="1.7" rx=".85" fill="#fff"/><rect x="17" y="10.3" width="4" height="1.7" rx=".85" fill="#fff"/></svg>',
  curb:'<svg viewBox="0 0 24 24"><rect x="2.5" y="8.6" width="19" height="5.6" rx="1.2" fill="#fff" stroke="#22303a" stroke-width="1"/><rect x="2.5" y="14.2" width="19" height="1.8" rx=".9" fill="#e8eaed" stroke="#22303a" stroke-width=".8"/></svg>',
  fence:'<svg viewBox="0 0 24 24"><rect x="14" y="5" width="2" height="16" rx=".6" fill="#6a7075" stroke="#22303a" stroke-width=".8"/><rect x="18.5" y="5" width="2" height="16" rx=".6" fill="#6a7075" stroke="#22303a" stroke-width=".8"/><rect x="3" y="7" width="17.4" height="1.8" rx=".9" fill="#f2f4f6" stroke="#22303a" stroke-width=".7"/><rect x="3" y="14" width="17.4" height="1.8" rx=".9" fill="#f2f4f6" stroke="#22303a" stroke-width=".7"/></svg>',
  estacada:'<svg viewBox="0 0 24 24"><path d="M2.8 18.5 7.5 11h9l4.7 7.5" fill="none" stroke="#9db4c4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="2.8" y1="18.5" x2="21.2" y2="18.5" stroke="#7c93a4" stroke-width="1.6"/></svg>',
};
const drawHint = (t) => DRAWHINTS[t] || DRAWHINTS.lines;

function setEditType(t) {
  if (t !== editType && editType !== "cones") finishLine();
  editType = t;
  typeIco.innerHTML = THUMBS[t] ? '<img src="' + THUMBS[t] + '" alt="">' : (TYPE_ICONS[t] || "");
  typeName.textContent = TYPE_NAMES[t] || t;
  setMode(mode);
}
function setMode(m) {
  finishLine();
  mode = m;
  for (const b of document.querySelectorAll("#editModes button")) b.classList.toggle("active", b.dataset.mode === m);
  hintline.textContent = editType === "cones" ? HINTS[mode] : drawHint(editType)[mode];
  canvas.style.cursor = CURSORS[mode];
  preview.isVisible = false;
  syncFinishBtn();
}
for (const b of document.querySelectorAll("#editModes button")) {
  b.addEventListener("click", () => { if (editOn) setMode(b.dataset.mode); });
}
est("mapClearAll").addEventListener("click", () => { clearCones(); clearDraw(); });

// ── окно «Карта»: счётчики, файл карты, очистка ─────────────────────
const mapWin = est("mapWin"), mapBackdrop = est("mapBackdrop");
function openMapWin(o) {
  mapWin.classList.toggle("open", o);
  mapBackdrop.classList.toggle("open", o);
  if (o) { openTypeWin(false); updateCount(); updateCounts(); }
}
est("mapCfgBtn").addEventListener("click", () => { if (editOn) openMapWin(true); });
est("mapCfgClose").addEventListener("click", () => openMapWin(false));
mapBackdrop.addEventListener("click", () => openMapWin(false));

// ── работа с указателем ──────────────────────────────────────────────
scene.onPointerObservable.add((pi) => {
  const t = pi.type;
  if (!editOn) return;
  if (t === BABYLON.PointerEventTypes.POINTERMOVE) {
    const p = pickGround();
    if (p.hit) {
      const sx = snapX(p.pickedPoint.x), sz = snapZ(p.pickedPoint.z);
      const y = surfaceHeight(sx, sz);
      preview.position.set(sx, y + 0.05, sz);
      preview.isVisible = mode === "place" || !!dragging;
      if (dragging) {
        dragging.position.set(sx, y, sz);
        dragging.rotationQuaternion = BABYLON.Quaternion.Identity();
        dragging.userData.knocked = false;
      }
      if (editType !== "cones" && mode === "place") updateLinePreview();
      else hideLinePreview();
    } else {
      preview.isVisible = false;
      hideLinePreview();
    }
  } else if (t === BABYLON.PointerEventTypes.POINTERDOWN) {
    if (mode !== "move") return;
    const c = pickCone();
    if (!c.hit) return;
    dragging = c.pickedMesh.parent;
    const ud = dragging.userData;
    const fi = flying.indexOf(dragging);
    if (fi >= 0) flying.splice(fi, 1);
    ud.vel = null;
    dragging.rotationQuaternion = BABYLON.Quaternion.Identity();
    ud.knocked = false;
    dragOldKey = ud.cellKey;
    occupied.delete(dragOldKey);
    // на время перетаскивания отдаём мышь перетаскиванию, а не облёту камеры
    editGrab = true;
    cam.detachControl();
    canvas.style.cursor = "grabbing";
  } else if (t === BABYLON.PointerEventTypes.POINTERUP) {
    if (!dragging) { editGrab = false; return; }
    const x = snapX(dragging.position.x), z = snapZ(dragging.position.z);
    const k = cellKey(x, z);
    const ud = dragging.userData;
    if (occupied.has(k)) {
      const pr = dragOldKey.split(",").map(Number);
      dragging.position.set(pr[0], surfaceHeight(pr[0], pr[1]), pr[1]);
      occupied.add(dragOldKey);
      ud.cellKey = dragOldKey;
    } else {
      dragging.position.set(x, surfaceHeight(x, z), z);
      occupied.add(k);
      ud.cellKey = k;
    }
    updateCount();
    saveCones();
    dragging = null;
    dragOldKey = null;
    editGrab = false;
    cam.attachControl(canvas, true);
    canvas.style.cursor = CURSORS[mode];
  } else if (t === BABYLON.PointerEventTypes.POINTERTAP) {
    if (dragging) return;
    if (mode === "delete") {
      const c = pickCone();
      if (c.hit) deleteCone(c.pickedMesh.parent);
      else {
        const l = pickLine();
        if (l.hit) deletePolylineFromMesh(l.pickedMesh);
      }
    } else if (mode === "place") {
      const p = pickGround();
      if (p.hit) {
        const px = snapX(p.pickedPoint.x), pz = snapZ(p.pickedPoint.z);
        if (editType !== "cones") addLinePoint(px, pz);
        else addConeAt(px, pz);
      }
    }
  }
});

// ── джойстик панорамирования камеры ──────────────────────────────────
const PAN_SPEED = 34;
const panState = { x:0, z:0 };
const joyBase = est("joyBase"), joyKnob = est("joyKnob");
const JOY_R = 30, JOY_RM = 33;
let joyActive = false, joyId = -1;
function joySet(px, py) {
  const r = joyBase.getBoundingClientRect();
  let dx = (px - (r.left + r.width / 2)) / JOY_RM;
  let dy = (py - (r.top + r.height / 2)) / JOY_RM;
  const L = Math.hypot(dx, dy);
  if (L > 1) { dx /= L; dy /= L; }
  panState.x = dx;
  panState.z = -dy;
  joyKnob.style.transform = "translate(calc(-50% + " + dx * JOY_R + "px),calc(-50% + " + dy * JOY_R + "px))";
}
function joyReset() {
  panState.x = 0; panState.z = 0;
  joyActive = false; joyId = -1;
  joyKnob.style.transform = "translate(-50%,-50%)";
  joyBase.classList.remove("on");
}
joyBase.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  joyBase.setPointerCapture(e.pointerId);
  joyActive = true; joyId = e.pointerId;
  joyBase.classList.add("on");
  joySet(e.clientX, e.clientY);
});
joyBase.addEventListener("pointermove", (e) => { if (joyActive && e.pointerId === joyId) joySet(e.clientX, e.clientY); });
joyBase.addEventListener("pointerup", (e) => { if (e.pointerId === joyId) joyReset(); });
joyBase.addEventListener("pointercancel", (e) => { if (e.pointerId === joyId) joyReset(); });
addEventListener("blur", joyReset);

function panApply(dt) {
  if (!panState.x && !panState.z) return;
  const d = cam.position.subtract(cam.target);
  const f = new BABYLON.Vector3(d.x, 0, d.z);
  if (f.lengthSquared() < 1e-9) f.set(0, 0, -1);
  f.normalize();
  const right = BABYLON.Vector3.Cross(BABYLON.Axis.Y, f).normalize();
  cam.target.addInPlace(right.scale(-panState.x * PAN_SPEED * dt).add(f.scale(-panState.z * PAN_SPEED * dt)));
  cam.target.x = clamp(cam.target.x, parkX - MAP_HALF, parkX + MAP_HALF);
  cam.target.z = clamp(cam.target.z, parkZ - MAP_HALF, parkZ + MAP_HALF);
}

// ── сетка и оси внутри площадки (как в первом приложении) ───────────
// Линии CreateLineSystem с шагом 0.5 м плюс оси через центр. Сетка
// центрируется там, где машина встала (parkX/parkZ), а не по мировому
// нулю: площадка привязана к месту стоянки. Живёт в мировых координатах
// и не едет за машиной, поэтому пересобирается только при входе в правку.
let gridMesh = null, gridAxes = null;
function gridLines(step, half, cx, cz, y) {
  const lines = [];
  for (let i = -half; i <= half + 1e-6; i += step) {
    lines.push([new BABYLON.Vector3(cx + i, y, cz - half), new BABYLON.Vector3(cx + i, y, cz + half)]);
  }
  for (let i = -half; i <= half + 1e-6; i += step) {
    lines.push([new BABYLON.Vector3(cx - half, y, cz + i), new BABYLON.Vector3(cx + half, y, cz + i)]);
  }
  return lines;
}
function buildGridAxes() {
  const vis = gridMesh ? gridMesh.isVisible : false;
  if (gridMesh) { gridMesh.dispose(); gridMesh = null; }
  if (gridAxes) { gridAxes.dispose(); gridAxes = null; }
  const h = MAP_HALF;
  gridMesh = BABYLON.MeshBuilder.CreateLineSystem("grid", { lines: gridLines(0.5, h, parkX, parkZ, 0.01) }, scene);
  gridMesh.color = new BABYLON.Color3(0.30, 0.30, 0.30);
  gridMesh.isPickable = false;
  gridMesh.isVisible = vis;
  gridAxes = BABYLON.MeshBuilder.CreateLineSystem("axes", { lines: [
    [new BABYLON.Vector3(parkX, 0.02, parkZ - h), new BABYLON.Vector3(parkX, 0.02, parkZ + h)],
    [new BABYLON.Vector3(parkX - h, 0.02, parkZ), new BABYLON.Vector3(parkX + h, 0.02, parkZ)],
  ]}, scene);
  gridAxes.color = new BABYLON.Color3(0.55, 0.55, 0.55);
  gridAxes.isPickable = false;
  gridAxes.isVisible = vis;
}
function setGridVisible(o) {
  if (gridMesh) gridMesh.isVisible = !!o;
  if (gridAxes) gridAxes.isVisible = !!o;
}

// ── вход и выход из режима правки ────────────────────────────────────
function openEdit(o) {
  if (o === editOn) return;
  if (typeof openSettings === "function") openSettings(false);
  editOn = o;
  editingMap = o;
  document.body.classList.toggle("edit-mode", o);
  est("mapEdit").classList.toggle("open", o);
  est("mapBtn").classList.toggle("on", o);
  if (!o) { openMapWin(false); openTypeWin(false); }
  if (o) {
    finishLine();
    const p = CAR.root.position;
    parkX = p.x; parkZ = p.z;
    CAR.v = 0; CAR.vy = 0;
    // площадка неподвижна: земля и сетка перестают ехать за машиной
    ground.position.x = p.x;
    ground.position.z = p.z;
    groundTex.uOffset = p.x / TILE;
    groundTex.vOffset = p.z / TILE;
    buildGridAxes();                      // сетка центрируется по месту стоянки
    setGridVisible(true);                 // сетка нужна только при правке
    prevCamMode = CAR.mode;
    CAR.mode = 2;                       // свободная камера: мышь орбитит и зумит
    applyCamMode();
    scene.skipPointerMovePicking = false;   // превью идёт за курсором
    cam.target.set(p.x, p.y + 0.75, p.z);
    cam.radius = Math.max(cam.radius, 16);
    editorTick = tickEdit;
    setMode(mode);
  } else {
    finishLine();
    hideLinePreview();
    preview.isVisible = false;
    setGridVisible(false);                // вернулись в езду — сетка не нужна
    editorTick = null;
    scene.skipPointerMovePicking = true;
    canvas.style.cursor = "";
    joyReset();
    if (dragging) { dragging = null; dragOldKey = null; editGrab = false; }
    cam.attachControl(canvas, true);
    cam.target.set(CAR.root.position.x, CAR.root.position.y + 0.75, CAR.root.position.z);
    CAR.mode = prevCamMode;
    applyCamMode();
  }
}
est("mapBtn").addEventListener("click", () => openEdit(true));

est("mapDone").addEventListener("click", () => openEdit(false));

// пока идёт правка, машина стоит: едем только объекты и превью
function tickEdit(dt) {
  panApply(dt);
  updateFlights(dt);
}
function tickWorld(dt) {
  updateFlights(dt);
  checkCollisions();
}

// ── горячие клавиши редактора ────────────────────────────────────────
const EDIT_KEYS = new Set(["Digit1", "Digit2", "Digit3", "KeyT"]);
addEventListener("keydown", (e) => {
  if (e.target && e.target.tagName === "INPUT") return;
  if (!editOn) {
    if (EDIT_KEYS.has(e.code)) e.preventDefault();
    return;
  }
  if (EDIT_KEYS.has(e.code)) {
    e.preventDefault();
    if (e.code === "Digit1") setMode("place");
    else if (e.code === "Digit2") setMode("move");
    else if (e.code === "Digit3") setMode("delete");
    else {
      const order = ["cones", "lines", "curb", "fence", "estacada"];
      setEditType(order[(order.indexOf(editType) + 1) % order.length]);
    }
  } else if (e.code === "KeyC" && !e.repeat) {
    e.preventDefault();
    clearCones();
  } else if (e.code === "Escape") {
    openMapWin(false);
    openTypeWin(false);
  }
});

// ── окно-галерея объектов ────────────────────────────────────────────
const typeWin = est("typeWin"), typeBackdrop = est("typeBackdrop");
function openTypeWin(o) {
  typeWin.classList.toggle("open", o);
  typeBackdrop.classList.toggle("open", o);
}
est("editTypeBtn").addEventListener("click", () => { if (editOn) openTypeWin(true); });
est("typeClose").addEventListener("click", () => openTypeWin(false));
typeBackdrop.addEventListener("click", () => openTypeWin(false));
for (const c of document.querySelectorAll("#typeWin .tg-card")) {
  c.addEventListener("click", () => {
    if (!editOn) return;
    setEditType(c.dataset.type);
    openTypeWin(false);
  });
}

// ── статичные 3D-превью типов объектов ───────────────────────────────
// Кадр рендерится через CreateScreenshotUsingRenderTargetAsync в отдельном слое:
// основная камера этот слой не видит, поэтому превью не мелькают в сцене.
const THUMBS = { cones:null, lines:null, curb:null, fence:null, estacada:null };
const THUMB_SIZE = 256, THUMB_MASK = 0x20000000, THUMB_K = 2.1;
const previewFrame = (type) => ({
  a: (type === "fence" || type === "curb") ? Math.PI / 2 : Math.PI / 4,
  b: type === "cones" ? 1.3 : type === "fence" ? 1.42 : type === "lines" ? 1 : 1.15,
});
function buildTypedPreview(type, parent) {
  const n = new BABYLON.TransformNode("thumb" + (++drawSeq), scene);
  const plain = (name, c) => {
    const m = new BABYLON.StandardMaterial("tm" + name + type, scene);
    m.diffuseColor = new BABYLON.Color3(c[0], c[1], c[2]);
    m.specularColor = new BABYLON.Color3(0.12, 0.12, 0.12);
    return m;
  };
  if (type === "cones") {
    const base = BABYLON.MeshBuilder.CreateBox("tb", { width:0.25, depth:0.25, height:0.035 }, scene);
    base.parent = n; base.position.y = 0.0175; base.material = plain("b", [0.82, 0.24, 0.07]);
    const body = BABYLON.MeshBuilder.CreateCylinder("tc",
      { diameterTop:0.04, diameterBottom:0.19, height:0.45, tessellation:24 }, scene);
    body.parent = n; body.position.y = 0.26; body.material = plain("c", [1, 0.43, 0]);
    const st = BABYLON.MeshBuilder.CreateCylinder("ts",
      { diameterTop:0.10, diameterBottom:0.14, height:0.11, tessellation:24 }, scene);
    st.parent = n; st.position.y = 0.255; st.material = plain("s", [1, 1, 1]);
  } else if (type === "lines") {
    const m = BABYLON.MeshBuilder.CreateBox("tl", { width:0.22, height:0.02, depth:0.8 }, scene);
    m.parent = n; m.position.y = 0.01; m.material = plain("l", [1, 1, 1]);
  } else if (type === "curb") {
    const m = BABYLON.MeshBuilder.CreateBox("tcu", { width:0.25, height:0.30, depth:0.9 }, scene);
    m.parent = n; m.position.y = 0.15; m.material = plain("cu", [1, 1, 1]);
  } else if (type === "fence") {
    for (const rh of [0.8, 1.5]) {
      const rail = BABYLON.MeshBuilder.CreateBox("tfr", { width:1.6, height:0.06, depth:0.06 }, scene);
      rail.parent = n; rail.position.y = rh; rail.material = plain("fr", [0.88, 0.9, 0.92]);
    }
    for (const x of [-0.8, 0.8]) {
      const post = BABYLON.MeshBuilder.CreateBox("tfp", { width:0.08, height:1.7, depth:0.08 }, scene);
      post.parent = n; post.position.set(x, 0.85, 0); post.material = plain("fp", [0.42, 0.46, 0.5]);
    }
  } else if (type === "estacada") {
    const p = buildRampMesh(1.4, 0.22, "testacada" + (drawSeq++), 1.2);
    p.parent = n;
    p.material = matRamp;
    buildRampCurbs(n, [-EST_W / 2 + 0.12, EST_W / 2 - 0.12], 1.4, 1.2, 0.22);
  }
  n.parent = parent;
  return n;
}
async function captureThumb(type) {
  const F = previewFrame(type);
  const root = new BABYLON.TransformNode("thumbRoot" + type, scene);
  root.position.set(-9999, 0, 0);
  const gm = new BABYLON.StandardMaterial("thumbGround" + type, scene);
  gm.diffuseColor = new BABYLON.Color3(0.17, 0.18, 0.21);
  gm.specularColor = new BABYLON.Color3(0, 0, 0);
  const g = BABYLON.MeshBuilder.CreateGround("thumbG" + type, { width:14, height:14 }, scene);
  g.parent = root;
  g.material = gm;
  buildTypedPreview(type, root);
  for (const m of root.getChildMeshes()) editorMeshes.add(m);
  try {
    const kids = root.getChildMeshes();
    for (const m of kids) { m.computeWorldMatrix(true); m.layerMask = THUMB_MASK; }
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const m of kids) {
      if (/^thumbG/.test(m.name)) continue;
      m.refreshBoundingInfo();
      const b = m.getBoundingInfo().boundingBox;
      const mn = b.minimumWorld, mx = b.maximumWorld;
      lo[0] = Math.min(lo[0], mn.x); lo[1] = Math.min(lo[1], mn.y); lo[2] = Math.min(lo[2], mn.z);
      hi[0] = Math.max(hi[0], mx.x); hi[1] = Math.max(hi[1], mx.y); hi[2] = Math.max(hi[2], mx.z);
    }
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const thCam = new BABYLON.ArcRotateCamera("thCam" + type, F.a, F.b, Math.max(size * THUMB_K, 0.4),
      new BABYLON.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2), scene);
    thCam.layerMask = THUMB_MASK;
    thCam.minZ = 0.01;
    thCam.maxZ = size * 60 + 100;
    const png = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(engine, thCam, THUMB_SIZE, "image/png", 4);
    THUMBS[type] = png.slice(0, 5) === "data:" ? png : "data:image/png;base64," + png;
    thCam.dispose();
  } catch (e) {
    // превью — украшение: если рендер не удался, остаётся векторная иконка
  }
  root.dispose();
}
function applyThumbs() {
  const fill = (el, type) => { if (el && THUMBS[type]) el.innerHTML = '<img src="' + THUMBS[type] + '" alt="">'; };
  fill(typeIco, editType);
  for (const c of document.querySelectorAll("#typeWin .tg-card")) fill(c.querySelector(".tg-fallback"), c.dataset.type);
}
requestAnimationFrame(() => requestAnimationFrame(async () => {
  for (const t of ["cones", "lines", "curb", "fence", "estacada"]) await captureThumb(t);
  applyThumbs();
}));

// ── карта в JSON-файл ────────────────────────────────────────────────
const MAP_FORMAT = "gta4_map", MAP_VERSION = 1;
const mapFileInput = est("mapFileInput"), mapFileStatus = est("mapFileStatus");
const r4 = (v) => Math.round(v * 1e4) / 1e4;
function setMapFileStatus(text, err) {
  mapFileStatus.textContent = text || "";
  mapFileStatus.style.color = err ? "#e08a6a" : "#7fbf8a";
  mapFileStatus.classList.toggle("show", !!text);
}
function collectMapJson() {
  const map = {
    format: MAP_FORMAT, version: MAP_VERSION, savedAt: new Date().toISOString(),
    cones: coneNodes.map((n) => [r4(n.position.x), r4(n.position.z)]),
  };
  for (const t of DRAW_TYPES) map[t] = drawStore[t].polys.map((poly) => poly.map((p) => [r4(p[0]), r4(p[1])]));
  return map;
}
function mapFileName() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return "gta4_map_" + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    "_" + p(d.getHours()) + p(d.getMinutes()) + ".json";
}
function saveMapFile() {
  let blob;
  try { blob = new Blob([JSON.stringify(collectMapJson(), null, 2)], { type:"application/json" }); }
  catch (e) { setMapFileStatus("Не удалось сформировать файл", true); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = mapFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setMapFileStatus("Карта сохранена: " + a.download);
}
const mapNum = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
function readMapPoly(src) {
  if (!Array.isArray(src)) return null;
  const pts = [];
  for (const p of src) {
    if (!Array.isArray(p)) continue;
    const x = mapNum(p[0]), z = mapNum(p[1]);
    if (x !== null && z !== null) pts.push([r4(x), r4(z)]);
  }
  return pts.length >= 2 ? pts : null;
}
function applyMapJson(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("неверный формат файла");
  if (data.format && data.format !== MAP_FORMAT) throw new Error("это не карта площадки");
  if (!Array.isArray(data.cones) && !DRAW_TYPES.some((t) => Array.isArray(data[t]))) {
    throw new Error("в файле нет объектов карты");
  }
  clearCones();
  clearDraw();
  if (Array.isArray(data.cones)) {
    for (const c of data.cones) {
      if (!Array.isArray(c)) continue;
      const x = mapNum(c[0]), z = mapNum(c[1]);
      if (x !== null && z !== null) addConeAt(r4(x), r4(z));
    }
  }
  for (const t of DRAW_TYPES) {
    if (!Array.isArray(data[t])) continue;
    for (const poly of data[t]) {
      const pts = readMapPoly(poly);
      if (pts) pushPolyline(t, pts);
    }
  }
  updateCount();
  updateCounts();
  for (const t of DRAW_TYPES) saveDraw(t);
  saveCones();
}
function loadMapFile(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      applyMapJson(JSON.parse(String(rd.result)));
      setMapFileStatus("Карта загружена: " + file.name);
    } catch (e) {
      setMapFileStatus("Ошибка загрузки: " + (e && e.message || "повреждённый файл"), true);
    }
  };
  rd.onerror = () => setMapFileStatus("Не удалось прочитать файл", true);
  rd.readAsText(file);
}
est("mapSaveBtn").addEventListener("click", saveMapFile);
est("mapLoadBtn").addEventListener("click", () => {
  if (!mapFileInput) return;
  mapFileInput.value = "";
  mapFileInput.click();
});
mapFileInput.addEventListener("change", () => {
  const f = mapFileInput.files && mapFileInput.files[0];
  if (f) loadMapFile(f);
});

// ── учёт своих мешей ─────────────────────────────────────────────────
// index.html берёт геометрию модели по снимку сцены ДО загрузки и цепляет
// корневые узлы к корню машины. Всё, что создаёт редактор, обязано быть вне
// этого списка, иначе конусы и эстакады станут детьми машины и поедут за ней.
const editorMeshes = new Set();

// ── инициализация ────────────────────────────────────────────────────
// Хуки опоры и объектов работают всегда: эстакады, бордюры и конусы остаются
// на карте после выхода из правки и продолжают держать машину при езде.
hintline.textContent = "Режим редактирования площадки выключен";
surfaceProbe = probeSurface;
obstacleProbe = obstacleBlocked;
objectTick = tickWorld;
setEditType("cones");
loadCones();
for (const t of DRAW_TYPES) loadDraw(t);
updateCount();
updateCounts();
for (const m of scene.meshes) editorMeshes.add(m);
