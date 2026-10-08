import { describe, expect, test } from 'vitest'
import { collectDirectImportOrigins, collectPackageImports } from './origins.js'

describe('structured package import references', () => {
  test('splits unscoped and scoped package subpaths', () => {
    const program = {
      body: [
        { type: 'ImportDeclaration', source: { value: 'fixture-ui/components/dialog' }, specifiers: [{ type: 'ImportDefaultSpecifier', local: { name: 'Dialog' } }] },
        { type: 'ImportDeclaration', source: { value: '@fixture/ui/forms/dialog' }, specifiers: [{ type: 'ImportSpecifier', imported: { name: 'Dialog' }, local: { name: 'FormDialog' } }] }
      ]
    }

    expect([...collectPackageImports(program).values()]).toEqual([
      { package: { specifier: 'fixture-ui/components/dialog', packageName: 'fixture-ui', subpath: './components/dialog' }, importedName: 'default' },
      { package: { specifier: '@fixture/ui/forms/dialog', packageName: '@fixture/ui', subpath: './forms/dialog' }, importedName: 'Dialog' }
    ])
  })

  test('rejects relative, absolute, URL, and virtual specifiers', () => {
    const sources = ['./local', '/absolute', 'https://fixture.invalid/module', 'virtual:fixture', '#internal']
    const program = {
      body: sources.map((value, index) => ({
        type: 'ImportDeclaration',
        source: { value },
        specifiers: [{ type: 'ImportDefaultSpecifier', local: { name: `Local${index}` } }]
      }))
    }

    expect(collectPackageImports(program)).toEqual(new Map())
  })

  test('marks relative component imports as local origins', () => {
    const program = {
      body: [
        {
          type: 'ImportDeclaration',
          source: { value: './time' },
          specifiers: [{ type: 'ImportDefaultSpecifier', local: { name: 'TimePicker' } }]
        },
        {
          type: 'ImportDeclaration',
          source: { value: 'fixture-ui/time-picker' },
          specifiers: [{ type: 'ImportDefaultSpecifier', local: { name: 'LibraryTimePicker' } }]
        }
      ]
    }

    expect(collectDirectImportOrigins(program)).toEqual(new Map([
      ['TimePicker', { kind: 'local-import', importSource: './time', importedName: 'default' }],
      ['LibraryTimePicker', {
        kind: 'direct-import',
        importSource: 'fixture-ui/time-picker',
        package: {
          specifier: 'fixture-ui/time-picker',
          packageName: 'fixture-ui',
          subpath: './time-picker'
        },
        importedName: 'default'
      }]
    ]))
  })

  test('marks dynamic import and require component registrations as local origins', () => {
    const program = {
      body: [
        {
          type: 'VariableDeclaration',
          declarations: [{
            type: 'VariableDeclarator',
            id: { type: 'Identifier', name: 'LazyTimePicker' },
            init: {
              type: 'ArrowFunctionExpression',
              body: {
                type: 'ImportExpression',
                source: { type: 'Literal', value: './time' }
              }
            }
          }]
        },
        {
          type: 'ExportDefaultDeclaration',
          declaration: {
            type: 'ObjectExpression',
            properties: [{
              type: 'Property',
              key: { type: 'Identifier', name: 'components' },
              value: {
                type: 'ObjectExpression',
                properties: [
                  {
                    type: 'Property',
                    key: { type: 'Identifier', name: 'TimePicker' },
                    value: { type: 'Identifier', name: 'LazyTimePicker' }
                  },
                  {
                    type: 'Property',
                    key: { type: 'Identifier', name: 'DateTable' },
                    value: {
                      type: 'CallExpression',
                      callee: { type: 'Identifier', name: 'require' },
                      arguments: [{ type: 'Literal', value: '../date-table' }]
                    }
                  }
                ]
              }
            }]
          }
        }
      ]
    }

    expect(collectDirectImportOrigins(program)).toEqual(new Map([
      ['LazyTimePicker', { kind: 'local-import' }],
      ['TimePicker', { kind: 'local-import' }],
      ['DateTable', { kind: 'local-import' }]
    ]))
  })

  test('propagates package origins through Options API aliases', () => {
    const program = {
      body: [
        {
          type: 'ImportDeclaration',
          source: { value: 'fixture-ui' },
          specifiers: [{
            type: 'ImportDefaultSpecifier',
            local: { name: 'LibraryPicker' }
          }]
        },
        {
          type: 'ExportDefaultDeclaration',
          declaration: {
            type: 'ObjectExpression',
            properties: [{
              type: 'Property',
              key: { type: 'Identifier', name: 'components' },
              value: {
                type: 'ObjectExpression',
                properties: [{
                  type: 'Property',
                  key: { type: 'Identifier', name: 'TimePicker' },
                  value: { type: 'Identifier', name: 'LibraryPicker' }
                }]
              }
            }]
          }
        }
      ]
    }

    expect(collectDirectImportOrigins(program).get('TimePicker')).toEqual({
      kind: 'direct-import',
      importSource: 'fixture-ui',
      package: { specifier: 'fixture-ui', packageName: 'fixture-ui' },
      importedName: 'default'
    })
  })
})
