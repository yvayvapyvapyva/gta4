/*
 * drive-control.js — модуль нижней панели управления (мобильные устройства).
 *
 * Подключается классическим <script> ПОСЛЕ основного inline-скрипта index.html.
 * Классические скрипты делят глобальную лексическую область, поэтому:
 *   — заполняет объявленные в index.html общие состояния сенсорного руля
 *     (touchSteerEnabled/touchSteerAngle) и поворотников (blinkerLeft/Right);
 *   — функции syncDvView/syncBlinkBtns/tickBlink/syncDvWheel становятся
 *     свойствами window и вызываются из главного скрипта.
 *
 * Знак поворота: в index.html угол CAR.steer положителен при повороте налево,
 * поэтому угол руля здесь берётся со знаком минус — по часовой стрелке налево нет.
 */

// Полный отворот берём у CAR: он считается по диаметру разворота при загрузке
// модели, иначе панель разошлась бы с физикой на машинах с другой геометрией.
const DV_LOCK = () => CAR.maxSteer;

// ── Руль и кнопки «вперёд/назад» ────────────────────────────────
(function(){
  const dv=document.getElementById('driveCtrl');if(!dv)return;
  const fwd=document.getElementById('dvFwd'),back=document.getElementById('dvBack');
  const wheel=document.getElementById('dvWheel'),rotEl=document.getElementById('dvRot');
  const WMAX=540;          // градусов поворота руля при полном отвороте
  let wAng=0,rotDrag=null;
  // Кнопки вперёд/назад: каждый палец запоминается по pointerId, отпускание
  // ловится глобально на window. Без setPointerCapture, чтобы не блокировать мультитач.
  const keyState={forward:new Set(),back:new Set()};
  const codeByKey={forward:'KeyW',back:'KeyS'};
  const btnByKey={forward:fwd,back:back};
  const releaseKey=(key,pointerId)=>{
    const s=keyState[key];if(!s.has(pointerId))return;
    s.delete(pointerId);
    if(s.size===0){keys[codeByKey[key]]=false;const b=btnByKey[key];if(b)b.classList.remove('on');}
  };
  const pressKey=(key,el,pointerId)=>{keyState[key].add(pointerId);keys[codeByKey[key]]=true;if(el)el.classList.add('on');};
  fwd.addEventListener('pointerdown',e=>{e.preventDefault();pressKey('forward',fwd,e.pointerId);});
  back.addEventListener('pointerdown',e=>{e.preventDefault();pressKey('back',back,e.pointerId);});
  window.addEventListener('pointerup',e=>{releaseKey('forward',e.pointerId);releaseKey('back',e.pointerId);});
  window.addEventListener('pointercancel',e=>{releaseKey('forward',e.pointerId);releaseKey('back',e.pointerId);});

  // Сенсорный руль без захвата указателя — движение отслеживается глобально
  // по pointerId, поэтому в мультитаче остальные кнопки работают.
  const setWheel=(ang)=>{
    wAng=Math.max(-WMAX,Math.min(WMAX,ang));
    rotEl.style.transform='rotate('+wAng+'deg)';
    touchSteerEnabled=true;touchSteerAngle=-(wAng/WMAX)*DV_LOCK();
  };
  wheel.addEventListener('pointerdown',e=>{
    e.preventDefault();
    const r=wheel.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
    const a=Math.atan2(e.clientY-cy,e.clientX-cx);
    // угол от вертикали вверх: 0 на 12 часах, растёт по часовой стрелке
    const target=a*180/Math.PI+90;
    setWheel(target+Math.round((wAng-target)/360)*360);
    rotDrag={id:e.pointerId,last:a,cx,cy};
  });
  window.addEventListener('pointermove',e=>{
    if(!rotDrag||rotDrag.id!==e.pointerId)return;
    e.preventDefault();
    const a=Math.atan2(e.clientY-rotDrag.cy,e.clientX-rotDrag.cx);
    let d=a-rotDrag.last;
    while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;
    rotDrag.last=a;
    setWheel(wAng+d*180/Math.PI);
  });
  const endDrag=e=>{
    if(!rotDrag||rotDrag.id!==e.pointerId)return;
    rotDrag=null;touchSteerEnabled=false;
  };
  window.addEventListener('pointerup',endDrag);
  window.addEventListener('pointercancel',endDrag);
  window.addEventListener('blur',()=>{rotDrag=null;touchSteerEnabled=false;});
  // руль и полоска индикатора догоняют реальный угол колёс, когда его не держат
  window.syncDvWheel=()=>{
    const lk=DV_LOCK();
    let cur;
    // Инвариант из setWheel: touchSteerAngle = -(wAng/WMAX)*DV_LOCK(), то есть
    // cur = touchSteerAngle/DV_LOCK() = -(wAng/WMAX) — СО ЗНАКОМ МИНУС.
    // Раньше здесь стояло cur=wAng/WMAX, а после отпускания ещё и
    // wAng=(CAR.steer/lk)*WMAX: минус терялся в обеих строках, и при отпускании
    // маркер шкалы прыгал на противоположную сторону, а сам руль — через сотни
    // градусов (замер: rotate(180deg) -> rotate(-93.6deg)).
    if(rotDrag)cur=-wAng/WMAX;
    else{wAng=-(CAR.steer/lk)*WMAX;cur=CAR.steer/lk;}
    rotEl.style.transform='rotate('+wAng+'deg)';
    const ind=document.getElementById('dvIndMarker');
    if(ind)ind.style.left=(50-cur*48)+'%';
  };
})();

