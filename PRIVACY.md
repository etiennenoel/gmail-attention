# Privacy Policy — Gmail @tention

**Last updated:** October 29, 2026

**Gmail @tention** is designed to operate 100% locally inside your web browser on `https://mail.google.com/*`.

## Summary

- **No Data Collection:** Gmail @tention does **not** collect, store, transmit, log, or share any personal information, email content, contact details, browsing history, or telemetry.
- **No Network Requests:** The extension makes **zero** external network calls (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or remote scripts).
- **Zero Extra Chrome Permissions:** The extension requests `"permissions": []` — no `storage`, `tabs`, `cookies`, `identity`, or background service worker access.
- **Local-Only DOM Inspection:** When you type `@` in a Gmail compose message body and select a contact from Gmail's autocomplete menu, the extension inspects the active compose editor DOM locally in memory to display a confirmation modal (with masked email display, e.g., `a***e@example.com`) and, if you choose **"No, remove from To"**, clicks the local delete control on the newly added `To` recipient chip while preserving the `@Name` link in your draft. All in-memory references are discarded immediately once your decision is made or the tab closes.

## Third-Party Sharing

Because Gmail @tention collects zero user data, no user data is ever sold, transferred, or disclosed to any third party, analytics provider, or remote server.

## Open Source Verification

The complete source code for Gmail @tention is publicly auditable at:
<https://github.com/etiennenoel/gmail-attention>

## Contact

For questions regarding this privacy policy, please open an issue on GitHub at <https://github.com/etiennenoel/gmail-attention/issues>.
