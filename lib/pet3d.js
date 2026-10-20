/* ==========================================================================
 * pet3d.js — 二次元桌宠 3D 立绘渲染器
 *   依赖：lib/three.min.js (UMD)  → 全局 THREE
 *        lib/GLTFLoader.js        → 全局 THREE.GLTFLoader（仅 VRM 需要）
 *        lib/three-vrm.min.js     → 全局 VRM（可选，拖入 .vrm 后接管角色）
 *   读取页面全局：PET（弹簧/眨眼/嘴部状态）、CHAR_SKIN 调色板
 *   输出：window.PET3D.{ init, render, setPalette, poke, setVisible, loadVRM, unloadVRM }
 * ========================================================================== */
window.PET3D = (function () {
  'use strict';

  const S = { ready:false, note:'', _pop:false };
  let renderer, scene, camera, container, canvas, root, keyLight;
  let MAT = {}, RIG = {}, ARMS = [], TEX = {};
  let vrm = null, vrmRoot = null, lookTarget = null, vrmProxy = null, vrmMouthKey = null;
  let W = 260, H = 372, popT = 9;

  const DEF_PAL = { hair:'#8f7cf5', hairDark:'#5646c7', eyeTop:'#312a9c', eyeBot:'#5eead4',
                    skin:'#ffe4d4', skinShade:'#f0bda6', blush:'#ff8fa8', cloth:'#4f46e5', clothDark:'#2c2a78' };

  /* ---------------- 卡通渲染素材 ---------------- */
  function gradientMap(){
    const c = document.createElement('canvas'); c.width = 4; c.height = 1;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0,0,4,0);
    gr.addColorStop(0,'#4e4e6a'); gr.addColorStop(.45,'#8f8fb0');
    gr.addColorStop(.5,'#d7d7ea'); gr.addColorStop(1,'#ffffff');
    g.fillStyle = gr; g.fillRect(0,0,4,1);
    const t = new THREE.CanvasTexture(c);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false;
    return t;
  }
  function irisTexture(PAL){
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(64,64,3,64,64,62);
    rg.addColorStop(0,PAL.eyeBot); rg.addColorStop(.5,PAL.eyeBot); rg.addColorStop(1,PAL.eyeTop);
    g.fillStyle = rg; g.beginPath(); g.arc(64,64,62,0,Math.PI*2); g.fill();
    g.fillStyle = '#0e0724'; g.beginPath(); g.arc(64,64,25,0,Math.PI*2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.92)'; g.beginPath(); g.ellipse(46,42,17,22,-.5,0,Math.PI*2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(86,90,7,0,Math.PI*2); g.fill();
    const t = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
    return t;
  }
  function blushTexture(PAL){
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(32,32,1,32,32,31);
    rg.addColorStop(0,PAL.blush); rg.addColorStop(1,'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0,0,64,64);
    return new THREE.CanvasTexture(c);
  }

  /* ---------------- 建模工具 ---------------- */
  function outline(mesh, k){
    const o = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color:0x180d2e, side:THREE.BackSide }));
    o.scale.setScalar(k || 1.06);
    mesh.add(o);
    return mesh;
  }
  function mk(geo, mat, o){
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    if (o) {
      if (o.pos) m.position.set(o.pos[0], o.pos[1], o.pos[2]);
      if (typeof o.scale === 'number') m.scale.setScalar(o.scale);
      else if (o.scale) m.scale.set(o.scale[0], o.scale[1], o.scale[2]);
      if (o.line !== false) outline(m, o.line || 1.055);
    }
    return m;
  }

  // 卡通着色会压暗，底色需提亮，避免深色裙摆糊成一团黑
  function tint(c, k){ return new THREE.Color(c).multiplyScalar(k); }

  /* ---------------- 材质 ---------------- */
  function buildMaterials(PAL){
    TEX.grad = TEX.grad || gradientMap();
    TEX.iris  = irisTexture(PAL);
    TEX.blush = blushTexture(PAL);
    const toon = c => new THREE.MeshToonMaterial({ color:new THREE.Color(c), gradientMap:TEX.grad });
    MAT = {
      skin:      toon(PAL.skin),      skinShade: toon(PAL.skinShade),
      cloth:     toon(PAL.cloth),     clothDark: toon(PAL.clothDark),
      hair:      toon(PAL.hair),      hairDark:  toon(PAL.hairDark),
      eyeWhite:  new THREE.MeshBasicMaterial({ color:0xfdfaff }),
      iris:      new THREE.MeshBasicMaterial({ map:TEX.iris }),
      mouth:     new THREE.MeshBasicMaterial({ color:0x8f2f4d }),
      blush:     new THREE.MeshBasicMaterial({ map:TEX.blush, transparent:true, opacity:.5, depthWrite:false }),
    };
  }

  /* ---------------- 角色（程序化二次元 chibi） ---------------- */
  function buildCharacter(){
    root = new THREE.Group(); scene.add(root);

    /* 躯干 */
    root.add(mk(new THREE.CapsuleGeometry(0.165,0.26,8,24), MAT.cloth, { pos:[0,0.92,0], scale:[1.05,1,0.86] }));
    root.add(mk(new THREE.SphereGeometry(0.155,20,16), MAT.cloth, { pos:[0,1.06,0.02], scale:[1.08,0.85,0.92], line:1.05 }));
    root.add(mk(new THREE.CylinderGeometry(0.06,0.075,0.14,14), MAT.skinShade, { pos:[0,1.22,0], line:1.07 }));

    /* 裙摆 */
    RIG.skirt = new THREE.Mesh(
      new THREE.ConeGeometry(0.34,0.32,22,1,true),
      new THREE.MeshToonMaterial({ color:tint(MAT.clothDark.color, 1.55), gradientMap:TEX.grad, side:THREE.DoubleSide }));
    RIG.skirt.position.set(0,0.70,0); RIG.skirt.castShadow = true;
    root.add(RIG.skirt);

    /* 腿 */
    [-1,1].forEach(s=>{
      const hip = new THREE.Group(); hip.position.set(s*0.088, 0.64, 0);
      hip.add(mk(new THREE.CapsuleGeometry(0.062,0.18,6,16), MAT.skin, { pos:[0,-0.13,0], line:1.08 }));
      const knee = new THREE.Group(); knee.position.set(0,-0.29,0); hip.add(knee);
      knee.add(mk(new THREE.CapsuleGeometry(0.052,0.18,6,16), MAT.skin, { pos:[0,-0.12,0], line:1.08 }));
      knee.add(mk(new THREE.SphereGeometry(0.062,14,12), MAT.clothDark, { pos:[0,-0.24,0.035], scale:[1,0.62,1.55], line:1.1 }));
      root.add(hip);
    });

    /* 手臂 */
    ARMS = [];
    [1,-1].forEach(s=>{
      const shoulder = new THREE.Group(); shoulder.position.set(s*0.20, 1.20, 0);
      shoulder.add(mk(new THREE.CapsuleGeometry(0.055,0.15,6,16), MAT.cloth, { pos:[0,-0.10,0], line:1.09 }));
      const elbow = new THREE.Group(); elbow.position.set(0,-0.20,0); shoulder.add(elbow);
      elbow.add(mk(new THREE.CapsuleGeometry(0.045,0.14,6,16), MAT.skin, { pos:[0,-0.10,0], line:1.09 }));
      elbow.add(mk(new THREE.SphereGeometry(0.05,14,12), MAT.skin, { pos:[0,-0.20,0], scale:[1,1.15,0.85], line:1.12 }));
      shoulder.rotation.z = s*0.13;
      root.add(shoulder);
      ARMS.push({ s, shoulder, elbow });
    });

    /* 头 */
    RIG.head = new THREE.Group(); RIG.head.position.set(0,1.54,0); root.add(RIG.head);
    RIG.head.add(mk(new THREE.SphereGeometry(0.30,36,28), MAT.skin, { scale:[1,1.05,0.98], line:1.035 }));
    RIG.head.add(mk(new THREE.SphereGeometry(0.21,24,18), MAT.skin, { pos:[0,-0.11,0.03], scale:[1.05,0.85,1.0], line:1.04 }));

    RIG.eyes = []; RIG.brows = []; RIG.blush = [];
    [1,-1].forEach(s=>{
      // 眼睛贴在球面外侧且法线朝外（贴反会整个埋进头里）
      const eg = new THREE.Group(); eg.position.set(s*0.105, 0.05, 0.272); eg.rotation.y = s*0.36;
      eg.add(mk(new THREE.SphereGeometry(0.072,20,16), MAT.eyeWhite, { scale:[1,1.16,0.5], line:false }));
      const iris = new THREE.Mesh(new THREE.CircleGeometry(0.053,28), MAT.iris);
      iris.position.z = 0.047; eg.add(iris);
      RIG.head.add(eg); RIG.eyes.push(eg);

      const b = new THREE.Mesh(new THREE.BoxGeometry(0.075,0.011,0.012), MAT.hairDark);
      b.position.set(s*0.105, 0.155, 0.262); b.rotation.y = s*0.36; b.rotation.z = -s*0.10;
      RIG.head.add(b); RIG.brows.push(b);

      const bl = new THREE.Mesh(new THREE.PlaneGeometry(0.13,0.09), MAT.blush);
      bl.position.set(s*0.16, 0.005, 0.238); bl.rotation.y = s*0.55;
      RIG.head.add(bl); RIG.blush.push(bl);
    });
    RIG.mouth = mk(new THREE.SphereGeometry(0.042,18,14), MAT.mouth, { pos:[0,-0.055,0.286], scale:[1,0.28,0.4], line:false });
    RIG.head.add(RIG.mouth);

    /* 头发 */
    RIG.hair = new THREE.Group(); RIG.head.add(RIG.hair);
    // 发帽：只盖到额头上沿，别糊住眼睛
    RIG.hair.add(mk(new THREE.SphereGeometry(0.315,32,24,0,Math.PI*2,0,Math.PI*0.42), MAT.hair,
                    { pos:[0,0.01,-0.01], scale:[1.02,1.05,1.02], line:1.04 }));
    // 后脑 + 长发
    RIG.hair.add(mk(new THREE.SphereGeometry(0.29,28,22), MAT.hairDark,
                    { pos:[0,-0.14,-0.07], scale:[1.05,1.22,1.0], line:1.05 }));
    const tail = mk(new THREE.CylinderGeometry(0.21,0.11,0.48,20,1,true), MAT.hairDark,
                    { pos:[0,-0.50,-0.08], line:false });
    tail.material = new THREE.MeshToonMaterial({ color:new THREE.Color(MAT.hairDark.color).multiplyScalar(1.35), gradientMap:TEX.grad, side:THREE.DoubleSide });
    RIG.hair.add(tail); MAT.tail = tail.material;
    // 刘海尖
    [-2,-1,0,1,2].forEach(i=>{
      const tip = mk(new THREE.SphereGeometry(0.055,16,12), MAT.hair,
                     { pos:[i*0.105, 0.055, 0.245 - Math.abs(i)*0.035], scale:[0.85,1.9,0.7], line:1.1 });
      tip.rotation.z = i*0.12;
      RIG.hair.add(tip);
    });
    // 侧发
    RIG.side = [];
    [1,-1].forEach(s=>{
      const lk = mk(new THREE.CapsuleGeometry(0.058,0.26,6,14), MAT.hair,
                    { pos:[s*0.245,-0.12,0.05], scale:[1,1,0.8], line:1.08 });
      RIG.hair.add(lk); RIG.side.push(lk);
    });
    // 呆毛
    RIG.ahoge = new THREE.Group(); RIG.ahoge.position.set(0.02,0.30,-0.02); RIG.hair.add(RIG.ahoge);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0,0,0), new THREE.Vector3(0.02,0.05,0.01),
      new THREE.Vector3(0.08,0.09,0.02), new THREE.Vector3(0.12,0.13,-0.02)]);
    RIG.ahoge.add(mk(new THREE.TubeGeometry(curve,20,0.021,8,false), MAT.hair, { line:1.2 }));
  }

  /* ---------------- 初始化 ---------------- */
  function init(containerEl){
    if (!window.THREE) { S.note = '未加载 three.js'; return false; }
    container = containerEl;
    W = container.clientWidth || 260; H = container.clientHeight || 372;
    try {
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;';
      container.appendChild(canvas);
      renderer = new THREE.WebGLRenderer({ canvas, alpha:true, antialias:true, powerPreference:'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(W, H, false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      if ('outputEncoding' in renderer && THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    } catch (e) {
      S.note = 'WebGL 不可用：' + e.message;
      canvas.remove(); return false;
    }

    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(26, W/H, 0.1, 50);
    camera.position.set(0, 1.00, 4.45);   // 实际取景由 frameCamera() 计算
    camera.lookAt(0, 0.95, 0);

    scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x171232, 0.55));
    keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
    keyLight.position.set(1.7, 3.0, 2.4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024,1024);
    const sc = keyLight.shadow.camera;
    sc.top = 2; sc.bottom = -0.4; sc.left = -1.6; sc.right = 1.6; sc.near = 0.5; sc.far = 8;
    sc.updateProjectionMatrix();
    scene.add(keyLight);
    const rim  = new THREE.DirectionalLight(0xa5b4fc, 0.85); rim.position.set(-2.2,1.2,-1.6);  scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25); fill.position.set(0,0.5,3);       scene.add(fill);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(8,8), new THREE.ShadowMaterial({ opacity:0.42 }));
    ground.rotation.x = -Math.PI/2; ground.receiveShadow = true; scene.add(ground);

    const PAL = (window.CHAR_SKIN && CHAR_SKIN.manus) ? CHAR_SKIN.manus : DEF_PAL;
    buildMaterials(PAL);
    buildCharacter();

    frameCamera();
    // WebGL 上下文丢失（休眠/驱动重置/长时间挂机）→ 通知页面回落到 2D
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); S.ready = false; S.note = 'WebGL 上下文已丢失';
      if (typeof window.onRendererLost === 'function') window.onRendererLost();
    });
    canvas.addEventListener('webglcontextrestored', () => { S.ready = true; S.note = '程序化二次元角色'; });

    lookTarget = new THREE.Object3D(); scene.add(lookTarget);
    S.ready = true; S.note = '程序化二次元角色';
    window.addEventListener('resize', resize);
    return true;
  }
  // 自动取景：按角色包围盒算出相机距离与高度，改模型不用手调参数
  function frameCamera(){
    if(!camera || !root) return;
    const box = new THREE.Box3().setFromObject(root);
    const sz = new THREE.Vector3(), c = new THREE.Vector3();
    box.getSize(sz); box.getCenter(c);
    const half = Math.tan(camera.fov*Math.PI/360);
    const dist = Math.max(sz.y*1.16/(2*half), sz.x*1.3/(2*half*camera.aspect)) + 0.55;
    camera.position.set(c.x, c.y + sz.y*0.06, dist);
    camera.lookAt(c.x, c.y - sz.y*0.02, 0);
  }

  function resize(){
    if (!renderer || !container) return;
    W = container.clientWidth || W; H = container.clientHeight || H;
    renderer.setSize(W, H, false);
    camera.aspect = W/H; camera.updateProjectionMatrix();
    frameCamera();
  }

  /* ---------------- 每帧驱动 ---------------- */
  function render(view, dt){
    if (!S.ready) return;
    const P = window.PET; if (!P) return;

    if (vrm) { renderVRM(view, dt, P); renderer.render(scene, camera); return; }
    if (!root || !root.visible) return;

    const { sleep, talk, think, exec, alert, squint, br } = view;

    popT += dt;
    if (S._pop && popT > 1.2) S._pop = false;
    const pop = S._pop ? Math.sin(popT*17)*Math.exp(-popT*5.5) : 0;
    root.position.y = P.bounce.a * 0.0032;
    root.scale.set(1 - 0.012*br - 0.05*pop + 0.012*P.happy,
                   1 + 0.016*br + 0.08*pop,
                   1 - 0.012*br - 0.05*pop + 0.012*P.happy);

    RIG.torso.rotation.z = -P.head.x * 0.05;
    RIG.head.rotation.y  =  P.head.x * 0.55;
    RIG.head.rotation.x  = -P.head.y * 0.26 + (sleep ? 0.20 : 0) + br*0.012;
    RIG.head.rotation.z  = -P.head.x * 0.13;
    RIG.head.position.y  =  1.54 + br*0.008 + (sleep ? -0.02 : 0);

    const open = Math.max(0.06, 1 - squint);
    RIG.eyes.forEach(e => { e.scale.y = open; });
    RIG.mouth.scale.y = 0.26 + P.mouth.a * 1.9;
    RIG.mouth.scale.x = 1 + P.mouth.a * 0.25;

    let browY = 0, browR = 0;
    if (think)      { browY = 0.012; browR = -0.10; }
    else if (exec)  { browY = -0.010; browR = 0.16; }
    else if (alert) { browY = 0.016; browR = 0.05; }
    else if (sleep) { browY = 0.006; }
    RIG.brows.forEach((b,i) => {
      const s = i === 0 ? 1 : -1;
      b.position.y = 0.132 + browY;
      b.rotation.z = -s * (0.12 + browR);
    });
    RIG.blush.forEach(b => { b.material.opacity = 0.42 + P.happy*0.4; });

    ARMS.forEach(o => {
      const A = o.s > 0 ? P.armL.a  : P.armR.a;
      const B = o.s > 0 ? P.armLb.a : P.armRb.a;
      o.shoulder.rotation.z = o.s * A + Math.sin(P.t*0.62) * 0.02 * o.s;
      o.elbow.rotation.z    = o.s * (B - A);
      o.shoulder.rotation.x = talk ? Math.sin(P.t*6.2) * 0.12 : 0;
    });

    RIG.hair.rotation.z   = P.hair.a * 0.30;
    RIG.ahoge.rotation.z  = P.ahoge.a * 0.9;
    RIG.ahoge.rotation.x  = Math.sin(P.t*1.6) * 0.12;
    RIG.side.forEach((l,i) => { l.rotation.z = P.side.a * (i === 0 ? -1 : 1) * 0.35; });
    RIG.skirt.rotation.z  = P.skirt.a * 0.35;
    RIG.skirt.rotation.y  = P.head.x * 0.12;

    renderer.render(scene, camera);
  }

  function renderVRM(view, dt, P){
    lookTarget.position.set(P.head.x*1.3, 1.35 + P.head.y*0.3, 1.4);
    if (vrm.lookAt) vrm.lookAt.target = lookTarget;
    if (vrmProxy) {
      try {
        vrmProxy.setValue('blink', view.squint > 0.6 ? 1 : 0);
        vrmProxy.setValue(vrmMouthKey, view.talk ? Math.min(1, P.mouth.a) : 0);
        vrmProxy.setValue('relaxed', view.sleep ? 1 : 0);
      } catch (e) {}
    }
    vrmRoot.position.y = P.bounce.a * 0.0035;
    if (vrm.humanoid) {
      const spine = vrm.humanoid.getBoneNode ? vrm.humanoid.getBoneNode('spine') : null;
      if (spine) spine.rotation.z = -P.head.x * 0.04;
    }
    try { vrm.update(dt); } catch (e) {}
  }

  /* ---------------- 外部接口 ---------------- */
  function setPalette(PAL){
    if (!S.ready || !PAL) return;
    const c = x => new THREE.Color(x);
    MAT.skin.color      = c(PAL.skin);
    MAT.skinShade.color = c(PAL.skinShade);
    MAT.cloth.color     = c(PAL.cloth);
    MAT.clothDark.color = c(PAL.clothDark);
    MAT.hair.color      = c(PAL.hair);
    MAT.hairDark.color  = c(PAL.hairDark);
    if (MAT.tail)  MAT.tail.color  = c(PAL.hairDark);
    RIG.skirt.material.color = tint(PAL.clothDark, 1.55);
    MAT.mouth.color = c(PAL.blush);
    TEX.blush.dispose && TEX.blush.dispose();
    MAT.blush.map = blushTexture(PAL); MAT.blush.needsUpdate = true;
    TEX.iris.dispose && TEX.iris.dispose();
    MAT.iris.map = irisTexture(PAL); MAT.iris.needsUpdate = true;
  }
  function poke(){ S._pop = true; popT = 0; }
  function setVisible(on){ if (canvas) canvas.style.display = on ? 'block' : 'none'; }

  /* ---------------- VRM：拖入本地 .vrm 即可接管（无需服务器） ---------------- */
  function vrmLib(){ return window.THREE_VRM || window.VRM || null; }
  function loadVRM(arrayBuffer){
    return new Promise((resolve, reject) => {
      const LIB = vrmLib();
      if (!LIB || !LIB.VRMLoaderPlugin) { reject(new Error('未加载 three-vrm')); return; }
      if (!window.THREE || !THREE.GLTFLoader) { reject(new Error('未加载 GLTFLoader')); return; }
      let loader;
      try {
        loader = new THREE.GLTFLoader();
        loader.register(parser => new LIB.VRMLoaderPlugin(parser));
        loader.crossOrigin = 'anonymous';
      } catch (e) { reject(new Error('Loader 初始化失败：' + e.message)); return; }
      loader.parse(arrayBuffer, '', gltf => {
        try {
          const v = gltf && gltf.userData && gltf.userData.vrm;
          if (!v) { reject(new Error('文件中没有 VRM 扩展数据')); return; }
          vrm = v; vrmRoot = v.scene;
          if (!vrmRoot) { reject(new Error('VRM 无场景')); return; }
          if (LIB.VRMUtils) {
            try { LIB.VRMUtils.removeUnnecessaryJoints(vrmRoot); } catch (e) {}
            try { if (LIB.VRMUtils.rotateVRM0) LIB.VRMUtils.rotateVRM0(vrmRoot); } catch (e) {}
          }
          const box = new THREE.Box3().setFromObject(vrmRoot);
          const sz = new THREE.Vector3(); box.getSize(sz);
          const k = 1.7 / (sz.y || 1.7);
          vrmRoot.scale.setScalar(k);
          vrmRoot.position.set(-(box.max.x + box.min.x)/2 * k, -box.min.y * k, 0);
          vrmRoot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
          if (root) root.visible = false;
          scene.add(vrmRoot);
          vrmProxy = vrm.expressionManager || vrm.blendShapeProxy || null;
          vrmMouthKey = vrm.expressionManager ? 'aa' : 'a';
          if (vrmProxy && vrm.blendShapeProxy) vrmMouthKey = 'a';
          if (vrm.lookAt) vrm.lookAt.autoUpdate = true;
          S.note = 'VRM 模型已载入';
          resolve(S.note);
        } catch (e) { reject(e); }
      }, e => reject(e && e.message ? new Error(e.message) : e));
    });
  }
  function unloadVRM(){
    if (vrmRoot) { scene.remove(vrmRoot); vrmRoot = null; vrm = null; vrmProxy = null; }
    if (root) root.visible = true;
    S.note = '程序化二次元角色';
  }

  return {
    get ready(){ return S.ready; }, get note(){ return S.note; },
    get hasVRM(){ return !!vrm; },
    get vrmSupported(){ const L = vrmLib(); return !!(L && L.VRMLoaderPlugin && window.THREE && THREE.GLTFLoader); },
    init, render, setPalette, poke, setVisible, loadVRM, unloadVRM, resize,
    // 导出当前立绘为 PNG dataURL（readPixels 翻转后重绘）
    snapshotPNG(){
      if(!renderer) return null;
      try{
        renderer.render(scene,camera);
        const gl=renderer.getContext(); const w=renderer.domElement.width,h=renderer.domElement.height;
        const px=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);
        const c=document.createElement('canvas'); c.width=w; c.height=h;
        const ctx=c.getContext('2d'); const img=ctx.createImageData(w,h);
        for(let y=0;y<h;y++){ const src=(h-1-y)*w*4, dst=y*w*4;
          for(let x=0;x<w*4;x++) img.data[dst+x]=px[src+x]; }
        ctx.putImageData(img,0,0);
        return c.toDataURL('image/png');
      }catch(e){ return null; }
    },
    get stats(){ return renderer ? { calls:renderer.info.render.calls, tris:renderer.info.render.triangles, w:renderer.domElement.width, h:renderer.domElement.height, ctxLost:renderer.getContext().isContextLost() } : null; },
  };
})();
