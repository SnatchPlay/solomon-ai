import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoist shared mock references so they are available inside vi.mock factories ──
const { mockUpdate, mockFrom } = vi.hoisted(() => {
  const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) })
  const mockFrom = vi.fn()
  return { mockUpdate, mockFrom }
})

// ── Mock supabase clients ──────────────────────────────────────────────────────
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({ from: mockFrom }),
  createAdminClient: vi.fn().mockResolvedValue({ from: mockFrom }),
}))

// ── Mock github API calls ──────────────────────────────────────────────────────
vi.mock('@/lib/github', () => ({
  GitHubError: class GitHubError extends Error {
    constructor(public status: number, message: string) { super(message) }
  },
  deleteRepoFile: vi.fn(),
  getRepoFileSha: vi.fn(),
  listRepoDir: vi.fn(),
  pushFile: vi.fn(),
  createMilestone: vi.fn(),
  updateMilestone: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  formatStoryBody: vi.fn((a: string, b: string, c: string) => `${a} ${b} ${c}`),
}))

import { repoNameFromUrl, syncPrdToGitHub } from '@/lib/github-sync'
import { pushFile, GitHubError } from '@/lib/github'

function singleQuery(data: unknown) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data }),
      }),
    }),
  }
}

function latestQuery(data: unknown) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data }),
          }),
        }),
      }),
    }),
  }
}

// ── Pure function tests ────────────────────────────────────────────────────────
describe('repoNameFromUrl', () => {
  it('extracts full_name from github URL', () => {
    expect(repoNameFromUrl('https://github.com/octocat/my-repo')).toBe('octocat/my-repo')
  })
  it('handles trailing slash', () => {
    expect(repoNameFromUrl('https://github.com/octocat/my-repo/')).toBe('octocat/my-repo')
  })
})

// ── syncPrdToGitHub ────────────────────────────────────────────────────────────
describe('syncPrdToGitHub', () => {
  const originalToken = process.env.GITHUB_ACCESS_TOKEN

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GITHUB_ACCESS_TOKEN = 'tok'
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_ACCESS_TOKEN
    else process.env.GITHUB_ACCESS_TOKEN = originalToken
  })

  it('returns empty object (silent skip) when project has no github_repo_url', async () => {
    mockFrom.mockReturnValue(singleQuery({ user_id: 'u1', github_repo_url: null }))
    const result = await syncPrdToGitHub('proj-1')
    expect(result).toEqual({})
    expect(pushFile).not.toHaveBeenCalled()
  })

  it('returns { githubSyncError: null } on successful sync', async () => {
    // getOwnerToken: project has repo_url, env has token
    let callCount = 0
    mockFrom.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // projects query (user-scoped)
        return singleQuery({ user_id: 'u1', github_repo_url: 'https://github.com/user/repo' })
      }
      if (callCount === 2) {
        // prd query
        return latestQuery({ id: 'prd-1', content: '# PRD', github_file_sha: null })
      }
      // prd update + projects update
      return { update: mockUpdate }
    })
    vi.mocked(pushFile).mockResolvedValue({ sha: 'abc123' })

    const result = await syncPrdToGitHub('proj-1')
    expect(result).toEqual({ githubSyncError: null })
  })

  it('returns { githubSyncError: "..." } and saves error on GitHub failure', async () => {
    let callCount = 0
    mockFrom.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return singleQuery({ user_id: 'u1', github_repo_url: 'https://github.com/user/repo' })
      }
      if (callCount === 2) {
        return latestQuery({ id: 'prd-1', content: '# PRD', github_file_sha: null })
      }
      return { update: mockUpdate }
    })
    vi.mocked(pushFile).mockRejectedValue(new (GitHubError as unknown as new (s: number, m: string) => Error)(500, 'server error'))

    const result = await syncPrdToGitHub('proj-1')
    expect(typeof result.githubSyncError).toBe('string')
    expect(result.githubSyncError).toBe('server error')
  })
})
