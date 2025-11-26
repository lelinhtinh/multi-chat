const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  Notification,
  desktopCapturer
} = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const crypto = require("crypto");

const APP_NAME = "Multi Chat";

const SERVICES = [
  { id: "telegram", name: "Telegram", url: "https://web.telegram.org/a", iconKey: "telegram" },
  { id: "messenger", name: "Messenger", url: "https://www.messenger.com/", iconKey: "messenger" },
  { id: "discord", name: "Discord", url: "https://discord.com/app", iconKey: "discord" },
  { id: "lark", name: "Lark", url: "https://www.larksuite.com/messenger", iconKey: "lark" },
  { id: "zalo", name: "Zalo", url: "https://chat.zalo.me/", iconKey: "zalo" },
  { id: "gmail", name: "Gmail", url: "https://mail.google.com/mail/u/0", iconKey: "gmail" },
  { id: "local-test", name: "Local API Test", url: "local-test", iconKey: "test" }
];

const SIDEBAR_WIDTH = 72;
const TOPBAR_HEIGHT = 64;
const APP_ICON = path.join(__dirname, "..", "build", "icons", "icon.ico");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36";

/** @type {Map<string, {serviceId: string, title: string, color: string, hasNotification: boolean, lastBadgeAt?: number, view: WebContentsView | null, passcodeHash?: string | null, locked?: boolean}>} */
const tabs = new Map();
let activeTabId = null;
let mainWindow = null;
let stateFilePath = null;
let currentAttachedView = null;
let detachedView = null;
const partitionHandlers = new Set();
const mediaHandlers = new Set();
let defaultMediaPatched = false;
const partitionPolicyPatched = new Set();
let mediaPickerInProgress = false;
const lockTimers = new Map();
let titleUpdateTimer = null;
let pendingTitleLabel = null;
let lastAppliedTitle = "";

// Disable Chrome autofill features to avoid DevTools warnings.
app.commandLine.appendSwitch("disable-features", "Autofill,AutofillServerCommunication");
app.commandLine.appendSwitch("disable-blink-features", "Autofill");

// Set App User Model ID (required for notifications on Windows).
app.setAppUserModelId("com.multichat.app");

function setAppTitle(label) {
  if (!mainWindow) return;
  const nextTitle = label ? `${APP_NAME} - ${label}` : APP_NAME;
  mainWindow.setTitle(nextTitle);
  lastAppliedTitle = label || "";
  pendingTitleLabel = null;
  if (titleUpdateTimer) {
    clearTimeout(titleUpdateTimer);
    titleUpdateTimer = null;
  }
}

function scheduleActiveAppTitle(label) {
  if (!mainWindow) return;
  if (label === lastAppliedTitle) return;
  pendingTitleLabel = label || "";
  if (titleUpdateTimer) return;
  titleUpdateTimer = setTimeout(() => {
    titleUpdateTimer = null;
    if (pendingTitleLabel !== lastAppliedTitle) {
      setAppTitle(pendingTitleLabel);
    }
  }, 400);
}

function hashPasscode(passcode) {
  const input = typeof passcode === "string" ? passcode.trim() : "";
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stripUnloadPermissionPolicy(sess) {
  if (partitionPolicyPatched.has(sess)) return;
  sess.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "permissions-policy");
    if (key && Array.isArray(headers[key])) {
      const sanitized = headers[key]
        .map((val) => val.replace(/\s*unload=[^;,]+[;,]?\s*/gi, "").trim())
        .filter(Boolean);
      if (sanitized.length > 0) {
        headers[key] = sanitized;
      } else {
        delete headers[key];
      }
    }
    callback({ responseHeaders: headers });
  });
  partitionPolicyPatched.add(sess);
}

function toggleActiveDevtools() {
  if (!activeTabId) return;
  const meta = tabs.get(activeTabId);
  const wc = meta?.view?.webContents;
  if (!wc) return;
  if (wc.isDevToolsOpened()) {
    wc.closeDevTools();
  } else {
    wc.openDevTools({ mode: "detach" });
  }
}

function getStateFile() {
  if (!stateFilePath) {
    stateFilePath = path.join(app.getPath("userData"), "multi-chat-state.json");
  }
  return stateFilePath;
}

function loadState() {
  try {
    const raw = fs.readFileSync(getStateFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
      activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : null
    };
  } catch (_err) {
    return { tabs: [], activeTabId: null };
  }
}

