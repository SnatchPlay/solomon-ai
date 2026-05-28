import { createClient, createAdminClient } from '@/lib/supabase/server'
import {
  deleteRepoFile,
  GitHubError,
  getRepoFileSha,
  listRepoDir,
  pushFile,
} from '@/lib/github'

export type GitHubSyncResult = { githubSyncError?: string | null }

type EpicRow = {
  id: string
  code: string
  title: string
  description: string | null
  acceptance_criteria: string | null
  priority: string
  order: number
  status: string
}

type StoryRow = {
  id: string
  epic_id: string | null
  code: string
  title: string
  as_a: string
  i_want: string
  so_that: string
  acceptance_criteria: string[] | null
  priority: string
  effort_estimate: string | null
  order: number
  status: string
}

export function repoNameFromUrl(url: string): string {
  return url.replace('https://github.com/', '').replace(/\/$/, '')
}

async function getOwnerToken(
  projectId: string
): Promise<{ token: string; repoFullName: string } | null> {
  const token = process.env.GITHUB_ACCESS_TOKEN
  if (!token) return null

  const supabase = await createClient()
  const { data: project } = await supabase
    .from('projects')
    .select('github_repo_url')
    .eq('id', projectId)
    .single()
  if (!project?.github_repo_url) return null

  return {
    token,
    repoFullName: repoNameFromUrl(project.github_repo_url),
  }
}

// Use adminClient so these writes succeed regardless of who triggered the save
// (a collaborator's session may not have RLS permission to write project columns).
async function saveError(projectId: string, message: string): Promise<void> {
  const adminClient = await createAdminClient()
  await adminClient.from('projects').update({ github_sync_error: message }).eq('id', projectId)
}

async function clearError(projectId: string): Promise<void> {
  const adminClient = await createAdminClient()
  await adminClient
    .from('projects')
    .update({ github_sync_error: null, github_exported_at: new Date().toISOString() })
    .eq('id', projectId)
}

function buildEpicMarkdown(projectName: string, epic: EpicRow): string {
  const lines = [`# ${epic.code}: ${epic.title}`, '']
  lines.push(`Project: ${projectName}`)
  lines.push(`Status: ${epic.status}`)
  lines.push(`Priority: ${epic.priority}`)
  lines.push('')
  if (epic.description) lines.push(epic.description, '')
  if (epic.acceptance_criteria) {
    lines.push('## Acceptance Criteria', '', epic.acceptance_criteria, '')
  }

  return lines.join('\n').trimEnd() + '\n'
}

