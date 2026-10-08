import type {
  BabelScriptRuleCheck,
  BabelScriptRuleOptions,
  OxcScriptRuleCheck,
  OxcScriptRuleOptions
} from './types.js'

export function scriptRule(options: OxcScriptRuleOptions): OxcScriptRuleCheck
export function scriptRule(options: BabelScriptRuleOptions): BabelScriptRuleCheck
export function scriptRule(
  options: OxcScriptRuleOptions | BabelScriptRuleOptions
): OxcScriptRuleCheck | BabelScriptRuleCheck {
  return { kind: 'script', ...options }
}

export function oxcRule(options: Omit<OxcScriptRuleOptions, 'parser'>): OxcScriptRuleCheck {
  return scriptRule({ parser: 'oxc', ...options })
}

export function babelRule(options: Omit<BabelScriptRuleOptions, 'parser'>): BabelScriptRuleCheck {
  return scriptRule({ parser: 'babel', ...options })
}
