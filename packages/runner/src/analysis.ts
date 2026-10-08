import {
  extractComponentLibraryContracts,
  type ComponentContract,
  type ComponentContractMap,
  type ComponentLibraryEvidence
} from '@vue-doctor/component-library'
import { resolveVueVersion } from '@vue-doctor/core'
import type {
  ComponentOwnership,
  ComponentLibraryCoverage,
  ContractKnowledge,
  CoverageProblem,
  CoverageStatus,
  DoctorCoverage,
  ProjectContext,
  ProjectContextIssue
} from '@vue-doctor/core'
import {
  classifyComponentPropSupport,
  isComponentEventListener,
  type ComponentUsageContractMatch
} from '@vue-doctor/rule-pack-component-library'
import type { VueComponentUsage, VueSourceUsageReport } from '@vue-doctor/source'

export interface AnalyzeComponentLibrariesOptions {
  source: VueSourceUsageReport
  libraries: ComponentLibraryEvidence[]
  contextIssues?: ProjectContextIssue[]
  projectContext?: ProjectContext
  vueVersions?: Readonly<Record<string, string | undefined>>
}

export interface ComponentLibraryAnalysis {
  coverage: DoctorCoverage
  matches: ComponentUsageContractMatch[]
  ownership: ComponentOwnership[]
}

interface ContractCandidate {
  library: ComponentLibraryEvidence
  contracts: ComponentContractMap
}

interface CandidateState {
  candidate: ContractCandidate
  detected: boolean
  detectedUsageCount: number
  matched: Array<{
    usage: VueComponentUsage
    contract: ComponentContract
    contracts: ComponentContractMap
  }>
  unmatchedAfterAttribution: boolean
  ambiguous: boolean
  ownershipProblems: CoverageProblem[]
}

type MatchDecision =
  | { kind: 'match'; candidate: ContractCandidate; contract: ComponentContract; origin: 'direct-import' | 'registered-plugin' | 'unique-contract' }
  | { kind: 'attributed-unmatched'; candidate: ContractCandidate; origin: 'direct-import' | 'registered-plugin' }
  | { kind: 'ambiguous'; candidates: ContractCandidate[] }
  | { kind: 'unmatched' }

const statusRank: Record<CoverageStatus, number> = {
  complete: 0,
  partial: 1,
  blocked: 2
}

export async function analyzeComponentLibraries(
  options: AnalyzeComponentLibrariesOptions
): Promise<ComponentLibraryAnalysis> {
  const candidates = await Promise.all(options.libraries.map(async (library) => ({
    library,
    contracts: await extractContracts(library)
  })))
  const states = new Map(candidates.map((candidate) => [candidate, createCandidateState(candidate)]))
  const matches: ComponentUsageContractMatch[] = []
  const ownership: ComponentOwnership[] = []

  for (const usage of options.source.components) {
    const scopedCandidates = candidatesForUsage(usage, candidates, options.projectContext)
    const decision = chooseLibrary(usage, scopedCandidates, pluginsForUsage(usage, options.source.globalPlugins))

    if (decision.kind === 'match') {
      const state = states.get(decision.candidate)!
      const matchedUsage = withMatchedOrigin(usage, decision.candidate, decision.origin)
      state.detected = true
      state.detectedUsageCount += 1
      state.matched.push({
        usage: matchedUsage,
        contract: decision.contract,
        contracts: decision.candidate.contracts
      })
      matches.push({
        usage: matchedUsage,
        library: decision.candidate.library,
        contract: decision.contract,
        contracts: decision.candidate.contracts
      })
      ownership.push({
        status: 'matched',
        package: decision.candidate.library.package,
        evidence: decision.origin,
        candidates: [decision.candidate.library.package]
      })
      continue
    }

    if (decision.kind === 'attributed-unmatched') {
      const state = states.get(decision.candidate)!
      state.detected = true
      state.detectedUsageCount += 1
      state.unmatchedAfterAttribution = true
      ownership.push({
        status: 'matched',
        package: decision.candidate.library.package,
        evidence: decision.origin,
        candidates: [decision.candidate.library.package]
      })
      continue
    }

    if (decision.kind === 'ambiguous') {
      const ambiguousStates = decision.candidates.map((candidate) => states.get(candidate)!)
      for (const state of ambiguousStates) {
        state.detected = true
        state.ambiguous = true
      }

      const problemOwner = [...ambiguousStates].sort((first, second) => (
        first.candidate.library.package.canonicalName.localeCompare(second.candidate.library.package.canonicalName)
      ))[0]
      problemOwner?.ownershipProblems.push(createAmbiguousOwnershipProblem(usage, decision.candidates))
      ownership.push({
        status: 'ambiguous',
        candidates: decision.candidates.map((candidate) => candidate.library.package)
      })
      continue
    }

    ownership.push({ status: 'unmatched', candidates: [] })
  }

  const failedFiles = deriveSourceFailures(options.source)
  const discoveryIssues = options.source.discoveryIssues ?? []
  const contextIssues = options.contextIssues ?? []
  const sourceStatus: CoverageStatus = failedFiles.length > 0 || discoveryIssues.length > 0 || contextIssues.length > 0
    ? 'partial'
    : 'complete'
  const libraries = candidates
    .map((candidate) => states.get(candidate)!)
    .filter((state) => state.detected)
    .map((state) => toLibraryCoverage(state, options.vueVersions))
  const status = worstStatus([sourceStatus, ...libraries.map((library) => library.status)])

  return {
    coverage: {
      status,
      source: {
        status: sourceStatus,
        scannedFileCount: options.source.files.length,
        failedFiles,
        ...(discoveryIssues.length > 0 ? { discoveryIssues } : {}),
        ...(contextIssues.length > 0 ? { contextIssues } : {})
      },
      componentLibraries: libraries
    },
    matches,
    ownership
  }
}

