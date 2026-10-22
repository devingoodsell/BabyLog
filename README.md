# Baby Log

A small phone app for logging a newborn's breastfeeds (minutes per side, start and end side), bottles (ounces) and diapers. Entries are saved to a private Google Sheet.

## How it fits together

```
Phone (Baby Log app, served from GitHub Pages: screens only, no data, no keys)
  │  HTTPS, device key in the request body
  ▼
Apps Script attached to the Baby Log sheet (apps-script/Code.gs)
  • @OnlyCurrentDoc: can reach this one spreadsheet and nothing else in Drive
  • checks the device key on every request
  • can only add, list and delete entries, and manage invites
  ▼
Baby Log Google Sheet (never shared or published)
```

- **Invites** are single-use links (`#invite=...`) that expire after 3 days. The part after `#` is never sent to GitHub. The app swaps the invite for a device key stored on that phone, then clears the link from the address bar.
- **Device keys** are stored in the sheet only as SHA-256 hashes (Devices tab). Removing a person, in the app or by setting Status to `Revoked`, locks out their phone on its next request.
- **Setup codes** (8 characters, 15 minutes, single use) move a signed-in Safari session into the Home Screen app on iPhone, which keeps its own storage.
- Nothing here is secret: `config.js` holds only the Apps Script web app URL, and every request without a valid key is refused.

## Files

- `index.html`, `app.js`: the app
- `config.js`: the Apps Script web app URL
- `sw.js`, `manifest.webmanifest`, `icons/`: Home Screen install and offline start
- `apps-script/Code.gs`: the backend, pasted into the sheet's Extensions > Apps Script
- `fonts/`: Nunito (SIL Open Font License), served locally so the app loads nothing from other sites