// ── Кнопка переключения вида (следом / салон / свободная) ─────
const dvView=document.getElementById('dvView');
function syncDvView(){
  if(!dvView)return;
  const modes=(typeof CAM_MODES!=='undefined')?CAM_MODES:['следом','салон','свободная'];
  const name=modes[CAR.mode]||'';
  const next=modes[(CAR.mode+1)%modes.length];
  dvView.textContent='👁';
  dvView.classList.toggle('active',CAR.mode===1);
  dvView.setAttribute('aria-label','Вид: '+name+'. Переключить на «'+next+'»');
}
if(dvView)dvView.addEventListener('click',()=>{
  if(!ready)return;
  // Раньше было CAR.mode=CAR.mode===1?0:1 — кнопка знала только салон и «следом»,
  // свободный вид был недостижим. Теперь циклит все виды, как клавиша C.
  if(typeof toggleCam==='function')toggleCam();
  else{CAR.mode=(CAR.mode+1)%3;applyCamMode();}
});
syncDvView();

// ── Поворотники: состояние, мигание, кнопки ────────────────────
// Меши фонарей находятся в модели по именам indicator_l*/indicator_r*; у каждой
// стороны своя копия материала, иначе включённый левый зажигает оба фонаря.
const BLINK=0.8, BLINK_DUTY=0.4;
let blinkT=0, blinkOn=false;
let indSides=null;
const AMBER=new BABYLON.Color3(1,0.55,0.05);

function setSide(list,on){
  for(const m of list){
    m.isVisible=on;
    const mt=m.material;
    if(mt)mt.emissiveColor=on?AMBER:new BABYLON.Color3(0,0,0);
  }
}
function applyBlink(){
  blinkOn=(blinkT%BLINK)<BLINK_DUTY;
  // Обе стороны задаём явно, а не только активную: иначе выключенная сторона
  // залипает в последнем состоянии. Раньше turn off в светлой фазе мигания
  // оставлял фонари включёнными навсегда (tickBlink при выключенных
  // поворотниках сразу выходит, а setSide вызывался только для активной стороны).
  if(indSides){
    setSide(indSides.left,blinkerLeft&&blinkOn);
    setSide(indSides.right,blinkerRight&&blinkOn);
  }
}
window.tickBlink=function(dt){
  if(!blinkerLeft&&!blinkerRight)return;
  blinkT+=dt;applyBlink();
};
function syncBlinkBtns(){
  const blkL=document.getElementById('dvBlinkL'),blkR=document.getElementById('dvBlinkR');
  if(blkL)blkL.classList.toggle('active',blinkerLeft);
  if(blkR)blkR.classList.toggle('active',blinkerRight);
}
function toggleBlinkL(){
  if(!ready)return;
  blinkerLeft=!blinkerLeft;if(blinkerLeft)blinkerRight=false;
  blinkT=0;applyBlink();syncBlinkBtns();
}
function toggleBlinkR(){
  if(!ready)return;
  blinkerRight=!blinkerRight;if(blinkerRight)blinkerLeft=false;
  blinkT=0;applyBlink();syncBlinkBtns();
}
const blkL=document.getElementById('dvBlinkL'),blkR=document.getElementById('dvBlinkR');
if(blkL)blkL.addEventListener('pointerdown',e=>{e.preventDefault();toggleBlinkL();});
if(blkR)blkR.addEventListener('pointerdown',e=>{e.preventDefault();toggleBlinkR();});
addEventListener('keydown',e=>{
  if(e.repeat)return;
  if(e.code==='KeyQ')toggleBlinkL();
  else if(e.code==='KeyE')toggleBlinkR();
});

