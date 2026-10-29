import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ICON_SVG_PATH = path.resolve(PROJECT_ROOT, 'assets/icon.svg');
const SRC_ICONS_DIR = path.resolve(PROJECT_ROOT, 'src/icons');
const STORE_ASSETS_DIR = path.resolve(PROJECT_ROOT, 'store-assets');

function findChromeExecutable(): string {
  const candidates = [
    process.env['CHROME_BIN'],
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not find a local Chrome/Chromium executable to rasterize store assets.');
}

async function getFreeLocalPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const address = srv.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

class MinimalCdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  public constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  public async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket error')), {
        once: true,
      });
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result);
        }
      }
    });
  }

  public send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) {
      payload['sessionId'] = sessionId;
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout on ${method}`));
        }
      }, 6000);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  public close(): void {
    this.ws.close();
  }
}

function buildIconRenderHtml(svgMarkup: string, size: number, tightToolbarCrop: boolean): string {
  // For 16x16 / 32x32 / 48x48 toolbar icons, use a tighter viewBox so the icon fills
  // Chrome's toolbar cleanly; for 128x128, preserve the full 16px transparent CWS padding.
  const effectiveSvg = tightToolbarCrop
    ? svgMarkup.replace('viewBox="0 0 128 128"', 'viewBox="10 9 109 109"')
    : svgMarkup;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${size}px;
    height: ${size}px;
    background: transparent;
    overflow: hidden;
  }
  svg {
    display: block;
    width: ${size}px;
    height: ${size}px;
  }
</style>
</head>
<body>${effectiveSvg}</body>
</html>`;
}

