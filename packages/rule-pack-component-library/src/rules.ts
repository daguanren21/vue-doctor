import type { DiagnosticSeverity, DoctorRuleDefinition } from '@vue-doctor/core'

export const componentLibraryRuleDefinitions = [
  {
    code: 'component-event-payload-changed',
    domain: 'component-library',
    tags: ['events', 'interaction', 'signature'],
    title: 'Component event payload changed',
    description: 'The handler requires more arguments than any complete installed event signature can provide.',
    verification: 'static',
    defaultEnabled: true,
    defaultSeverity: 'warning',
    requires: { ownership: 'matched', contractDimensions: ['events'], signature: 'exact' },
    help: {
      problem: 'The handler requires more arguments than any complete installed event signature can provide.',
      remediation: 'Check the installed event signatures and remove unsupported required parameters or make them optional. Handlers may ignore emitted arguments; parameter names alone do not establish a mismatch.'
    }
  },
  {
    code: 'component-prop-unsupported',
    domain: 'component-library',
    tags: ['props', 'compatibility'],
    title: 'Component prop is unsupported',
    description: 'Business source passes a prop that is not declared by the installed component library metadata.',
    verification: 'static',
    defaultEnabled: true,
    defaultSeverity: 'warning',
    requires: { ownership: 'matched', contractDimensions: ['props'] },
    help: {
      problem: 'Business source passes a prop that is not declared by the installed component library metadata.',
      remediation: 'Verify the installed package version and remove the prop, rename it to a supported prop, or upgrade/fix the component library when runtime evidence proves the prop exists.'
    }
  },
  {
    code: 'component-prop-required-missing',
    domain: 'component-library',
    tags: ['props'],
    title: 'Required component prop is missing',
    description: 'Business source omits a prop that the installed component library contract marks as required.',
    verification: 'static',
    defaultEnabled: true,
    defaultSeverity: 'error',
    requires: { ownership: 'matched', contractDimensions: ['props'] },
    help: {
      problem: 'Business source omits a prop that the installed component library contract marks as required.',
      remediation: 'Pass the required prop on the component usage, or adjust the component library contract when the prop is intentionally optional.'
    }
  },
  {
    code: 'component-prop-type-mismatch',
    domain: 'component-library',
    tags: ['props', 'types'],
    title: 'Component prop type does not match',
    description: 'Business source passes a static prop value that does not match the installed component library prop type contract.',
    verification: 'static',
    defaultEnabled: true,
    defaultSeverity: 'warning',
    requires: { ownership: 'matched', contractDimensions: ['props'] },
    help: {
      problem: 'Business source passes a static prop value that does not match the installed component library prop type contract.',
      remediation: 'Update the static value to one of the accepted contract types or literals, or bind a dynamic expression when the value is computed at runtime.'
    }
  },
  {
    code: 'component-attribute-unverified',
    domain: 'component-library',
    tags: ['attributes', 'fallthrough'],
    title: 'Component attribute support is unverified',
    description: 'The installed public contract does not declare the attribute, and runtime forwarding evidence cannot prove whether the final child component or native element supports it.',
    verification: 'static',
    defaultEnabled: false,
    defaultSeverity: 'info',
    requires: { ownership: 'matched', contractDimensions: ['props'], acceptance: 'open-or-unknown' },
    help: {
      problem: 'The installed public contract does not declare the attribute, and runtime forwarding evidence cannot prove whether the final child component or native element supports it.',
      remediation: 'Confirm the receiving component contract or final native element. Declare the prop in the wrapper metadata when it is intentionally supported.'
    }
  },
  {
    code: 'component-model-unsupported',
    domain: 'component-library',
    tags: ['models', 'events', 'interaction'],
    title: 'Component v-model contract is unsupported',
    description: 'Business source uses a v-model binding whose update event is not declared by the installed component library metadata.',
    verification: 'static',
    defaultEnabled: true,
    defaultSeverity: 'warning',
    requires: { ownership: 'matched', contractDimensions: ['events'] },
    help: {
      problem: 'Business source uses a v-model binding whose update event is not declared by the installed component library metadata.',
      remediation: 'Use a v-model or model argument whose update event is declared by the installed component version. Prefer also declaring the matching prop; emit-backed wrappers that read modelValue from attrs are accepted when update:modelValue (or update:<arg>) is declared.'
    }
  },
  {
    code: 'component-slot-unsupported',
    domain: 'component-library',
    tags: ['slots'],
    title: 'Component slot is unsupported',
    description: 'Business source provides a named slot that is not declared by the installed component library metadata.',
    verification: 'static',
    defaultEnabled: true,
    defaultSeverity: 'warning',
    requires: { ownership: 'matched', contractDimensions: ['slots'] },
    help: {
      problem: 'Business source provides a named slot that is not declared by the installed component library metadata.',
      remediation: 'Verify the installed component metadata and use a supported slot, remove the slot template, or upgrade/fix the component library when runtime evidence proves the slot exists.'
    }
  },
  {
    code: 'component-event-unsupported',
    domain: 'component-library',
    tags: ['events', 'interaction'],
    title: 'Component event is unsupported',
    description: 'Business source listens to an event that is not declared by the installed component library metadata.',
    verification: 'static',
    defaultEnabled: true,
    defaultSeverity: 'warning',
    requires: { ownership: 'matched', contractDimensions: ['events'] },
    help: {
      problem: 'Business source listens to an event that is not declared by the installed component library metadata.',
      remediation: 'Verify the installed package version and use a supported event, remove the listener, or upgrade/fix the component library when runtime evidence proves the event exists.'
    }
  }
] as const satisfies readonly DoctorRuleDefinition[]

const rulesByCode = new Map<string, DoctorRuleDefinition>(
  componentLibraryRuleDefinitions.map((rule) => [rule.code, rule])
)

export function getComponentLibraryRuleDefaultSeverity(code: string): DiagnosticSeverity {
  const severity = rulesByCode.get(code)?.defaultSeverity
  if (!severity) throw new Error(`Component-library diagnostic ${code} is not declared in the rule catalog.`)
  return severity
}
