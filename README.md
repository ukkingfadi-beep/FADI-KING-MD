# FADI KING MD — WhatsApp Multi-Device Bot & VIP Pairing Board

A modular, production-ready WhatsApp Multi-Device (`@whiskeysockets/baileys`) bot and web control board featuring an **8-Digit VIP Pairing Code System**, sliding-window rate limiting, group moderation, media utilities, and auto-reconnecting persistent sessions.

## Architecture

```text
├── config/
│   └── bot.config.ts        # Env & persistent runtime configuration
├── handlers/
│   ├── connection.ts        # Baileys MD socket, QR, 8-digit pairing & auto-reconnect
│   ├── message.ts           # Prefix parser, mode/VIP gates & error isolation
│   └── group.ts             # Welcome/goodbye events & antilink guard
├── commands/
│   ├── types.ts             # Modular command interface
│   ├── index.ts             # Central command registry
│   ├── general.ts           # menu, ping, alive, owner
│   ├── vip.ts               # pair, addvip, delvip, viplist, checkvip
│   ├── group.ts             # kick, add, promote, demote, tagall, hidetag, antilink, welcome, goodbye, group
│   ├── media.ts             # sticker, toimg, vv, info
│   └── owner.ts             # mode, setprefix, broadcast, restart
├── utils/
│   ├── vipStore.ts          # VIP whitelist, tokens, group rules & audit logs
│   ├── rateLimiter.ts       # Sliding-window anti-spam & pairing rate guard
│   ├── mediaHelper.ts       # Sticker/WebP, PNG & View-Once extractor
│   └── logger.ts            # Structured console + buffered log inspector
├── database/
│   └── sessions/            # Persistent Baileys Multi-File Auth credentials
└── server.ts                # Express API + Vite/React Control Board
```

## Step-by-Step Setup Guide

1. **Install Dependencies**
   ```bash
   npm install
   ```
   *(Optional for `.sticker` / `.toimg` media conversion: install `ffmpeg` on your OS or VPS.)*

2. **Configure Environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set your `OWNER_NUMBER` (country code + number without `+`, e.g. `923001234567`), `DEFAULT_PREFIX`, and `VIP_ONLY_PAIRING=true`.

3. **Run in Development / Production**
   ```bash
   # Development (Control Board + Bot on port 3000)
   npm run dev

   # Production Build & Start
   npm run build
   npm start
   ```

4. **Link WhatsApp via VIP Pairing Code or QR**
   - Open the **FADI KING MD** Control Board (`http://localhost:3000`).
   - Add authorized numbers in **VIP Access** (or use the primary Owner number).
   - Go to **VIP Pairing Studio**, enter the phone number with country code, and click **Generate 8-Digit Code** (or scan the live **QR Code**).
   - On WhatsApp mobile: **Settings -> Linked Devices -> Link a Device -> Link with phone number instead** and enter the 8-digit code.
