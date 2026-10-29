# Chrome Web Store Publishing Guide & Listing Copy

Everything required to publish **Gmail @tention** in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) and automate future releases via GitHub Actions is ready in this repository.

---

## 1. Package & Graphic Assets Checklist

| Chrome Web Store Slot | File in Repository | Dimensions / Spec | Required? |
| --- | --- | --- | --- |
| **Extension Package (`.zip`)** | `release/gmail-attention.zip` *(built via `npm run package`)* | Manifest V3 ZIP (no `"key"`) | **Yes** |
| **Store Icon** | `store-assets/store-icon-128x128.png` | `128 × 128` RGBA PNG (`96 × 96` artwork + `16px` padding) | **Yes** |
| **Screenshot 1** | `store-assets/screenshot-1-decision-modal-1280x800.png` | `1280 × 800` 24-bit PNG (no alpha) | **Yes** (min 1) |
| **Screenshot 2** | `store-assets/screenshot-2-keep-link-remove-recipient-1280x800.png` | `1280 × 800` 24-bit PNG (no alpha) | Recommended |
| **Small Promo Tile** | `store-assets/small-promo-tile-440x280.png` | `440 × 280` 24-bit PNG (no alpha) | Optional |
| **Marquee Promo Tile** | `store-assets/marquee-promo-tile-1400x560.png` | `1400 × 560` 24-bit PNG (no alpha) | Optional |

---

## 2. Store Listing Tab (Copy & Paste)

### Title
```text
Gmail @tention
```

### Summary (`manifest.json` `"description"` — 95 / 132 characters)
```text
Asks whether to keep or remove @mentioned people from Gmail's To recipient list before sending.
```

### Detailed Description
```text
In Gmail, typing "@" in an email draft and choosing a contact from the autocomplete menu automatically adds that person to the email's "To" recipient list. When you only wanted to reference a colleague by name or insert a mailto link in a thread, it is easy to email someone by mistake.

Gmail @tention gives you an explicit, keyboard-friendly choice every time an @mention adds a contact:

• Immediate Focus-Stealing Decision Modal — As soon as you select a contact from Gmail's "@" autocomplete menu in a compose body, Gmail @tention opens a clean top-layer modal asking whether to keep them in the To recipient list.
• "Yes, keep in To" (Default) — Press Enter (or click) to keep both the @Name link in your message body and the person in Gmail's To recipient list, returning your cursor directly to your draft.
• "No, remove from To" — Press Left Arrow / Tab + Enter (or click) to keep the clickable @Name link in your email body while automatically removing the newly added recipient chip from To (leaving any pre-existing thread recipients untouched).
• Pre-Send Safeguard — Blocks the Send button and Cmd+Enter / Ctrl+Enter shortcuts while an @mention decision is still open so an accidental shortcut never fires off the email early.
• Zero False Positives — Ignores existing saved drafts, quoted email history, "+" mentions, To/Cc/Subject fields, and auxiliary prompts.

Privacy by Design:
• 100% local execution inside your browser on https://mail.google.com/*.
• Zero extra Chrome permissions requested ("permissions": []).
• Zero external network requests, analytics, or data collection.
• Fully open source: https://github.com/etiennenoel/gmail-attention
```

### Category & Language
- **Category:** `Productivity` → `Communication` (or `Workflow & Planning`)
- **Language:** `English`
- **Homepage URL:** `https://github.com/etiennenoel/gmail-attention`
- **Support URL:** `https://github.com/etiennenoel/gmail-attention/issues`

---

## 3. Privacy Practices Tab (Copy & Paste)

### Single Purpose Description
```text
Monitors Gmail compose message bodies for @mention contact selections and prompts the user to choose whether to keep or remove the @mentioned contact from the email's To recipient list before sending.
```

### Host Permission Justification (`https://mail.google.com/*`)
```text
Required solely to run the content script on Gmail web compose editors (https://mail.google.com/*) so the extension can detect when a user selects an @mentioned contact chip (a.gmail_plusreply) in an active draft, display the confirmation dialog, and click the local remove button on the newly added To recipient chip when the user chooses "No, remove from To". No email data is ever stored or transmitted off the page.
```

