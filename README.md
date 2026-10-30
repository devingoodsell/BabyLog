# Baby Log

A phone app for logging a newborn's feeds and diapers, shared by everyone who cares for the baby. Entries go into a private Google Sheet that you own.

- **Breastfeeds:** a left and right timer (tap to start, switch or pause), or enter minutes per side after the fact. Records which side you started and ended on.
- **Bottles and syringes:** ounces or mL (0.1 mL steps), and breast milk or formula.
- **Diapers:** wet, dirty, or both.
- **Pumping:** left, right or both, minutes, how much came from each breast (oz or mL, optional), and an optional storage label (for example, "Bag 12").
- **Stats:** daily averages and per-day charts for feeds (breastfeeds and bottles), bottle amount, wet and dirty diapers over the last 7, 14 or 30 days, with a table view.
- **Notes** on any entry, when you log it or later from the timeline.
- **Backdating** ("20 minutes ago" or an exact time) for entries logged after the fact.
- **Works offline:** entries wait on the phone and save when it reconnects.
- Runs on iPhone, Android or any phone browser, and can be added to the Home Screen like an app. Nobody needs a Google account except the person who sets it up.

It costs nothing to run: the app is hosted free on GitHub Pages and the data lives in your own Google account.

## How it fits together

```
Phone (Baby Log app, served from GitHub Pages: screens only, no data, no keys)
  │  HTTPS, device key in the request body
  ▼
Apps Script attached to your Baby Log sheet (apps-script/Code.gs)
  • @OnlyCurrentDoc: can reach this one spreadsheet and nothing else in your Drive
  • checks the device key on every request
  • can only add, list, delete and annotate entries, and manage invites
  ▼
Your Baby Log Google Sheet (never shared or published)
```

---

## Set it up for your family

Allow about 20 minutes. You need a Google account (a regular Gmail account works) and a free GitHub account. You don't need to install anything or write code.

### 1. Copy this repository

1. On GitHub, click **Fork** (or **Use this template**) to make your own copy.
2. Keep the copy **Public**. GitHub Pages is free only for public repositories. That's safe here: the code has no keys or data in it (see [Security](#security)).

Your app's address will be `https://YOUR-GITHUB-NAME.github.io/YOUR-REPO-NAME/`. You'll need it in step 4. For example, a repository named `BabyLog` under `jane` is `https://jane.github.io/BabyLog/`.

### 2. Turn on GitHub Pages

1. In your copy, go to **Settings → Pages**.
2. Under **Build and deployment**, set Source to **Deploy from a branch**, pick **main** and **/(root)**, then click **Save**.

After a minute or two, your app's address shows "Baby Log is almost ready." That's expected until step 7.

### 3. Create the Google Sheet

