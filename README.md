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

### Key paths

- `electron/` (main process, WebContentsView, permissions, locking)
- `renderer/` (UI, local test)
- `build/icons/` (app icon `icon.ico`)

## Credits

- Service icons by [Simple Icons](https://simpleicons.org/)
- Application icons by [Freepik - Flaticon](https://www.flaticon.com/free-icon/application_3595022 "application icons")
