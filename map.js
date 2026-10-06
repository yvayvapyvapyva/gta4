/*
 * map.js — рантайм карты площадки (без редактирования).
 *
 * Подключается классическим <script> ПОСЛЕ основного inline-скрипта.
 * Классические скрипты делят глобальную лексическую область, поэтому отсюда видны
 * scene, BABYLON, ground, GROUND_SIZE, CAR, clamp.
 *
 * Здесь только: построение конусов/линий/бордюров/заборов/эстакад,
 * опора и препятствия для машины, касание конусов (звук+тост без сбивания),
 * сериализация карты
 * (collectMapJson / applyMapJson) и загрузка DEFAULT_MAP.
 * Никакого UI редактирования, сетки, превью и сохранения в файл тут нет —
 * всё это живёт в независимом приложении editor.html.
 */

const STEP = 0.25;                               // шаг привязки объектов, м
const MAP_HALF = GROUND_SIZE / 2;                // половина площадки: вся земля 400 м
const snapAxis = (v, c) => c + Math.round((v - c) / STEP) * STEP;
const clampSnap = (v, a, b, c) => Math.max(a, Math.min(b, snapAxis(v, c)));
const snapX = (v) => clampSnap(v, -MAP_HALF, MAP_HALF, 0);
const snapZ = (v) => clampSnap(v, -MAP_HALF, MAP_HALF, 0);
const cellKey = (x, z) => x.toFixed(2) + "," + z.toFixed(2);

// ── конусы ────────────────────────────────────────────────────────────
const CONE_TYPES = ["cones", "coneHigh"];
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

function createCone(high) {
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
  if (high) {
    node.scaling.y = 2;
  }
  coneNodes.push(node);
  return node;
}

function addConeAt(x, z, high) {
  const k = cellKey(x, z);
  if (occupied.has(k)) return null;
  occupied.add(k);
  const n = createCone(high);
  // конус стоит на опоре: если под ним эстакада, поднимаем на её высоту
  n.position.set(x, surfaceHeight(x, z), z);
  n.userData = { cellKey:k, knocked:false, high:!!high };
  freezeCone(n);   // статика: матрицы и баундинги больше не пересчитываются
  updateCount();
  return n;
}

function deleteCone(n) {
  if (!n || !n.userData) return;
  occupied.delete(n.userData.cellKey);
  const i = coneNodes.indexOf(n);
  if (i >= 0) coneNodes.splice(i, 1);
  unfreezeCone(n);
  n.dispose();
  updateCount();
}

function clearCones() { [...coneNodes].forEach(deleteCone); }
// Счётчик в DOM есть только в редакторе; в игре — тихий no-op.
function updateCount() {
  const el = document.getElementById("count");
  if (el) el.textContent = coneNodes.length;
}

// ── линии: разметка, бордюр, забор, эстакада ──────────────────────────
const DRAW_TYPES = ["lines", "curb", "fence", "estacada"];
const LINE_WIDTH = { lines:0.1, curb:0.25, fence:0.05 };
const LINE_H = { lines:0.006, curb:0.30, fence:1.7 };
const LINE_Y = { lines:0.01, curb:0.16, fence:0.85 };
const EST_SLOPE = 0.16, EST_L2 = 5, EST_W = 7.5, FENCE_STEP = 3.2, EST_MAX_H = 3.2;
// На какую высоту машина способна въехать на полотно эстакады, м.
const EST_CLIMB_STEP = 0.3;
let drawSeq = 0;

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
  rampTex.wrapU = rampTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
}
matRamp.diffuseTexture = rampTex;

const drawStore = {};
for (const t of DRAW_TYPES) drawStore[t] = { polys:[], groups:[] };
const segRotY = (dx, dz) => Math.atan2(dx, dz);

// Статика навсегда: земля, разметка, бордюры, заборы, эстакады и конусы после
// построения не двигаются — замораживаем мировые матрицы и баундинги,
// движок пропускает их пересчёт каждый кадр. Детей кузова — не морозим (едут за ним).
// В редакторе конус на время перетаскивания размораживается (unfreezeCone),
// по отпусканию — замораживается обратно (см. editor.html).
function freezeStatic(m) {
  m.computeWorldMatrix(true);
  m.refreshBoundingInfo();
  m.freezeWorldMatrix();
  m.doNotSyncBoundingInfo = true;
  return m;
}
function unfreezeStatic(m) {
  m.unfreezeWorldMatrix();
  m.doNotSyncBoundingInfo = false;
  return m;
}
// Конус — узел с тремя Mesh-детьми: морозим именно меши, как у заборов.
function freezeCone(node) {
  if (!node) return node;
  node.computeWorldMatrix(true);
  for (const m of node.getChildMeshes(false)) freezeStatic(m);
  return node;
}
function unfreezeCone(node) {
  if (!node) return node;
  for (const m of node.getChildMeshes(false)) {
    try { unfreezeStatic(m); } catch (e) {}
  }
  return node;
}

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
    post.material = matPost;
    post.metadata = { isLine:true, stype:"fence", group:g };
  }
  g.position.set(0, 0, 0);
  for (const m of g.getChildMeshes(false)) freezeStatic(m);
  return g;
}

