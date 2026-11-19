// Assemble the GitHub Pages site into _site/: the landing page, plus each
// effect's built demo at /<package-name>/. Run after `npm run build`.
//
// Videos are not in git. Locally they are whatever `npm run videos` left in
// videos/; in CI the Pages workflow downloads them from the `videos` release.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const OUT = '_site'
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

const packages = readdirSync('packages')
  .filter((dir) => existsSync(`packages/${dir}/package.json`))
  .map((dir) => ({ dir, ...JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8')) }))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT)
cpSync('site', OUT, { recursive: true })
if (existsSync('videos')) {
  cpSync('videos', `${OUT}/videos`, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') })
}

const cards = packages.map((p) => {
  const dist = `packages/${p.dir}/dist`
  if (!existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run build\` first`)
  cpSync(dist, `${OUT}/${p.name}`, { recursive: true })
  const video = existsSync(`${OUT}/videos/${p.name}.mp4`)
    ? `<video controls preload="none" playsinline poster="posters/${p.name}.jpg" src="videos/${p.name}.mp4"></video>`
    : `<a href="${p.name}/"><img src="posters/${p.name}.jpg" alt="" loading="lazy" /></a>`
  return `
      <article id="${p.name}">
        ${video}
        <div class="body">
          <h2>${p.name} <small>v${p.version}</small></h2>
          <p>${escape(p.description)}</p>
          <pre><code>npm install ${p.name}</code></pre>
          <nav>
            <a class="primary" href="${p.name}/">Live demo</a>
            <a href="https://www.npmjs.com/package/${p.name}">npm</a>
            <a href="https://github.com/genie360s/js-web-effects/tree/main/packages/${p.dir}#readme">Source and docs</a>
          </nav>
        </div>
      </article>`
})

const page = readFileSync('site/index.html', 'utf8').replace('<!-- effects -->', cards.join('\n'))
writeFileSync(`${OUT}/index.html`, page)
console.log(`_site: landing page + ${packages.length} demos` + (existsSync(`${OUT}/videos`) ? ' + videos' : ' (no videos/ found)'))
