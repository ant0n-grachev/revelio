# Revelio

Revelio is a security-focused Chrome extension that scans webpages for potentially hidden or deceptive text.

It helps surface text hidden through common CSS/DOM tricks, including:
- tiny font size
- low contrast / transparent text
- off-canvas positioning
- clipping and pseudo-content patterns
- other suspicious visibility manipulations

![Screenshot 2026-02-1 _imresizer](https://github.com/user-attachments/assets/9ba5d5df-0b20-4d26-ac56-0424a54dc5ad)
![Screenshot 2026-02-1 _imresizer-2](https://github.com/user-attachments/assets/ebaba2ab-3278-4cb6-b648-6d847fa29662)

## Why this exists

Hidden text can be used for manipulation, prompt injection, policy evasion, or misleading page behavior. Revelio gives a fast manual audit view directly in the browser.

## Features

- One-click scan of the active tab
- Clickable findings panel with jump-to-element behavior
- Dual highlight mode:
  - hidden element: red
  - containing block: blue
- Tolerance modes:
  - `Everything`
  - `Sweep`
  - `Default`
  - `Precise`
- JSON export via `Copy JSON`
- Local-only analysis (no external API calls)

## Install (Developer Mode)

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this project folder.

## Usage

1. Open a webpage you want to inspect.
2. Click the Revelio extension icon.
3. Choose a tolerance mode.
4. Click `Scan this page`.
5. Review findings in the in-page panel and click any row to jump to its location.
6. Click `Clear highlights` to reset.

## Permissions

Revelio uses minimal permissions:

- `activeTab`: access only the currently active tab after user action.
- `scripting`: inject the packaged scanner script into that tab.

## Privacy

- Revelio processes page content locally in your browser.
- Revelio does not send scan data to remote servers.
- Revelio does not use remote code.
- Data export happens only when the user explicitly clicks `Copy JSON`.

See: `privacy.html`

## Project structure

- `manifest.json` - extension manifest (MV3)
- `popup.html` - popup UI
- `popup.js` - popup logic and scan trigger
- `content.js` - page scanner, heuristics, highlight UI
- `icon128.png` - extension/store icon
- `privacy.html` - privacy policy page