function candidatesForUsage(
  usage: VueComponentUsage,
  candidates: ContractCandidate[],
  projectContext: ProjectContext | undefined
): ContractCandidate[] {
  if (!projectContext) return candidates
  const targetPackage = projectContext.packages.find((item) => item.targetFiles.includes(usage.file))
  const application = usage.applicationId
    ? projectContext.applications.find((item) => item.id === usage.applicationId)
    : undefined
  const packageContext = targetPackage ?? (application
    ? projectContext.packages.find((item) => item.root === application.packageRoot)
    : undefined)
  if (!packageContext) return candidates
  const allowed = Object.values(packageContext.inventory.packages)
  return candidates.filter((candidate) => allowed.some((identity) => (
    isSamePackageIdentity(identity, candidate.library.package)
  )))
}

function isSamePackageIdentity(
  left: ComponentLibraryEvidence['package'],
  right: ComponentLibraryEvidence['package']
): boolean {
  if (left.packageJsonPath && right.packageJsonPath) return left.packageJsonPath === right.packageJsonPath
  return left.dependencyName === right.dependencyName && left.canonicalName === right.canonicalName
}

function pluginsForUsage(
  usage: VueComponentUsage,
  plugins: VueSourceUsageReport['globalPlugins']
): VueSourceUsageReport['globalPlugins'] {
  return usage.applicationId === undefined
    ? plugins.filter((plugin) => plugin.applicationId === undefined)
    : plugins.filter((plugin) => plugin.applicationId === usage.applicationId)
}

async function extractContracts(library: ComponentLibraryEvidence): Promise<ComponentContractMap> {
  try {
    return await extractComponentLibraryContracts(library)
  } catch (error) {
    return {
      components: new Map(),
      sources: [],
      problems: [{
        message: `Component contract extraction failed: ${error instanceof Error ? error.message : String(error)}`
      }]
    }
  }
}

function deriveSourceFailures(source: VueSourceUsageReport) {
  return source.fileResults.flatMap((file) => file.blocks
    .filter((block) => block.status === 'failed')
    .map((block) => ({
      file: file.file,
      block: block.kind,
      message: block.message ?? 'Source block parsing failed.'
    })))
    .sort((left, right) => (
      compareText(left.file, right.file)
      || compareText(left.block, right.block)
      || compareText(left.message, right.message)
    ))
}

function createCandidateState(candidate: ContractCandidate): CandidateState {
  return {
    candidate,
    detected: false,
    detectedUsageCount: 0,
    matched: [],
    unmatchedAfterAttribution: false,
    ambiguous: false,
    ownershipProblems: []
  }
}

