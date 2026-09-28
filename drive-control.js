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

const DV_LOCK = 0.58;   // предельный угол колёс на полном отвороте, рад

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
    touchSteerEnabled=true;touchSteerAngle=-(wAng/WMAX)*DV_LOCK;
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
    let cur;
    if(rotDrag)cur=wAng/WMAX;
    else{wAng=(CAR.steer/DV_LOCK)*WMAX;cur=CAR.steer/DV_LOCK;}
    rotEl.style.transform='rotate('+wAng+'deg)';
    const ind=document.getElementById('dvIndMarker');
    if(ind)ind.style.left=(50-cur*48)+'%';
  };
})();

// ── Кнопка переключения вида (салон / снаружи) ─────────────────
const dvView=document.getElementById('dvView');
function syncDvView(){
  if(!dvView)return;
  dvView.textContent='👁';
  dvView.classList.toggle('active',CAR.mode===1);
  dvView.setAttribute('aria-label',CAR.mode===1?'Вид: салон. Переключить наружу':'Вид: снаружи. Переключить в салон');
}
if(dvView)dvView.addEventListener('click',()=>{
  if(!ready)return;
  CAR.mode=CAR.mode===1?0:1;   // свободный режим с панели не берём: там мышь
  applyCamMode();
});
syncDvView();

// ── Поворотники: состояние, мигание, кнопки ────────────────────
// Меши фонарей находятся в модели по именам indicator_l*/indicator_r*; у каждой
// стороны своя копия материала, иначе включённый левый зажигает оба фонаря.
const BLINK=0.8, BLINK_DUTY=0.4;
let blinkT=0, blinkOn=false;
let indSides=null, indGlow=null;
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
  if(indSides){
    if(blinkerLeft)setSide(indSides.left,blinkOn);
    if(blinkerRight)setSide(indSides.right,blinkOn);
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
  if(indGlow){indGlow.dispose();indGlow=null;}
  indSides=null;
  const side=(re)=>meshes.filter(m=>re.test(m.name)||re.test((m.parent&&m.parent.name)||''));
  const left=side(/indicator_l[a-z]/i),right=side(/indicator_r[a-z]/i);
  if(!left.length&&!right.length)return;
  for(const m of left.concat(right)){
    m.material=(m.material||new BABYLON.StandardMaterial('ind_'+m.name,scene)).clone('indm_'+m.name);
    m.material.emissiveColor=new BABYLON.Color3(0,0,0);
    m.isVisible=false;
  }
  indSides={left,right};
  // свечение: в сцену попадают только фонари, остальное не трогаем
  indGlow=new BABYLON.GlowLayer('indGlow',scene,{kernel:32,mainTextureFixedSize:256});
  indGlow.intensity=0.8;
  for(const m of left.concat(right))indGlow.addIncludedOnlyMesh(m);
  syncBlinkBtns();applyBlink();
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
