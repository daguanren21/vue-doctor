import tsParser from '@typescript-eslint/parser'

let libraryBindings: ReadonlyMap<string, { type: boolean; value: boolean }> | undefined

/** Vue consumes fragment references, not the parser's library-variable objects. */
export const templateParser: Pick<typeof tsParser, 'parseForESLint'> = {
  parseForESLint(source, options) {
    libraryBindings ??= new Map(tsParser.parseForESLint('', { sourceType: 'module' })
      .scopeManager.globalScope!.variables.map(variable => [variable.name, {
        type: variable.isTypeVariable,
        value: variable.isValueVariable
      }]))
    const parsed = tsParser.parseForESLint(source, { ...options, lib: [] })
    const scope = parsed.scopeManager.globalScope!
    // Keep TS namespace resolution: only references unresolved by local scopes reach here.
    // Derive builtin bindings from this parser version rather than maintaining a globals list.
    scope.through = scope.through.filter(reference => {
      const binding = libraryBindings!.get(reference.identifier.name)
      return !binding || !(reference.isTypeReference && binding.type
        || reference.isValueReference && binding.value)
    })
    return parsed
  }
}
