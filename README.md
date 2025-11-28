# Multi Chat

Electron-based multi-service webapp wrapper.

## Features

- Quick-launch sidebar for Telegram, Messenger, Discord, Gmail, Lark, Zalo with multi-session.
- Passcode lock per tab: hides content, auto-locks after 15 minutes idle.
- Media permissions pre-approved (microphone, camera, display capture, fullscreen).

## Development

Requires Node.js and npm.

```bash
npm install
npm start
npm run build:win
```

### Local mock notification server

Use the bundled mock backend to test the `local-test` service without deploying real infrastructure:

```bash
npm run mock:server
```

The server listens on `http://localhost:8787` and exposes:

- `POST /subscribe` – stores Push API subscriptions (payload: `{ serviceId, subscription }`).
- `GET ws://localhost:8787/notifications` – realtime WebSocket stream used by `deliveryMode: realtime`.
- `GET /events` – optional SSE stream mirroring the realtime payloads.
- `POST /broadcast` – broadcast a custom notification to all WebSocket/SSE clients. Example:

	```bash
	curl -X POST http://localhost:8787/broadcast \
		-H "content-type: application/json" \
		-d '{"title":"Hello","body":"from mock"}'
	```

Point `notification-config.json` at these URLs (already set for `local-test`) and open the “Notification Adapters” card in `renderer/local-test/index.html` to trigger the adapters.

### FCM native adapter (optional)

When a backend requires Firebase Cloud Messaging instead of WebPush, you can implement the native bridge referenced by `deliveryMode: "fcm-native"`:

1. Install a native bridge such as [`electron-push-receiver`](https://github.com/MatthieuLemoine/electron-push-receiver) or your in-house module: `npm install electron-push-receiver`.
2. Obtain your Firebase sender ID and a service-account key. Store the key path in `notification-config.json` under `services.<id>.fcmNative.credentialsPath` and the sender ID under `senderId`.
3. Update `startFcmNativeBridge` in `electron/main.js` to initialize the bridge, forward the generated FCM token to your backend, and listen for incoming data-only payloads. Forward those payloads to the renderer over IPC so `notificationHub` can display them.
4. Keep the payload strictly in the `data` section (no direct `notification` body) to avoid system UI conflicts; the renderer is responsible for showing OS notifications.
5. Watch Electron/Node ABI changes—native modules may require rebuilds whenever you update Electron (`npx electron-rebuild`).

With these pieces in place, set the service’s `deliveryMode` to `"fcm-native"`, restart the app, and monitor the console for `[fcm-native]` logs while testing.

### Key paths

- `electron/` (main process, WebContentsView, permissions, locking)
- `renderer/` (UI, local test)
- `build/icons/` (app icon `icon.ico`)

## Credits

- Service icons by [Simple Icons](https://simpleicons.org/)
- Application icons by [Freepik - Flaticon](https://www.flaticon.com/free-icon/application_3595022 "application icons")
