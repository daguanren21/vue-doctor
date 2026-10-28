import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import type { SFCDescriptor, SFCParseResult, SFCScriptBlock } from '@vue/compiler-sfc'

const functionalTemplateDiagnostic = '<template functional> is no longer supported in Vue 3, since functional components no longer have significant performance difference from stateful ones. Just use a normal <template> instead.'

type RuntimeSfcNode = { type: string; [key: string]: unknown }

export interface CompiledRuntimeSfc {
  script: SFCScriptBlock
  /** False means generated options could not be inspected, not that props are absent. */
  propsResolved: boolean
  /** Present only when the compiler emits an own props option, including an empty one. */
  props?: RuntimeSfcNode
}

export type RuntimeSfcCompiler = (descriptor: SFCDescriptor) => CompiledRuntimeSfc | undefined

/** Memoize within one extraction only; later runs must observe changed imported types. */
export function createRuntimeSfcCompiler(): RuntimeSfcCompiler {
  const compiledScripts = new WeakMap<SFCDescriptor, CompiledRuntimeSfc | undefined>()
  return descriptor => {
    if (!compiledScripts.has(descriptor)) compiledScripts.set(descriptor, compileRuntimeSfc(descriptor))
    return compiledScripts.get(descriptor)
  }
}

function compileRuntimeSfc(descriptor: SFCDescriptor): CompiledRuntimeSfc | undefined {
  let compiled: CompiledRuntimeSfc | undefined
  if (descriptor.script || descriptor.scriptSetup) {
    try {
      const script = compileScript(descriptor, { id: descriptor.filename })
      compiled = { script, propsResolved: !descriptor.scriptSetup }
      if (descriptor.scriptSetup) {
        const body = babelParse(script.content, {
          sourceType: 'module',
          plugins: descriptor.scriptSetup.lang === 'tsx' || descriptor.scriptSetup.lang === 'jsx'
            ? ['typescript', 'decorators-legacy', 'explicitResourceManagement', 'importAttributes', 'jsx']
            : ['typescript', 'decorators-legacy', 'explicitResourceManagement', 'importAttributes']
        }).program.body
        const exported = body.find(node => node.type === 'ExportDefaultDeclaration')
        if (exported?.type === 'ExportDefaultDeclaration') {
          const declaration = exported.declaration
          // TS emits defineComponent({...}); JS may emit Object.assign(normal, {...}).
          const options = declaration.type === 'CallExpression' ? declaration.arguments.at(-1) : declaration
          if (options?.type === 'ObjectExpression') {
            for (let index = options.properties.length - 1; index >= 0; index--) {
              const property = options.properties[index]!
              if (property.type === 'SpreadElement' || property.computed) break
              const name = property.key.type === 'Identifier' ? property.key.name
                : property.key.type === 'StringLiteral' ? property.key.value : undefined
              if (name === 'props' && property.type === 'ObjectProperty') {
                compiled.props = property.value as RuntimeSfcNode
                break
              }
            }
            compiled.propsResolved = true
          }
        }
      }
    } catch {
      // Preserve unavailable compilation rather than inventing macro-derived options.
    }
  }
  return compiled
}

/** Vue 2's functional attribute is valid syntax; retain all actual parse errors. */
export function parseRuntimeSfc(source: string, filename: string): SFCParseResult {
  const result = parse(source, { filename })
  if (result.descriptor.template?.attrs.functional !== undefined) {
    return {
      ...result,
      errors: result.errors.filter(error => !(error instanceof SyntaxError && error.message === functionalTemplateDiagnostic))
    }
  }
  return result
}
