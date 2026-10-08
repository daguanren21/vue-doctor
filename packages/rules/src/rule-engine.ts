import type { EngineRuleCheck, RuleEngine } from './types.js'

export function defineRuleEngine<Config>(definition: RuleEngine<Config>): RuleEngine<Config> {
  if (!definition || typeof definition !== 'object'
    || typeof definition.name !== 'string' || !definition.name.trim()
    || typeof definition.runBatch !== 'function') {
    throw new Error('A Doctor rule engine must have a non-empty name and a runBatch function.')
  }
  return definition
}

export function engineRule<Config>(
  engine: RuleEngine<Config>,
  config: Config
): EngineRuleCheck<Config> {
  return { kind: 'engine', engine, config }
}
