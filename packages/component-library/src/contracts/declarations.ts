import {
  API,
  ElementFlags,
  ObjectFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags
} from 'typescript/unstable/sync'
import type {
  Checker,
  Project,
  Symbol as TypeScriptSymbol,
  Type,
  TypeReference
} from 'typescript/unstable/sync'
import type {
  CallSignatureDeclaration,
  NamedTupleMember,
  Node,
  TupleTypeNode
} from 'typescript/unstable/ast'
import { resolve } from 'node:path'
import type { ComponentLibraryEvidence } from '../types.js'
import type {
  ComponentContract,
  ComponentContractMap,
  ContractDimension,
  ContractIssue,
  ContractProvenance,
  DeclarationCacheInputs,
  DeclarationContractReadResult,
  EventContract,
  EventParameter,
  EventSignature,
  PropContract,
  PropTypeDescriptor
} from './types.js'

const VUE_BUILT_IN_PROPS = new Set(['key', 'ref', 'ref_for', 'ref_key', 'class', 'style'])

export async function readTypeScriptContracts(
  evidence: ComponentLibraryEvidence
): Promise<ComponentContractMap> {
  return (await readTypeScriptContractsWithCacheInputs(evidence)).contracts
}

export async function readTypeScriptContractsWithCacheInputs(
  evidence: ComponentLibraryEvidence
): Promise<DeclarationContractReadResult> {
  const entries = evidence.artifacts.declarationEntries
  const sources = entries.map(toTypeScriptProvenance)
  const components = new Map<string, ComponentContract>()
  const problems: ComponentContractMap['problems'] = []

  if (entries.length === 0) {
    return {
      contracts: { components, sources, problems },
      cacheInputs: { reliable: true, files: [], fileProbes: [], directoryProbes: [], resolutions: [] }
    }
  }

  const cwd = evidence.package.packageRoot ?? process.cwd()
  const tracking = createDeclarationCacheInputTracker()
  const api = new API({
    cwd,
    fs: {
      readFile(fileName) {
        tracking.files.add(normalizeTrackedPath(fileName, cwd))
        return undefined
      },
      fileExists(fileName) {
        tracking.fileProbes.add(normalizeTrackedPath(fileName, cwd))
        return undefined
      },
      directoryExists(directoryName) {
        tracking.directoryProbes.add(normalizeTrackedPath(directoryName, cwd))
        return undefined
      },
      getAccessibleEntries(directoryName) {
        tracking.directoryProbes.add(normalizeTrackedPath(directoryName, cwd))
        return undefined
      }
    }
  })
  let snapshot: ReturnType<API['updateSnapshot']> | undefined

  try {
    snapshot = api.updateSnapshot({ openFiles: entries.map((entry) => entry.path) })

    for (const [index, entry] of entries.entries()) {
      const project = snapshot.getDefaultProjectForFile(entry.path)
      const sourceFile = project?.program.getSourceFile(entry.path)
      if (!project || !sourceFile) {
        problems.push({ message: 'TypeScript could not load the declaration entry.', path: entry.path })
        continue
      }

      recordProjectCacheInputs(project, tracking, cwd)

      const checker = project.checker
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
      const provenance = sources[index]!

      for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
        const symbol = exported.flags & SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported
        const location = getSymbolLocation(symbol, project, sourceFile)
        const type = checker.getTypeOfSymbolAtLocation(symbol, location)
        const instance = getComponentInstanceType(checker, type)

        if (!instance || components.has(exported.name)) {
          continue
        }

        components.set(
          exported.name,
          createContractFromInstance(
            checker,
            project,
            exported.name,
            symbol.name,
            instance,
            location,
            provenance
          )
        )
      }
    }
  } finally {
    try {
      snapshot?.dispose()
    } finally {
      api.close()
    }
  }

  return {
    contracts: { components, sources, problems },
    cacheInputs: finalizeDeclarationCacheInputs(tracking)
  }
}

interface DeclarationCacheInputTracker {
  files: Set<string>
  fileProbes: Set<string>
  directoryProbes: Set<string>
  resolutions: Set<string>
  projects: Set<string>
}

function createDeclarationCacheInputTracker(): DeclarationCacheInputTracker {
  return {
    files: new Set(),
    fileProbes: new Set(),
    directoryProbes: new Set(),
    resolutions: new Set(),
    projects: new Set()
  }
}