function chooseLibrary(
  usage: VueComponentUsage,
  candidates: ContractCandidate[],
  plugins: VueSourceUsageReport['globalPlugins']
): MatchDecision {
  if (usage.origin?.kind === 'local-import') {
    return { kind: 'unmatched' }
  }
  if (usage.origin?.kind === 'direct-import' && usage.origin.package) {
    const directCandidates = candidates.filter((candidate) => candidate.library.package.importRoots.includes(usage.origin!.package!.packageName))
    if (directCandidates.length === 1) {
      return candidateDecision(directCandidates[0]!, usage, 'direct-import')
    }
    if (directCandidates.length > 1) {
      return { kind: 'ambiguous', candidates: directCandidates }
    }
    return { kind: 'unmatched' }
  }

  const pluginCandidates = candidatesForComponentName(usage, candidates.filter((candidate) => (
    plugins.some((plugin) => plugin.package.packageName && candidate.library.package.importRoots.includes(plugin.package.packageName))
  )))
  const named = pluginCandidates.length > 0 ? pluginCandidates : candidatesForComponentName(usage, candidates)
  if (named.length === 1) {
    return candidateDecision(named[0]!, usage, pluginCandidates.length > 0 ? 'registered-plugin' : 'unique-contract')
  }
  if (named.length > 1) {
    return { kind: 'ambiguous', candidates: named }
  }
  return { kind: 'unmatched' }
}

function candidateDecision(
  candidate: ContractCandidate,
  usage: VueComponentUsage,
  origin: 'direct-import' | 'registered-plugin' | 'unique-contract'
): MatchDecision {
  const contract = findContract(usage, candidate)
  return contract
    ? { kind: 'match', candidate, contract, origin }
    : origin === 'unique-contract'
      ? { kind: 'unmatched' }
      : { kind: 'attributed-unmatched', candidate, origin }
}

function candidatesForComponentName(
  usage: VueComponentUsage,
  candidates: ContractCandidate[]
): ContractCandidate[] {
  return candidates.filter((candidate) => findContract(usage, candidate))
}

function findContract(
  usage: VueComponentUsage,
  candidate: ContractCandidate
): ComponentContract | undefined {
  const names = [usage.origin?.importedName, usage.componentName, usage.tag]
  for (const name of names) {
    if (!name) {
      continue
    }
    const contract = candidate.contracts.components.get(name)
    if (contract) {
      return contract
    }
  }
  return undefined
}

function withMatchedOrigin(
  usage: VueComponentUsage,
  candidate: ContractCandidate,
  origin: 'direct-import' | 'registered-plugin' | 'unique-contract'
): VueComponentUsage {
  if (origin === 'direct-import') {
    return usage
  }

  return {
    ...usage,
    origin: {
      kind: origin === 'registered-plugin' ? 'global-plugin' : 'unique-contract-match',
      package: {
        specifier: candidate.library.package.canonicalName,
        packageName: candidate.library.package.canonicalName
      }
    }
  }
}

function toLibraryCoverage(
  state: CandidateState,
  vueVersions: AnalyzeComponentLibrariesOptions['vueVersions']
): ComponentLibraryCoverage {
  const { library, contracts } = state.candidate
  const contractSources = contracts.sources.map((source) => ({
    kind: 'component-contract' as const,
    source: source.source,
    file: source.path
  }))
  const extractionProblems: CoverageProblem[] = contracts.problems.map((problem) => ({
    code: 'component-library-contracts-partial',
    message: problem.message,
    evidence: problem.path
      ? [{ kind: 'component-contract', file: problem.path }]
      : []
  }))
  const dimensions = aggregateDimensions(state.matched)
  const blocked = contracts.components.size === 0
  const checkedDimensionIncomplete = state.matched.some(({ usage, contract, contracts }) => (
    hasIncompleteCheckedDimension(usage, contract, contracts, vueVersions?.[usage.file])
  ))
  const partial = state.ambiguous
    || state.unmatchedAfterAttribution
    || extractionProblems.length > 0
    || checkedDimensionIncomplete
  const problems = blocked
    ? [createUnavailableContractsProblem(library, contractSources)]
    : [...extractionProblems, ...state.ownershipProblems]

  return {
    package: library.package,
    status: blocked ? 'blocked' : partial ? 'partial' : 'complete',
    contractSources,
    detectedUsageCount: state.detectedUsageCount,
    matchedUsageCount: state.matched.length,
    dimensions,
    problems
  }
}

