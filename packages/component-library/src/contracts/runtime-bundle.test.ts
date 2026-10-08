import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readMappedRuntimeEntry } from './runtime-bundle.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function bundleFixture(entryId = 0) {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runtime-map-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  const original = 'export default { render() {} }'
  const sourceFile = join(root, 'src/index.js')
  const entry = { path: join(root, 'bundle.js'), relativePath: 'bundle.js', source: 'exports' as const, entry: '.' }
  const bundle = `module.exports = (function(modules) {
    function load(id) {
      var current = { exports: {} }
      modules[id].call(current.exports, current, current.exports, load)
      return current.exports
    }
    return load(load.s = ${entryId})
  })([function(module, exports) {
exports.default = component
  }, function(module, exports) {
exports.default = privateComponent
  }]);\n//# sourceMappingURL=bundle.js.map`
  const publicLine = bundle.split('\n').findIndex(line => line === 'exports.default = component')
  const map = { version: 3, sources: ['webpack:///./src/index.js'], sourcesContent: [original], names: [], mappings: `${';'.repeat(publicLine)}AAAA` }
  await writeFile(entry.path, bundle)
  await writeFile(sourceFile, original)
  await writeFile(`${entry.path}.map`, JSON.stringify(map))
  return { root, entry, sourceFile, available: new Set([entry.path, sourceFile]), map, bundle }
}

function mappingAtColumn(column: number, originalColumn = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const encode = (number: number) => {
    let value = number * 2
    let encoded = ''
    do {
      const digit = value % 32
      value = Math.floor(value / 32)
      encoded += alphabet[digit + (value ? 32 : 0)]
    } while (value)
    return encoded
  }
  return `${encode(column)}AA${encode(originalColumn)}`
}

async function mappedBindingFixture(body: string, original: string, mappedExpression: string, originalColumn = 0) {
  const fixture = await bundleFixture()
  const bundle = fixture.bundle
    .replace('function(module, exports) {', 'function(module, exports, load) {')
    .replace('exports.default = component', body)
  const lines = bundle.split('\n')
  const line = lines.findIndex(value => value.includes(mappedExpression))
  await Promise.all([
    writeFile(fixture.entry.path, bundle),
    writeFile(fixture.sourceFile, original),
    writeFile(`${fixture.entry.path}.map`, JSON.stringify({
      ...fixture.map, sourcesContent: [original],
      mappings: `${';'.repeat(line)}${mappingAtColumn(lines[line]!.indexOf(mappedExpression), originalColumn)}`
    }))
  ])
  return fixture
}

