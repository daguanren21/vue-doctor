import { parse, type SFCParseResult } from '@vue/compiler-sfc'

const functionalTemplateDiagnostic = '<template functional> is no longer supported in Vue 3, since functional components no longer have significant performance difference from stateful ones. Just use a normal <template> instead.'

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