// Фонари включаем только после загрузки модели: до этого их в сцене нет.
window.setupIndicators=function(meshes){
  indSides=null;
  const ind=meshes.filter(m=>/indicator/i.test(m.name)||/indicator/i.test((m.parent&&m.parent.name)||''));
  if(!ind.length)return;
  // Сторону фонаря берём из его положения относительно кузова, а НЕ из имени.
  // В этой модели передняя пара названа наоборот: indicator_lf стоит справа
  // (+X = 0.49), а indicator_rf — слева (−X = 0.47). Разложение по именам
  // включало в левом поворотнике задний левый фонарь (верно) и передний
  // правый (неверно), то есть в переднем фонаре горел чужой стороны.
  // Переводим фонарь в локальные оси кузова: +X — правая сторона.
  const invRoot=CAR.root.getWorldMatrix().clone().invert();
  const wp=new BABYLON.Vector3(),lp=new BABYLON.Vector3();
  const left=[],right=[];
  for(const m of ind){
    m.computeWorldMatrix(true);
    const bb=m.getBoundingInfo().boundingBox;
    BABYLON.Vector3.TransformCoordinatesToRef(bb.centerWorld,m.getWorldMatrix(),wp);
    BABYLON.Vector3.TransformCoordinatesToRef(wp,invRoot,lp);
    // если фонарь почти на оси — модель неоднозначна, откатываемся на имя
    const byName=/indicator_l[a-z]/i.test(m.name)||/indicator_l[a-z]/i.test((m.parent&&m.parent.name)||'');
    const isLeft=Math.abs(lp.x)>0.05?lp.x<0:byName;
    (isLeft?left:right).push(m);
  }
  for(const m of left.concat(right)){
    m.material=(m.material||new BABYLON.StandardMaterial('ind_'+m.name,scene)).clone('indm_'+m.name);
    m.material.emissiveColor=new BABYLON.Color3(0,0,0);
    m.isVisible=false;
  }
  indSides={left,right};
  // Свечение (GlowLayer) убрано: оно компонуется аддитивно поверх итоговой
  // картинки и не проверяет глубину, поэтому фонарь за кузовом просвечивал
  // насквозь. Материал фонаря emissive сам по себе даёт яркое жёлтое пятно,
  // а перекрытие кузовом теперь работает обычным тестом глубины.
  syncBlinkBtns();applyBlink();
};

// Номера. Числа на табличках — не текстура, а отдельные чёрные меши (материал
// siyah, ~1956 вершин), выступающие вперёд на 1,3 см. Сама табличка — скруглённая
// пластина с текстурой plaka, где слева красная полоса флага Турции.
// Убираем и то и другое: меши с цифрами скрываем, а саму пластину заменяем её
// копией с той же геометрией — поэтому скругление и толщина сохраняются —
// и новой текстурой: белый фон с зелёной надписью. Плоскую наклейку сверху
// класть не нужно, копия стоит ровно на месте оригинала и закрывает его целиком.
const PLATE_GREEN = "#12b312";

