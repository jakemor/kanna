import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://kanna-wiki.lowbit.link',
  base: '/',
  integrations: [
    starlight({
      title: 'Kanna',
      description: 'A beautiful web UI for the Claude Code & Codex CLIs',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      customCss: ['./src/styles/kanna-theme.css'],
      // social format for Starlight 0.30.x: object map of icon -> URL
      social: {
        github: 'https://github.com/cuongtranba/kanna',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Install', slug: 'getting-started/install' },
            { label: 'First Chat', slug: 'getting-started/first-chat' },
            { label: 'OAuth Pool Setup', slug: 'getting-started/oauth-pool-setup' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'Providers & Models', slug: 'features/providers-models' },
            { label: 'Chat & Transcript', slug: 'features/chat-transcript' },
            { label: 'Projects & Sessions', slug: 'features/projects-sessions' },
            { label: 'Advanced', slug: 'features/advanced' },
            { label: 'Security & Sandboxing', slug: 'features/security-sandboxing' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'User Guide', autogenerate: { directory: 'guides/user' } },
            { label: 'Contributing', autogenerate: { directory: 'guides/contributing' } },
            { label: 'Ops & Self-Host', autogenerate: { directory: 'guides/ops' } },
          ],
        },
        {
          label: 'Sharing',
          items: [
            { label: 'Read-only session share', slug: 'sharing/session-share' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Env Vars', slug: 'reference/env-vars' },
            { label: 'Keybindings', slug: 'reference/keybindings' },
          ],
        },
        {
          label: 'Changelog',
          slug: 'changelog',
        },
      ],
    }),
  ],
})
