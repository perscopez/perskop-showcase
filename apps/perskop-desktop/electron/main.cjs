const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const {
  loadPerskopConfig,
  routeMacPrompt,
  chatViaVps,
  syncMemory,
  fetchMemory,
  VPS_PROVIDERS,
  listLocalProviders,
} = require("../../mac/lib/providers.mjs");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    title: "perskop",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The renderer only ever shows the bundled UI: block new windows and navigation.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const dev = process.env.PERSKOP_DEV_SERVER;
    if (!dev || !url.startsWith(dev)) event.preventDefault();
  });

  const dev = process.env.PERSKOP_DEV_SERVER;
  if (dev) win.loadURL(dev);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("perskop:get-providers", () => ({
    vps: VPS_PROVIDERS,
    local: listLocalProviders(loadPerskopConfig()),
  }));
  ipcMain.handle("perskop:get-config", () => {
    try {
      const c = loadPerskopConfig();
      return { apiUrl: c.apiUrl, hasToken: Boolean(c.apiToken), mode: "vps" };
    } catch (e) {
      return { error: String(e) };
    }
  });
  ipcMain.handle("perskop:chat", async (_e, { prompt, provider, mode }) => {
    const config = loadPerskopConfig();
    if (mode === "local") {
      const result = await routeMacPrompt(config, prompt, provider || undefined);
      const saved = await syncMemory(config, {
        title: prompt.slice(0, 80),
        content: result.output,
        provider: result.provider,
      });
      return { ...result, memoryId: saved.item?.id, via: "local" };
    }
    return chatViaVps(config, prompt, provider || "codex");
  });

  ipcMain.handle("perskop:memory", async () => {
    const config = loadPerskopConfig();
    return fetchMemory(config, 30);
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
