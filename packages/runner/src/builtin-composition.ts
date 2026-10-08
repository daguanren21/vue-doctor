import { componentLibraryRuleDefinitions } from '@vue-doctor/rule-pack-component-library/rules'
import { vueRuleDefinitions } from '@vue-doctor/rule-pack-vue/rules'
import { eslintRulePack } from '@vue-doctor/rule-pack-eslint'
import type { DoctorRulePack, DoctorRuleCatalog } from '@vue-doctor/core'

/** Built-in diagnostics and executors. Inspector UI is separate. */
export function createBuiltinRuleComposition(): { catalogs: DoctorRuleCatalog[]; packs: DoctorRulePack[] } {
  return {
    catalogs: [
      { name: 'vue', rules: vueRuleDefinitions },
      { name: 'component-library', rules: componentLibraryRuleDefinitions },
      { name: eslintRulePack.name, rules: eslintRulePack.rules }
    ],
    packs: [eslintRulePack]
  }
}
