// ==UserScript==
// @name         GeoFS 卫星地图增强 (ArcGIS + Google HD + 3D建筑 + 控制台)
// @namespace    https://www.geo-fs.com/geofs.php?v=4
// @version      4.0.0
// @description  HD卫星图 + 3D建筑 + 高度修正 + 控制台 | 开源免费
// @author       DeepSeek
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geo-fs.com
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  // ============================================================
  // 1. 配置 - 卫星图源 & 3D建筑
  // ============================================================
  const IMAGERY_SOURCES = {
    arcgis: {
      label: "🌍 ArcGIS 卫星图 (稳定)",
      urls: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "https://ibasemaps.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      ],
      maxLevel: 19,
      type: "multi"
    },
    google: {
      label: "🌍 Google HD 卫星图",
      url: "https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      subdomains: ["mt0", "mt1", "mt2", "mt3"],
      maxLevel: 21,
      type: "single"
    },
    googleHybrid: {
      label: "🗺️ Google 混合图",
      url: "https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      subdomains: ["mt0", "mt1", "mt2", "mt3"],
      maxLevel: 21,
      type: "single"
    },
    esri: {
      label: "🌐 Esri World",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      subdomains: [],
      maxLevel: 19,
      type: "single"
    },
    osm: {
      label: "📌 OpenStreetMap",
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      subdomains: ["a", "b", "c"],
      maxLevel: 19,
      type: "single"
    }
  };

  // ============================================================
  // 2. 状态管理
  // ============================================================
  let currentSource = "arcgis";
  let injected = false;
  let buildingsTileset = null;
  let manualOffset = 0;        // 手动高度偏移 (米)
  let autoOffset = 0;          // 自动采样偏移
  let correctionLoop = null;
  let lastSampleTime = 0;
  let panel = null;
  let isDragging = false;
  let startX, startY, panelX, panelY;
  let offsetDisplay = null;

  // ============================================================
  // 3. 工具函数
  // ============================================================
  function getCesium() {
    return window.Cesium || (window.geofs?.api?.Cesium) || null;
  }
  function getViewer() {
    return (window.geofs?.api?.viewer) || null;
  }

  // Toast 提示队列
  let toastQueue = [];
  let isShowingToast = false;

  function showTip(text, isOk, duration = 3000) {
    toastQueue.push({ text, isOk, duration });
    if (!isShowingToast) processToastQueue();
  }

  function processToastQueue() {
    if (toastQueue.length === 0) { isShowingToast = false; return; }
    isShowingToast = true;
    const { text, isOk, duration } = toastQueue.shift();

    const tip = document.createElement("div");
    tip.style.cssText = `
      position:fixed;top:20px;left:50%;transform:translateX(-50%);
      background:${isOk ? "rgba(0,160,0,0.85)" : "rgba(190,0,0,0.85)"};
      color:#fff;padding:10px 22px;border-radius:8px;z-index:99999;
      font-size:14px;transition:all 0.7s ease;backdrop-filter:blur(4px);
      pointer-events:none;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,0.2);
      max-width:90vw;text-align:center;
    `;
    tip.textContent = text;
    document.body.appendChild(tip);

    setTimeout(() => {
      if (!tip.isConnected) { processToastQueue(); return; }
      tip.style.transform = "translateX(-50%) translateY(-70px)";
      tip.style.opacity = "0";
      setTimeout(() => { tip.remove(); processToastQueue(); }, 700);
    }, duration);
  }

  // ============================================================
  // 4. 卫星图加载 (支持多节点故障切换)
  // ============================================================
  async function applyImagery(sourceKey) {
    const src = IMAGERY_SOURCES[sourceKey];
    const Cesium = getCesium();
    const viewer = getViewer();
    if (!src || !Cesium || !viewer) return;

    // 移除现有图层
    if (viewer.imageryLayers.length > 0) {
      viewer.imageryLayers.removeAll();
    }

    if (src.type === "multi") {
      // 多节点故障切换加载 (ArcGIS)
      for (let i = 0; i < src.urls.length; i++) {
        try {
          const provider = new Cesium.UrlTemplateImageryProvider({
            url: src.urls[i],
            maximumLevel: src.maxLevel,
            credit: new Cesium.Credit(src.label)
          });
          await provider.readyPromise;
          viewer.imageryLayers.addImageryProvider(provider);
          currentSource = sourceKey;
          if (i > 0) showTip(`📍 已切换到备用节点 ${i}`, true);
          showTip(`✅ ${src.label} 加载成功`, true);
          return;
        } catch (e) {
          if (i < src.urls.length - 1) {
            showTip(`⚠️ 节点 ${i + 1} 失败，尝试下一个...`, false, 1500);
          }
        }
      }
      showTip("❌ 所有ArcGIS节点加载失败", false);
    } else {
      // 单源加载 (Google, Esri, OSM)
      const opts = {
        url: src.url,
        maximumLevel: src.maxLevel,
        credit: new Cesium.Credit(src.label)
      };
      if (src.subdomains?.length) opts.subdomains = src.subdomains;

      try {
        const provider = new Cesium.UrlTemplateImageryProvider(opts);
        await provider.readyPromise;
        viewer.imageryLayers.addImageryProvider(provider);
        currentSource = sourceKey;
        showTip(`✅ ${src.label} 加载成功`, true);
      } catch (e) {
        showTip(`❌ ${src.label} 加载失败: ${e.message}`, false);
      }
    }
  }

  // ============================================================
  // 5. 3D 建筑系统
  // ============================================================
  async function load3DBuildings(token) {
    const Cesium = getCesium();
    const viewer = getViewer();
    if (!Cesium || !viewer) return "❌ Cesium/Viewer 不可用";

    Cesium.Ion.defaultAccessToken = token.trim();

    try {
      // 移除已有建筑
      if (buildingsTileset && viewer.scene.primitives.contains(buildingsTileset)) {
        viewer.scene.primitives.remove(buildingsTileset);
        stopLoop();
        buildingsTileset = null;
      }

      let tileset;
      if (typeof Cesium.createOsmBuildingsAsync === "function") {
        tileset = await Cesium.createOsmBuildingsAsync();
      } else {
        const url = await Cesium.IonResource.fromAssetId(96188);
        tileset = new Cesium.Cesium3DTileset({ url });
      }

      viewer.scene.primitives.add(tileset);
      buildingsTileset = tileset;
      startLoop();
      console.log("[GeoFS-Enhancer] ✅ 3D建筑已加载");
      return "✅ 3D建筑已激活!";
    } catch (err) {
      console.error("[GeoFS-Enhancer] ❌ 建筑加载失败:", err);
      if (err.message?.includes("401")) return "❌ Token无效，请检查";
      return "❌ " + (err.message || err);
    }
  }

  function remove3DBuildings() {
    const viewer = getViewer();
    if (viewer && buildingsTileset && viewer.scene.primitives.contains(buildingsTileset)) {
      viewer.scene.primitives.remove(buildingsTileset);
      stopLoop();
      buildingsTileset = null;
      showTip("🗑️ 3D建筑已移除", true);
    }
  }

  // ============================================================
  // 6. 高度修正系统
  // ============================================================
  function startLoop() {
    if (correctionLoop) return;
    function tick() {
      correctionLoop = requestAnimationFrame(tick);
      frameTick();
    }
    tick();
  }

  function stopLoop() {
    if (correctionLoop) { cancelAnimationFrame(correctionLoop); correctionLoop = null; }
  }

  function frameTick() {
    if (!buildingsTileset) return;
    const Cesium = getCesium();
    const viewer = getViewer();
    if (!Cesium || !viewer) return;

    const now = performance.now();
    if ((now - lastSampleTime) > 2000) {
      lastSampleTime = now;
      doTerrainSample(viewer, Cesium);
    }

    const totalOffset = autoOffset + manualOffset;
    const camCarto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    if (!camCarto) return;

    const surface = Cesium.Cartesian3.fromRadians(camCarto.longitude, camCarto.latitude, 0.0);
    const target = Cesium.Cartesian3.fromRadians(camCarto.longitude, camCarto.latitude, totalOffset);
    const translation = Cesium.Cartesian3.subtract(target, surface, new Cesium.Cartesian3());

    buildingsTileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);

    if (offsetDisplay) offsetDisplay.textContent = totalOffset.toFixed(1) + " m";
  }

  async function doTerrainSample(viewer, Cesium) {
    try {
      const tp = viewer.terrainProvider;
      if (!tp?.ready) return;

      const camCarto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
      if (!camCarto) return;

      const pos = [new Cesium.Cartographic(camCarto.longitude, camCarto.latitude)];
      if (typeof Cesium.sampleTerrainMostDetailed === "function") {
        const sampled = await Cesium.sampleTerrainMostDetailed(tp, pos);
        if (sampled?.[0]?.height != null) {
          console.log("[GeoFS-Enhancer] 地形高度:", sampled[0].height.toFixed(2), "m");
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  // ============================================================
  // 7. 控制台 UI (按 D 键呼出)
  // ============================================================
  function showPanel() {
    if (panel) { panel.remove(); panel = null; return; }

    const style = document.createElement("style");
    style.textContent = `
      #geo-panel {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(20,20,30,0.92); backdrop-filter: blur(12px);
        padding: 20px; border-radius: 16px; z-index: 100000;
        min-width: 300px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        border: 1px solid rgba(255,255,255,0.2);
        font-family: 'Segoe UI', sans-serif; color: #fff; cursor: move; user-select: none;
      }
      #geo-panel .close-btn {
        cursor: pointer; position: absolute; top: 12px; right: 12px;
        font-size: 20px; width: 24px; height: 24px; text-align: center;
        border-radius: 50%; background: rgba(255,255,255,0.1);
      }
      #geo-panel .sec-title {
        font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
        color: #5a9fff; margin: 12px 0 6px; font-weight: 600;
      }
      #geo-panel .img-btn {
        display: block; width: 100%; text-align: left;
        background: rgba(30,42,68,0.7); border: 1px solid transparent;
        border-radius: 7px; color: #b0bdd4; padding: 6px 10px;
        margin-bottom: 3px; cursor: pointer; font-size: 13px;
        transition: background 0.15s, border-color 0.15s;
      }
      #geo-panel .img-btn:hover { background: rgba(45,68,115,0.75); }
      #geo-panel .img-btn.active {
        border-color: rgba(90,155,255,0.6); background: rgba(32,62,115,0.85); color: #fff;
      }
      #geo-panel input[type="password"], #geo-panel input[type="text"] {
        width: 100%; box-sizing: border-box;
        background: rgba(20,30,52,0.85); border: 1px solid rgba(80,130,240,0.28);
        border-radius: 6px; color: #c0cce0; padding: 6px 8px;
        font-size: 12px; font-family: 'Consolas', monospace; outline: none;
      }
      #geo-panel input:focus { border-color: rgba(90,155,255,0.65); }
      #geo-panel .btn-row { display: flex; gap: 6px; margin-top: 6px; }
      #geo-panel .btn-row button {
        flex: 1; padding: 6px 0; border: none; border-radius: 6px;
        font-size: 12px; cursor: pointer; font-weight: 600;
        transition: filter 0.15s;
      }
      #geo-panel .btn-load { background: linear-gradient(135deg,#3a7bd5,#2a5ba0); color:#fff; }
      #geo-panel .btn-clear { background: rgba(150,55,55,0.75); color:#f0c0c0; }
      #geo-panel .btn-row button:hover { filter: brightness(1.25); }
      #geo-panel .slider-head {
        display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;
      }
      #geo-panel .slider-head span { font-size: 11px; color: #7a9bb8; }
      #geo-panel .slider-head .val { font-weight: 600; color: #a0c8f0; font-family: 'Consolas', monospace; font-size: 12px; }
      #geo-panel input[type="range"] {
        -webkit-appearance: none; width: 100%; height: 5px;
        background: rgba(40,60,100,0.8); border-radius: 3px; outline: none;
      }
      #geo-panel input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none; width: 16px; height: 16px;
        background: #5a9fff; border-radius: 50%; cursor: pointer;
        box-shadow: 0 0 7px rgba(90,160,255,0.5);
      }
      #geo-panel .reset-btn {
        display: block; width: 100%; margin-top: 5px;
        background: rgba(35,50,80,0.7); border: 1px solid rgba(80,130,240,0.25);
        border-radius: 5px; color: #7a9bb8; padding: 4px 0;
        font-size: 11px; cursor: pointer; text-align: center;
      }
      #geo-panel .reset-btn:hover { background: rgba(50,75,120,0.7); color: #a0c8f0; }
      #geo-panel #geo-status {
        margin-top: 10px; padding: 6px 8px;
        background: rgba(20,28,50,0.7); border-radius: 5px;
        font-size: 11px; min-height: 16px; color: #6a8fa8; word-break: break-all;
      }
      #geo-panel .hint {
        font-size: 10px; color: #4a6a88; margin-top: 8px; text-align: center;
      }
      #geo-panel .hint a { color: #5a90c8; text-decoration: none; }
    `;
    document.head.appendChild(style);

    // 面板 HTML
    panel = document.createElement("div");
    panel.id = "geo-panel";
    panel.innerHTML = `
      <div class="close-btn" id="geo-close">✕</div>
      <div style="text-align:center;margin-bottom:12px;">
        <div style="font-weight:bold;font-size:16px;">🛰️ 地图增强控制台</div>
        <div style="font-size:10px;color:#888;">DeepSeek | 开源免费</div>
      </div>
      <div class="sec-title">🌍 卫星图源</div>
      <div id="geo-img-btns"></div>
      <div class="sec-title">🏙️ 3D 建筑</div>
      <input id="geo-token" type="password" placeholder="Cesium ion Token..." />
      <div class="btn-row">
        <button class="btn-load" id="geo-load-3d">加载</button>
        <button class="btn-clear" id="geo-clear-3d">移除</button>
      </div>
      <div id="geo-height-sec" style="display:none;">
        <div class="sec-title">🕹️ 高度修正</div>
        <div class="slider-head">
          <span>偏移量</span>
          <span class="val" id="geo-offset-val">0.0 m</span>
        </div>
        <input type="range" id="geo-slider" min="-80" max="80" step="1" value="0" />
        <button class="reset-btn" id="geo-reset">↺ 重置为0</button>
      </div>
      <div id="geo-status"></div>
      <div class="hint">
        Token: <a href="https://ion.cesium.com/signup/" target="_blank">ion.cesium.com</a>
      </div>
    `;
    document.body.appendChild(panel);
    offsetDisplay = panel.querySelector("#geo-offset-val");

    // 卫星图按钮
    const btnWrap = panel.querySelector("#geo-img-btns");
    Object.entries(IMAGERY_SOURCES).forEach(([key, src]) => {
      const btn = document.createElement("button");
      btn.className = "img-btn" + (key === currentSource ? " active" : "");
      btn.dataset.source = key;
      btn.textContent = src.label;
      btn.addEventListener("click", () => {
        applyImagery(key);
        panel.querySelectorAll(".img-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      });
      btnWrap.appendChild(btn);
    });

    // 关闭 & 拖拽
    panel.querySelector("#geo-close").onclick = () => { panel.remove(); panel = null; };
    panel.addEventListener("mousedown", e => {
      if (e.target.closest("button, input, .close-btn")) return;
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      const r = panel.getBoundingClientRect();
      panelX = r.left; panelY = r.top;
      panel.style.transition = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", e => {
      if (!isDragging) return;
      let l = panelX + (e.clientX - startX);
      let t = panelY + (e.clientY - startY);
      l = Math.max(0, Math.min(l, window.innerWidth - panel.offsetWidth));
      t = Math.max(0, Math.min(t, window.innerHeight - panel.offsetHeight));
      panel.style.left = l + "px";
      panel.style.top = t + "px";
      panel.style.transform = "none";
    });
    window.addEventListener("mouseup", () => { isDragging = false; });

    // 3D 建筑按钮
    panel.querySelector("#geo-load-3d").onclick = async () => {
      const token = panel.querySelector("#geo-token").value.trim();
      const status = panel.querySelector("#geo-status");
      if (!token) { status.textContent = "⚠️ 请输入Token"; return; }
      status.textContent = "⏳ 加载中...";
      const res = await load3DBuildings(token);
      status.textContent = res;
      if (res.startsWith("✅")) {
        panel.querySelector("#geo-height-sec").style.display = "block";
      }
    };

    panel.querySelector("#geo-clear-3d").onclick = () => {
      remove3DBuildings();
      panel.querySelector("#geo-status").textContent = "🗑️ 3D建筑已移除";
      panel.querySelector("#geo-height-sec").style.display = "none";
    };

    panel.querySelector("#geo-slider").oninput = function () {
      manualOffset = parseFloat(this.value);
    };

    panel.querySelector("#geo-reset").onclick = () => {
      manualOffset = 0;
      panel.querySelector("#geo-slider").value = 0;
    };

    document.addEventListener("keydown", function escClose(e) {
      if (e.key === "Escape") { panel?.remove(); panel = null; }
    });
  }

  // 按 D 键呼出控制台
  document.addEventListener("keydown", e => {
    if ((e.key === "/" || e.key === "?") && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      showPanel();
    }
  });

  // ============================================================
  // 8. 初始化
  // ============================================================
  function tryInit() {
    if (injected) return;
    if (!getCesium() || !getViewer()) return;
    injected = true;
    setTimeout(() => {
      console.log("[GeoFS-Enhancer] 🚀 DeepSeek 增强脚本初始化...");
      applyImagery(currentSource);
      showTip("🛰️ GeoFS 增强脚本已就绪 | 按 / 键打开控制台", true, 5000);
    }, 800);
  }

  let attempts = 0;
  const poller = setInterval(() => {
    tryInit();
    if (injected || ++attempts > 120) clearInterval(poller);
  }, 300);
  window.addEventListener("load", tryInit);
  document.querySelectorAll("body > div.geofs-adbanner.geofs-adsense-container")[0].remove();
})();
