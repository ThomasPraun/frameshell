// Frameshell beside the chat (#798): a pane with the project's jobs, the waiting review proposal and a frame of the
// timeline, a band above the prompt while a proposal waits, and a status line entry. Everything is read through the
// `frameshell` CLI (`status --json`, `frame`), which talks to the running daemon; the mod changes nothing in the
// project. A proposal is accepted or rejected in the app only: the daemon takes those from the app alone (ADR 0019).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Frame, Job, Proposal, Snapshot } from '../types'

const PANE = 'frameshell'
const POLL_MS = 5000
const snapshot = atom({ plugin: 'frameshell', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const frame = atom({ plugin: 'frameshell', key: 'frame' } as const, null, { shape: 'frame-1' })
/** Largest PNG handed to the surface as bytes; a bigger one is drawn from its file. */
const MAX_PNG_BYTES = 2 * 1024 * 1024

/** What `frameshell status --json` answers, the fields the mod reads. */
type Status = {
  daemon?: { daemonVersion?: string }
  project?: { name: string; dir: string } | null
  jobs?: { id: string; kind: string; asset: string; state: string; progress: number }[]
  review?: { enabled: boolean; proposal: { label: string | null; author: unknown; state: string; operations: unknown[] } | null } | null
}

/** The snapshot of a `status --json` answer. */
export function snapshotOf(status: Status): Snapshot {
  const proposal = status.review?.proposal ?? null
  return {
    project: status.project ? { name: status.project.name, dir: status.project.dir } : null,
    daemonVersion: status.daemon?.daemonVersion ?? null,
    jobs: (status.jobs ?? [])
      .filter(job => job.state === 'queued' || job.state === 'running')
      .map((job): Job => ({ id: job.id, kind: job.kind, asset: job.asset, state: job.state, progress: job.progress })),
    review: status.review?.enabled === true,
    proposal: proposal
      ? ({ label: proposal.label, author: authorText(proposal.author), state: proposal.state, operations: proposal.operations.length } satisfies Proposal)
      : null,
    error: null,
  }
}

/** The status line text of a snapshot; undefined clears it (no project). */
export function statusText(shot: Snapshot | null): string | undefined {
  if (!shot?.project) return undefined
  const jobs = shot.jobs.length === 0 ? '' : ` · ${shot.jobs.length} job${shot.jobs.length === 1 ? '' : 's'}`
  const waiting = shot.proposal?.state === 'ready' ? ' · proposal waits' : ''
  return `Frameshell ${shot.project.name}${jobs}${waiting}`
}

function authorText(author: unknown): string {
  if (typeof author === 'string') return author
  if (author && typeof author === 'object' && 'label' in author) return String((author as { label: unknown }).label)
  return 'an agent'
}

export const register: Register = (on, options) => {
  const command = typeof options.command === 'string' && options.command !== '' ? options.command : 'frameshell'
  let polling = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'frameshell',
      description: 'Show Frameshell beside the chat; `frame <seconds>` shows the frame at that time',
      argumentHint: '[frame <seconds>]',
    })
    // Only a session inside a Frameshell project keeps polling, so the daemon is not kept awake elsewhere.
    const first = await poll($, command)
    if (first.project && !polling) {
      polling = true
      $.clock.every(POLL_MS, async () => {
        await poll($, command)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'frameshell' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    if (words[0] === 'frame') {
      const at = Number(words[1])
      if (!Number.isFinite(at) || at < 0) return { text: 'Usage: /frameshell frame <seconds>, e.g. /frameshell frame 12.5' }
      const shot = (await read($, snapshot)) ?? (await poll($, command))
      if (!shot?.project) return { text: 'This folder is in no Frameshell project.' }
      const file = `${shot.project.dir}/.frameshell/claude-code/frame.png`
      const ran = await $.process.run([command, 'frame', '--at', String(at), '--out', file, '--preset', 'gif'], {
        cwd: shot.project.dir,
        timeoutMs: 120000,
      })
      if (ran.exitCode !== 0) return { text: `frameshell frame failed: ${firstLine(ran.stderr)}` }
      const { size } = await $.fs.stat(file)
      const png = size <= MAX_PNG_BYTES ? (await $.fs.read(file, { as: 'bytes' })).base64 : null
      const before = await read($, frame)
      await update($, frame, (): Frame => ({ at, file, png, generation: (before?.generation ?? 0) + 1 }))
      await $.ui.open({ id: PANE, title: 'Frameshell' })
      return { text: `Frame at ${at} s shown in the Frameshell pane.` }
    }
    await poll($, command)
    await $.ui.open({ id: PANE, title: 'Frameshell' })
    return { text: 'Frameshell pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress } = $.ui.resolve(e)
    const shot = await read($, snapshot)
    const picture = await read($, frame)
    if (!shot || shot.error) return <Text dimColor>{shot?.error ?? 'Reading Frameshell…'}</Text>
    if (!shot.project) return <Text dimColor>This folder is in no Frameshell project.</Text>
    const columns = Math.max(16, Math.min(80, (e.viewport?.columns ?? 60) - 2))
    return (
      <Box flexDirection="column">
        <Text bold>
          {shot.project.name}
          {shot.daemonVersion ? <Text dimColor> · daemon {shot.daemonVersion}</Text> : null}
        </Text>
        {shot.proposal ? (
          <Text>
            Proposal {shot.proposal.state === 'ready' ? 'waits for review' : 'is being built'}: {shot.proposal.label ?? 'changes'} by {shot.proposal.author} (
            {shot.proposal.operations} operations). Accept or reject it in the app.
          </Text>
        ) : (
          <Text dimColor>{shot.review ? 'Review mode on, no proposal waiting.' : 'Review mode off.'}</Text>
        )}
        {shot.jobs.length === 0 ? <Text dimColor>No jobs running.</Text> : null}
        {shot.jobs.map(job => (
          <Progress key={job.id} label={`${job.kind} ${job.asset}`} value={job.state === 'running' ? job.progress : undefined} />
        ))}
        {picture ? (
          <Box flexDirection="column">
            <Text dimColor>Frame at {picture.at} s</Text>
            {pictureOf($, e, picture, columns)}
          </Box>
        ) : (
          <Text dimColor>/frameshell frame {'<seconds>'} shows a frame here.</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shot = await read($, snapshot)
    if (e.props.hasSurvey || shot?.proposal?.state !== 'ready') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>
          Frameshell: a proposal waits for review ({shot.proposal.label ?? 'changes'}, {shot.proposal.operations} operations). Accept or reject it in
          the app.
        </Text>
      </Box>
    )
  })
}

/** Read `frameshell status --json` into the snapshot atom and the status line. */
async function poll($: EngineInterface, command: string): Promise<Snapshot> {
  const cwd = await $.session.cwd()
  let shot: Snapshot
  try {
    const ran = await $.process.run([command, 'status', '--json'], { cwd, timeoutMs: 15000 })
    shot = ran.exitCode === 0 ? snapshotOf(JSON.parse(ran.stdout) as Status) : { ...empty(), error: firstLine(ran.stderr) }
  } catch (error) {
    shot = { ...empty(), error: `${command} could not run: ${error instanceof Error ? error.message : String(error)}` }
  }
  await update($, snapshot, () => shot)
  $.ui.status(statusText(shot))
  return shot
}

/** The frame as a picture where the surface draws one (the terminal), else where its file is. */
function pictureOf($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], picture: Frame, columns: number) {
  if (e.surface !== 'terminal') {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{picture.file}</Text>
  }
  const { Image } = $.ui.resolve(e)
  return (
    <Image
      key="frame"
      source={picture.png ? { png: picture.png } : { file: picture.file, format: 'png', generation: picture.generation }}
      columns={columns}
      rows={Math.max(4, Math.round(columns * 0.28))}
      alt={`Frame at ${picture.at} s`}
    />
  )
}

function empty(): Snapshot {
  return { project: null, daemonVersion: null, jobs: [], review: false, proposal: null, error: null }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