### Remote Code Attestation
- **Are you using remote code?** Select **No, I am not using remote code.**
- *Justification (if prompted):* All JavaScript is compiled from TypeScript at build time and bundled statically inside `content.js` within the extension package (`script-src 'self'`).

### Data Usage Disclosures
- **Check none of the data collection boxes** (the extension collects zero user data).
- **Check all three required certifications:**
  - [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
  - [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
  - [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.
- **Privacy Policy URL:**
  ```text
  https://github.com/etiennenoel/gmail-attention/blob/main/PRIVACY.md
  ```

---

## 4. Automated GitHub Actions CI/CD Setup (Chrome Web Store API v2)

### Step A — Initial Item Creation (One-Time Chrome Web Store Requirement)
Google's Chrome Web Store API v2 requires the very first draft of a brand-new extension to be uploaded once in the Developer Dashboard so Chrome assigns its permanent 32-character Extension ID:

1. Run `npm run package` locally (or download the `gmail-attention-cws-zip` artifact from the GitHub Actions **CI** workflow).
2. Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **+ New item** → upload `release/gmail-attention.zip`.
3. Fill in the **Store Listing** and **Privacy Practices** fields from Sections 1–3 above, upload the PNGs from `store-assets/`, and copy:
   - Your **Publisher ID** (shown on the **Account** page in the Developer Dashboard).
   - Your new 32-character **Extension ID** (shown under the item title / URL).

### Step B — Create Chrome Web Store API OAuth2 Credentials
1. In [Google Cloud Console](https://console.cloud.google.com/), create (or select) a project and enable the **Chrome Web Store API**.
2. Configure the **OAuth consent screen** and add your Developer Dashboard Google account as a test/authorized user.
3. Under **APIs & Services → Credentials → Create Credentials → OAuth client ID**, create a **Desktop app** (or **Web application** with redirect URI `https://developers.google.com/oauthplayground`) client and note its `CLIENT_ID` and `CLIENT_SECRET`.
4. Authorize the scope `https://www.googleapis.com/auth/chromewebstore` (for example via OAuth 2.0 Playground using your own OAuth credentials, or an installed-app loopback flow) and exchange the authorization code for a `REFRESH_TOKEN`.

### Step C — Configure GitHub Repository Secrets
In `https://github.com/etiennenoel/gmail-attention/settings/secrets/actions`, add these **Repository secrets**:

| Secret Name | Description |
| --- | --- |
| `CWS_PUBLISHER_ID` | Your Chrome Web Store Publisher ID (from Developer Dashboard → Account) |
| `CWS_EXTENSION_ID` | The 32-character Chrome Web Store item ID (e.g. `abcdefghijklmnopabcdefghijklmnop`) |
| `CWS_CLIENT_ID` | Google Cloud OAuth 2.0 Client ID with Chrome Web Store API enabled |
| `CWS_CLIENT_SECRET` | Google Cloud OAuth 2.0 Client Secret |
| `CWS_REFRESH_TOKEN` | OAuth 2.0 Refresh Token authorized for `https://www.googleapis.com/auth/chromewebstore` |

### Step D — Triggering Automated Releases
Whenever you bump `"version"` in `src/manifest.json` and `package.json` (for example to `1.0.1`) and push a matching Git tag:

```bash
git tag v1.0.1
git push origin main --tags
```

The [`.github/workflows/release.yml`](../.github/workflows/release.yml) workflow automatically:
1. Verifies `src/manifest.json` and `package.json` versions match the `vX.Y.Z` tag.
2. Runs strict TypeScript type-checking, builds `dist/`, executes the Jest test suite, and packages `release/gmail-attention-vX.Y.Z.zip`.
3. Publishes a GitHub Release with auto-generated release notes and attaches the Chrome Web Store `.zip`.
4. Uploads the `.zip` to **Chrome Web Store API v2** (`:upload`), polls `:fetchStatus` until async package validation succeeds, and submits the revision for review (`:publish`).
