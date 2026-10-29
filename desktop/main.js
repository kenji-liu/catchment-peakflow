// 集水區洪峰流量圖台 — Windows 桌面版
// 以本機 HTTP 服務提供 site/ 內的網頁 (DEM 圖磚需以 fetch 讀取，file:// 不可用)。
// 固定埠號讓瀏覽器儲存 (localStorage) 的控制點與參數在每次開啟時都保留；埠號被占用時改用隨機埠。
const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, 'site');
const PORT = 47615;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream',
};

function handler(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv.address().port));
  });
}

async function start() {
  let port;
  try { port = await listen(PORT); } catch (e) { port = await listen(0); }
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: '集水區洪峰流量圖台',
    icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 外部連結 (資料來源、GitHub 等) 改用系統瀏覽器開啟
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') win.webContents.reload();
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