1. Go to [sheets.new](https://sheets.new) and give the sheet a name, such as "Baby Log".
2. Go to **File → Settings** and set **Time zone** to your local time zone, so times in the sheet display correctly.

Leave it blank. The setup script creates every tab it needs.

### 4. Add the script to the sheet

1. In the sheet, go to **Extensions → Apps Script**. A new tab opens with a file named `Code.gs`.
2. Delete everything in it, then paste in the full contents of [`apps-script/Code.gs`](apps-script/Code.gs) from this repository.
3. Near the top, change these two lines:
   ```js
   const APP_URL = 'https://YOUR-GITHUB-NAME.github.io/YOUR-REPO-NAME/';  // keep the trailing slash
   const OWNER_NAME = 'Your first name';
   ```
4. Click **Save** (the disk icon).

The script must be opened from the sheet with **Extensions → Apps Script**. A script created separately at script.google.com isn't attached to the sheet and won't work.

### 5. Run setup

1. In the function menu at the top of the editor, choose **setup**, then click **Run**.
2. Google asks for permission:
   - It warns that the app isn't verified, because it's your own script. Click **Advanced**, then **Go to (project name)**.
   - The permission list should only ask to view and manage **this spreadsheet**. That's the `@OnlyCurrentDoc` line doing its job. If it asks for your whole Drive, stop and check that you pasted the file exactly.
3. Your sheet now has five tabs:

| Tab | What it holds |
|---|---|
| **Dashboard** | Last feed, last diapers, and 24-hour and since-midnight totals |
| **Log** | One row per entry. This is where the app writes. |
| **Daily** | Per-day totals |
| **Devices** | Each phone with access: who, when it was last used, and whether it's active |
| **Invites** | Invite links and setup codes. Codes are stored only as hashes. |

### 6. Deploy the script as a web app

1. In the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
4. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/.../exec`.

"Anyone" means the app can reach the script without a Google sign-in. The script itself still refuses every request that lacks a valid device key.

**Using Google Workspace (a work or custom-domain account)?** If "Anyone" isn't offered, an admin needs to allow sharing outside your organization: **Admin console → Apps → Google Workspace → Drive and Docs → Sharing settings**.

### 7. Connect the app to your script

1. In your GitHub copy, open `config.js` and click the pencil icon to edit it.
2. Paste your Web app URL between the quotes:
   ```js
   window.BABYLOG_CONFIG = {
     apiUrl: 'https://script.google.com/macros/s/.../exec'
   };
   ```
3. Click **Commit changes**. GitHub Pages updates within a minute or two.

### 8. Sign yourself in

1. Back in the Apps Script editor, choose **createOwnerInvite** in the function menu and click **Run**.
2. Open **Execution log** at the bottom. It shows a link like `https://.../#invite=...`.
3. Open that link on your phone and tap **Join Baby Log**. The link works once and expires after 3 days.

You're signed in as a manager, which means you can invite and remove people.

### 9. Invite everyone else

In the app, tap your initial at the top right, then **Invite someone**. Enter a name and choose whether they can manage access, then send the link with **Share** or **Copy link**. Each link works once and expires after 3 days.

### 10. Add it to the Home Screen

The app offers this after someone joins, and it's always available under Settings.

- **iPhone:** in Safari, tap **Share → Add to Home Screen**. iPhone gives Home Screen apps their own storage, so the app shows an 8-character **setup code**. Open Baby Log from the Home Screen and type the code. It works once and expires after 15 minutes.
- **Android:** in Chrome, tap **Install** when prompted, or use **⋮ → Add to Home screen**.

---

## Making changes later

There are two kinds of change, and they update differently.

| You changed | How it reaches the phones |
|---|---|
| Anything except `apps-script/Code.gs` (screens, `config.js`, icons) | Commit to GitHub. Phones pick it up the next time the app is opened, or after it's closed and reopened. |
| `apps-script/Code.gs` | Paste the new code into Apps Script, save, then publish a **new version** (below). |

**Publishing a new version of the script.** Saving the code isn't enough: the web app keeps running the copy it had when you last deployed. To update it:

1. Go to **Deploy → Manage deployments** and select your existing deployment.
2. Click the **pencil icon**, open the **Version** dropdown, and choose **New version**.
3. Click **Deploy**.

The web address stays the same. Don't use **New deployment** for updates: it creates a second address that the app doesn't know about.

## Managing access

- **Remove someone:** in the app, go to **Settings → People with access → Remove**. In the sheet, you can instead set their row's **Status** on the Devices tab to `Revoked`. Either way, that phone loses access on its next request.
- **Cancel an unused invite:** remove it under People with access in the app.
- **Sign out a phone:** on that phone, go to **Settings → Sign out of this phone**.
- **Timing settings,** at the top of `Code.gs`:
  - `INVITE_HOURS` (default 72): how long an unused invite link lasts
  - `PAIR_MINUTES` (default 15): how long a setup code lasts
  - `LIST_DAYS` (default 30): how much history the app downloads; Stats shows up to 30 days

## The Log tab

| Column | Contents |
|---|---|
| Time | When it happened. For breastfeeds, when the feed started. |
| Event | `Breastfeed`, `Bottle`, `Pump`, `Wet diaper`, `Dirty diaper` or `Wet + dirty diaper` |
| Left min, Right min | Breastfeed minutes per side |
| Bottle oz | Always in ounces, with mL converted at 29.5735 mL per oz, so totals add up |
| First side, Last side | Where a breastfeed started and ended |
| Feed end | Breastfeed or pump start plus its minutes |
| Logged by, Logged at | Who logged it, and when they pressed Save |
| Notes | Optional note |
| ID | Used by the app. Leave it alone. |
| Amount, Unit, Milk | The bottle amount exactly as entered, `oz` or `mL`, and `Breast milk` or `Formula` |
| Pump side, Pump min, Label | `Left`, `Right` or `Both`, pumping minutes, and the optional storage label. Pump minutes are kept separate from the breastfeed columns so feeding totals stay accurate. |
| Left pumped, Right pumped, Pump unit, Pumped oz | Amount from each breast as entered, `oz` or `mL`, and the total converted to ounces so it can be summed. Empty when no amount was entered. |

You can fix a value by hand in the sheet. The app picks up the change on its next refresh. Rows you add by hand appear in the app too, as long as Time and Event are filled in.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Baby Log is almost ready" | `config.js` has no `apiUrl` yet (step 7), or GitHub Pages hasn't updated. Wait a minute and reload. |
| A new script feature doesn't save (for example, notes or mL stay empty in the sheet) | The web app is still running the old copy. Publish a **New version** (see [Making changes later](#making-changes-later)). |
| "This invite cannot be used" | The link was already used or has expired. Create a new one. |
| "This phone no longer has access" | The phone was removed or signed out. Send it a new invite. |
| "Anyone" isn't offered when deploying | Your Google Workspace blocks sharing outside the organization (see step 6). |
| Times in the sheet are off by hours | Set the sheet's time zone under **File → Settings**. |
| The permission screen asks for your whole Drive | The `@OnlyCurrentDoc` line at the top of `Code.gs` is missing. Paste the file again. |

## Security

- **The sheet is never shared or published.** Only the script reads or writes it, and the script runs as you.
- **The script can only reach this one spreadsheet.** `@OnlyCurrentDoc` limits Google's grant to the sheet the script is attached to.
- **Every request needs a device key** in the encrypted request body, never in the address, so keys don't show up in server logs or browser history. Requests without a valid key are refused.
- **Keys and codes are stored only as SHA-256 hashes** in the Devices and Invites tabs.
- **Invites are single-use** and expire. The code travels after the `#` in the link, which browsers never send to any server, and the app clears it from the address bar once it's used. A forwarded or screenshotted invite that has already been used gets nobody in.
- **The app loads nothing from other websites.** It ships its own fonts, sends no referrer, and its content security policy only allows connections to Google Apps Script.
- **Notes and names can't become formulas.** Text that starts with `=`, `+`, `-` or `@` is stored as plain text.
- **What remains:** anyone holding an unlocked phone that's already signed in can log entries, as with any app.

## Files

- `index.html`, `app.js`: the app
- `config.js`: your Apps Script web app URL (not a secret)
- `sw.js`, `manifest.webmanifest`, `icons/`: Home Screen install and offline start
- `apps-script/Code.gs`: the backend, pasted into the sheet's Apps Script
- `fonts/`: Nunito, under the SIL Open Font License, served locally so the app loads nothing from other sites
