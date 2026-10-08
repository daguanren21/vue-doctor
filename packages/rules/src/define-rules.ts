import {
  validateDoctorRulePacks,
  type DoctorRuleDefinition,
  type DoctorRulePack
} from '@vue-doctor/core'
import { runDefinedRules, type ExecutableRule } from './runtime.js'
import type {
  DefineRulesOptions,
  RuleDefinition,
  RuleDefinitionRecord,
  RuleCheck,
  ScriptRuleCheck
} from './types.js'

const SCRIPT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue'] as const
const LOCAL_RULE_KEY = /^[a-z][a-z0-9-]*$/

export function defineRule<const Definition extends RuleDefinition>(definition: Definition): Definition {
  return definition
}

export function defineRules<const Rules extends RuleDefinitionRecord>(
  options: DefineRulesOptions<Rules>
): DoctorRulePack {
  const executableRules: ExecutableRule[] = []
  for (const [key, authored] of Object.entries(options.rules)) {
    if (!LOCAL_RULE_KEY.test(key)) {
      throw new Error(`Custom Doctor rule keys must match ${LOCAL_RULE_KEY}; received ${JSON.stringify(key)}.`)
    }
    if (!isRuleCheck(authored?.check)) {
      throw new Error(`Custom Doctor rule ${JSON.stringify(key)} must use an oxcRule, babelRule, or scriptRule check, or an engineRule check.`)
    }
    const definition: DoctorRuleDefinition = {
      ...authored.meta,
      code: `${options.name}/${key}`
    }
    executableRules.push({ definition, authored: authored as RuleDefinition<RuleCheck> })
  }

  const engineExtensions = executableRules.flatMap(({ authored }) => authored.check.kind === 'engine'
    ? authored.check.engine.sourceExtensions ?? []
    : [])

  const pack: DoctorRulePack = {
    name: options.name,
    rules: executableRules.map((rule) => rule.definition),
    sourceExtensions: [...new Set([...SCRIPT_EXTENSIONS, ...engineExtensions, ...(options.sourceExtensions ?? [])])],
    run(context) {
      return runDefinedRules(options.name, executableRules, context)
    }
  }
  validateDoctorRulePacks([pack])
  return pack
}

function isRuleCheck(value: unknown): value is RuleCheck {
  if (!value || typeof value !== 'object') return false
  const check = value as Partial<RuleCheck> & { parser?: unknown; create?: unknown; engine?: unknown }
  if (check.kind === 'script') {
    return ['oxc', 'babel'].includes(check.parser as string) && typeof check.create === 'function'
  }
  if (check.kind !== 'engine' || !check.engine || typeof check.engine !== 'object') return false
  const engine = check.engine as { name?: unknown; runBatch?: unknown }
  return typeof engine.name === 'string' && engine.name.trim().length > 0 && typeof engine.runBatch === 'function'
}