// Эстакада: подъём EST_SLOPE, вершина длиной L2, спуск. Вершина — рабочая поверхность.
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
  poly.metadata = { isLine:true, stype:"estacada", group:g, isSurface:true };
  buildRampCurbs(g, [-EST_W / 2 + 0.12, EST_W / 2 - 0.12], D, EST_L2, h);
  g.position.set(ax, 0, az);
  g.rotation.y = segRotY(dx, dz);
  for (const m of g.getChildMeshes(false)) freezeStatic(m);
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
  seg.metadata = { isLine:true, stype:type };
  freezeStatic(seg);
  return seg;
}

function updateCounts() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("countLines", drawStore.lines.polys.length);
  set("countCurb", drawStore.curb.polys.length);
  set("countFence", drawStore.fence.polys.length);
  set("countEstacada", drawStore.estacada.polys.length);
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
}
function clearDraw() {
  for (const t of DRAW_TYPES) {
    for (const arr of drawStore[t].groups) for (const g of arr) { try { g.dispose(); } catch (e) {} }
    drawStore[t].polys.length = 0;
    drawStore[t].groups.length = 0;
  }
  updateCounts();
}

// ── опора и препятствия для машины ───────────────────────────────────
const SURF_UP = 2, SURF_DOWN = 4;
const surfRay = new BABYLON.Ray(new BABYLON.Vector3(), new BABYLON.Vector3(0, -1, 0), SURF_UP + SURF_DOWN);
const isSurfaceMesh = (m) => m === ground || (m.metadata && m.metadata.isSurface);

// Нормаль эстакады считаем аналитически по её профилю.
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
      if (Math.abs(yt - hitY) > 0.35) continue;
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

// Высота полотна эстакады в точке (x, z) или null, если точка не над эстакадой.
function estacadaTopAt(x, z) {
  const hw = EST_W / 2;
  try {
    for (const p of drawStore.estacada.polys) {
      for (let i = 0; i < p.length - 1; i++) {
        const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
        const LL = Math.hypot(bx - ax, bz - az);
        if (LL < 1e-4) continue;
        const ux = (bx - ax) / LL, uz = (bz - az) / LL;
        const rx = x - ax, rz = z - az;
        const u = rx * ux + rz * uz, v = rx * -uz + rz * ux;
        if (Math.abs(v) >= hw || u < 0 || u > LL + EST_L2 + LL) continue;
        const h = Math.min(LL * EST_SLOPE, EST_MAX_H);
        if (u <= LL) return u / LL * h;
        if (u <= LL + EST_L2) return h;
        return h * (1 - (u - LL - EST_L2) / LL);
      }
    }
  } catch (e) {}
  return null;
}

function carRidesEstacada(x, z, y) {
  const t = estacadaTopAt(x, z);
  return t !== null && Math.abs(t - y) < 0.35;
}

// Габарит для проверки препятствий.
const OBST_MARGIN = 0.04;
const CONTACT_GAP = 0.03;
const OBST_STEP = 0.45;

// Бордюры, заборы и бока эстакады: машина не проходит сквозь них.
function carPointInBands(px, pz, y, skipEstacada) {
  const list = [["curb", LINE_WIDTH.curb / 2 + CONTACT_GAP], ["fence", 0.04 + CONTACT_GAP]];
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
    if (skipEstacada) return false;
    const hw = EST_W / 2, L2 = EST_L2;
    for (const p of drawStore.estacada.polys) {
      if (p.length < 2) continue;
      for (let si = 0; si < p.length - 1; si++) {
        const ax = p[si][0], az = p[si][1], bx = p[si + 1][0], bz = p[si + 1][1];
        const LL = Math.hypot(bx - ax, bz - az);
        if (LL < 1e-4) continue;
        const ux = (bx - ax) / LL, uz = (bz - az) / LL;
        const px2 = -uz, py2 = ux;
        const rx = px - ax, rz = pz - az;
        const u = rx * ux + rz * uz, v = rx * px2 + rz * py2;
        if (u < 0 || u > LL + L2 + LL || Math.abs(v) >= hw) continue;
        const h = Math.min(LL * EST_SLOPE, 3.2);
        let yt;
        if (u <= LL) yt = u / LL * h;
        else if (u <= LL + L2) yt = h;
        else yt = h * (1 - (u - LL - L2) / LL);
        if (yt - y > EST_CLIMB_STEP) return true;
      }
    }
  } catch (e) {}
  return false;
}

