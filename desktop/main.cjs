const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');
const { mkdirSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parse } = require('dotenv');

app.setName('PulseTradingDemo');
app.setAppUserModelId('local.pulse.trading.demo');
const testing = process.env.PULSE_TEST_MODE === '1';
const customData = process.env.PULSE_USER_DATA_DIR;
if (customData && !path.isAbsolute(customData)) throw new Error('PULSE_USER_DATA_DIR 必须是绝对路径');
const dataDir = customData || path.join(app.getPath('appData'), 'PulseTradingDemo');
mkdirSync(dataDir, { recursive: true });
mkdirSync(path.join(dataDir, 'browser'), { recursive: true });
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'browser'));

let window;
let service;
let quitting = false;
const settingsPath = path.join(dataDir, 'settings.env');
const writeTest = (name, value) => {
  if (testing) writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
};
const openWeb = () => service && shell.openExternal(service.url);
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    writeTest('second-instance.json', { received: true, web: argv.includes('--web') });
    if (argv.includes('--web') && !testing) void openWeb();
    if (window && !testing) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(async () => {
    if (!existsSync(settingsPath)) {
      writeFileSync(settingsPath, readFileSync(path.join(__dirname, 'settings.env.example'), 'utf8'), { mode: 0o600 });
    }
    const { startServer, loadConfig } = await import(pathToFileURL(path.join(__dirname, 'dist/server/app.js')).href);
    const settings = parse(readFileSync(settingsPath));
    const config = { ...loadConfig({ ...process.env, ...settings }), HOST: '127.0.0.1', PORT: 0,
      DATABASE_PATH: path.join(dataDir, 'trader.sqlite') };
    service = await startServer({ config, clientDir: path.join(__dirname, 'dist/client'), logger: false });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window = new BrowserWindow({ width: 1420, height: 960, minWidth: 860, minHeight: 650,
      show: !testing, backgroundColor: '#0b1320', title: '脉冲 Pulse · 桌面版',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (target.protocol === 'https:' && ['www.tradingview.com', 'tradingview.com'].includes(target.hostname)) void shell.openExternal(url);
      } catch { /* Invalid or untrusted destinations remain closed. */ }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      try { if (new URL(url).origin !== service.url) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
    window.on('closed', () => { window = undefined; });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '软件', submenu: [
        { label: '在浏览器打开网页版', click: () => void openWeb() },
        { label: '打开账户数据目录', click: () => void shell.openPath(dataDir) },
        { label: '编辑配置（保存后重启）', click: () => void shell.openPath(settingsPath) },
        { type: 'separator' }, { label: '退出软件', click: () => app.quit() }
      ] },
      { label: '查看', submenu: [{ role: 'reload', label: '刷新界面' }, { role: 'togglefullscreen', label: '全屏' },
        { role: 'resetzoom', label: '原始大小' }, { role: 'zoomin', label: '放大' }, { role: 'zoomout', label: '缩小' }] },
      { label: '帮助', submenu: [{ label: '关于与网页版地址', click: () => dialog.showMessageBox(window, {
        type: 'info', title: '脉冲 Pulse', message: 'OKX 虚拟交易观察台 ' + app.getVersion(),
        detail: '桌面和网页共用虚拟账户。\n网页版：' + service.url + '\n数据：' + dataDir + '\n关闭软件即停止后台扫描。所有交易均为虚拟积分。'
      }) }] }
    ]));
    await window.loadURL(service.url);
    window.setTitle('脉冲 Pulse · 桌面版');
    writeTest('ready.json', { ok: true, url: service.url, userData: dataDir, pid: process.pid,
      electron: process.versions.electron, node: process.versions.node, rendererLoaded: true,
      rendererSecurity: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    if (process.argv.includes('--web') && !testing) await openWeb();
  }).catch(error => {
    writeTest('error.json', { error: error instanceof Error ? error.message : '启动失败' });
    if (!testing) dialog.showErrorBox('脉冲 Pulse 启动失败', (error instanceof Error ? error.message : '无法启动本地服务') + '\n配置位置：' + settingsPath);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !service) return;
    event.preventDefault();
    quitting = true;
    const timeout = setTimeout(() => app.exit(1), 8000);
    service.close().then(() => { clearTimeout(timeout); app.quit(); }).catch(() => { clearTimeout(timeout); app.exit(1); });
  });
  // Test harness requests the same graceful shutdown path as the menu/window close.
  if (testing) setInterval(() => { if (existsSync(path.join(dataDir, 'request-quit'))) app.quit(); }, 200).unref();
}
