(function () {
  const LOG_PREFIX = "[notify]";
  const DEFAULT_RECONNECT_MS = 1500;
  const MAX_RECONNECT_MS = 15000;
  const MIN_DESKTOP_GAP_MS = 2000;

  const logger = {
    info: (...args) => console.log(LOG_PREFIX, ...args),
    warn: (...args) => console.warn(LOG_PREFIX, ...args),
    error: (...args) => console.error(LOG_PREFIX, ...args)
  };

  const noop = () => undefined;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class AdapterRegistry {
    constructor() {
      this.factories = new Map();
    }

    register(mode, descriptor) {
      this.factories.set(mode, descriptor);
    }

    async supports(mode, ctx) {
      const descriptor = this.factories.get(mode);
      if (!descriptor) return false;
      if (typeof descriptor.supports !== "function") return true;
      try {
        return await descriptor.supports(ctx);
      } catch (err) {
        logger.warn("support check failed for", mode, err);
        return false;
      }
    }

    create(mode, ctx) {
      const descriptor = this.factories.get(mode);
      if (!descriptor || typeof descriptor.create !== "function") return null;
      return descriptor.create(ctx);
    }
  }

  class WebPushAdapter {
    constructor({ service, notifySystem, markActivity }) {
      this.service = service;
      this.registration = null;
      this.subscription = null;
      this.notifySystem = notifySystem || noop;
      this.markActivity = markActivity || noop;
    }

    static supports({ service }) {
      const cfg = service?.deliveryConfig?.webpush;
      if (!cfg) return false;
      if (!window.isSecureContext) return false;
      return "serviceWorker" in navigator && "PushManager" in window;
    }

    get config() {
      return this.service.deliveryConfig?.webpush || {};
    }

    async init() {
      const swPath = this.config.serviceWorkerPath || "sw.js";
      logger.info(`register SW for ${this.service.id} at`, swPath);
      this.registration = await navigator.serviceWorker.register(swPath);
      await navigator.serviceWorker.ready;
      await this.ensureSubscription();
    }

    async ensureSubscription(force = false) {
      if (!this.registration) return null;
      const vapidKey = this.config.vapidPublicKey;
      if (!vapidKey) {
        logger.warn(`service ${this.service.id} missing vapidPublicKey`);
        return null;
      }
      if (!force) {
        const existing = await this.registration.pushManager.getSubscription();
        if (existing) {
          this.subscription = existing;
          await this.syncSubscription(existing);
          return existing;
        }
      }
      const convertedKey = WebPushAdapter.base64ToUint8Array(vapidKey);
      const sub = await this.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedKey
      });
      this.subscription = sub;
      await this.syncSubscription(sub);
      return sub;
    }

    async syncSubscription(subscription) {
      const subscribeUrl = this.config.subscribeUrl;
      if (!subscribeUrl) return subscription;
      try {
        await fetch(subscribeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceId: this.service.id,
            subscription
          })
        });
        logger.info(`synced subscription for ${this.service.id}`);
      } catch (err) {
        logger.warn(`failed syncing subscription for ${this.service.id}`, err);
      }
      return subscription;
    }

    static base64ToUint8Array(base64String) {
      const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }
      return outputArray;
    }

    async notify(payload = {}) {
      if (!this.registration) {
        await this.init();
      }
      const title = payload.title || this.service.name;
      const body = payload.body || payload.message || "";
      const message = {
        serviceId: this.service.id,
        payload,
        channel: payload.channel || "webpush:client"
      };
      let result = { ok: false, reason: "no_controller" };
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(message);
        result = { ok: true, via: "controller" };
      } else if (this.registration?.active) {
        this.registration.active.postMessage(message);
        result = { ok: true, via: "active-worker" };
      } else {
        logger.warn(`service worker controller missing for ${this.service.id}`);
      }
      try {
        await this.notifySystem({ title, body, silent: !!payload.silent, icon: payload.icon });
      } catch (err) {
        logger.warn("notifySystem fallback failed for webpush", err);
      }
      try {
        await this.markActivity({ mode: "webpush", title, body, payload });
      } catch (err) {
        logger.warn("markActivity failed for webpush", err);
      }
      return result;
    }

    async teardown() {
      this.registration = null;
      this.subscription = null;
    }
  }

  class RealtimeAdapter {
    constructor({ service, notifySystem, markActivity }) {
      this.service = service;
      this.notifySystem = notifySystem || noop;
      this.markActivity = markActivity || noop;
      this.wsUrl = service.deliveryConfig?.realtime?.wsUrl;
      this.sseUrl = service.deliveryConfig?.realtime?.sseUrl;
      this.controller = null;
      this.socket = null;
      this.eventSource = null;
      this.reconnectDelay = DEFAULT_RECONNECT_MS;
      this.reconnectTimer = null;
      this.lastDesktopAt = 0;
    }

    static supports({ service }) {
      const cfg = service?.deliveryConfig?.realtime || {};
      return Boolean(cfg.wsUrl || cfg.sseUrl);
    }

    async init() {
      this.attach();
    }

    attach() {
      if (this.wsUrl) {
        this.openWebSocket();
        return;
      }
      if (this.sseUrl) {
        this.openEventSource();
        return;
      }
      logger.warn(`service ${this.service.id} has no realtime endpoint`);
    }

    scheduleReconnect() {
      if (this.reconnectTimer) return;
      const delayMs = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.attach();
      }, delayMs);
      logger.info(`reconnect ${this.service.id} in ${delayMs}ms`);
    }

    resetBackoff() {
      this.reconnectDelay = DEFAULT_RECONNECT_MS;
    }

    openWebSocket() {
      try {
        const socket = new WebSocket(this.wsUrl);
        this.socket = socket;
        socket.addEventListener("open", () => {
          logger.info(`ws open for ${this.service.id}`);
          this.resetBackoff();
        });
        socket.addEventListener("message", (event) => this.handleIncoming(event.data));
        socket.addEventListener("close", () => {
          logger.warn(`ws closed for ${this.service.id}`);
          this.socket = null;
          this.scheduleReconnect();
        });
        socket.addEventListener("error", (err) => {
          logger.warn(`ws error for ${this.service.id}`, err);
          socket.close();
        });
      } catch (err) {
        logger.warn(`ws init failed for ${this.service.id}`, err);
        this.scheduleReconnect();
      }
    }

    openEventSource() {
      try {
        const eventSource = new EventSource(this.sseUrl, { withCredentials: true });
        this.eventSource = eventSource;
        eventSource.addEventListener("open", () => {
          logger.info(`sse open for ${this.service.id}`);
          this.resetBackoff();
        });
        eventSource.addEventListener("message", (event) => this.handleIncoming(event.data));
        eventSource.addEventListener("error", (err) => {
          logger.warn(`sse error for ${this.service.id}`, err);
          this.eventSource?.close?.();
          this.eventSource = null;
          this.scheduleReconnect();
        });
      } catch (err) {
        logger.warn(`sse init failed for ${this.service.id}`, err);
        this.scheduleReconnect();
      }
    }

    parsePayload(data) {
      if (!data) return {};
      if (typeof data === "string") {
        try {
          return JSON.parse(data);
        } catch (_err) {
          return { title: this.service.name, body: data };
        }
      }
      return data;
    }

    async handleIncoming(raw) {
      const payload = this.parsePayload(raw);
      await this.dispatchNotification(payload);
    }

    async dispatchNotification(payload = {}) {
      const now = Date.now();
      const shouldDebounce = now - this.lastDesktopAt < MIN_DESKTOP_GAP_MS;
      const title = payload.title || this.service.name;
      const body = payload.body || payload.message || "";
      if (!shouldDebounce) {
        const permission = await this.ensurePermission();
        if (permission === "granted") {
          this.lastDesktopAt = now;
          if (this.notifySystem) {
            await this.notifySystem({ title, body, silent: !!payload.silent, icon: payload.icon });
          } else {
            new Notification(title, { body });
          }
        }
      }
      window.dispatchEvent(
        new CustomEvent("realtime:message", {
          detail: {
            serviceId: this.service.id,
            payload
          }
        })
      );
      try {
        await this.markActivity({ mode: "realtime", title, body, payload });
      } catch (err) {
        logger.warn("markActivity failed for realtime", err);
      }
    }

    async ensurePermission() {
      if (!("Notification" in window)) return "denied";
      if (Notification.permission === "default") {
        try {
          return await Notification.requestPermission();
        } catch (_err) {
          return "denied";
        }
      }
      return Notification.permission;
    }

    async notify(payload) {
      await this.dispatchNotification(payload);
      return { ok: true };
    }

    teardown() {
      if (this.socket) {
        this.socket.close();
        this.socket = null;
      }
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }
  }

  class FcmNativeAdapter {
    constructor({ service, notifySystem, markActivity }) {
      this.service = service;
      this.notifySystem = notifySystem || noop;
      this.markActivity = markActivity || noop;
      this.ready = false;
    }

    static supports() {
      return typeof window.multiChat?.startFcmNative === "function";
    }

    get config() {
      return this.service.deliveryConfig?.fcmNative || {};
    }

    async init() {
      if (!FcmNativeAdapter.supports()) {
        logger.warn("fcm-native bridge not available in preload");
        return;
      }
      const res = await window.multiChat.startFcmNative({
        serviceId: this.service.id,
        config: this.config
      });
      if (res?.ok) {
        logger.info(`fcm-native started for ${this.service.id}`);
        this.ready = true;
      } else {
        logger.warn(`fcm-native failed for ${this.service.id}`, res);
      }
    }

    async notify(payload = {}) {
      const title = payload.title || this.service.name;
      const body = payload.body || payload.message || "";
      await this.notifySystem({ title, body, silent: !!payload.silent, icon: payload.icon });
      try {
        await this.markActivity({ mode: "fcm-native", title, body, payload });
      } catch (err) {
        logger.warn("markActivity failed for fcm-native", err);
      }
      return { ok: true };
    }

    teardown() {
      this.ready = false;
    }
  }

  class NotificationHub {
    constructor() {
      this.registry = new AdapterRegistry();
      this.services = new Map();
      this.instances = new Map();
      this.fallbackModes = ["webpush", "realtime", "fcm-native"];
      this.initDefaultAdapters();
    }

    initDefaultAdapters() {
      this.registry.register("webpush", {
        supports: (ctx) => WebPushAdapter.supports(ctx),
        create: (ctx) => new WebPushAdapter(ctx)
      });
      this.registry.register("realtime", {
        supports: (ctx) => RealtimeAdapter.supports(ctx),
        create: (ctx) => new RealtimeAdapter(ctx)
      });
      this.registry.register("fcm-native", {
        supports: (ctx) => FcmNativeAdapter.supports(ctx),
        create: (ctx) => new FcmNativeAdapter(ctx)
      });
    }

    async configure(serviceList = []) {
      serviceList.forEach((svc) => this.services.set(svc.id, svc));
      await Promise.all(serviceList.map((svc) => this.ensureAdapter(svc.id)));
    }

    async ensureAdapter(serviceId, options = {}) {
      const svc = this.services.get(serviceId);
      if (!svc) return null;
      const forced = Array.isArray(options.forceModes) ? options.forceModes.filter(Boolean) : [];
      const preferred = [svc.deliveryMode, svc.fallbackMode].filter(Boolean);
      const candidates = (forced.length ? forced : preferred.length ? preferred : this.fallbackModes).filter(
        (mode, idx, arr) => mode && arr.indexOf(mode) === idx
      );
      for (const mode of candidates) {
        const ctx = {
          service: svc,
          notifySystem: this.notifySystem.bind(this),
          markActivity: (meta) => this.markServiceActivity(svc.id, meta)
        };
        const supported = await this.registry.supports(mode, ctx);
        if (!supported) continue;
        try {
          const adapter = this.registry.create(mode, ctx);
          if (!adapter) continue;
          await adapter.init?.();
          this.instances.set(serviceId, { adapter, mode });
          logger.info(`service ${serviceId} using ${mode} adapter`);
          return adapter;
        } catch (err) {
          logger.warn(`adapter ${mode} failed for ${serviceId}`, err);
        }
      }
      logger.warn(`no adapter available for ${serviceId}`);
      this.instances.delete(serviceId);
      return null;
    }

    async notify(serviceId, payload) {
      let record = this.instances.get(serviceId);
      if (!record) {
        await this.ensureAdapter(serviceId);
        record = this.instances.get(serviceId);
      }
      if (!record) {
        logger.warn(`notify skipped, adapter missing for ${serviceId}`);
        return { ok: false, reason: "no_adapter" };
      }
      try {
        return await record.adapter.notify(payload);
      } catch (err) {
        logger.warn(`notify failed for ${serviceId}`, err);
        return { ok: false, reason: err?.message };
      }
    }

    async notifyViaMode(serviceId, mode, payload) {
      if (!mode) {
        return this.notify(serviceId, payload);
      }
      const record = this.instances.get(serviceId);
      if (record?.mode === mode) {
        return record.adapter.notify(payload);
      }
      const adapter = await this.ensureAdapter(serviceId, { forceModes: [mode] });
      if (!adapter) {
        logger.warn(`notifyViaMode skipped, adapter missing for ${serviceId} (${mode})`);
        return { ok: false, reason: "no_adapter" };
      }
      return adapter.notify(payload);
    }

    notifySystem(payload) {
      if (typeof window.multiChat?.notifySystem === "function") {
        return window.multiChat.notifySystem(payload);
      }
      if (Notification.permission === "granted") {
        return Promise.resolve(new Notification(payload.title || "Thông báo", { body: payload.body || "" }));
      }
      return Promise.resolve();
    }

    async markServiceActivity(serviceId, meta = {}) {
      if (!serviceId) return;
      const payload = meta.payload || {};
      const svc = this.services.get(serviceId);
      const title = meta.title || payload.title || svc?.name || serviceId;
      const body = meta.body || payload.body || payload.message || "";
      if (typeof window.multiChat?.flagServiceActivity === "function") {
        try {
          await window.multiChat.flagServiceActivity({ serviceId, title, body });
        } catch (err) {
          logger.warn("flagServiceActivity failed", err);
        }
      }
    }

    async handleServiceWorkerMessage(detail = {}) {
      if (!detail?.serviceId) return;
      await this.markServiceActivity(detail.serviceId, { payload: detail.payload, mode: detail.channel });
    }

    teardown() {
      this.instances.forEach(({ adapter }) => adapter.teardown?.());
      this.instances.clear();
    }
  }

  if (!window.notificationHub) {
    window.notificationHub = new NotificationHub();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data || {};
      const serviceId = data.serviceId;
      if (!serviceId) return;
      window.notificationHub?.handleServiceWorkerMessage?.({
        serviceId,
        payload: data.payload,
        channel: data.channel
      });
      window.dispatchEvent(
        new CustomEvent("webpush:message", {
          detail: {
            serviceId,
            payload: data.payload,
            channel: data.channel
          }
        })
      );
    });
  }

  window.addEventListener("beforeunload", () => {
    window.notificationHub?.teardown?.();
  });
})();
