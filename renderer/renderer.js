const serviceList = document.getElementById("service-list");
const tabsContainer = document.getElementById("tabs");
const tabLeftBtn = document.getElementById("tab-left");
const tabRightBtn = document.getElementById("tab-right");
const placeholder = document.getElementById("placeholder");

const COLOR_PALETTE = [
  "#5ef2d6",
  "#ffb347",
  "#7aa2f7",
  "#f7768e",
  "#9ece6a",
  "#c0caf5",
  "#ff9e64",
  "#e0af68"
];

let services = [];
let icons = {};
let tabs = [];
let activeTabId = null;
let currentMenu = null;
let overlayOpen = false;
let isDraggingTabs = false;
let dragPending = false;
let dragTimer = null;
let dragPointerId = null;
let dragStartX = 0;
let dragStartScroll = 0;
let ignoreClick = false;

function createPrompt(defaultValue = "") {
  return new Promise((resolve) => {
    overlayOpen = true;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    const label = document.createElement("label");
    label.textContent = "Nhập tên tab";
    const input = document.createElement("input");
    input.type = "text";
    input.value = defaultValue;
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const ok = document.createElement("button");
    ok.textContent = "OK";
    const cancel = document.createElement("button");
    cancel.textContent = "Hủy";
    cancel.className = "ghost";

    actions.append(ok, cancel);
    modal.append(label, input, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    input.focus();

    const cleanup = () => {
      backdrop.remove();
      overlayOpen = false;
    };
    const submit = () => {
      const val = input.value.trim();
      cleanup();
      resolve(val);
    };
    const abort = () => {
      cleanup();
      resolve(null);
    };

    ok.addEventListener("click", submit);
    cancel.addEventListener("click", abort);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) abort();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") abort();
    });
  });
}

function getService(id) {
  return services.find((s) => s.id === id);
}

function pickColor() {
  const used = new Set(tabs.map((t) => t.color));
  const available = COLOR_PALETTE.filter((c) => !used.has(c));
  const pool = available.length ? available : COLOR_PALETTE;
  return pool[Math.floor(Math.random() * pool.length)];
}

function renderSidebar() {
  serviceList.innerHTML = "";
  services.forEach((svc) => {
    const btn = document.createElement("button");
    btn.className = "service-btn";
    btn.title = svc.name;
    const iconHtml = icons[svc.iconKey];
    if (iconHtml) {
      btn.innerHTML = iconHtml;
    } else {
      btn.textContent = svc.icon || svc.name[0];
    }
    btn.addEventListener("click", () => promptNewTab(svc.id));
    btn.addEventListener("click", (e) => e.stopPropagation());
    serviceList.appendChild(btn);
  });
}

function renderTabs() {
  tabsContainer.innerHTML = "";
  tabs.forEach((tab) => {
    const svc = getService(tab.serviceId);
    const btn = document.createElement("button");
    btn.className = `tab ${activeTabId === tab.id ? "active" : ""}`;
    btn.style.borderColor = tab.color;
    const iconSpan = document.createElement("span");
    iconSpan.className = "icon";
    if (tab.hasNotification) {
      iconSpan.style.color = tab.color;
    }
    const iconHtml = icons[svc?.iconKey];
    if (iconHtml) {
      iconSpan.innerHTML = iconHtml;
    } else {
      iconSpan.textContent = svc?.icon || "●";
    }
    const label = document.createElement("span");
    label.className = "tab-label";
    if (tab.title.length > 14) {
      label.classList.add("marquee");
      const inner = document.createElement("span");
      inner.textContent = tab.title;
      label.appendChild(inner);
    } else {
      label.textContent = tab.title;
    }
    btn.append(iconSpan, label);
    btn.addEventListener("click", () => window.multiChat.activateTab(tab.id));
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showTabMenu(tab, e);
    });
    tabsContainer.appendChild(btn);
  });

  if (placeholder) {
    if (!activeTabId) {
      placeholder.textContent = "Chọn dịch vụ ở sidebar để mở.";
    } else {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      const svc = getService(activeTab?.serviceId);
      placeholder.textContent = `Đang mở ${activeTab?.title || svc?.name || ""}.`;
    }
  }
}

async function promptNewTab(serviceId) {
  const svc = getService(serviceId);
  if (!svc) return;
  await window.multiChat.hideActiveView?.();
  const name = await createPrompt(svc.name);
  if (name === null) {
    await window.multiChat.showActiveView?.();
    return; // cancelled
  }
  const title = name || svc.name;
  const color = pickColor();
  await window.multiChat.createTab({ serviceId, title, color });
  await window.multiChat.showActiveView?.();
}

async function closeMenu(showView = false) {
  if (currentMenu) {
    currentMenu.remove();
    currentMenu = null;
  }
  if (showView && !overlayOpen) {
    await window.multiChat.showActiveView?.();
  }
}

