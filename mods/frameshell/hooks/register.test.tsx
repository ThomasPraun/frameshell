import { expect, test } from 'claude-code/testing'

const STATUS = {
  daemon: { daemonVersion: '0.9.0' },
  project: { name: 'launch', dir: '/videos/launch' },
  jobs: [
    { id: 'j_1', kind: 'render', asset: 'timelines/main.json', state: 'running', progress: 0.4 },
    { id: 'j_2', kind: 'ingest', asset: 'assets/a.mp4', state: 'done', progress: 1 },
  ],
  review: { enabled: true, proposal: { label: 'Tighten the intro', author: 'agent:claude:term-1', state: 'ready', operations: [{}, {}, {}] } },
}

const PANE = {
  plugin: 'frameshell',
  component: 'Pane',
  requestId: 'frameshell',
  props: { title: 'Frameshell', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the pane and the band show the jobs and the waiting proposal from frameshell status', async ($, on) => {
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '' } }
  })
  on('session.cwd', () => ({ value: '/videos/launch' }))
  on('command.register', () => ({ value: { command: 'frameshell' } }))
  on('clock.every', () => ({ value: { id: 'poll' } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/videos/launch', surface: 'desktop', isInteractive: true })
  expect(ran[0]).toEqual(['frameshell', 'status', '--json'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /waits for review/ }))?.text).toContain('Tighten the intro')
    expect(await ui.find({ type: 'Text', text: /\/frameshell frame/ })).toBeDefined()
    await ui.unmount()
  }
  const band = await $.ui.mount({ plugin: 'frameshell', component: 'AbovePrompt', surface: 'desktop', props: {} })
  expect((await band.find({ type: 'Text', text: /proposal waits/ }))?.text).toContain('3 operations')
  await band.unmount()
})

test('outside a project the pane says so and nothing keeps polling', async ($, on) => {
  let timers = 0
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ...STATUS, project: null, jobs: [], review: null }), stderr: '' } }))
  on('session.cwd', () => ({ value: '/tmp' }))
  on('command.register', () => ({ value: { command: 'frameshell' } }))
  on('clock.every', () => {
    timers++
    return { value: { id: 'poll' } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  expect(timers).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('This folder is in no Frameshell project.')
  await ui.unmount()
})
