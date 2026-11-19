// Records one "how it works" video per effect, by driving the real built demo
// in Chrome with a scripted pointer and captions laid over the page.
//
//   npm run build && npm run site
//   npm run videos                      # all of them
//   npm run videos -- web-fire web-sand # just these
//
// Needs Google Chrome and ffmpeg on the machine, and a real GPU: the effects
// are WebGL2, and a software renderer will not keep up.
// Writes videos/<name>.mp4 (not in git; they ship as release assets) and
// site/posters/<name>.jpg (in git; the landing page and README use them).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { storyboards } from './storyboards.mjs'

const W = 1920
const H = 1080
const PORT = 4181
const SITE = 'https://genie360s.github.io/js-web-effects'

if (!existsSync('_site')) throw new Error('_site/ is missing: run `npm run build && npm run site` first')
const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(storyboards)
for (const name of names) if (!storyboards[name]) throw new Error(`no storyboard for "${name}"`)

// Everything the video adds to the page lives in one shadow root, so the
// demo's CSS cannot reach it and it cannot reach the demo. It starts behind a
// black curtain; the recorder lifts it once the page under it is running.
function overlay() {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; }
      :host { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; color: #fff; }
      .curtain { position: absolute; inset: 0; background: #000; opacity: 1; transition: opacity .35s ease; }
      .card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
              justify-content: center; gap: 28px; text-align: center; padding: 0 12%;
              background: rgba(6, 6, 6, .74); backdrop-filter: blur(14px);
              opacity: 0; transition: opacity .5s ease; }
      .card h1 { font-size: 132px; font-weight: 800; letter-spacing: -.045em; line-height: .95; }
      .card p { font-size: 40px; font-weight: 400; line-height: 1.3; color: rgba(255, 255, 255, .82); max-width: 26em; }
      .card code { font: 600 44px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 18px 34px;
                   border-radius: 14px; background: rgba(255, 255, 255, .1); border: 1px solid rgba(255, 255, 255, .22); }
      .card small { font-size: 30px; color: rgba(255, 255, 255, .7); }
      .lower { position: absolute; left: 0; right: 0; bottom: 64px; display: flex; flex-direction: column;
               align-items: center; gap: 14px; opacity: 0; transform: translateY(12px);
               transition: opacity .35s ease, transform .35s ease; }
      .lower.on { opacity: 1; transform: none; }
      .chips { display: flex; align-items: center; gap: 12px; }
      .chips span { font-size: 22px; font-weight: 600; padding: 9px 18px; border-radius: 999px;
                    background: rgba(255, 255, 255, .92); color: #111; white-space: nowrap; }
      .chips i { font-style: normal; font-size: 24px; color: #fff; text-shadow: 0 1px 6px #000; }
      .caption { max-width: 1280px; padding: 20px 34px; border-radius: 18px; text-align: center;
                 font-size: 34px; font-weight: 500; line-height: 1.32; text-wrap: balance;
                 background: rgba(8, 8, 8, .8); backdrop-filter: blur(10px);
                 border: 1px solid rgba(255, 255, 255, .14); }
      .cursor { position: absolute; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
                border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 0 1.5px rgba(0, 0, 0, .55), 0 2px 10px rgba(0, 0, 0, .5);
                opacity: 0; transition: opacity .2s, background .1s, width .1s, height .1s, margin .1s; }
      .cursor.down { background: rgba(255, 255, 255, .55); width: 26px; height: 26px; margin: -13px 0 0 -13px; }
    </style>
    <div class="cursor"></div>
    <div class="lower"><div class="chips"></div><div class="caption"></div></div>
    <div class="card"></div>
    <div class="curtain"></div>`
  const $ = (sel) => root.querySelector(sel)
  const cursor = $('.cursor')
  addEventListener('pointermove', (e) => {
    cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`
  }, true)
  addEventListener('pointerdown', () => cursor.classList.add('down'), true)
  addEventListener('pointerup', () => cursor.classList.remove('down'), true)
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  window.__rec = {
    curtain: (on) => { $('.curtain').style.opacity = on ? 1 : 0 },
    cursor: (on) => { cursor.style.opacity = on ? 1 : 0 },
    say(text, chips = []) {
      $('.lower').classList.toggle('on', !!text)
      if (!text) return
      $('.caption').textContent = text
      $('.chips').innerHTML = chips.map((c) => `<span>${esc(c)}</span>`).join('<i>→</i>')
    },
    card(lines) {
      const card = $('.card')
      if (lines) card.innerHTML = lines.map(([tag, text]) => `<${tag}>${esc(text)}</${tag}>`).join('')
      card.style.opacity = lines ? 1 : 0
    },
  }
  const attach = () => document.documentElement.append(host)
  if (document.documentElement) attach()
  else addEventListener('DOMContentLoaded', attach)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

// A point on the Catmull-Rom spline through `pts`, u in 0..1.
function along(pts, u) {
  const n = pts.length - 1
  const f = Math.min(u * n, n - 1e-6)
  const i = Math.floor(f)
  const t = f - i
  const p = (k) => pts[Math.max(0, Math.min(n, k))]
  const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)]
  const axis = (a) =>
    0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t * t +
      (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t * t * t)
  return [axis(0), axis(1)]
}