// Текстура слоя букв: белые буквы на прозрачном фоне. Белые, потому что при
// disableLighting Babylon выводит только цвет материала, а текстуру в
// emissiveTexture игнорирует — проба с зелёными буквами прямо в текстуре дала
// сплошной белый прямоугольник. Цвет задаёт emissiveColor слоя, текстура несёт
// только альфу.
//
// Из-за этого же зелёные буквы и чёрная окантовка нельзя совместить в одной
// текстуре: цвет у слоя один. Поэтому надпись рисуется двумя слоями —
// outline=true даёт кольцо вокруг глифов (чёрный), outline=false сами глифы
// (зелёные). Кольцо получается так: обводим и заливаем текст, затем
// destination-out выбивает середину, и остаётся только ободок.
//
// Ориентацию UV проверяли опросом: непрозрачным делали по очереди каждый
// квадрант канвы и смотрели, куда он попал на экране. Результат одинаковый у
// обоих номеров — канва сверху попадает на экран снизу, канва слева налево:
//   передний (bumper_f_primitive5): x 36..402, y 196..280 для квадранта «сверху»;
//   задний  (bumper_r_primitive12): x 29..399, y 195..272 для того же квадранта.
// То есть UV обоих номеров перевёрнуты по вертикали, и без переворота надпись
// выходит вверх ногами. Горизонталь правильная у обоих, отражать по X не нужно.
function plateLettersTexture(name, outline) {
  const tex = new BABYLON.DynamicTexture(name, { width:1024, height:256 }, scene, true);
  tex.hasAlpha = true;
  const g = tex.getContext();
  g.clearRect(0, 0, 1024, 256);
  g.textAlign = "center";
  g.textBaseline = "middle";
  // Подгоняем кегль так, чтобы надпись заняла почти всю ширину номера.
  // Масштабируем в обе стороны, а не только вниз: прежняя проверка «if (w > N)»
  // умела лишь ужимать текст, который шире N, и при исходных 614 px из 1024
  // ничего не делала — надпись оставалась мелкой. Теперь кегль всегда
  // приводит ширину к 1000 px: текстура ровно натянута на номер шириной 0,57 м,
  // так что это фактически во всю табличку. Запас по краям — на обводку.
  const TARGET = 1000;
  let size = 150;
  g.font = 'bold ' + size + 'px Arial, Helvetica, sans-serif';
  size = Math.max(1, Math.round(size * TARGET / g.measureText("КОЛЕСО").width));
  g.font = 'bold ' + size + 'px Arial, Helvetica, sans-serif';
  // 512,128 — центр текстуры 1024×256, поэтому после переворота (256-128=128)
  // надпись остаётся центрированной, и подгонка кегля по ширине выше не ломается.
  g.save();
  g.translate(0, 256);
  g.scale(1, -1);
  if (outline) {
    g.fillStyle = "#ffffff";
    g.strokeStyle = "#ffffff";
    g.lineWidth = 12;
    g.lineJoin = "round";
    g.miterLimit = 2;
    g.strokeText("КОЛЕСО", 512, 128);
    g.fillText("КОЛЕСО", 512, 128);
    g.globalCompositeOperation = "destination-out";
    g.fillText("КОЛЕСО", 512, 128);           // выбиваем середину — остаётся ободок
    g.globalCompositeOperation = "source-over";
  } else {
    g.fillStyle = "#ffffff";
    g.fillText("КОЛЕСО", 512, 128);
  }
  g.restore();
  tex.update();
  return tex;
}

function plateLayers(plate, front) {
  // наружу от таблички: спереди это -Z, сзади +Z. Отсчёт отсюда, иначе на
  // заднем номере буквенный слой оказывается под фоном и не виден вовсе.
  const out = front ? -1 : 1;

  // Копия геометрии вместо плоской плоскости: скругление и толщина те же.
  // clone без newParent наследует родителя оригинала, так что копия едет
  // вместе с машиной сама.
  const bg = plate.clone(plate.name + "_label", null, true);
  bg.isPickable = false;
  bg.material = new BABYLON.StandardMaterial(plate.name + "_labelMat", scene);
  bg.material.emissiveColor = new BABYLON.Color3(0.95, 0.95, 0.95);
  bg.material.diffuseColor = new BABYLON.Color3(0, 0, 0);
  bg.material.specularColor = new BABYLON.Color3(0, 0, 0);
  bg.material.disableLighting = true;

  // Копия с материалом слоя: общая заготовка для окантовки и букв.
  const layer = (suffix, dz, texName, outline, color, zOffset) => {
    const q = plate.clone(plate.name + suffix, null, true);
    q.isPickable = false;
    q.position.z = plate.position.z + out * dz;
    q.material = new BABYLON.StandardMaterial(plate.name + suffix + "Mat", scene);
    q.material.opacityTexture = plateLettersTexture(plate.name + texName, outline);
    q.material.emissiveColor = color;
    q.material.diffuseColor = new BABYLON.Color3(0, 0, 0);
    q.material.specularColor = new BABYLON.Color3(0, 0, 0);
    q.material.disableLighting = true;
    q.material.zOffset = zOffset;
    return q;
  };

  // Окантовка: кольцо вокруг глифов, чёрное. Лежит между фоном и буквами.
  layer("_labelEdge", 0.0004, "_labelEdgeTex", true, new BABYLON.Color3(0, 0, 0), -4);
  // Буквы: сами глифы, зелёные, снаружи окантовки — она оставляет видимую
  // чёрную кромку только там, где глиф её не перекрывает.
  const fg = layer("_labelFg", 0.0008, "_labelTex", false,
                   BABYLON.Color3.FromHexString(PLATE_GREEN), -8);

  // Оригинал скрываем: копия стоит на его месте и полностью его закрывает,
  // поэтому ни цифр, ни красной полосы, ни кромки пластины не видно.
  plate.isVisible = false;
  return fg;
}

