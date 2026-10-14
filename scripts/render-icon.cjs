// Renders the title-screen GHOST logo onto a macOS-style tile as a 1024px PNG (app icon source).
// Needs the renderer dev server (npm run dev:web). Usage: npx electron scripts/render-icon.cjs <out.png>
// Then build icon.icns / icon.ico / icons/*.png under resources/build (see git history for the sips/iconutil steps).
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const out = process.argv[process.argv.length - 1]
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 2200, height: 2200, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  await win.loadURL('http://127.0.0.1:5173/?screen=title'); win.webContents.setZoomFactor(1.5)
  await new Promise((r) => setTimeout(r, 3000))
  const rect = await win.webContents.executeJavaScript(`(() => {
    const st = document.createElement('style')
    st.textContent = 'html,body,#root,#g-app{background:transparent!important} body *{visibility:hidden!important} .tl-logo-art, .tl-logo-art *{visibility:visible!important} .tl-logo-art__glow{display:none!important} canvas{display:none!important}'
    document.head.appendChild(st)
    const r = document.querySelector('.tl-logo-art__ring').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  const pad = 4
  const z = 1.5; const img = await win.webContents.capturePage({ x: Math.floor((rect.x - pad) * z), y: Math.floor((rect.y - pad) * z), width: Math.ceil((rect.w + pad * 2) * z), height: Math.ceil((rect.h + pad * 2) * z) }); console.log('captured', img.getSize())
  const logoPng = img.toPNG()
  // Compose onto a macOS-style squircle tile at 1024.
  const S = 1024
  const comp = new BrowserWindow({ show: false, width: S, height: S, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  const html = `<html><body style="margin:0;background:transparent;width:${S}px;height:${S}px;overflow:hidden">
    <div style="position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:185px;overflow:hidden;background:radial-gradient(120% 120% at 30% 18%, #3d2c70 0%, #1b1533 46%, #0c0a15 100%);box-shadow: inset 0 0 0 3px rgba(255,255,255,0.07)">
      <div style="position:absolute;inset:0;background:radial-gradient(50% 50% at 50% 52%, rgba(255,102,170,0.35), transparent 70%)"></div>
      <img src="data:image/png;base64,${logoPng.toString('base64')}" style="position:absolute;left:50%;top:50%;width:690px;height:690px;transform:translate(-50%,-50%)"/>
    </div></body></html>`
  await comp.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
  await new Promise((r) => setTimeout(r, 500))
  const final = await comp.webContents.capturePage({ x: 0, y: 0, width: S, height: S })
  fs.writeFileSync(out, final.toPNG())
  console.log('logo rect', rect, 'final', final.getSize())
  app.quit()
})