async function showTabMenu(tab, e) {
  await window.multiChat.hideActiveView?.();
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.addEventListener("click", (ev) => ev.stopPropagation());
  menu.addEventListener("contextmenu", (ev) => ev.preventDefault());
  const renameBtn = document.createElement("button");
  renameBtn.textContent = "Đổi tên tab";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Xóa tab";

  renameBtn.addEventListener("click", async () => {
    closeMenu();
    const newName = await createPrompt(tab.title);
    if (newName !== null && newName.trim()) {
      await window.multiChat.renameTab?.(tab.id, newName.trim());
    }
    await window.multiChat.showActiveView?.();
  });

  closeBtn.addEventListener("click", async () => {
    await closeMenu();
    await window.multiChat.closeTab?.(tab.id);
  });

  menu.append(renameBtn, closeBtn);
  document.body.appendChild(menu);

  // Position within viewport bounds.
  const { clientX, clientY } = e;
  const menuRect = menu.getBoundingClientRect();
  const maxLeft = window.innerWidth - menuRect.width - 8;
  const maxTop = window.innerHeight - menuRect.height - 8;
  menu.style.left = `${Math.max(8, Math.min(maxLeft, clientX))}px`;
  menu.style.top = `${Math.max(8, Math.min(maxTop, clientY))}px`;

  currentMenu = menu;
}

document.addEventListener("click", (ev) => {
  if (overlayOpen) return;
  if (currentMenu && currentMenu.contains(ev.target)) return;
  closeMenu(true);
});

window.addEventListener("keydown", (e) => {
  const isToggle = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "i";
  if (isToggle) {
    e.preventDefault();
    window.multiChat.toggleDevtools?.();
  }
});

function handleTabsUpdate(payload) {
  tabs = payload.tabs || [];
  activeTabId = payload.activeTabId || null;
  renderTabs();
  updateTabArrows();
}

async function init() {
  const state = (await window.multiChat.getState?.()) || {};
  services = state.services || (await window.multiChat.getServices?.()) || [];
  icons = window.multiChat.getIcons ? window.multiChat.getIcons() : {};
  tabs = state.tabs || [];
  activeTabId = state.activeTabId || null;
  renderSidebar();
  renderTabs();
  window.multiChat.onTabsUpdated?.(handleTabsUpdate);
  updateTabArrows();
}

tabLeftBtn?.addEventListener("click", () => scrollTabs(-1));
tabRightBtn?.addEventListener("click", () => scrollTabs(1));
tabsContainer?.addEventListener(
  "click",
  (e) => {
    if (ignoreClick) {
      e.preventDefault();
      e.stopPropagation();
      ignoreClick = false;
    }
  },
  true
);
tabsContainer?.addEventListener("scroll", () => updateTabArrows());

init();

function scrollTabs(direction) {
  const amount = 150 * direction;
  tabsContainer.scrollBy({ left: amount, behavior: "smooth" });
  setTimeout(updateTabArrows, 200);
}

function updateTabArrows() {
  if (!tabsContainer || !tabLeftBtn || !tabRightBtn) return;
  const maxScroll = tabsContainer.scrollWidth - tabsContainer.clientWidth;
  const hasOverflow = maxScroll > 2;
  tabLeftBtn.style.visibility = hasOverflow ? "visible" : "hidden";
  tabRightBtn.style.visibility = hasOverflow ? "visible" : "hidden";
  tabLeftBtn.disabled = tabsContainer.scrollLeft <= 0;
  tabRightBtn.disabled = tabsContainer.scrollLeft >= maxScroll - 2;
}

function startDrag(e) {
  if (!tabsContainer) return;
  isDraggingTabs = true;
  ignoreClick = true;
  dragPointerId = e.pointerId;
  tabsContainer.setPointerCapture(e.pointerId);
}

tabsContainer?.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragPending = true;
  dragStartX = e.clientX;
  dragStartScroll = tabsContainer.scrollLeft;
  dragPointerId = e.pointerId;
  dragTimer = setTimeout(() => {
    if (dragPending) {
      startDrag(e);
    }
  }, 200);
});

tabsContainer?.addEventListener("pointermove", (e) => {
  if (!dragPending && !isDraggingTabs) return;
  const delta = dragStartX - e.clientX;
  if (!isDraggingTabs) {
    if (Math.abs(delta) > 5) {
      clearTimeout(dragTimer);
      dragPending = false;
      startDrag(e);
    } else {
      return;
    }
  }
  tabsContainer.scrollLeft = dragStartScroll + delta;
  updateTabArrows();
});

function endDrag(e) {
  if (dragTimer) clearTimeout(dragTimer);
  dragPending = false;
  if (isDraggingTabs) {
    if (dragPointerId !== null) {
      try {
        tabsContainer.releasePointerCapture(dragPointerId);
      } catch (_err) {
        // ignore
      }
    }
  }
  isDraggingTabs = false;
  dragPointerId = null;
}

tabsContainer?.addEventListener("pointerup", endDrag);
tabsContainer?.addEventListener("pointercancel", endDrag);