function recordProjectCacheInputs(
  project: Project,
  tracking: DeclarationCacheInputTracker,
  cwd: string
): void {
  if (tracking.projects.has(project.id)) return
  tracking.projects.add(project.id)
  for (const file of project.program.getSourceFileNames()) {
    tracking.files.add(normalizeTrackedPath(file, cwd))
  }
  if (project.configFileName) {
    tracking.files.add(normalizeTrackedPath(project.configFileName, cwd))
  }
  tracking.resolutions.add(stableJson({
    configFileName: project.configFileName,
    compilerOptions: project.program.getCompilerOptions(),
    rootFiles: [...project.rootFiles]
  }))
}

function normalizeTrackedPath(path: string, cwd: string): string {
  return resolve(cwd, path)
}

function finalizeDeclarationCacheInputs(
  tracking: DeclarationCacheInputTracker
): DeclarationCacheInputs {
  const sorted = (values: Set<string>) => [...values].sort((left, right) => left.localeCompare(right))
  return {
    reliable: true,
    files: sorted(tracking.files),
    fileProbes: sorted(tracking.fileProbes),
    directoryProbes: sorted(tracking.directoryProbes),
    resolutions: sorted(tracking.resolutions)
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function toTypeScriptProvenance(entry: { path: string; relativePath: string }): ContractProvenance {
  return {
    source: 'typescript',
    path: entry.path,
    relativePath: entry.relativePath
  }
}

function getComponentInstanceType(
  checker: Checker,
  type: Type,
  seen = new Set<number>()
): Type | undefined {
  if (seen.has(type.id)) {
    return undefined
  }
  seen.add(type.id)

  for (const signature of checker.getSignaturesOfType(type, SignatureKind.Construct)) {
    const instance = checker.getReturnTypeOfSignature(signature)
    if (instance && isComponentInstance(checker, instance)) {
      return instance
    }
  }

  if (type.isIntersectionType() || type.isUnionType()) {
    for (const member of type.getTypes()) {
      const instance = getComponentInstanceType(checker, member, seen)
      if (instance) {
        return instance
      }
    }
  }

  if (isTypeReference(type)) {
    for (const argument of checker.getTypeArguments(type)) {
      const instance = getComponentInstanceType(checker, argument, seen)
      if (instance) {
        return instance
      }
    }
  }

  return undefined
}

function isTypeReference(type: Type): type is TypeReference {
  return type.isTypeReference() || (
    Boolean(type.flags & TypeFlags.Object) &&
    Boolean(type.isObjectType() && type.objectFlags & ObjectFlags.Reference)
  )
}

function isComponentInstance(checker: Checker, type: Type) {
  return Boolean(checker.getPropertyOfType(type, '$props') || checker.getPropertyOfType(type, '$emit'))
}

function createContractFromInstance(
  checker: Checker,
  project: Project,
  exportedName: string,
  symbolName: string,
  instance: Type,
  location: Node,
  provenance: ContractProvenance
): ComponentContract {
  const propsSymbol = checker.getPropertyOfType(instance, '$props')
  const emitSymbol = checker.getPropertyOfType(instance, '$emit')
  const props = new Map<string, PropContract>()
  const events = new Map<string, EventContract>()
  const listenerEvents = new Map<string, EventContract>()
  const propIssues: ContractIssue[] = []
  const eventIssues: ContractIssue[] = []
  let propsAcceptance: 'closed' | 'open' | 'unknown' = 'unknown'
  let eventsAcceptance: 'closed' | 'open' | 'unknown' = 'unknown'
  let hasOpenEventName = false
  let hasUnresolvedEventName = false

  if (propsSymbol) {
    const propsType = checker.getTypeOfSymbolAtLocation(
      propsSymbol,
      getSymbolLocation(propsSymbol, project, location)
    )

    if (propsType.isErrorType()) {
      propIssues.push({
        code: 'declaration-type-unresolved',
        message: 'The component $props type could not be resolved.',
        artifact: provenance.relativePath
      })
    } else {
      for (const prop of checker.getPropertiesOfType(propsType)) {
        const name = prop.name
        if (VUE_BUILT_IN_PROPS.has(name)) {
          continue
        }

        const eventName = getListenerEventName(name)
        const propLocation = getSymbolLocation(prop, project, location)
        const propType = checker.getTypeOfSymbolAtLocation(prop, propLocation)
        props.set(name, {
          name,
          required: !(prop.flags & SymbolFlags.Optional),
          types: describePropTypes(checker, propType)
        })
        if (eventName) {
          listenerEvents.set(eventName, {
            name: eventName,
            signatures: listenerSignatures(checker, prop, project, location),
            source: 'listener-prop'
          })
        }
      }

      propsAcceptance = checker.getIndexInfosOfType(propsType).length > 0 ? 'open' : 'closed'
    }
  }

  if (emitSymbol) {
    const emitType = checker.getTypeOfSymbolAtLocation(
      emitSymbol,
      getSymbolLocation(emitSymbol, project, location)
    )

    if (emitType.isErrorType()) {
      eventIssues.push({
        code: 'declaration-type-unresolved',
        message: 'The component $emit type could not be resolved.',
        artifact: provenance.relativePath
      })
    } else {
      const signatures = checker.getSignaturesOfType(emitType, SignatureKind.Call)
      for (const signature of signatures) {
        const parameters = signature.getParameters()
        const eventParameter = parameters[0]
        if (!eventParameter) {
          eventIssues.push({
            code: 'declaration-event-signature-invalid',
            message: 'An $emit call signature is missing its event parameter.',
            artifact: provenance.relativePath
          })
          continue
        }

        const eventParameterType = checker.getTypeOfSymbolAtLocation(
          eventParameter,
          getSymbolLocation(eventParameter, project, location)
        )
        const eventSignature = createEventSignature(checker, project, location, signature, parameters)
        const eventNames = getStringLiteralValues(eventParameterType)

        if (eventParameterType.flags & TypeFlags.String) {
          hasOpenEventName = true
        } else if (eventNames.length === 0) {
          hasUnresolvedEventName = true
          eventIssues.push({
            code: 'declaration-event-name-unresolved',
            message: 'An $emit event-name type is not a finite string-literal set.',
            artifact: provenance.relativePath
          })
        }

        for (const eventName of eventNames) {
          const current = events.get(eventName)
          const next: EventContract = current ?? {
            name: eventName,
            signatures: [],
            source: 'emit'
          }
          if (!next.signatures.some((candidate) => isSameSignature(candidate, eventSignature))) {
            next.signatures.push(eventSignature)
          }
          events.set(eventName, next)
        }
      }
      eventsAcceptance = hasOpenEventName
        ? 'open'
        : hasUnresolvedEventName || eventIssues.length > 0
          ? 'unknown'
          : 'closed'
    }
  }

  let hasListenerFallback = false
  for (const [eventName, event] of listenerEvents) {
    if (!events.has(eventName)) {
      events.set(eventName, event)
      hasListenerFallback = true
    }
  }
  if (hasListenerFallback) {
    eventsAcceptance = 'unknown'
    eventIssues.push({
      code: 'event-derived-from-listener-prop',
      message: 'Some events were derived from listener props because no matching $emit declaration was available.',
      artifact: provenance.relativePath
    })
  }

  return {
    name: exportedName,
    aliases: symbolName === exportedName ? [] : [symbolName],
    props: propsSymbol
      ? createDimension(propIssues.length > 0 ? 'partial' : 'known', propsAcceptance, props, propIssues)
      : createUnknownDimension(),
    events: emitSymbol || listenerEvents.size > 0
      ? createDimension(
        eventIssues.length > 0 ? 'partial' : 'known',
        eventsAcceptance,
        events,
        eventIssues
      )
      : createUnknownDimension(),
    slots: createUnknownDimension(),
    fallthrough: { attributes: 'unknown', listeners: 'unknown' },
    sources: [provenance]
  }
}

function createEventSignature(
  checker: Checker,
  project: Project,
  location: Node,
  signature: ReturnType<Checker['getSignaturesOfType']>[number],
  parameters: readonly TypeScriptSymbol[],
  payloadStart = 1
): EventSignature {
  const payload = parameters.slice(payloadStart)
  const last = payload.at(-1)
  if (last && signature.hasRestParameter) {
    const fixedPayload = payload.slice(0, -1).map(toEventParameter)
    const declaration = signature.declaration?.resolve(project) as CallSignatureDeclaration | undefined
    const restNode = declaration?.parameters.at(-1)
    const tupleNode = restNode?.type as TupleTypeNode | undefined
    if (tupleNode?.elements) {
      const tupleParameters: EventParameter[] = tupleNode.elements.map((element) => {
        const named = element as NamedTupleMember
        return {
          name: 'name' in named && named.name && 'text' in named.name ? named.name.text : undefined,
          optional: 'questionToken' in named && Boolean(named.questionToken),
          rest: 'dotDotDotToken' in named && Boolean(named.dotDotDotToken)
        }
      })
      return {
        parameters: [...fixedPayload, ...tupleParameters],
        minArity: fixedPayload.filter((parameter) => !parameter.optional).length
          + tupleParameters.filter((parameter) => !parameter.optional && !parameter.rest).length,
        maxArity: tupleParameters.some((parameter) => parameter.rest)
          ? null
          : fixedPayload.length + tupleParameters.length
      }
    }

    const lastType = checker.getTypeOfSymbolAtLocation(last, getSymbolLocation(last, project, location))
    if (lastType.isTupleType()) {
      const tupleArguments = checker.getTypeArguments(lastType)
      const tupleParameters = tupleArguments.map((type, index) => ({
        name: undefined,
        optional: Boolean(lastType.elementFlags[index]! & ElementFlags.Optional),
        rest: Boolean(lastType.elementFlags[index]! & (ElementFlags.Rest | ElementFlags.Variadic))
      }))
      return {
        parameters: [...fixedPayload, ...tupleParameters],
        minArity: fixedPayload.filter((parameter) => !parameter.optional).length
          + tupleParameters.filter((parameter) => !parameter.optional && !parameter.rest).length,
        maxArity: tupleParameters.some((parameter) => parameter.rest)
          ? null
          : fixedPayload.length + tupleParameters.length
      }
    }

    return {
      parameters: [...fixedPayload, { name: last.name, optional: false, rest: true }],
      minArity: fixedPayload.filter((parameter) => !parameter.optional).length,
      maxArity: null
    }
  }

  const eventParameters = payload.map(toEventParameter)
  return {
    parameters: eventParameters,
    minArity: eventParameters.filter((parameter) => !parameter.optional).length,
    maxArity: eventParameters.length
  }
}

function toEventParameter(parameter: TypeScriptSymbol): EventParameter {
  return {
    name: parameter.name,
    optional: isOptionalParameter(parameter),
    rest: false
  }
}

function isOptionalParameter(parameter: TypeScriptSymbol): boolean {
  if (parameter.flags & SymbolFlags.Optional) {
    return true
  }
  const declaration = parameter.valueDeclaration?.resolve()
  return Boolean(declaration && 'questionToken' in declaration && declaration.questionToken)
}

function listenerSignatures(
  checker: Checker,
  prop: TypeScriptSymbol,
  project: Project,
  location: Node
): EventSignature[] {
  const type = checker.getTypeOfSymbolAtLocation(prop, getSymbolLocation(prop, project, location))
  const signatures = checker.getSignaturesOfType(checker.getNonNullableType(type) ?? type, SignatureKind.Call)
  return signatures.length > 0
    ? signatures.map((signature) => createEventSignature(
        checker,
        project,
        location,
        signature,
        signature.getParameters(),
        0
      ))
    : [{ parameters: [], minArity: 0, maxArity: 0 }]
}

function isSameSignature(first: EventSignature, second: EventSignature): boolean {
  return first.minArity === second.minArity
    && first.maxArity === second.maxArity
    && first.parameters.length === second.parameters.length
    && first.parameters.every((parameter, index) => {
      const other = second.parameters[index]!
      return parameter.name === other.name
        && parameter.optional === other.optional
        && parameter.rest === other.rest
    })
}

function getStringLiteralValues(type: Type): string[] {
  if (type.isStringLiteralType()) {
    return [type.value]
  }

  if (type.isUnionType()) {
    return type.getTypes().flatMap(getStringLiteralValues)
  }

  return []
}

function describePropTypes(checker: Checker, type: Type): PropTypeDescriptor[] {
  const descriptors: PropTypeDescriptor[] = []
  const seen = new Set<string>()

  const visit = (current: Type) => {
    if (current.isErrorType() || current.flags & TypeFlags.Never) {
      return
    }

    if (current.flags & (TypeFlags.Undefined | TypeFlags.Void)) {
      return
    }

    if (current.isUnionType()) {
      for (const member of current.getTypes()) {
        visit(member)
      }
      return
    }

    if (current.isIntersectionType()) {
      for (const member of current.getTypes()) {
        visit(member)
      }
      return
    }

    if (current.flags & TypeFlags.Null) {
      add({ kind: 'null' })
      return
    }

    if (current.isStringLiteralType()) {
      add({ kind: 'literal', value: current.value })
      return
    }

    if (current.isNumberLiteralType()) {
      add({ kind: 'literal', value: current.value })
      return
    }

    if (current.isBooleanLiteralType()) {
      add({ kind: 'literal', value: current.value === true || checker.typeToString(current) === 'true' })
      return
    }

    if (current.flags & TypeFlags.String) {
      add({ kind: 'string' })
      return
    }

    if (current.flags & TypeFlags.Number) {
      add({ kind: 'number' })
      return
    }

    if (current.flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral)) {
      add({ kind: 'boolean' })
      return
    }

    if (current.flags & TypeFlags.BigInt) {
      add({ kind: 'bigint' })
      return
    }

    if (current.flags & TypeFlags.ESSymbol) {
      add({ kind: 'symbol' })
      return
    }

    if (current.flags & TypeFlags.Any) {
      add({ kind: 'any' })
      return
    }

    if (current.flags & TypeFlags.Unknown) {
      add({ kind: 'unknown' })
      return
    }

    if (checker.getSignaturesOfType(current, SignatureKind.Call).length > 0) {
      add({ kind: 'function' })
      return
    }

    if (isArrayLikeType(checker, current)) {
      add({ kind: 'array' })
      return
    }

    if (current.flags & TypeFlags.Object || current.isObjectType() || current.isTypeReference()) {
      add({ kind: 'object' })
      return
    }

    // Fall back to the printed type when we cannot classify more specifically.
    const printed = checker.typeToString(current)
    if (printed === 'string') add({ kind: 'string' })
    else if (printed === 'number') add({ kind: 'number' })
    else if (printed === 'boolean') add({ kind: 'boolean' })
    else if (printed === 'bigint') add({ kind: 'bigint' })
    else if (printed === 'symbol') add({ kind: 'symbol' })
    else if (printed === 'any') add({ kind: 'any' })
    else if (printed === 'unknown') add({ kind: 'unknown' })
    else add({ kind: 'object' })
  }

  const add = (descriptor: PropTypeDescriptor) => {
    const key = descriptor.kind === 'literal'
      ? `literal:${String(descriptor.value)}`
      : descriptor.kind
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    descriptors.push(descriptor)
  }

  visit(type)

  const onlyBooleanLiterals = descriptors.length > 0 && descriptors.every((descriptor) => (
    descriptor.kind === 'literal' && (descriptor.value === true || descriptor.value === false)
  ))
  if (onlyBooleanLiterals) {
    const values = new Set(descriptors.map((descriptor) => descriptor.value))
    if (values.has(true) && values.has(false)) {
      return [{ kind: 'boolean' }]
    }
  }

  return descriptors.sort((left, right) => {
    const leftKey = left.kind === 'literal' ? `literal:${String(left.value)}` : left.kind
    const rightKey = right.kind === 'literal' ? `literal:${String(right.value)}` : right.kind
    return leftKey.localeCompare(rightKey)
  })
}

function isArrayLikeType(checker: Checker, type: Type): boolean {
  if (checker.isArrayType(type)) {
    return true
  }

  const symbolName = type.getSymbol()?.name
  if (symbolName === 'Array' || symbolName === 'ReadonlyArray') {
    return true
  }

  const printed = checker.typeToString(type)
  return printed.endsWith('[]') || printed.startsWith('Array<') || printed.startsWith('ReadonlyArray<')
}

function getSymbolLocation(symbol: TypeScriptSymbol, project: Project, fallback: Node): Node {
  return symbol.valueDeclaration?.resolve(project) ??
    symbol.declarations[0]?.resolve(project) ??
    fallback
}

function getListenerEventName(name: string): string | undefined {
  if (!name.startsWith('on') || name.length < 3 || !isUpperCaseLetter(name[2]!)) {
    return undefined
  }

  return toKebabCase(name.slice(2))
}

function toKebabCase(value: string) {
  let result = ''

  for (const [index, character] of [...value].entries()) {
    if (isUpperCaseLetter(character)) {
      if (index > 0 && result.at(-1) !== '-') {
        result += '-'
      }
      result += character.toLowerCase()
      continue
    }

    if (character === '_' || character === ' ') {
      if (result && result.at(-1) !== '-') {
        result += '-'
      }
      continue
    }

    result += character
  }

  return result
}

function isUpperCaseLetter(character: string) {
  return character >= 'A' && character <= 'Z'
}

function createDimension<T>(
  knowledge: ContractDimension<T>['knowledge'],
  acceptance: ContractDimension<T>['acceptance'],
  entries: Map<string, T>,
  issues: ContractIssue[] = []
): ContractDimension<T> {
  return { knowledge, acceptance, entries, issues }
}

function createUnknownDimension<T>(): ContractDimension<T> {
  return createDimension('unknown', 'unknown', new Map())
}