function buildScreenshot1Html(svgMarkup: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1280px;
    height: 800px;
    overflow: hidden;
    background: linear-gradient(180deg, #F8FAFC 0%, #EEF2F7 100%);
    font-family: 'Google Sans', Inter, Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
    color: #0F172A;
  }
  .canvas {
    width: 1280px;
    height: 800px;
    padding: 44px 72px 52px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .top-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 10px;
  }
  .top-header svg {
    width: 40px;
    height: 40px;
  }
  .brand {
    font-size: 20px;
    font-weight: 700;
    color: #0B57D0;
    letter-spacing: -0.01em;
  }
  .headline {
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #0F172A;
    margin-bottom: 28px;
    text-align: center;
  }
  .gmail-window {
    position: relative;
    width: 1040px;
    height: 604px;
    background: #FFFFFF;
    border-radius: 16px;
    border: 1px solid rgba(15, 23, 42, 0.1);
    box-shadow: 0 24px 48px -16px rgba(15, 23, 42, 0.14);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .compose-titlebar {
    background: #F2F6FC;
    padding: 14px 24px;
    font-size: 15px;
    font-weight: 600;
    color: #1F1F1F;
    border-bottom: 1px solid #E2E8F0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .window-controls {
    display: flex;
    gap: 10px;
    color: #64748B;
    font-size: 15px;
  }
  .compose-row {
    padding: 12px 24px;
    border-bottom: 1px solid #F1F5F9;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    color: #475569;
  }
  .row-label {
    width: 58px;
    color: #64748B;
    font-weight: 500;
  }
  .to-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid #CBD5E1;
    background: #FFFFFF;
    color: #1E293B;
    font-size: 13px;
    font-weight: 500;
  }
  .to-chip--new {
    border-color: #93C5FD;
    background: #EFF6FF;
    color: #0B57D0;
  }
  .compose-body {
    flex: 1;
    padding: 26px 24px;
    font-size: 16px;
    line-height: 1.65;
    color: #1F1F1F;
  }
  .mention-chip {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    background: #E8F0FE;
    color: #0B57D0;
    font-weight: 600;
  }
  .compose-footer {
    padding: 16px 24px;
    border-top: 1px solid #F1F5F9;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .gmail-send {
    background: #0B57D0;
    color: #FFFFFF;
    font-size: 14px;
    font-weight: 600;
    padding: 10px 24px;
    border-radius: 999px;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(15, 23, 42, 0.42);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal-card {
    width: 456px;
    background: #FFFFFF;
    color: #1F1F1F;
    border: 1px solid rgba(15, 23, 42, 0.12);
    border-radius: 18px;
    padding: 26px;
    box-shadow:
      0 24px 48px -12px rgba(15, 23, 42, 0.34),
      0 4px 12px -2px rgba(15, 23, 42, 0.14);
  }
  .modal-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }
  .modal-icon {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    background: #E8F0FE;
    color: #0B57D0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal-title {
    font-size: 18px;
    font-weight: 600;
    color: #1F1F1F;
  }
  .modal-desc {
    font-size: 14.5px;
    line-height: 1.58;
    color: #444746;
  }
  .modal-desc strong {
    color: #1F1F1F;
    font-weight: 600;
  }
  .modal-actions {
    margin-top: 24px;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .btn-no {
    border: 1px solid rgba(15, 23, 42, 0.24);
    background: #FFFFFF;
    color: #1F1F1F;
    font-size: 14px;
    font-weight: 600;
    padding: 10px 18px;
    border-radius: 999px;
  }
  .btn-yes {
    border: 1px solid transparent;
    background: #0B57D0;
    color: #FFFFFF;
    font-size: 14px;
    font-weight: 600;
    padding: 10px 20px;
    border-radius: 999px;
    outline: 2px solid #0B57D0;
    outline-offset: 2px;
  }
</style>
</head>
<body>
  <div class="canvas">
    <div class="top-header">
      ${svgMarkup}
      <span class="brand">Gmail @tention</span>
    </div>
    <h1 class="headline">Never add an @mentioned person to an email by accident</h1>

    <div class="gmail-window">
      <div class="compose-titlebar">
        <span>New Message</span>
        <div class="window-controls"><span>—</span><span>✕</span></div>
      </div>
      <div class="compose-row">
        <span class="row-label">To</span>
        <span class="to-chip">Jordan Lee &nbsp;✕</span>
        <span class="to-chip to-chip--new">Alice Smith &nbsp;✕</span>
      </div>
      <div class="compose-row">
        <span class="row-label">Subject</span>
        <span style="color:#1E293B;font-weight:500;">Q4 Launch Notes</span>
      </div>
      <div class="compose-body">
        Hi Jordan,<br /><br />
        Sharing the updated rollout checklist below. Looping in <span class="mention-chip">@Alice Smith</span>’s doc for context on the milestone schedule.
      </div>
      <div class="compose-footer">
        <div class="gmail-send">Send</div>
      </div>

      <div class="scrim">
        <div class="modal-card">
          <div class="modal-header">
            <div class="modal-icon">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <line x1="19" y1="8" x2="19" y2="14"></line>
                <line x1="22" y1="11" x2="16" y2="11"></line>
              </svg>
            </div>
            <div class="modal-title">Add recipient to email list?</div>
          </div>
          <div class="modal-desc">
            You @mentioned <strong>Alice Smith</strong> (a***h@example.com) in the email body. Gmail adds @mentioned people to the To email recipient list — keep them in To?
          </div>
          <div class="modal-actions">
            <div class="btn-no">No, remove from To</div>
            <div class="btn-yes">Yes, keep in To</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildScreenshot2Html(svgMarkup: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1280px;
    height: 800px;
    overflow: hidden;
    background: linear-gradient(180deg, #F8FAFC 0%, #EEF2F7 100%);
    font-family: 'Google Sans', Inter, Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
    color: #0F172A;
  }
  .canvas {
    width: 1280px;
    height: 800px;
    padding: 48px 72px 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .top-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 10px;
  }
  .top-header svg { width: 40px; height: 40px; }
  .brand { font-size: 20px; font-weight: 700; color: #0B57D0; }
  .headline {
    font-size: 31px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #0F172A;
    margin-bottom: 10px;
    text-align: center;
  }
  .subhead {
    font-size: 16px;
    color: #475569;
    margin-bottom: 34px;
    text-align: center;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
    width: 100%;
    flex: 1;
  }
  .panel {
    background: #FFFFFF;
    border-radius: 18px;
    border: 1px solid rgba(15, 23, 42, 0.1);
    box-shadow: 0 18px 36px -14px rgba(15, 23, 42, 0.1);
    padding: 28px;
    display: flex;
    flex-direction: column;
  }
  .step-label {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748B;
    margin-bottom: 8px;
  }
  .panel-title {
    font-size: 21px;
    font-weight: 700;
    color: #0F172A;
    margin-bottom: 20px;
  }
  .mini-compose {
    border: 1px solid #E2E8F0;
    border-radius: 12px;
    overflow: hidden;
    flex: 1;
    display: flex;
    flex-direction: column;
    background: #FFFFFF;
  }
  .mini-row {
    padding: 12px 18px;
    border-bottom: 1px solid #F1F5F9;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13.5px;
  }
  .mini-label {
    width: 36px;
    color: #64748B;
    font-weight: 500;
  }
  .chip {
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid #CBD5E1;
    font-size: 13px;
    font-weight: 500;
    color: #1E293B;
    background: #FFFFFF;
  }
  .chip-added {
    border-color: #93C5FD;
    background: #EFF6FF;
    color: #0B57D0;
  }
  .mini-body {
    padding: 20px 18px;
    font-size: 15px;
    line-height: 1.65;
    color: #1E293B;
    flex: 1;
  }
  .mention-link {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    background: #E8F0FE;
    color: #0B57D0;
    font-weight: 600;
  }
  .panel-note {
    margin-top: 18px;
    font-size: 14px;
    line-height: 1.5;
    color: #475569;
  }
  .panel-note strong {
    color: #0F172A;
  }
</style>
</head>
<body>
  <div class="canvas">
    <div class="top-header">
      ${svgMarkup}
      <span class="brand">Gmail @tention</span>
    </div>
    <h1 class="headline">Choose “No, remove from To” to keep the @mention link only</h1>
    <p class="subhead">Full keyboard control (ArrowLeft / Tab + Enter), Send protection while undecided, and zero data leaves your browser.</p>

    <div class="grid">
      <div class="panel">
        <div class="step-label">Option 1 · Yes, keep in To</div>
        <div class="panel-title">Keep both the @mention and the To recipient</div>
        <div class="mini-compose">
          <div class="mini-row">
            <span class="mini-label">To</span>
            <span class="chip">Jordan Lee &nbsp;✕</span>
            <span class="chip chip-added">Alice Smith &nbsp;✕</span>
          </div>
          <div class="mini-body">
            Hi Jordan,<br /><br />
            Please review the proposal with <span class="mention-link">@Alice Smith</span> before Friday.
          </div>
        </div>
        <p class="panel-note">
          Press <strong>Enter</strong> on default focus to confirm adding <strong>Alice Smith</strong> to the email thread and return the cursor directly to your draft.
        </p>
      </div>

      <div class="panel">
        <div class="step-label">Option 2 · No, remove from To</div>
        <div class="panel-title">Keep the @Name link, remove from To</div>
        <div class="mini-compose">
          <div class="mini-row">
            <span class="mini-label">To</span>
            <span class="chip">Jordan Lee &nbsp;✕</span>
          </div>
          <div class="mini-body">
            Hi Jordan,<br /><br />
            Please review the proposal with <span class="mention-link">@Alice Smith</span> before Friday.
          </div>
        </div>
        <p class="panel-note">
          The clickable <strong>@Alice Smith</strong> link stays in your message body while removing her from <strong>To</strong> and keeping existing recipients untouched.
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildSmallPromoTileHtml(svgMarkup: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 440px;
    height: 280px;
    overflow: hidden;
    background: linear-gradient(145deg, #FFFFFF 0%, #F1F5FB 100%);
    font-family: 'Google Sans', Inter, Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
    color: #0F172A;
  }
  .tile {
    width: 440px;
    height: 280px;
    padding: 34px 36px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border: 1px solid #E2E8F0;
  }
  .brand-row {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .brand-row svg {
    width: 68px;
    height: 68px;
    flex-shrink: 0;
  }
  .title {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #0F172A;
    line-height: 1.15;
  }
  .subtitle {
    font-size: 16.5px;
    line-height: 1.48;
    color: #334155;
    font-weight: 500;
  }
  .subtitle strong {
    color: #0B57D0;
    font-weight: 600;
  }
  .footer-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-weight: 600;
    color: #64748B;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #0B57D0;
  }
</style>
</head>
<body>
  <div class="tile">
    <div class="brand-row">
      ${svgMarkup}
      <div class="title">Gmail<br />@tention</div>
    </div>
    <p class="subtitle">
      Confirm whether <strong>@mentioned</strong> contacts stay in Gmail’s <strong>To</strong> list — or keep the link without adding them.
    </p>
    <div class="footer-bar">
      <span class="dot"></span>
      <span>100% Local · Zero Permissions</span>
    </div>
  </div>
</body>
</html>`;
}

function buildMarqueePromoTileHtml(svgMarkup: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1400px;
    height: 560px;
    overflow: hidden;
    background: linear-gradient(135deg, #F8FAFC 0%, #E8F0FE 100%);
    font-family: 'Google Sans', Inter, Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
    color: #0F172A;
  }
  .marquee {
    width: 1400px;
    height: 560px;
    padding: 64px 88px;
    display: grid;
    grid-template-columns: 1.08fr 0.92fr;
    align-items: center;
    gap: 64px;
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .brand-row {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .brand-row svg {
    width: 76px;
    height: 76px;
  }
  .brand-name {
    font-size: 28px;
    font-weight: 700;
    color: #0B57D0;
    letter-spacing: -0.01em;
  }
  .hero-title {
    font-size: 46px;
    font-weight: 800;
    line-height: 1.14;
    letter-spacing: -0.025em;
    color: #0F172A;
  }
  .hero-copy {
    font-size: 20px;
    line-height: 1.55;
    color: #334155;
    max-width: 580px;
  }
  .card {
    background: #FFFFFF;
    border-radius: 22px;
    border: 1px solid rgba(15, 23, 42, 0.12);
    padding: 34px;
    box-shadow:
      0 28px 56px -14px rgba(15, 23, 42, 0.2),
      0 6px 16px -4px rgba(15, 23, 42, 0.08);
  }
  .card-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 16px;
  }
  .card-icon {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: #E8F0FE;
    color: #0B57D0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card-title {
    font-size: 21px;
    font-weight: 600;
    color: #1F1F1F;
  }
  .card-desc {
    font-size: 16px;
    line-height: 1.6;
    color: #444746;
  }
  .card-desc strong {
    color: #1F1F1F;
    font-weight: 600;
  }
  .card-actions {
    margin-top: 28px;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }
  .btn-secondary {
    border: 1px solid rgba(15, 23, 42, 0.24);
    background: #FFFFFF;
    color: #1F1F1F;
    font-size: 15px;
    font-weight: 600;
    padding: 12px 20px;
    border-radius: 999px;
  }
  .btn-primary {
    background: #0B57D0;
    color: #FFFFFF;
    font-size: 15px;
    font-weight: 600;
    padding: 12px 24px;
    border-radius: 999px;
  }
</style>
</head>
<body>
  <div class="marquee">
    <div class="left">
      <div class="brand-row">
        ${svgMarkup}
        <span class="brand-name">Gmail @tention</span>
      </div>
      <h1 class="hero-title">Intentional @mentions in every Gmail draft.</h1>
      <p class="hero-copy">
        Steals focus whenever an @mention adds a contact to To — letting you keep them as a recipient or keep only the @mention link.
      </p>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-icon">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
            <circle cx="9" cy="7" r="4"></circle>
            <line x1="19" y1="8" x2="19" y2="14"></line>
            <line x1="22" y1="11" x2="16" y2="11"></line>
          </svg>
        </div>
        <div class="card-title">Add recipient to email list?</div>
      </div>
      <div class="card-desc">
        You @mentioned <strong>Alice Smith</strong> (a***h@example.com) in the email body. Gmail adds @mentioned people to the To email recipient list — keep them in To?
      </div>
      <div class="card-actions">
        <div class="btn-secondary">No, remove from To</div>
        <div class="btn-primary">Yes, keep in To</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function assertPngDimensions(filePath: string, expectedWidth: number, expectedHeight: number): void {
  const buf = fs.readFileSync(filePath);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) {
    throw new Error(`Invalid PNG file at ${filePath}`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `PNG dimension mismatch for ${filePath}: expected ${expectedWidth}x${expectedHeight}, got ${width}x${height}`
    );
  }
}

async function main(): Promise<void> {
  const svgMarkup = fs.readFileSync(ICON_SVG_PATH, 'utf8').trim();
  fs.mkdirSync(SRC_ICONS_DIR, { recursive: true });
  fs.mkdirSync(STORE_ASSETS_DIR, { recursive: true });

  const chromeBin = findChromeExecutable();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-assets-'));
  const port = await getFreeLocalPort();

  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--hide-scrollbars',
      `--user-data-dir=${path.join(tmpDir, 'profile')}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let stderrBuf = '';
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out launching Chrome:\n${stderrBuf}`)),
        8000
      );
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        const match = stderrBuf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
        if (match?.[1]) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
    });

    const cdp = new MinimalCdpClient(wsUrl);
    await cdp.connect();

    const { targetInfos } = await cdp.send<{
      targetInfos: Array<{ targetId: string; type: string }>;
    }>('Target.getTargets');
    const pageTarget = targetInfos.find((t) => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target available in headless Chrome');
    }

    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });

    await cdp.send('Page.enable', {}, sessionId);
    const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
      {},
      sessionId
    );
    const frameId = frameTree.frame.id;

    const captureHtmlToPng = async (
      html: string,
      width: number,
      height: number,
      omitBackground: boolean,
      outPath: string
    ): Promise<void> => {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId
      );
      await cdp.send(
        'Emulation.setDefaultBackgroundColorOverride',
        omitBackground ? { color: { r: 0, g: 0, b: 0, a: 0 } } : { color: { r: 255, g: 255, b: 255, a: 1 } },
        sessionId
      );
      await cdp.send('Page.setDocumentContent', { frameId, html }, sessionId);
      await new Promise((r) => setTimeout(r, 80));

      const { data } = await cdp.send<{ data: string }>(
        'Page.captureScreenshot',
        {
          format: 'png',
          omitBackground,
          clip: { x: 0, y: 0, width, height, scale: 1 },
          captureBeyondViewport: true,
        },
        sessionId
      );

      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      assertPngDimensions(outPath, width, height);
    };

    // 1. Extension icons (16, 32, 48 toolbar crop; 128 CWS 96x96 safe-zone crop)
    for (const size of [16, 32, 48, 128] as const) {
      const outPath = path.join(SRC_ICONS_DIR, `icon-${size}.png`);
      await captureHtmlToPng(
        buildIconRenderHtml(svgMarkup, size, size < 128),
        size,
        size,
        true,
        outPath
      );
    }

    // Copy 128x128 store icon into store-assets/
    const storeIconOut = path.join(STORE_ASSETS_DIR, 'store-icon-128x128.png');
    fs.copyFileSync(path.join(SRC_ICONS_DIR, 'icon-128.png'), storeIconOut);
    assertPngDimensions(storeIconOut, 128, 128);

    // 2. Chrome Web Store 1280x800 screenshots (opaque)
    await captureHtmlToPng(
      buildScreenshot1Html(svgMarkup),
      1280,
      800,
      false,
      path.join(STORE_ASSETS_DIR, 'screenshot-1-decision-modal-1280x800.png')
    );

    await captureHtmlToPng(
      buildScreenshot2Html(svgMarkup),
      1280,
      800,
      false,
      path.join(STORE_ASSETS_DIR, 'screenshot-2-keep-link-remove-recipient-1280x800.png')
    );

    // 3. Chrome Web Store Small Promo Tile (440x280, opaque)
    await captureHtmlToPng(
      buildSmallPromoTileHtml(svgMarkup),
      440,
      280,
      false,
      path.join(STORE_ASSETS_DIR, 'small-promo-tile-440x280.png')
    );

    // 4. Chrome Web Store Marquee Promo Tile (1400x560, opaque)
    await captureHtmlToPng(
      buildMarqueePromoTileHtml(svgMarkup),
      1400,
      560,
      false,
      path.join(STORE_ASSETS_DIR, 'marquee-promo-tile-1400x560.png')
    );

    cdp.close();
    process.stdout.write(
      `Generated extension icons in ${SRC_ICONS_DIR} and Chrome Web Store visual assets in ${STORE_ASSETS_DIR}\n`
    );
  } finally {
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
      await new Promise((resolve) => proc.once('exit', resolve));
    }
    await new Promise((r) => setTimeout(r, 60));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

void main();