function bodyProbePoints() {
  if (typeof CAR === "undefined" || !CAR) return [[0, 0]];
  const hw = CAR.halfW + OBST_MARGIN, hl = CAR.halfL + OBST_MARGIN;
  const cx = CAR.bodyCx, cz = CAR.bodyCz;
  const nx = Math.max(2, Math.ceil((2 * hw) / OBST_STEP));
  const nz = Math.max(2, Math.ceil((2 * hl) / OBST_STEP));
  const out = [];
  for (let i = 0; i <= nx; i++) {
    const lx = cx - hw + (2 * hw * i) / nx;
    out.push([lx, cz - hl], [lx, cz + hl]);
  }
  for (let j = 1; j < nz; j++) {
    const lz = cz - hl + (2 * hl * j) / nz;
    out.push([cx - hw, lz], [cx + hw, lz]);
  }
  return out;
}

function obstacleBlocked(x, z, y) {
  if (typeof CAR === "undefined" || !CAR || !CAR.root) return false;
  const pts = bodyProbePoints();
  const c = Math.cos(CAR.yaw), s = Math.sin(CAR.yaw);
  const skipEst = carRidesEstacada(x, z, y);
  for (const p of pts) {
    const wx = x + p[0] * c - p[1] * s;
    const wz = z + p[0] * s + p[1] * c;
    if (carPointInBands(wx, wz, y, skipEst)) return true;
  }
  // Конусы — твёрдые: прямоугольник кузова в точке (x,z) против круга конуса.
  // Важно: проверяем КАНДИДАТ (будущую позицию), а звук пищит по ФАКТУ.
  // Если кандидат упёрся, движение отменяется и факт никогда не войдёт
  // в прямоугольник — поэтому здесь только взводим флаг, а пищит tickWorld.
  // Если факт уже внутри (проскочили на прошлом кадре) — выпускаем:
  // блокируем только движение вглубь, а выход наружу и скольжение разрешаем.
  // Иначе любое малое движение остаётся внутри и машина «приклеивается».
  try {
    const cx = CAR.root.position.x, cz = CAR.root.position.z;
    for (const node of coneNodes) {
      if (!coneLevelMatches(node, y)) continue;
      const cand = coneDepthAt(x, z, node.position.x, node.position.z);
      if (cand <= 0) continue;
      const cur = coneDepthAt(cx, cz, node.position.x, node.position.z);
      if (cur > 0 && cand <= cur + 1e-9) continue;   // наружу/вдоль — выпускаем
      coneHitPending = true;
      return true;
    }
  } catch (e) {}
  return false;
}

