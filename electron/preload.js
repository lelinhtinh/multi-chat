const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");
const fs = require("fs");

const ICON_NAMES = ["telegram", "messenger", "discord", "gmail", "test", "lock", "lark", "zalo"];

function loadSvg(name) {
  try {
    const filePath = path.join(__dirname, "..", "renderer", "icons", `${name}.svg`);
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn(`Icon ${name} not found at renderer/icons/${name}.svg`, err);
    return null;
  }
}

const iconCache = ICON_NAMES.reduce((acc, name) => {
  const svg = loadSvg(name);
  if (svg) acc[name] = svg;
  return acc;
}, {});

contextBridge.exposeInMainWorld("multiChat", {
  getServices: () => ipcRenderer.invoke("services:list"),
  getState: () => ipcRenderer.invoke("state:get"),
  createTab: (payload) => ipcRenderer.invoke("tabs:create", payload),
  activateTab: (tabId) => ipcRenderer.invoke("tabs:activate", tabId),
  closeTab: (tabId) => ipcRenderer.invoke("tabs:close", tabId),
  renameTab: (tabId, title) => ipcRenderer.invoke("tabs:rename", { tabId, title }),
  setTabPasscode: (tabId, passcode) => ipcRenderer.invoke("tabs:set-passcode", { tabId, passcode }),
  lockTab: (tabId) => ipcRenderer.invoke("tabs:lock", tabId),
  unlockTab: (tabId, passcode) => ipcRenderer.invoke("tabs:unlock", { tabId, passcode }),
  clearTabPasscode: (tabId, passcode) => ipcRenderer.invoke("tabs:clear-passcode", { tabId, passcode }),
  reloadTab: () => ipcRenderer.invoke("tabs:reload"),
  toggleDevtools: () => ipcRenderer.invoke("devtools:toggle"),
  hideActiveView: () => ipcRenderer.invoke("view:hide-active"),
  showActiveView: () => ipcRenderer.invoke("view:show-active"),
  onTabsUpdated: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("tabs:updated", listener);
    return () => ipcRenderer.removeListener("tabs:updated", listener);
  },
  getIcons: () => iconCache
});
