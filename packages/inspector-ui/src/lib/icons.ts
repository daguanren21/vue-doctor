import { addIcon } from '@iconify/vue'
import chevronRight from '@iconify-icons/lucide/chevron-right'
import chevronDown from '@iconify-icons/lucide/chevron-down'
import search from '@iconify-icons/lucide/search'
import refresh from '@iconify-icons/lucide/refresh-cw'
import filter from '@iconify-icons/lucide/list-filter'
import close from '@iconify-icons/lucide/x'
import alert from '@iconify-icons/lucide/triangle-alert'
import octagonAlert from '@iconify-icons/lucide/octagon-alert'
import info from '@iconify-icons/lucide/info'
import packageIcon from '@iconify-icons/lucide/package'
import file from '@iconify-icons/lucide/file-code-2'
import gitCommit from '@iconify-icons/lucide/git-commit-horizontal'
import folder from '@iconify-icons/lucide/folder'
import rule from '@iconify-icons/lucide/scan-search'
import check from '@iconify-icons/lucide/check-circle-2'
import copy from '@iconify-icons/lucide/copy'
import externalLink from '@iconify-icons/lucide/external-link'
import sun from '@iconify-icons/lucide/sun'
import moon from '@iconify-icons/lucide/moon'
import panelLeft from '@iconify-icons/lucide/panel-left'
import book from '@iconify-icons/lucide/book-open'
import pieChart from '@iconify-icons/lucide/pie-chart'
import languages from '@iconify-icons/lucide/languages'
import shieldCheck from '@iconify-icons/lucide/shield-check'
import scrollText from '@iconify-icons/lucide/scroll-text'
import download from '@iconify-icons/lucide/download'
import braces from '@iconify-icons/lucide/braces'
import listChecks from '@iconify-icons/lucide/list-checks'
import clock from '@iconify-icons/lucide/clock-3'
import wifiOff from '@iconify-icons/lucide/wifi-off'
import circleDashed from '@iconify-icons/lucide/circle-dashed'
import fileWarning from '@iconify-icons/lucide/file-warning'

export const inspectorIcons = {
  chevronRight: 'lucide:chevron-right',
  chevronDown: 'lucide:chevron-down',
  search: 'lucide:search',
  refresh: 'lucide:refresh-cw',
  filter: 'lucide:list-filter',
  close: 'lucide:x',
  alert: 'lucide:triangle-alert',
  octagonAlert: 'lucide:octagon-alert',
  info: 'lucide:info',
  package: 'lucide:package',
  file: 'lucide:file-code-2',
  gitCommit: 'lucide:git-commit-horizontal',
  folder: 'lucide:folder',
  rule: 'lucide:scan-search',
  check: 'lucide:check-circle-2',
  copy: 'lucide:copy',
  externalLink: 'lucide:external-link',
  sun: 'lucide:sun',
  moon: 'lucide:moon',
  panelLeft: 'lucide:panel-left',
  book: 'lucide:book-open',
  pieChart: 'lucide:pie-chart',
  languages: 'lucide:languages'
  ,shieldCheck: 'lucide:shield-check'
  ,scrollText: 'lucide:scroll-text'
  ,download: 'lucide:download'
  ,braces: 'lucide:braces'
  ,listChecks: 'lucide:list-checks'
  ,clock: 'lucide:clock-3'
  ,wifiOff: 'lucide:wifi-off'
  ,circleDashed: 'lucide:circle-dashed'
  ,fileWarning: 'lucide:file-warning'
} as const

// Local diagnostics must not depend on an external icon service, including on first load.
addIcon(inspectorIcons.chevronRight, chevronRight)
addIcon(inspectorIcons.chevronDown, chevronDown)
addIcon(inspectorIcons.search, search)
addIcon(inspectorIcons.refresh, refresh)
addIcon(inspectorIcons.filter, filter)
addIcon(inspectorIcons.close, close)
addIcon(inspectorIcons.alert, alert)
addIcon(inspectorIcons.octagonAlert, octagonAlert)
addIcon(inspectorIcons.info, info)
addIcon(inspectorIcons.package, packageIcon)
addIcon(inspectorIcons.file, file)
addIcon(inspectorIcons.gitCommit, gitCommit)
addIcon(inspectorIcons.folder, folder)
addIcon(inspectorIcons.rule, rule)
addIcon(inspectorIcons.check, check)
addIcon(inspectorIcons.copy, copy)
addIcon(inspectorIcons.externalLink, externalLink)
addIcon(inspectorIcons.sun, sun)
addIcon(inspectorIcons.moon, moon)
addIcon(inspectorIcons.panelLeft, panelLeft)
addIcon(inspectorIcons.book, book)
addIcon(inspectorIcons.pieChart, pieChart)
addIcon(inspectorIcons.languages, languages)
addIcon(inspectorIcons.shieldCheck, shieldCheck)
addIcon(inspectorIcons.scrollText, scrollText)
addIcon(inspectorIcons.download, download)
addIcon(inspectorIcons.braces, braces)
addIcon(inspectorIcons.listChecks, listChecks)
addIcon(inspectorIcons.clock, clock)
addIcon(inspectorIcons.wifiOff, wifiOff)
addIcon(inspectorIcons.circleDashed, circleDashed)
addIcon(inspectorIcons.fileWarning, fileWarning)

export const inspectorWorkspaceViews = [
  { id: 'findings', icon: inspectorIcons.book },
  { id: 'coverage', icon: inspectorIcons.pieChart },
  { id: 'rules', icon: inspectorIcons.listChecks },
  { id: 'audit', icon: inspectorIcons.scrollText }
] as const