describe('published bundle public-entry provenance', () => {
  test('accepts an actual mapped public export and normalizes only module-scope downlevel syntax and comments', async () => {
    const fixture = await bundleFixture()
    const published = 'export default { render() {} }; export const version = 1'
    await writeFile(fixture.sourceFile, published)
    await writeFile(`${fixture.entry.path}.map`, JSON.stringify({
      ...fixture.map, sourcesContent: ['export default { render() {} }; export var version = 1 // WEBPACK FOOTER']
    }))
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toMatchObject({
      file: fixture.sourceFile, source: published, mapFile: `${fixture.entry.path}.map`
    })
  })

  test.each(['missing', 'malformed', 'stale'] as const)('rejects %s maps or mapped source evidence', async kind => {
    const fixture = await bundleFixture()
    if (kind === 'missing') await rm(`${fixture.entry.path}.map`)
    else if (kind === 'malformed') await writeFile(`${fixture.entry.path}.map`, '{')
    else await writeFile(fixture.sourceFile, 'export default { props: ["changed"], render() {} }')
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toBeUndefined()
  })

  test.each(['map', 'source'] as const)('rejects %s symlinks outside the physical package', async kind => {
    const fixture = await bundleFixture()
    const outside = await mkdtemp(join(tmpdir(), 'vue-doctor-runtime-map-outside-'))
    roots.push(outside)
    const destination = join(outside, 'evidence')
    const original = kind === 'map' ? `${fixture.entry.path}.map` : fixture.sourceFile
    await writeFile(destination, kind === 'map' ? JSON.stringify(fixture.map) : fixture.map.sourcesContent[0]!)
    await rm(original)
    await symlink(destination, original)
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toBeUndefined()
  })

  test('does not confuse a mapped internal module with the bootstrap entry', async () => {
    const fixture = await bundleFixture(1)
    // Even an explicit unmapped segment must not let a greatest-lower-bound lookup
    // resurrect a mapping from the preceding, non-entry module.
    const privateLine = fixture.bundle.split('\n').findIndex(line => line === 'exports.default = privateComponent')
    const segments = fixture.map.mappings.split(';')
    while (segments.length <= privateLine) segments.push('')
    segments[privateLine] = 'A'
    await writeFile(`${fixture.entry.path}.map`, JSON.stringify({ ...fixture.map, mappings: segments.join(';') }))
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toBeUndefined()
  })

  test('rejects entry export replacement even when a default assignment is mapped', async () => {
    const fixture = await bundleFixture()
    await writeFile(fixture.entry.path, fixture.bundle.replace('exports.default = component', 'exports = {}; exports.default = component'))
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toBeUndefined()
  })

  test.each([false, true])('accepts a mapped RHS after an unmapped segment (named mapping: %s)', async named => {
    const fixture = await bundleFixture()
    const lines = fixture.bundle.split('\n')
    const line = lines.findIndex(line => line === 'exports.default = component')
    const column = lines[line]!.indexOf('component')
    await writeFile(`${fixture.entry.path}.map`, JSON.stringify({
      ...fixture.map,
      names: named ? ['Public'] : [],
      mappings: `${';'.repeat(line)}A,${mappingAtColumn(column)}${named ? 'A' : ''}`
    }))
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toMatchObject({
      file: fixture.sourceFile
    })
  })

  test('rejects a preceding private-module mapping on the same minified line', async () => {
    const fixture = await bundleFixture()
    const bundle = 'module.exports=(function(m){function r(i){var x={exports:{}};m[i].call(x.exports,x,x.exports,r);return x.exports}return r(r.s=1)})([function(module,exports){exports.default=privateValue},function(module,exports){exports.default=publicValue}]);\n//# sourceMappingURL=bundle.js.map'
    const privateColumn = bundle.indexOf('exports.default=privateValue')
    await writeFile(fixture.entry.path, bundle)
    await writeFile(`${fixture.entry.path}.map`, JSON.stringify({
      ...fixture.map, mappings: mappingAtColumn(privateColumn)
    }))
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toBeUndefined()
    const publicColumn = bundle.indexOf('exports.default=publicValue')
    // Remove the three source-coordinate fields, leaving only the generated delta.
    const unmappedPublic = mappingAtColumn(publicColumn - privateColumn).slice(0, -3)
    await writeFile(`${fixture.entry.path}.map`, JSON.stringify({
      ...fixture.map, mappings: `${mappingAtColumn(privateColumn)},${unmappedPublic}`
    }))
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toBeUndefined()
    await writeFile(`${fixture.entry.path}.map`, JSON.stringify({
      ...fixture.map, mappings: mappingAtColumn(bundle.indexOf('publicValue'))
    }))
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toMatchObject({
      file: fixture.sourceFile
    })
  })

  test('traces a minified default import through canonical Babel interop', async () => {
    const fixture = await mappedBindingFixture(
      'var imported = load(1), wrapped = function(value) { return value && value.__esModule ? value : { default: value } }(imported); exports.default = wrapped.default;',
      "import Public from './Public.vue'; export default Public;",
      'load(1)'
    )
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toMatchObject({
      file: fixture.sourceFile, defaultOnly: true
    })
  })

  test.each([
    ['a nonidentity factory', 'var imported = load(1), wrapped = function(value) { return { default: replacement } }(imported); exports.default = wrapped.default;'],
    ['an async factory', 'var imported = load(1), wrapped = async function(value) { return value && value.__esModule ? value : { default: value } }(imported); exports.default = wrapped.default;'],
    ['a generator factory', 'var imported = load(1), wrapped = function*(value) { return value && value.__esModule ? value : { default: value } }(imported); exports.default = wrapped.default;'],
    ['a replaced wrapper', 'var imported = load(1), wrapped = function(value) { return value && value.__esModule ? value : { default: value } }(imported); wrapped.default = replacement; exports.default = wrapped.default;'],
    ['an escaped wrapper', 'var imported = load(1), wrapped = function(value) { return value && value.__esModule ? value : { default: value } }(imported); mutate(wrapped); exports.default = wrapped.default;'],
    ['an escaped container alias', 'var imported = load(1), wrapped = function(value) { return value && value.__esModule ? value : { default: value } }(imported); var box = { wrapped }; mutate(box); exports.default = wrapped.default;'],
    ['an escaped callback', 'var imported = load(1), wrapped = function(value) { return value && value.__esModule ? value : { default: value } }(imported); mutate(() => wrapped); exports.default = wrapped.default;'],
    ['a replaced loader', 'load = foreignLoader; var imported = load(1), wrapped = function(value) { return value && value.__esModule ? value : { default: value } }(imported); exports.default = wrapped.default;']
  ])('rejects mapped default imports with %s', async (_label, body) => {
    const fixture = await mappedBindingFixture(body!, "import Public from './Public.vue'; export default Public;", 'load(1)')
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toBeUndefined()
  })

  test('traces a scope-hoisted public object without exposing its other exports', async () => {
    const original = 'const Public = { name: "Public" }; export default Public; export const Internal = {}'
    const fixture = await mappedBindingFixture(
      'var component = { name: "Public" }; var alias = component; exports.default = alias;',
      original, '{ name:', original.indexOf('{')
    )
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toMatchObject({
      file: fixture.sourceFile, defaultOnly: true
    })
  })

  test('does not borrow a private declaration on the same source line as a public export', async () => {
    const original = 'const Private = { name: "Private" }; const Public = {}; export default Public'
    const fixture = await mappedBindingFixture(
      'var component = { name: "Private" }; exports.default = component;',
      original, '{ name:', original.indexOf('{')
    )
    expect(await readMappedRuntimeEntry(fixture.entry, fixture.root, fixture.available)).toBeUndefined()
  })
})