// ── конусы: твёрдые несбиваемые препятствия ──────────────────────────
// Конусы больше не сбиваются и не летают: это статичные столбики,
// сквозь которые машина не проходит. При касании — только звук и тост,
// без изменения позиции конуса.
const flying = [];   // совместимость с editor.html (раньше тут летели сбитые)
const CONE_Y_TOL = 0.6;     // перепад высот, выше которого конус не задевает (эстакада)
let lastConeHitAt = 0;
let coneHitPending = false;   // взводится в obstacleBlocked (кандидат упёрся), гасится в tickWorld
const CONE_HIT_COOLDOWN = 1500;   // мс между повторами звука/тоста при упоре в конус
const carHits = (px, pz) => {
  if (typeof CAR === "undefined" || !CAR || !CAR.root) return false;
  return coneBlockedAt(CAR.root.position.x, CAR.root.position.z, px, pz, CAR.y);
};
// Как было при сбивании: срабатывает, когда ось конуса (его центр px,pz)
// входит в прямоугольник кузова. Без радиуса/зазора — блокировка ровно
// в тот момент, когда раньше был подброс.
function coneBlockedAt(x, z, px, pz, y) {
  return coneDepthAt(x, z, px, pz) > 0;
}
// Глубина проникновения оси конуса в габарит: 0 — снаружи, >0 — внутри
// (расстояние до ближайшего края). Нужна, чтобы выпустить машину:
// внутрь пускаем только наружу, а не запираем её там навсегда.
function coneDepthAt(x, z, px, pz) {
  if (typeof CAR === "undefined" || !CAR) return 0;
  const c = Math.cos(CAR.yaw), s = Math.sin(CAR.yaw);
  const dx = px - x, dz = pz - z;
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  const ex = CAR.halfW - Math.abs(lx - CAR.bodyCx);
  const ez = CAR.halfL - Math.abs(lz - CAR.bodyCz);
  if (ex <= 0 || ez <= 0) return 0;
  return Math.min(ex, ez);
}
// Звук/тост — в тот же момент, что и блокировка (по оси, без упреждения).
function coneTouchedAt(x, z, px, pz) {
  return coneBlockedAt(x, z, px, pz);
}
function coneLevelMatches(node, y) {
  if (y === undefined || y === null) return true;
  try { if (Math.abs(node.position.y - y) > CONE_Y_TOL) return false; } catch (e) {}
  return true;
}
function notifyConeHit() {
  const now = (typeof performance !== "undefined") ? performance.now() : 0;
  if (now - lastConeHitAt < CONE_HIT_COOLDOWN) return;
  lastConeHitAt = now;
  if (typeof window.playConeHit === 'function') window.playConeHit();
  if (typeof window.showToast === 'function') window.showToast('СБИТ КОНУС!(3 балла)');
}
// Совместимость: раньше подбрасывала конус, теперь только сигнал.
function knockCone(node, carPos) {
  notifyConeHit();
}
function landCone(n) {}
function updateFlights(dt) {}
function checkCollisions() {
  if (typeof CAR === "undefined" || !CAR || !CAR.root) { coneHitPending = false; return; }
  // Упор в конус: движение уже отменено, факт снаружи — пищим по флагу.
  if (coneHitPending) {
    coneHitPending = false;
    notifyConeHit();
    return;
  }
  const p = CAR.root.position;
  for (const node of coneNodes) {
    if (coneLevelMatches(node, CAR.y) && coneTouchedAt(p.x, p.z, node.position.x, node.position.z)) {
      notifyConeHit();
      break;
    }
  }
}
function tickWorld(dt) {
  checkCollisions();
}

// ── сериализация карты (общий формат игры и редактора) ───────────────
const MAP_FORMAT = "gta4_map", MAP_VERSION = 1;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
function collectMapJson() {
  const map = {
    format: MAP_FORMAT, version: MAP_VERSION, savedAt: new Date().toISOString(),
    cones: coneNodes.map((n) => [r4(n.position.x), r4(n.position.z), n.userData.high ? 1 : 0]),
  };
  for (const t of DRAW_TYPES) map[t] = drawStore[t].polys.map((poly) => poly.map((p) => [r4(p[0]), r4(p[1])]));
  return map;
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
      if (x !== null && z !== null) addConeAt(r4(x), r4(z), c[2] === 1);
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
}

// ── учёт своих мешей ─────────────────────────────────────────────────
// Геометрия машины берётся по снимку сцены ДО загрузки модели: всё, что создаёт
// карта, обязано быть вне этого списка, иначе конусы и эстакады станут детьми
// машины и поедут за ней.
const mapMeshes = new Set();
// Совместимость: index.html раньше использовал имя editorMeshes.
const editorMeshes = mapMeshes;

// ── инициализация ────────────────────────────────────────────────────
// Хуки опоры и объектов работают всегда: эстакады, бордюры и конусы остаются
// на карте и держат машину при езде.
if (typeof surfaceProbe !== "undefined") surfaceProbe = probeSurface;
if (typeof obstacleProbe !== "undefined") obstacleProbe = obstacleBlocked;
if (typeof objectTick !== "undefined") objectTick = tickWorld;
// Карта всегда берётся только из модуля default-map.js: своего хранилища у
// приложения нет. Каждый запуск площадка начинается в исходном виде.
if (typeof DEFAULT_MAP === "object") {
  try { applyMapJson(DEFAULT_MAP); } catch (e) {}
}
// Земля статична в обоих приложениях — тоже замораживаем.
// Небо (sky.infiniteDistance) трогать нельзя: оно едет за камерой.
if (typeof ground !== "undefined" && ground) freezeStatic(ground);
updateCount();
updateCounts();
for (const m of scene.meshes) mapMeshes.add(m);
