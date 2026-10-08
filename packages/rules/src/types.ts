import type {
  DiagnosticConfidence,
  DiagnosticFix,
  DiagnosticSeverity,
  DoctorRuleDefinition,
  EvidenceLocation
} from '@vue-doctor/core'
import type { DoctorRulePackContext, DoctorRulePackResult } from '@vue-doctor/core'
import type { SourceDocument, SourceDocumentBlock } from '@vue-doctor/source'
import type { Node as BabelNode } from '@babel/types'
import type { ParserOptions as BabelParserOptions } from '@babel/parser'
import type { Visitor as BabelTraverseVisitor } from '@babel/traverse'
import type {
  Node as OxcNode,
  ParserOptions as OxcParserOptions,
  VisitorObject as OxcVisitorObject
} from 'oxc-parser'

export type DoctorRuleMeta = Omit<DoctorRuleDefinition, 'code'>

export interface ScriptRuleCapabilities {
  /** Every supported backend provides a syntax tree. */
  syntax?: true
  /** Requires lexical bindings and scope. Provided only by the Babel backend. */
  scope?: true
  /** Reserved for a future type-checker integration. No current backend provides this. */
  types?: true
}

export interface ScriptBackendCapabilities {
  syntax: boolean
  scope: boolean
  types: boolean
}

export interface RuleSourcePosition {
  /** Full-document UTF-16 offset. */
  offset: number
  /** One-based line. */
  line: number
  /** One-based UTF-16 column. */
  column: number
}

export interface RuleSourceLocation {
  file: string
  start: RuleSourcePosition
  /** Exclusive end. */
  end: RuleSourcePosition
}

export interface RuleSourceRange {
  /** Block-relative UTF-16 offset. */
  start: number
  /** Block-relative exclusive UTF-16 offset. */
  end: number
}

export interface RuleReportInput<Node> {
  message: string
  /** AST node used for the diagnostic range. Defaults to the whole block. */
  node?: Node
  /** Block-relative UTF-16 range. Used when there is no suitable AST node. */
  range?: RuleSourceRange
  severity?: DiagnosticSeverity
  confidence?: DiagnosticConfidence
  evidence?: readonly EvidenceLocation[]
  fixes?: readonly DiagnosticFix[]
}

export interface ScriptRuleContext<Node> {
  readonly backend: 'oxc' | 'babel'
  readonly capabilities: Readonly<ScriptBackendCapabilities>
  readonly document: Readonly<SourceDocument>
  readonly block: Readonly<SourceDocumentBlock>
  readonly source: string
  /** Map a block-relative AST node or range to full-document coordinates. */
  location(nodeOrRange: Node | RuleSourceRange): RuleSourceLocation
  /** Read source text using block-relative AST offsets. */
  text(nodeOrRange: Node | RuleSourceRange): string
  report(input: RuleReportInput<Node>): void
}

export type OxcRuleContext = ScriptRuleContext<OxcNode>
export type BabelRuleContext = ScriptRuleContext<BabelNode>
export type OxcRuleVisitor = OxcVisitorObject
export type BabelRuleVisitor = BabelTraverseVisitor<undefined>

type BabelParserPlugin = NonNullable<BabelParserOptions['plugins']>[number]
type WithoutEstreePlugin<Plugin> = Plugin extends 'estree'
  ? never
  : Plugin extends readonly ['estree', ...unknown[]]
    ? never
    : Plugin

export type SafeBabelParserPlugin = WithoutEstreePlugin<BabelParserPlugin>
export type SafeBabelParserOptions = Omit<
  BabelParserOptions,
  'plugins' | 'startColumn' | 'startIndex' | 'startLine'
> & {
  /** `estree` would violate the native Babel Node/NodePath visitor contract. */
  plugins?: SafeBabelParserPlugin[]
}

export interface OxcScriptRuleOptions {
  parser: 'oxc'
  /** Capabilities the rule needs in addition to syntax. */
  requires?: ScriptRuleCapabilities
  /** `lang` is selected from each source block and cannot be overridden. */
  parserOptions?: Omit<OxcParserOptions, 'lang'>
  create(context: OxcRuleContext): OxcRuleVisitor
}

export interface BabelScriptRuleOptions {
  parser: 'babel'
  /** Capabilities the rule needs in addition to syntax. */
  requires?: ScriptRuleCapabilities
  /** Language-required TypeScript/JSX plugins are added automatically. */
  parserOptions?: SafeBabelParserOptions
  create(context: BabelRuleContext): BabelRuleVisitor
}

export interface OxcScriptRuleCheck extends OxcScriptRuleOptions {
  readonly kind: 'script'
}

export interface BabelScriptRuleCheck extends BabelScriptRuleOptions {
  readonly kind: 'script'
}

export type ScriptRuleCheck = OxcScriptRuleCheck | BabelScriptRuleCheck

export interface RuleEngineEntry<Config> {
  definition: DoctorRuleDefinition
  config: Config
}

/**
 * A shared execution backend for rules that need one coordinated parse, scope,
 * type-program, or framework-analysis pass.
 */
export interface RuleEngine<Config> {
  name: string
  /** Additional source extensions required by every rule using this engine. */
  sourceExtensions?: readonly string[]
  runBatch(
    context: DoctorRulePackContext,
    rules: readonly RuleEngineEntry<Config>[]
  ): DoctorRulePackResult | Promise<DoctorRulePackResult>
}

export interface EngineRuleCheck<Config> {
  readonly kind: 'engine'
  readonly engine: RuleEngine<Config>
  readonly config: Config
}

export type RuleCheck = ScriptRuleCheck | EngineRuleCheck<unknown>

export interface RuleDefinition<Check extends RuleCheck = RuleCheck> {
  meta: DoctorRuleMeta
  check: Check
}

export type RuleDefinitionRecord = Readonly<Record<string, RuleDefinition>>

export interface DefineRulesOptions<Rules extends RuleDefinitionRecord = RuleDefinitionRecord> {
  name: string
  rules: Rules
  /** Additional source extensions to request from the Doctor run. */
  sourceExtensions?: readonly string[]
}

export type { BabelNode, OxcNode }