function buildStoryMarkdown(projectName: string, story: StoryRow, epics: EpicRow[]): string {
  const epicById = new Map(epics.map(epic => [epic.id, epic]))
  const epic = story.epic_id ? epicById.get(story.epic_id) : undefined
  const lines = [`# ${story.code}: ${story.title}`, '']
  lines.push(`Project: ${projectName}`)
  lines.push(`Epic: ${epic ? `${epic.code}: ${epic.title}` : 'Unassigned'}`)
  lines.push(`Status: ${story.status}`)
  lines.push(`Priority: ${story.priority}`)
  if (story.effort_estimate) lines.push(`Effort: ${story.effort_estimate}`)
  lines.push('')
  lines.push(`**As a** ${story.as_a}`)
  lines.push(`**I want** ${story.i_want}`)
  lines.push(`**So that** ${story.so_that}`)
  lines.push('')
  if (story.acceptance_criteria?.length) {
    lines.push('## Acceptance Criteria', '')
    for (const criterion of story.acceptance_criteria) lines.push(`- ${criterion}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}

function markdownPath(dir: 'epics' | 'stories', code: string): string {
  return `docs/${dir}/${code.replace(/[^A-Za-z0-9._-]/g, '-')}.md`
}

async function pushMarkdownFile(
  token: string,
  repoFullName: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  const existingSha = await getRepoFileSha(token, repoFullName, path)
  await pushFile(token, repoFullName, path, content, existingSha, message)
}

async function deleteIfExists(
  token: string,
  repoFullName: string,
  path: string,
  message: string
): Promise<void> {
  const sha = await getRepoFileSha(token, repoFullName, path)
  if (sha) await deleteRepoFile(token, repoFullName, path, sha, message)
}

async function listRepoDirOrEmpty(token: string, repoFullName: string, path: string) {
  try {
    return await listRepoDir(token, repoFullName, path)
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return []
    throw err
  }
}

async function deleteStaleMarkdownFiles(
  token: string,
  repoFullName: string,
  dir: 'epics' | 'stories',
  desiredPaths: Set<string>
): Promise<void> {
  const existingFiles = await listRepoDirOrEmpty(token, repoFullName, `docs/${dir}`)
  await Promise.all(existingFiles
    .filter(item => item.type === 'file' && item.name.endsWith('.md') && !desiredPaths.has(item.path))
    .map(async item => {
      const sha = item.sha ?? await getRepoFileSha(token, repoFullName, item.path)
      if (sha) {
        await deleteRepoFile(token, repoFullName, item.path, sha, `docs: remove stale ${item.name}`)
      }
    }))
}

export async function syncBacklogDocsToGitHub(
  projectId: string,
  token: string,
  repoFullName: string
): Promise<void> {
  const supabase = await createAdminClient()

  const [{ data: project }, { data: epics }, { data: stories }] = await Promise.all([
    supabase.from('projects').select('name').eq('id', projectId).single(),
    supabase
      .from('epics')
      .select('id, code, title, description, acceptance_criteria, priority, order, status')
      .eq('project_id', projectId)
      .order('order', { ascending: true }),
    supabase
      .from('user_stories')
      .select('id, epic_id, code, title, as_a, i_want, so_that, acceptance_criteria, priority, effort_estimate, order, status')
      .eq('project_id', projectId)
      .order('order', { ascending: true }),
  ])

  const projectName = project?.name ?? 'Project'
  const epicRows = (epics ?? []) as EpicRow[]
  const storyRows = (stories ?? []) as StoryRow[]
  const desiredEpicPaths = new Set(epicRows.map(epic => markdownPath('epics', epic.code)))
  const desiredStoryPaths = new Set(storyRows.map(story => markdownPath('stories', story.code)))

  await Promise.all([
    deleteIfExists(token, repoFullName, 'docs/Epics.md', 'docs: remove aggregate epics file'),
    deleteIfExists(token, repoFullName, 'docs/User-Stories.md', 'docs: remove aggregate user stories file'),
    deleteStaleMarkdownFiles(token, repoFullName, 'epics', desiredEpicPaths),
    deleteStaleMarkdownFiles(token, repoFullName, 'stories', desiredStoryPaths),
  ])

  for (const epic of epicRows) {
    await pushMarkdownFile(
      token,
      repoFullName,
      markdownPath('epics', epic.code),
      buildEpicMarkdown(projectName, epic),
      `docs: sync epic ${epic.code}`
    )
  }

  for (const story of storyRows) {
    await pushMarkdownFile(
      token,
      repoFullName,
      markdownPath('stories', story.code),
      buildStoryMarkdown(projectName, story, epicRows),
      `docs: sync story ${story.code}`
    )
  }
}

export async function syncCharterToGitHub(projectId: string): Promise<GitHubSyncResult> {
  const ctx = await getOwnerToken(projectId)
  if (!ctx) return {} // silent skip

  const supabase = await createClient()
  try {
    const { data: charter } = await supabase
      .from('project_charter')
      .select('id, content, github_file_sha')
      .eq('project_id', projectId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!charter?.content) return {}

    const { sha } = await pushFile(
      ctx.token,
      ctx.repoFullName,
      'docs/Charter.md',
      charter.content,
      charter.github_file_sha ?? undefined
    )
    await supabase.from('project_charter').update({ github_file_sha: sha }).eq('id', charter.id)
    await clearError(projectId)
    return { githubSyncError: null }
  } catch (err) {
    const message = err instanceof GitHubError ? err.message : 'GitHub sync failed'
    await saveError(projectId, message)
    return { githubSyncError: message }
  }
}

export async function syncPrdToGitHub(projectId: string): Promise<GitHubSyncResult> {
  const ctx = await getOwnerToken(projectId)
  if (!ctx) return {} // silent skip

  const supabase = await createClient()
  try {
    const { data: prd } = await supabase
      .from('prd')
      .select('id, content, github_file_sha')
      .eq('project_id', projectId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!prd?.content) return {}

    const { sha } = await pushFile(
      ctx.token,
      ctx.repoFullName,
      'docs/PRD.md',
      prd.content,
      prd.github_file_sha ?? undefined
    )
    await supabase.from('prd').update({ github_file_sha: sha }).eq('id', prd.id)
    await clearError(projectId)
    return { githubSyncError: null }
  } catch (err) {
    const message = err instanceof GitHubError ? err.message : 'GitHub sync failed'
    await saveError(projectId, message)
    return { githubSyncError: message }
  }
}

export async function syncEpicToGitHub(epicId: string, projectId: string): Promise<GitHubSyncResult> {
  void epicId
  const ctx = await getOwnerToken(projectId)
  if (!ctx) return {} // silent skip

  try {
    await syncBacklogDocsToGitHub(projectId, ctx.token, ctx.repoFullName)
    await clearError(projectId)
    return { githubSyncError: null }
  } catch (err) {
    const message = err instanceof GitHubError ? err.message : 'GitHub sync failed'
    await saveError(projectId, message)
    return { githubSyncError: message }
  }
}

export async function syncStoryToGitHub(storyId: string, projectId: string): Promise<GitHubSyncResult> {
  void storyId
  const ctx = await getOwnerToken(projectId)
  if (!ctx) return {} // silent skip

  try {
    await syncBacklogDocsToGitHub(projectId, ctx.token, ctx.repoFullName)
    await clearError(projectId)
    return { githubSyncError: null }
  } catch (err) {
    const message = err instanceof GitHubError ? err.message : 'GitHub sync failed'
    await saveError(projectId, message)
    return { githubSyncError: message }
  }
}