// What a storyboard gets to work with. Coordinates are CSS pixels in a
// 1920×1080 viewport; durations are milliseconds.
function stage(page, base) {
  let at = [W / 2, H / 2]
  let caption = ['', []]
  const rec = (method, ...args) => page.evaluate(([m, a]) => window.__rec[m](...a), [method, args])
  const s = {
    page,
    wait: sleep,
    say: (text, chips = []) => { caption = [text, chips]; return rec('say', text, chips) },
    card: (lines) => rec('card', lines),
    // Trace a smooth curve through the points, taking `ms` over it.
    async path(points, ms = 1500) {
      const pts = [at, ...points]
      const start = performance.now()
      for (;;) {
        const u = Math.min(1, (performance.now() - start) / ms)
        at = along(pts, ease(u))
        await page.mouse.move(at[0], at[1])
        if (u >= 1) break
        await sleep(6)
      }
    },
    move: (x, y, ms = 700) => s.path([[x, y]], ms),
    // Go to the first point, press, trace the rest, release.
    async drag(points, ms = 1800, settle = 500) {
      await s.move(points[0][0], points[0][1], settle)
      await page.mouse.down()
      await s.path(points.slice(1), ms)
      await page.mouse.up()
    },
    async click(x, y) {
      await s.move(x, y, 600)
      await page.mouse.down()
      await sleep(90)
      await page.mouse.up()
    },
    type: (text) => page.keyboard.type(text, { delay: 75 }),
    // Dip to black, change page, come back. `route` is a hash ("#/text") or a
    // file ("text.html") inside the effect's demo.
    async go(route, warmup = 900) {
      await rec('curtain', true)
      await sleep(380)
      if (route.startsWith('#') && page.url().startsWith(base)) {
        await page.evaluate((hash) => { location.hash = hash }, route)
      } else {
        await page.goto(base + route)
      }
      await sleep(warmup)
      await page.mouse.move(at[0], at[1])
      await rec('cursor', true)
      await rec('say', ...caption)
      await rec('curtain', false)
      await sleep(380)
    },
  }
  return s
}

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('ffmpeg failed')
}

async function record(browser, name) {
  const board = storyboards[name]
  const base = `http://localhost:${PORT}/${name}/`
  const dir = mkdtempSync(join(tmpdir(), `rec-${name}-`))
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await context.addInitScript(overlay)
  const page = await context.newPage()
  page.on('pageerror', (err) => console.warn(`  [${name}] page error: ${err.message}`))
  const s = stage(page, base)

  // Chrome hands over a frame whenever the page repaints, each with the time
  // it was shown, so the video keeps the page's own timing.
  const frames = []
  const cdp = await context.newCDPSession(page)
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`)
    frames.push({ file, t: metadata.timestamp })
    writeFileSync(file, Buffer.from(data, 'base64'))
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })

  await page.goto(base + (board.start ?? ''))
  await sleep(1200)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 96, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
  await s.card([['h1', board.title], ['p', board.tagline]])
  await page.evaluate(() => window.__rec.curtain(false))
  await sleep(3600)
  await s.card(null)
  await page.evaluate(() => window.__rec.cursor(true))
  await sleep(500)

  await board.run(s)

  await s.say('')
  await page.evaluate(() => window.__rec.cursor(false))
  await s.card([['h1', board.title], ['code', `npm install ${name}`], ['small', `${SITE.replace('https://', '')}/${name}/`]])
  await sleep(4200)
  await page.evaluate(() => window.__rec.curtain(true))
  await sleep(600)
  await cdp.send('Page.stopScreencast')
  await context.close()

  // Each frame is held until the next one arrived.
  const list = frames.map((f, i) => {
    const hold = i + 1 < frames.length ? frames[i + 1].t - f.t : 1 / 60
    return `file '${f.file}'\nduration ${Math.max(hold, 0.001).toFixed(4)}`
  })
  list.push(`file '${frames.at(-1).file}'`)
  writeFileSync(join(dir, 'frames.txt'), list.join('\n'))
  const seconds = frames.at(-1).t - frames[0].t

  mkdirSync('videos', { recursive: true })
  mkdirSync('site/posters', { recursive: true })
  // H.264 that every browser plays, starting before the whole file has loaded.
  // CRF holds the quality; the rate cap keeps noisy scenes (fire, sand grain)
  // from costing a phone its data plan.
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'),
    // 30 fps: the screencast delivers about 44 unevenly spaced frames a second,
    // which is an even 30 but a juddering 60. The frames are full-range JPEG;
    // video players expect limited-range BT.709, so say so and convert.
    '-vf', 'fps=30,scale=in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high',
    '-crf', '19', '-maxrate', '7M', '-bufsize', '14M', '-movflags', '+faststart', '-an',
    `videos/${name}.mp4`,
  ])
  ffmpeg(['-ss', String(board.poster ?? 8), '-i', `videos/${name}.mp4`, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', `site/posters/${name}.jpg`])
  rmSync(dir, { recursive: true, force: true })
  console.log(`${name}: ${seconds.toFixed(1)} s, ${frames.length} frames captured`)
}

const server = await preview({ configFile: false, logLevel: 'silent', build: { outDir: '_site' }, preview: { port: PORT, strictPort: true } })
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
    // headless Chrome on a Mac falls back to software GL without this
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
  ],
})
try {
  for (const name of names) await record(browser, name)
} finally {
  await browser.close()
  await server.close()
}
