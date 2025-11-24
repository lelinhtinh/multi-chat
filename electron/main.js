const { app, BrowserWindow, WebContentsView, ipcMain, session, Notification } = require("electron");
const path = require("path");
const fs = require("fs");

const SERVICES = [
  { id: "telegram", name: "Telegram", url: "https://web.telegram.org/a", iconKey: "telegram" },
  { id: "messenger", name: "Messenger", url: "https://www.messenger.com/", iconKey: "messenger" },
  { id: "discord", name: "Discord", url: "https://discord.com/app", iconKey: "discord" },
  { id: "gmail", name: "Gmail", url: "https://mail.google.com/mail/u/0", iconKey: "gmail" }
];

const SIDEBAR_WIDTH = 72;
const TOPBAR_HEIGHT = 64;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36";

/** @type {Map<string, {serviceId: string, title: string, color: string, hasNotification: boolean, lastBadgeAt?: number, view: WebContentsView | null}>} */
const tabs = new Map();
let activeTabId = null;
let mainWindow = null;
let stateFilePath = null;
let currentAttachedView = null;
let detachedView = null;
const partitionHandlers = new Set();
const partitionPolicyPatched = new Set();

// Disable Chrome autofill features to avoid DevTools warnings.
app.commandLine.appendSwitch("disable-features", "Autofill,AutofillServerCommunication");
app.commandLine.appendSwitch("disable-blink-features", "Autofill");

// Set App User Model ID (required for notifications on Windows).
app.setAppUserModelId("com.multichat.app");

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
        color: meta.color
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
    title: "Multi Chat",
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
  if (!meta) return;
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
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:${partitionId}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });
  view.webContents.setUserAgent(USER_AGENT);
  view.webContents.loadURL(svc.url).catch((err) => {
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
    const changed = (meta.hasNotification || false) !== has;
    meta.hasNotification = has;
    if (changed) {
      console.log("[notify] tab", tabId, "title:", title, "hasNotification:", has);
      if (has) {
        meta.lastBadgeAt = Date.now();
        showBadgeNotification(tabId, title);
      }
      broadcastTabs();
    }
  });

  view.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    console.log("[notify] permission request", permission, "for tab", tabId);
    if (permission === "notifications") {
      return callback(true);
    }
    callback(false);
  });

  view.webContents.session.setPermissionCheckHandler((wc, permission) => {
    if (permission === "notifications") return true;
    return false;
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
  const allowed = new Set(["notifications", "media", "audioCapture", "videoCapture"]);
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

function createTab({ serviceId, title, color, loadView = true, id: fixedId }) {
  const svc = findService(serviceId);
  if (!svc) return null;
  const id = fixedId || `tab-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const view = loadView ? buildView(serviceId, id) : null;
  tabs.set(id, { serviceId, title: title || svc.name, color, hasNotification: false, view });
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
  if (!meta.view) {
    meta.view = buildView(meta.serviceId, tabId);
  }
  mainWindow.contentView.addChildView(meta.view);
  meta.view.webContents.focus();
  currentAttachedView = meta.view;
  detachedView = null;
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
      hasNotification: meta.hasNotification || false
    }))
  };
  mainWindow.webContents.send("tabs:updated", payload);
}

function removeTab(tabId) {
  if (!tabs.has(tabId)) return;
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
  activeTabId = tabId;
  const meta = tabs.get(tabId);
  if (meta) {
    meta.hasNotification = false;
  }
  attachTabView(tabId);
  layoutActiveView();
  persistState();
  broadcastTabs();
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
        const loadView = tab.id === saved.activeTabId;
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
      color: meta.color
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
