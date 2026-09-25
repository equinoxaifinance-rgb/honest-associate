import { defineCliConfig } from 'sanity/cli'

export default defineCliConfig({
  api: {
    projectId: '0b9qmvox',
    dataset: 'production',
  },
  // preset hostname — `sanity deploy` prompts interactively without it (Windows scaffolder-hang class)
  studioHost: 'honest-associate',
})