function persistState() {
  try {
    fs.mkdirSync(path.dirname(getStateFile()), { recursive: true });
    const payload = {
      tabs: Array.from(tabs.entries()).map(([id, meta]) => ({
        id,
        serviceId: meta.serviceId,
        title: meta.title,
        color: meta.color,
        passcodeHash: meta.passcodeHash || null,
        locked: !!meta.locked
      })),
      activeTabId
    };
    fs.writeFileSync(getStateFile(), JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.warn("Failed to persist state", err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_NAME,
    icon: APP_ICON,
    titleBarStyle: "default",
    frame: true,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(true);

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    const isToggle = (input.control || input.meta) && input.shift && key === "i";
    const isF12 = key === "f12";
    if (isToggle || isF12) {
      event.preventDefault();
      toggleActiveDevtools();
    }
  });

  mainWindow.on("resize", () => {
    layoutActiveView();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function findService(id) {
  return SERVICES.find((svc) => svc.id === id);
}

function layoutActiveView() {
  if (!mainWindow || !activeTabId) return;
  const meta = tabs.get(activeTabId);
  if (!meta || meta.locked || !meta.view) return;
  currentAttachedView = meta.view;
  const { width, height } = mainWindow.getContentBounds();
  const w = Math.max(200, width - SIDEBAR_WIDTH);
  const h = Math.max(200, height - TOPBAR_HEIGHT);
  meta.view.setBounds({
    x: SIDEBAR_WIDTH,
    y: TOPBAR_HEIGHT,
    width: w,
    height: h
  });
}

function buildView(serviceId, partitionId) {
  const svc = findService(serviceId);
  if (!svc) return null;
  ensureNotificationPermission(partitionId);
  ensureMediaPermission(partitionId);
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:${partitionId}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });
  view.webContents.setUserAgent(USER_AGENT);
  const targetUrl =
    svc.url === "local-test"
      ? pathToFileURL(path.join(__dirname, "..", "renderer", "local-test", "index.html")).href
      : svc.url;
  view.webContents
    .loadURL(targetUrl)
    .catch((err) => {
      console.error("Failed to load service", serviceId, err);
    });
  attachNotificationListener(view, partitionId);
  return view;
}

function detectNotificationFromTitle(title) {
  if (!title) return false;
  return /[\[\(\{]?\d+[\]\)\}]?/.test(title) || title.includes("•");
}

function showBadgeNotification(tabId, pageTitle) {
  const meta = tabs.get(tabId);
  if (!meta) return;
  const svc = findService(meta.serviceId);
  const title = svc ? `${svc.name} có thông báo` : "Có thông báo mới";
  const body = pageTitle && pageTitle.trim() ? pageTitle : meta.title || svc?.name || "";
  try {
    const n = new Notification({
      title,
      body,
      silent: true
    });
    n.show();
  } catch (err) {
    console.warn("Failed showing badge notification", err);
  }
}

function attachNotificationListener(view, tabId) {
  view.webContents.on("page-title-updated", (_event, title) => {
    const has = detectNotificationFromTitle(title);
    const meta = tabs.get(tabId);
    if (!meta) return;
    // If already has notification and still inactive, avoid toggling off due to title changes.
    if (meta.hasNotification && !has && tabId !== activeTabId) {
      return;
    }
    const changed = (meta.hasNotification || false) !== has;
    meta.hasNotification = has;
    if (changed) {
      console.log("[notify] tab", tabId, "title:", title, "hasNotification:", has);
      if (has && tabId !== activeTabId) {
        meta.lastBadgeAt = Date.now();
        showBadgeNotification(tabId, title);
      }
      broadcastTabs();
    }
    if (tabId === activeTabId && !meta.locked) {
      scheduleActiveAppTitle(title || meta.title || findService(meta.serviceId)?.name || APP_NAME);
    }
  });

  view.webContents.on("notification", (_event, notification, callback) => {
    console.log("[notify] web notification event", tabId, notification.title);
    try {
      const n = new Notification({
        title: notification.title,
        body: notification.body || "",
        silent: !!notification.silent,
        icon: notification.icon
      });
      n.show();
    } catch (err) {
      console.warn("Failed forwarding notification", err);
    }
    if (typeof callback === "function") callback(true);
  });
}

function ensureNotificationPermission(partitionId) {
  if (partitionHandlers.has(partitionId)) return;
  const sess = session.fromPartition(`persist:${partitionId}`);
  stripUnloadPermissionPolicy(sess);
  console.log("[notify] setup permission handlers for partition", partitionId);
  const allowed = new Set([
    "notifications",
    "media",
    "camera",
    "microphone",
    "display-capture",
    "audioCapture",
    "videoCapture",
    "fullscreen"
  ]);
  sess.setPermissionRequestHandler((_, permission, callback) => {
    if (allowed.has(permission)) {
      return callback(true);
    }
    callback(false);
  });
  sess.setPermissionCheckHandler((_, permission) => {
    if (allowed.has(permission)) return true;
    return false;
  });
  partitionHandlers.add(partitionId);
}

function ensureMediaPermission(partitionId) {
  const key = `media:${partitionId}`;
  if (mediaHandlers.has(key)) return;
  const sess = session.fromPartition(`persist:${partitionId}`);
  const allowed = new Set([
    "notifications",
    "media",
    "camera",
    "microphone",
    "display-capture",
    "audioCapture",
    "videoCapture",
    "fullscreen"
  ]);
  console.log("[media] setup handlers for partition", partitionId);
  sess.setPermissionRequestHandler((details, permission, callback) => {
    console.log("[media] permission request", permission, "origin", details?.embeddingOrigin);
    if (allowed.has(permission)) {
      return callback(true);
    }
    callback(false);
  });
  sess.setPermissionCheckHandler((_, permission) => {
    return allowed.has(permission);
  });
  if (typeof sess.setDisplayMediaRequestHandler === "function") {
    sess.setDisplayMediaRequestHandler((details, callback) => {
      console.log("[media] display capture request", details);
      handleDisplayMediaRequest(details, callback);
    });
  }
  mediaHandlers.add(key);

  // Also patch defaultSession once for getDisplayMedia fallbacks.
  if (!defaultMediaPatched) {
    const ds = session.defaultSession;
    if (typeof ds.setDisplayMediaRequestHandler === "function") {
      ds.setDisplayMediaRequestHandler((details, callback) => {
        console.log("[media] defaultSession display capture request", details);
        handleDisplayMediaRequest(details, callback);
      });
    }
    defaultMediaPatched = true;
  }
}

async function handleDisplayMediaRequest(details, callback) {
  let settled = false;
  const safeCallback = (result) => {
    if (settled) return;
    settled = true;
    try {
      callback(result);
    } catch (_err) {
      // ignore follow-up failures
    }
  };

  // Prevent overlapping pickers if multiple requests race.
  if (mediaPickerInProgress) {
    console.warn("[media] picker already open, denying request");
    safeCallback({ video: null, audio: null });
    return;
  }

  mediaPickerInProgress = true;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      fetchWindowIcons: true,
      thumbnailSize: { width: 320, height: 200 }
    });
    if (!sources.length) {
      console.warn("[media] no capture sources available");
      safeCallback({ video: null, audio: null });
      return;
    }

    const selectedIndex = await showMediaPickerWindow(sources);
    if (selectedIndex === null) {
      console.log("[media] user cancelled screen share picker");
      safeCallback({ video: null, audio: null });
      return;
    }

    const source = sources[selectedIndex];
    if (!source) {
      console.warn("[media] invalid picker selection index", selectedIndex);
      safeCallback({ video: null, audio: null });
      return;
    }

    safeCallback({
      video: source,
      audio: details?.audioRequested ? "loopback" : null
    });
  } catch (err) {
    console.warn("[media] display capture handler error", err);
    safeCallback({ video: null, audio: null });
  } finally {
    mediaPickerInProgress = false;
  }
}

