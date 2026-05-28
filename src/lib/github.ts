const BASE = 'https://api.github.com'

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'GitHubError'
  }
}

export function slugifyRepoName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function formatStoryBody(asA: string, iWant: string, soThat: string): string {
  return `**As a** ${asA}\n**I want** ${iWant}\n**So that** ${soThat}`
}

async function ghFetch(token: string, path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new GitHubError(res.status, (body as { message?: string }).message ?? `GitHub API error ${res.status}`)
  }
  return res
}

export async function getGitHubUser(token: string): Promise<{ login: string }> {
  const res = await ghFetch(token, '/user')
  return res.json()
}

export async function createRepo(
  token: string,
  org: string,
  name: string,
  isPrivate: boolean
): Promise<{ full_name: string; html_url: string }> {
  const res = await ghFetch(token, `/orgs/${org}/repos`, {
    method: 'POST',
    body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
  })
  return res.json()
}

type GitHubContentsItem = {
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  name: string
  path: string
  sha?: string
}

type GitHubContentsFile = {
  type: 'file'
  name: string
  path: string
  sha: string
  content?: string
  encoding?: string
}

function encodeGitHubPath(path: string): string {
  return path
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/')
}

export async function listRepoDir(token: string, repo: string, path: string): Promise<GitHubContentsItem[]> {
  const res = await ghFetch(token, `/repos/${repo}/contents/${encodeGitHubPath(path)}`)
  const data = await res.json()
  if (!Array.isArray(data)) {
    throw new GitHubError(500, 'GitHub contents API: expected directory listing')
  }
  return data as GitHubContentsItem[]
}

export async function getRepoFile(token: string, repo: string, path: string): Promise<GitHubContentsFile> {
  const res = await ghFetch(token, `/repos/${repo}/contents/${encodeGitHubPath(path)}`)
  return res.json() as Promise<GitHubContentsFile>
}

export async function getRepoFileSha(token: string, repo: string, path: string): Promise<string | undefined> {
  try {
    const file = await getRepoFile(token, repo, path)
    return file.sha
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return undefined
    throw err
  }
}

export async function pushFileBase64(
  token: string,
  repo: string,
  path: string,
  base64Content: string,
  sha?: string,
  message = 'chore: sync template files'
): Promise<{ sha: string }> {
  const body: Record<string, unknown> = {
    message,
    content: base64Content.replace(/\n/g, ''),
  }
  if (sha) body.sha = sha
  const res = await ghFetch(token, `/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  const data = await res.json() as { content: { sha: string } }
  return { sha: data.content.sha }
}

export async function copyRepoDir(
  token: string,
  sourceRepo: string,
  sourceDir: string,
  destRepo: string,
  destDir: string = sourceDir
): Promise<void> {
  const items = await listRepoDir(token, sourceRepo, sourceDir)
  for (const item of items) {
    if (item.type === 'dir') {
      const relative = item.path.startsWith(sourceDir) ? item.path.slice(sourceDir.length) : ''
      const nextDestDir = `${destDir}${relative}`.replace(/\/+/g, '/')
      await copyRepoDir(token, sourceRepo, item.path, destRepo, nextDestDir)
      continue
    }
    if (item.type !== 'file') continue

    const relative = item.path.startsWith(sourceDir) ? item.path.slice(sourceDir.length) : ''
    const destPath = `${destDir}${relative}`.replace(/\/+/g, '/').replace(/^\//, '')

    const file = await getRepoFile(token, sourceRepo, item.path)
    const content = (file.content ?? '').trim()
    if (!content) continue
    if (file.encoding && file.encoding !== 'base64') {
      throw new GitHubError(500, `Unsupported GitHub content encoding: ${file.encoding}`)
    }

    const existingSha = await getRepoFileSha(token, destRepo, destPath)
    await pushFileBase64(token, destRepo, destPath, content, existingSha, `chore: sync ${destPath} from template`)
  }
}

// NOTE: pushFile uses Buffer.from() which requires the Node.js runtime.
// All routes that call this function must NOT use `export const runtime = 'edge'`.
export async function pushFile(
  token: string,
  repo: string,
  path: string,
  content: string,
  sha?: string,
  message = 'chore: update requirements'
): Promise<{ sha: string }> {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString('base64'),
  }
  if (sha) body.sha = sha
  const res = await ghFetch(token, `/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  const data = await res.json() as { content: { sha: string } }
  return { sha: data.content.sha }
}

export async function deleteRepoFile(
  token: string,
  repo: string,
  path: string,
  sha: string,
  message = 'chore: remove stale requirements file'
): Promise<void> {
  await ghFetch(token, `/repos/${repo}/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha }),
  })
}

export async function createMilestone(
  token: string,
  repo: string,
  title: string,
  description = ''
): Promise<{ number: number }> {
  const res = await ghFetch(token, `/repos/${repo}/milestones`, {
    method: 'POST',
    body: JSON.stringify({ title, description }),
  })
  return res.json()
}

export async function updateMilestone(
  token: string,
  repo: string,
  number: number,
  title: string,
  description = ''
): Promise<void> {
  await ghFetch(token, `/repos/${repo}/milestones/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ title, description }),
  })
}

export async function createIssue(
  token: string,
  repo: string,
  title: string,
  body: string,
  milestone?: number
): Promise<{ number: number }> {
  const res = await ghFetch(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, ...(milestone ? { milestone } : {}) }),
  })
  return res.json()
}

export async function updateIssue(
  token: string,
  repo: string,
  number: number,
  title: string,
  body: string
): Promise<void> {
  await ghFetch(token, `/repos/${repo}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ title, body }),
  })
}
