import ts from 'typescript'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface ProjectAlias {
  pattern: string
  targets: string[]
}

interface AliasConfig {
  baseUrl?: string
  paths?: Record<string, unknown>
  pathsDirectory?: string
}

/** Read JSONC only: never load executable build configuration or infer directory conventions. */
export async function readProjectAliases(
  root: string,
  readConfig: (file: string) => Promise<string | undefined>
): Promise<ProjectAlias[]> {
  const active = new Set<string>()
  const load = async (file: string, source?: string): Promise<AliasConfig> => {
    if (active.has(file)) throw new Error(`Alias configuration inheritance cycle at ${file}.`)
    active.add(file)
    try {
      const text = source ?? await readConfig(file)
      if (text === undefined) throw new Error(`Alias configuration ${file} is unavailable or outside the consuming package.`)
      const parsed = ts.parseConfigFileTextToJson(file, text)
      if (parsed.error) throw new Error(`Alias configuration ${file} is not valid JSONC.`)
      const config = parsed.config as Record<string, unknown>
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Alias configuration ${file} must be an object.`)
      let inherited: AliasConfig = {}
      if (config.extends !== undefined) {
        if (typeof config.extends !== 'string' || !config.extends.startsWith('.')) {
          throw new Error(`Alias configuration ${file} has unsupported non-local or multiple inheritance.`)
        }
        const parent = resolve(dirname(file), config.extends)
        inherited = await load(parent.endsWith('.json') ? parent : `${parent}.json`)
      }
      const compiler = config.compilerOptions as Record<string, unknown> | undefined
      if (compiler !== undefined && (!compiler || typeof compiler !== 'object' || Array.isArray(compiler))) {
        throw new Error(`Alias configuration ${file} has invalid compilerOptions.`)
      }
      if (compiler?.baseUrl !== undefined) {
        if (typeof compiler.baseUrl !== 'string') throw new Error(`Alias configuration ${file} has a non-static baseUrl.`)
        inherited.baseUrl = resolve(dirname(file), compiler.baseUrl)
      }
      if (compiler?.paths !== undefined) {
        if (!compiler.paths || typeof compiler.paths !== 'object' || Array.isArray(compiler.paths)) {
          throw new Error(`Alias configuration ${file} has invalid paths.`)
        }
        inherited.paths = compiler.paths as Record<string, unknown>
        inherited.pathsDirectory = dirname(file)
      }
      return inherited
    } finally {
      active.delete(file)
    }
  }

  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = join(root, name)
    const text = await readConfig(file)
    if (text === undefined) continue
    const config = await load(file, text)
    // Declaration redirects describe types, not a runtime project import target.
    return Object.entries(config.paths ?? {})
      .filter(([, values]) => !(Array.isArray(values) && values.length > 0
        && values.every(value => typeof value === 'string' && /\.d\.[cm]?ts$/.test(value))))
      .map(([pattern, values]) => ({
        pattern,
        targets: pattern.length > 0 && (pattern.match(/\*/g)?.length ?? 0) <= 1 && Array.isArray(values)
          && values.every((value): value is string => typeof value === 'string' && value.length > 0 && (value.match(/\*/g)?.length ?? 0) <= (pattern.includes('*') ? 1 : 0))
          ? values.map((value) => resolve(config.baseUrl ?? config.pathsDirectory ?? root, value))
          : []
      }))
  }
  return []
}

/** TypeScript paths precedence: exact match, then longest prefix; ties and targets retain declared order. */
export function matchProjectAlias(specifier: string, aliases: readonly ProjectAlias[]): string[] | undefined {
  const exact = aliases.find((alias) => alias.pattern === specifier)
  if (exact) return exact.targets
  let selected: ProjectAlias | undefined
  let captured = ''
  let prefixLength = -1
  for (const alias of aliases) {
    const star = alias.pattern.indexOf('*')
    if (star < 0) continue
    const prefix = alias.pattern.slice(0, star)
    const suffix = alias.pattern.slice(star + 1)
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) continue
    if (prefix.length <= prefixLength) continue
    selected = alias
    captured = specifier.slice(prefix.length, specifier.length - suffix.length)
    prefixLength = prefix.length
  }
  return selected?.targets.map((target) => target.replace('*', () => captured)).filter(isAbsolute)
}