function formatSourceLabel(source, index) {
  if (!source) return `Nguồn ${index + 1}`;
  return source.name || `Nguồn ${index + 1}`;
}

function buildPickerHtml({ channel, items }) {
  const payload = JSON.stringify(items);
  const sanitizedChannel = JSON.stringify(channel);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Chọn nguồn chia sẻ màn hình</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 14px; font-family: "Segoe UI", Arial, sans-serif; background: #0f172a; color: #e2e8f0; }
    h1 { margin: 0 0 10px; font-size: 18px; }
    #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .item { border: 1px solid #1e293b; background: #111827; border-radius: 10px; padding: 8px; cursor: pointer; text-align: left; transition: border-color 120ms ease, transform 120ms ease; color: inherit; }
    .item:hover { border-color: #38bdf8; transform: translateY(-1px); }
    .thumb { width: 100%; height: 120px; border-radius: 6px; object-fit: cover; background: #0b1224; display: block; margin-bottom: 6px; }
    .label { display: block; font-size: 13px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #actions { margin-top: 10px; text-align: right; }
    button.action { padding: 8px 12px; border-radius: 8px; border: 1px solid #1e293b; background: #0b1224; color: #e2e8f0; cursor: pointer; }
    button.action:hover { border-color: #38bdf8; color: #38bdf8; }
  </style>
</head>
<body>
  <h1>Chọn cửa sổ hoặc màn hình</h1>
  <div id="grid"></div>
  <div id="actions"><button class="action" id="cancel">Hủy</button></div>
  <script>
    const { ipcRenderer } = require("electron");
    const channel = ${sanitizedChannel};
    const items = ${payload};
    const grid = document.getElementById("grid");
    const sendChoice = (index) => ipcRenderer.send(channel, index);
    items.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.className = "item";
      btn.title = item.label;
      const img = document.createElement("img");
      img.className = "thumb";
      img.alt = item.label;
      img.src = item.thumbnail || "";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;
      btn.append(img, label);
      btn.addEventListener("click", () => sendChoice(idx));
      btn.addEventListener("dblclick", () => sendChoice(idx));
      grid.appendChild(btn);
    });
    document.getElementById("cancel").addEventListener("click", () => sendChoice(null));
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") sendChoice(null); });
  </script>
</body>
</html>`;
}

function showMediaPickerWindow(sources) {
  return new Promise((resolve) => {
    const pickerId = `media-picker-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const channel = `media-picker:choose:${pickerId}`;
    const items = sources.map((s, idx) => ({
      id: s.id,
      label: formatSourceLabel(s, idx),
      thumbnail: s.thumbnail?.toDataURL?.() || ""
    }));

    const picker = new BrowserWindow({
      width: 520,
      height: 600,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: "#0f172a",
      title: "Chọn nguồn chia sẻ màn hình",
      parent: mainWindow ?? undefined,
      modal: !!mainWindow,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false
      }
    });

    let done = false;
    const finish = (index) => {
      if (done) return;
      done = true;
      ipcMain.removeAllListeners(channel);
      if (!picker.isDestroyed()) {
        picker.close();
      }
      resolve(typeof index === "number" ? index : null);
    };

    ipcMain.once(channel, (_event, index) => finish(index));
    picker.on("closed", () => finish(null));

    const html = buildPickerHtml({ channel, items });
    picker.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

function clearAutoLock(tabId) {
  const timer = lockTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
  }
  lockTimers.delete(tabId);
}

function scheduleAutoLock(tabId) {
  const meta = tabs.get(tabId);
  if (!meta || !meta.passcodeHash || meta.locked) return;
  clearAutoLock(tabId);
  const handle = setTimeout(() => {
    lockTab(tabId);
  }, 15 * 60 * 1000);
  lockTimers.set(tabId, handle);
}

function detachTabView(tabId) {
  const meta = tabs.get(tabId);
  if (!meta?.view || !mainWindow) return;
  const targetView = meta.view;
  try {
    mainWindow.contentView.removeChildView(targetView);
  } catch (_err) {
    // ignore
  }
  try {
    targetView.setVisible(false);
    targetView.setBounds({ x: -5000, y: -5000, width: 1, height: 1 });
  } catch (_err) {
    // ignore
  }
  if (currentAttachedView === targetView) {
    currentAttachedView = null;
  }
  if (activeTabId === tabId) {
    detachedView = null;
  }
}

function lockTab(tabId) {
  const meta = tabs.get(tabId);
  if (!meta) return { ok: false, reason: "not_found" };
  if (!meta.passcodeHash) return { ok: false, reason: "no_passcode" };
  meta.locked = true;
  clearAutoLock(tabId);
  if (activeTabId === tabId) {
    detachTabView(tabId);
  }
  persistState();
  broadcastTabs();
  return { ok: true };
}

function ensureViewForTab(tabId) {
  const meta = tabs.get(tabId);
  if (!meta || meta.locked) return null;
  if (!meta.view) {
    meta.view = buildView(meta.serviceId, tabId);
  }
  return meta.view;
}

function unlockTab(tabId, passcode) {
  const meta = tabs.get(tabId);
  if (!meta) return { ok: false, reason: "not_found" };
  if (meta.passcodeHash) {
    const hashed = hashPasscode(passcode);
    if (hashed !== meta.passcodeHash) {
      return { ok: false, reason: "invalid_passcode" };
    }
  }
  meta.locked = false;
  clearAutoLock(tabId);
  ensureViewForTab(tabId);
  if (activeTabId === tabId) {
    attachTabView(tabId);
    layoutActiveView();
  }
  persistState();
  broadcastTabs();
  return { ok: true };
}

function setTabPasscode(tabId, passcode) {
  const meta = tabs.get(tabId);
  if (!meta) return { ok: false, reason: "not_found" };
  const trimmed = typeof passcode === "string" ? passcode.trim() : "";
  if (!trimmed) return { ok: false, reason: "empty_passcode" };
  meta.passcodeHash = hashPasscode(trimmed);
  meta.locked = true;
  clearAutoLock(tabId);
  if (activeTabId === tabId) {
    detachTabView(tabId);
  }
  persistState();
  broadcastTabs();
  return { ok: true };
}

function clearTabPasscode(tabId, passcode) {
  const meta = tabs.get(tabId);
  if (!meta) return { ok: false, reason: "not_found" };
  if (!meta.passcodeHash) return { ok: false, reason: "no_passcode" };
  const hashed = hashPasscode(passcode);
  if (hashed !== meta.passcodeHash) {
    return { ok: false, reason: "invalid_passcode" };
  }
  meta.passcodeHash = null;
  meta.locked = false;
  clearAutoLock(tabId);
  ensureViewForTab(tabId);
  if (activeTabId === tabId) {
    attachTabView(tabId);
    layoutActiveView();
  }
  persistState();
  broadcastTabs();
  return { ok: true };
}

function createTab({ serviceId, title, color, loadView = true, id: fixedId, passcodeHash = null, locked = false }) {
  const svc = findService(serviceId);
  if (!svc) return null;
  const id = fixedId || `tab-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const shouldLock = locked || !!passcodeHash;
  const view = loadView && !shouldLock ? buildView(serviceId, id) : null;
  tabs.set(id, {
    serviceId,
    title: title || svc.name,
    color,
    hasNotification: false,
    view,
    passcodeHash: passcodeHash || null,
    locked: shouldLock
  });
  persistState();
  return { id, serviceId, title: title || svc.name, color };
}

function attachTabView(tabId) {
  const meta = tabs.get(tabId);
  if (!meta || !mainWindow) return;
  if (currentAttachedView) {
    try {
      mainWindow.contentView.removeChildView(currentAttachedView);
    } catch (err) {
      console.warn("Failed removing previous view", err);
    }
  }
  if (meta.locked) {
    currentAttachedView = null;
    detachedView = null;
    return;
  }
  if (!meta.view) {
    meta.view = buildView(meta.serviceId, tabId);
  }
  if (meta.view) {
    mainWindow.contentView.addChildView(meta.view);
    meta.view.webContents.focus();
    currentAttachedView = meta.view;
    detachedView = null;
  }
}

function broadcastTabs() {
  if (!mainWindow) return;
  const payload = {
    activeTabId,
    tabs: Array.from(tabs.entries()).map(([id, meta]) => ({
      id,
      serviceId: meta.serviceId,
      title: meta.title,
      color: meta.color,
      hasNotification: meta.hasNotification || false,
      locked: !!meta.locked,
      hasPasscode: !!meta.passcodeHash
    }))
  };
  mainWindow.webContents.send("tabs:updated", payload);
}

function removeTab(tabId) {
  if (!tabs.has(tabId)) return;
  clearAutoLock(tabId);
  const meta = tabs.get(tabId);
  if (meta?.view) {
    try {
      mainWindow?.contentView.removeChildView(meta.view);
    } catch (_err) {
      // ignore
    }
    try {
      meta.view.webContents.destroy();
    } catch (_err) {
      // ignore
    }
  }
  tabs.delete(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
    currentAttachedView = null;
    const next = tabs.keys().next().value;
    if (next) {
      activateTab(next);
    } else {
      broadcastTabs();
    }
  } else {
    broadcastTabs();
  }
  persistState();
}

function activateTab(tabId) {
  if (!tabs.has(tabId) || !mainWindow) return;
  const previous = activeTabId;
  if (previous && previous !== tabId) {
    scheduleAutoLock(previous);
  }
  activeTabId = tabId;
  clearAutoLock(tabId);
  const meta = tabs.get(tabId);
  if (meta) {
    meta.hasNotification = false;
  }
  attachTabView(tabId);
  layoutActiveView();
  persistState();
  broadcastTabs();
  const label = meta?.title || findService(meta?.serviceId)?.name || APP_NAME;
  setAppTitle(label);
}

function hideActiveView() {
  if (!mainWindow || !activeTabId) return;
  const meta = tabs.get(activeTabId);
  const targetView = currentAttachedView || meta?.view;
  if (!targetView) return;
  try {
    mainWindow.contentView.removeChildView(targetView);
  } catch (_err) {
    // ignore
  }
  try {
    targetView.setVisible(false);
    targetView.setBounds({ x: -5000, y: -5000, width: 1, height: 1 });
  } catch (_err) {
    // ignore
  }

  detachedView = targetView;
  currentAttachedView = null;
}

function showActiveView() {
  if (!mainWindow || !activeTabId) return;
  console.log("[view] showActiveView", { activeTabId, hasDetached: !!detachedView });
  const meta = tabs.get(activeTabId);
  if (meta?.locked) {
    detachTabView(activeTabId);
    return;
  }
  if (detachedView) {
    try {
      mainWindow.contentView.addChildView(detachedView);
      currentAttachedView = detachedView;
      detachedView = null;
    } catch (_err) {
      // ignore and fallback
    }
  } else {
    attachTabView(activeTabId);
  }
  if (currentAttachedView) {
    try {
      currentAttachedView.setVisible(true);
    } catch (_err) {
      // ignore
    }
  }
  layoutActiveView();
}

function restoreState() {
  const saved = loadState();
  if (saved.tabs && saved.tabs.length > 0) {
    saved.tabs.forEach((tab) => {
      if (findService(tab.serviceId)) {
        // Only active tab will load view immediately; others lazy.
        const loadView = tab.id === saved.activeTabId && !tab.locked && !tab.passcodeHash;
        createTab({ ...tab, loadView });
      }
    });
    if (saved.activeTabId && tabs.has(saved.activeTabId)) {
      activateTab(saved.activeTabId);
    }
  } else {
    broadcastTabs();
  }
}

ipcMain.handle("services:list", async () => SERVICES);

ipcMain.handle("tabs:create", async (_event, { serviceId, title, color }) => {
  const tab = createTab({ serviceId, title, color });
  if (tab) {
    activateTab(tab.id);
  }
  return tab;
});

ipcMain.handle("tabs:activate", async (_event, tabId) => {
  activateTab(tabId);
});

ipcMain.handle("tabs:close", async (_event, tabId) => {
  removeTab(tabId);
});

ipcMain.handle("tabs:rename", async (_event, { tabId, title }) => {
  const meta = tabs.get(tabId);
  if (!meta) return;
  meta.title = title || meta.title;
  persistState();
  broadcastTabs();
  if (tabId === activeTabId) {
    const label = meta.title || findService(meta.serviceId)?.name || APP_NAME;
    setAppTitle(label);
  }
});

ipcMain.handle("tabs:set-passcode", async (_event, { tabId, passcode }) => {
  return setTabPasscode(tabId, passcode);
});

ipcMain.handle("tabs:lock", async (_event, tabId) => {
  return lockTab(tabId);
});

ipcMain.handle("tabs:unlock", async (_event, { tabId, passcode }) => {
  return unlockTab(tabId, passcode);
});

ipcMain.handle("tabs:clear-passcode", async (_event, { tabId, passcode }) => {
  return clearTabPasscode(tabId, passcode);
});

ipcMain.handle("tabs:reload", async () => {
  if (activeTabId) {
    const meta = tabs.get(activeTabId);
    meta?.view?.webContents?.reload();
  }
});

ipcMain.handle("state:get", async () => {
  return {
    services: SERVICES,
    tabs: Array.from(tabs.entries()).map(([id, meta]) => ({
      id,
      serviceId: meta.serviceId,
      title: meta.title,
      color: meta.color,
      locked: !!meta.locked,
      hasPasscode: !!meta.passcodeHash
    })),
    activeTabId
  };
});

ipcMain.handle("devtools:toggle", async () => {
  toggleActiveDevtools();
});

ipcMain.handle("view:hide-active", async () => {
  hideActiveView();
});

ipcMain.handle("view:show-active", async () => {
  showActiveView();
});

ipcMain.handle("notify", async (_event, payload) => {
  const { title, body = "", silent = false, icon } = payload || {};
  console.log("[notify] IPC notify", { title, body, silent, icon });
  const n = new Notification({
    title: title || "Notification",
    body,
    silent: !!silent,
    icon
  });
  n.show();
});

app.whenReady().then(() => {
  stripUnloadPermissionPolicy(session.defaultSession);
  createWindow();
  restoreState();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      restoreState();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
