const CLIENT_CHANNEL = "webpush:client";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const payload = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch (_err) {
      return { body: event.data?.text?.() };
    }
  })();
  const title = payload.title || "Thông báo";
  const options = {
    body: payload.body || payload.message || "",
    icon: payload.icon,
    data: payload.data || {},
    tag: payload.tag,
    renotify: !!payload.renotify
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      await forwardToClients({ serviceId: payload.serviceId, payload });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      if (allClients.length) {
        const target = allClients[0];
        target.focus();
        target.postMessage({
          serviceId: event.notification.data?.serviceId,
          payload: event.notification.data,
          channel: "webpush:notification-click"
        });
      }
    })()
  );
});

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.payload?.title) {
    self.registration.showNotification(message.payload.title, {
      body: message.payload.body || message.payload.message || "",
      icon: message.payload.icon,
      data: { serviceId: message.serviceId, ...message.payload.data }
    });
  }
  forwardToClients(message);
});

async function forwardToClients(payload) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  clients.forEach((client) => client.postMessage({ ...payload, channel: payload?.channel || CLIENT_CHANNEL }));
}
