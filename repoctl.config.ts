import { defineMonorepoConfig } from 'repoctl'

export default defineMonorepoConfig({
  commands: {
    init: { preset: 'minimal' },
    create: { defaultTemplate: 'tsdown' },
    upgrade: { skipOverwrite: true },
    release: {
      branches: { stable: 'main', prerelease: [] },
      qualityScripts: ['check'],
      hooks: { verify: ['release:guard'] }
    }
  }
})
