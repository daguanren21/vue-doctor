import { access, copyFile, cp, mkdir, rm } from 'node:fs/promises'

const packageRoot = new URL('../', import.meta.url)
const skillSource = new URL('../../../skills/vue-doctor/', import.meta.url)
const skillDestination = new URL('skills/vue-doctor/', packageRoot)
const inspectorSource = new URL('../../inspector-ui/dist/inspector-client/', import.meta.url)
const inspectorDestination = new URL('dist/inspector-client/', packageRoot)
const guideSource = new URL('../../../docs/guide/', import.meta.url)
const guideDestination = new URL('docs/guide/', packageRoot)

// Missing build inputs are errors, never an incomplete publishable archive.
await Promise.all([
  access(new URL('SKILL.md', skillSource)),
  access(new URL('index.html', inspectorSource)),
  access(new URL('assets/inspector.js', inspectorSource)),
  access(new URL('assets/inspector.css', inspectorSource)),
  access(new URL('favicon.svg', inspectorSource)),
  access(new URL('THIRD-PARTY-LICENSES.txt', inspectorSource)),
  access(new URL('LUCIDE-LICENSE', inspectorSource)),
  access(new URL('README.md', guideSource))
])
await mkdir(new URL('dist/', packageRoot), { recursive: true })
await mkdir(new URL('skills/', packageRoot), { recursive: true })
await rm(skillDestination, { recursive: true, force: true })
await rm(guideDestination, { recursive: true, force: true })
await Promise.all([
  cp(skillSource, skillDestination, { recursive: true }),
  cp(inspectorSource, inspectorDestination, { recursive: true }),
  cp(guideSource, guideDestination, { recursive: true }),
  copyFile(
    new URL('../../rule-pack-eslint/dist/ESLINT-LICENSE', import.meta.url),
    new URL('dist/ESLINT-LICENSE', packageRoot)
  ),
  copyFile(new URL('../../../LICENSE', import.meta.url), new URL('LICENSE', packageRoot)),
  copyFile(new URL('../../../README.md', import.meta.url), new URL('README.md', packageRoot)),
  copyFile(new URL('../../../README.zh-CN.md', import.meta.url), new URL('README.zh-CN.md', packageRoot))
])