function aggregateDimensions(
  matches: Array<{
    usage: VueComponentUsage
    contract: ComponentContract
    contracts: ComponentContractMap
  }>
): ComponentLibraryCoverage['dimensions'] {
  const contracts = matches.map((match) => match.contract)
  return {
    props: aggregateKnowledge(matches.map(getCheckedPropKnowledge)),
    events: aggregateKnowledge(contracts.map((contract) => contract.events.knowledge)),
    models: aggregateKnowledge(contracts.map((contract) => (
      combineKnowledge(contract.props.knowledge, contract.events.knowledge)
    ))),
    slots: aggregateKnowledge(contracts.map((contract) => contract.slots.knowledge))
  }
}

function getCheckedPropKnowledge(
  match: {
    usage: VueComponentUsage
    contract: ComponentContract
    contracts: ComponentContractMap
  }
): ContractKnowledge {
  if (match.contract.props.knowledge !== 'known') {
    return match.contract.props.knowledge
  }

  return match.usage.props.some((prop) => (
    classifyComponentPropSupport(match.contract, prop.name, match.contracts) === 'unknown'
  )) ? 'partial' : 'known'
}

function aggregateKnowledge(values: ContractKnowledge[]): ContractKnowledge {
  if (values.length === 0 || values.every((value) => value === 'unknown')) {
    return 'unknown'
  }
  if (values.every((value) => value === 'known')) {
    return 'known'
  }
  return 'partial'
}

function combineKnowledge(first: ContractKnowledge, second: ContractKnowledge): ContractKnowledge {
  if (first === 'known' && second === 'known') {
    return 'known'
  }
  if (first === 'unknown' && second === 'unknown') {
    return 'unknown'
  }
  return 'partial'
}

function hasIncompleteCheckedDimension(
  usage: VueComponentUsage,
  contract: ComponentContract,
  contracts: ComponentContractMap,
  vueVersion: string | undefined
): boolean {
  const vueMajor = resolveVueVersion(vueVersion)?.major
  return (usage.props.length > 0 && getCheckedPropKnowledge({ usage, contract, contracts }) !== 'known')
    || (usage.events.some(event => isComponentEventListener(event, vueMajor)) && contract.events.knowledge !== 'known')
    || (usage.slots.length > 0 && contract.slots.knowledge !== 'known')
    || (usage.models.length > 0 && combineKnowledge(
      contract.props.knowledge,
      contract.events.knowledge
    ) !== 'known')
}

function createUnavailableContractsProblem(
  library: ComponentLibraryEvidence,
  contractSources: ComponentLibraryCoverage['contractSources']
): CoverageProblem {
  return {
    code: 'component-library-contracts-unavailable',
    message: `No usable component contracts were extracted for ${library.package.canonicalName}.`,
    evidence: contractSources.length > 0
      ? contractSources
      : [{
          kind: 'component-library-package',
          file: library.package.packageJsonPath,
          message: `Installed package ${library.package.canonicalName} was attributed from source usage.`
        }]
  }
}

function createAmbiguousOwnershipProblem(
  usage: VueComponentUsage,
  candidates: ContractCandidate[]
): CoverageProblem {
  const packageNames = candidates.map((candidate) => candidate.library.package.canonicalName).sort()
  return {
    code: 'component-usage-ownership-ambiguous',
    message: `${usage.componentName} matches multiple component libraries: ${packageNames.join(', ')}.`,
    evidence: [{
      kind: 'source-component-usage',
      file: usage.file,
      line: usage.loc.line,
      message: `Ownership of ${usage.componentName} could not be resolved.`
    }]
  }
}

function worstStatus(statuses: CoverageStatus[]): CoverageStatus {
  return statuses.reduce((worst, status) => (
    statusRank[status] > statusRank[worst] ? status : worst
  ), 'complete')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
