# Devin Account Creator Manager

Automation tool for Devin.ai account registration with session management.

Built with Playwright + Node.js.

## Features

- **Auto-registration** - Automated account creation flow
- **Session Manager** - Track and manage multiple sessions
- **BIN Lookup** - Database of 148 BINs from 12 countries
- **Card Generation** - Auto-generate card details (Luhn algorithm)
- **Billing Rotation** - 25 countries with real addresses
- **Fingerprint Rotation** - WebGL, viewport, timezone spoofing
- **Proxy Support** - HTTP/SOCKS5 with rotation
- **Stealth Mode** - Anti-detection measures

## Requirements

- Node.js 18+
- Playwright Chromium

## Installation

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
# Interactive menu (recommended)
node menu.js

# Direct run
node autoreger.js

# BIN lookup utility
node internal/bin-lookup.js
```

## Configuration

Edit `config.js` to customize:

- Card/BIN settings
- Proxy configuration  
- Billing profiles (25 countries)
- Browser settings
- Timing delays
- Stealth options

## Project Structure

```
├── autoreger.js          # Main registration script
├── menu.js               # Interactive menu
├── config.js             # Configuration
├── internal/
│   └── bin-lookup.js     # BIN database & generator
├── docs/
│   └── README.md         # Full documentation
└── presets/              # Config presets
```

## Community

This project was made possible thanks to the help and activity of the community.

Join us: **https://t.me/abuz_ai**

## Disclaimer

This tool is for educational purposes only. Use responsibly and in accordance with Devin.ai's terms of service.

## License

MIT