window.setupPlateLabels = function (meshes) {
  const plates = meshes.filter((m) => m.material && /plaka/i.test(m.material.name));
  if (!plates.length) return;
  // Работаем в локальной системе таблички: её вершины уже лежат в системе
  // координат узла машины, и локальные координаты ребёнка — те же самые.
  // Мировые брать нельзя: наклейка — ребёнок таблички, и мировое смещение
  // приплюсовалось бы к трансформу машины второй раз.
  const localBox = (m) => m.getBoundingInfo().boundingBox;
  for (const plate of plates) {
    const bb = localBox(plate), mn = bb.minimum, mx = bb.maximum;
    // цифры на номере: чёрные меши того же материала, что стоят на этой же
    // таблицечке. Совпадение проверяем по всем трём осям, иначе в переднюю
    // выборку попадает задний номер (а у него ось Z вообще другого знака)
    // и наклейка встаёт не на ту сторону.
    const near = (m) => {
      const b2 = localBox(m);
      const cx2 = (b2.maximum.x + b2.minimum.x) / 2, cy2 = (b2.maximum.y + b2.minimum.y) / 2, cz2 = (b2.maximum.z + b2.minimum.z) / 2;
      const cx = (mn.x + mx.x) / 2, cy = (mn.y + mx.y) / 2, cz = (mn.z + mx.z) / 2;
      return b2.maximum.x - b2.minimum.x < 0.6
        && Math.abs(cx2 - cx) < 0.2 && Math.abs(cy2 - cy) < 0.2 && Math.abs(cz2 - cz) < 0.2
        && (b2.minimum.z < mn.z - 0.001 || b2.maximum.z > mx.z + 0.001);
    };
    const nums = meshes.filter((m) => m !== plate && m.material && /^siyah/i.test(m.material.name) && near(m));
    if (!nums.length) continue;                 // цифр нет — наклейку не куда класть
    const front = nums[0] && localBox(nums[0]).minimum.z < mn.z;
    for (const n of nums) n.isVisible = false;

    plateLayers(plate, front);
  }
};

// ── Кнопки масштаба (+/−) ──────────────────────────────────────
const zIn=document.getElementById('dvZoomIn'),zOut=document.getElementById('dvZoomOut');
function zoomStep(k){
  if(CAR.mode===1){setCamFov(CAR.camFov+(k<1?-0.06:0.06));return;}
  cam.radius=Math.max(cam.lowerRadiusLimit,Math.min(cam.upperRadiusLimit,cam.radius*k));
}
function zoomHold(k,dt){
  if(CAR.mode===1){setCamFov(CAR.camFov+(k<1?-1:1)*0.9*dt);return;}
  const f=Math.exp(dt*Math.log(k)/0.13);
  cam.radius=Math.max(cam.lowerRadiusLimit,Math.min(cam.upperRadiusLimit,cam.radius*f));
}
function bindZoom(el,k){
  if(!el)return;
  let raf=null,lastT=0;
  const tick=t=>{
    if(!lastT)lastT=t;
    const dt=Math.min(0.1,(t-lastT)/1000);lastT=t;
    zoomHold(k,dt);
    raf=requestAnimationFrame(tick);
  };
  const stop=()=>{if(raf){cancelAnimationFrame(raf);raf=null;lastT=0;}};
  el.addEventListener('pointerdown',e=>{e.preventDefault();zoomStep(k);
    if(!raf){lastT=0;raf=requestAnimationFrame(tick);}});
  el.addEventListener('pointerup',stop);el.addEventListener('pointercancel',stop);
  el.addEventListener('pointerleave',stop);el.addEventListener('lostpointercapture',stop);
}
bindZoom(zIn,0.9);
bindZoom(zOut,1.1);

// ── Защита от контекстного меню / выделения на мобильных ─────────
document.addEventListener('contextmenu',e=>{
  const t=e.target;
  if(t&&t.closest&&(t.closest('#driveCtrl')||t.closest('#mapEdit')))e.preventDefault();
});
document.addEventListener('selectstart',e=>{
  const t=e.target;
  if(t&&t.closest&&t.closest('#driveCtrl'))e.preventDefault();
});
