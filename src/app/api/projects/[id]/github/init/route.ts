// src/app/api/projects/[id]/github/init/route.ts
import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import {
  GitHubError,
  slugifyRepoName,
  createRepo,
  copyRepoDir,
  pushFile,
} from '@/lib/github'
import { repoNameFromUrl, syncBacklogDocsToGitHub } from '@/lib/github-sync'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const adminClient = await createAdminClient()

  // Owner or editor can export to GitHub
  const { data: project } = await adminClient
    .from('projects')
    .select('id, name, user_id, github_repo_url')
    .eq('id', id)
    .single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const isOwner = project.user_id === user.id
  if (!isOwner) {
    const { data: membership } = await adminClient
      .from('project_members')
      .select('role')
      .eq('project_id', id)
      .eq('user_id', user.id)
      .single()
    if (membership?.role !== 'editor') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const token = process.env.GITHUB_ACCESS_TOKEN
  if (!token) {
    return NextResponse.json(
      { error: 'GitHub integration not configured. Contact your administrator.' },
      { status: 503 }
    )
  }

  const org = process.env.GITHUB_ORG
  if (!org) {
    return NextResponse.json(
      { error: 'GitHub organization not configured. Contact your administrator.' },
      { status: 503 }
    )
  }

  const templateRepo = process.env.GITHUB_TEMPLATE_REPO
  if (!templateRepo) {
    return NextResponse.json(
      { error: 'GitHub template repository not configured. Contact your administrator.' },
      { status: 503 }
    )
  }

  const body = await request.json() as { repoName?: string; isPrivate?: boolean }
  const repoName = body.repoName?.trim() || slugifyRepoName(project.name)
  const isPrivate = body.isPrivate ?? false

  const logPrefix = `[github/init project=${id}]`
  console.log(`${logPrefix} start repoName=${repoName} isPrivate=${isPrivate} reusingRepo=${!!project.github_repo_url}`)

  try {
    let repoFullName: string
    let repoUrl: string

    if (project.github_repo_url) {
      // Partial export — reuse existing repo
      repoUrl = project.github_repo_url
      repoFullName = repoNameFromUrl(repoUrl)
      console.log(`${logPrefix} reusing existing repo ${repoFullName}`)
    } else {
      // Create new repo
      const repo = await createRepo(token, org, repoName, isPrivate)
      repoFullName = repo.full_name
      repoUrl = repo.html_url
      console.log(`${logPrefix} created repo ${repoFullName}`)
      // Save immediately so partial retry works
      const { error: repoUpdateError } = await adminClient
        .from('projects')
        .update({ github_repo_url: repoUrl })
        .eq('id', id)
      if (repoUpdateError) throw repoUpdateError
    }

    // Sync template GitHub workflows/config
    console.log(`${logPrefix} copying .github from template ${templateRepo}`)
    await copyRepoDir(token, templateRepo, '.github', repoFullName, '.github')
    console.log(`${logPrefix} .github copied`)

    // Push Charter (if content exists)
    const { data: charter, error: charterErr } = await adminClient
      .from('project_charter')
      .select('id, content, github_file_sha')
      .eq('project_id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (charterErr) {
      console.warn(`${logPrefix} charter lookup error: ${charterErr.message}`)
    }
    if (charter?.content) {
      console.log(`${logPrefix} pushing docs/Charter.md (length=${charter.content.length})`)
      const { sha } = await pushFile(
        token,
        repoFullName,
        'docs/Charter.md',
        charter.content,
        charter.github_file_sha ?? undefined,
        'docs: add Project Charter'
      )
      const { error: charterUpdateError } = await adminClient
        .from('project_charter')
        .update({ github_file_sha: sha })
        .eq('id', charter.id)
      if (charterUpdateError) throw charterUpdateError
      console.log(`${logPrefix} docs/Charter.md pushed sha=${sha}`)
    } else {
      console.log(`${logPrefix} skipping Charter — no content (charterRow=${!!charter})`)
    }

    // Push PRD (if content exists)
    const { data: prd, error: prdErr } = await adminClient
      .from('prd')
      .select('id, content, github_file_sha')
      .eq('project_id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (prdErr) {
      console.warn(`${logPrefix} prd lookup error: ${prdErr.message}`)
    }
    if (prd?.content) {
      console.log(`${logPrefix} pushing docs/PRD.md (length=${prd.content.length})`)
      const { sha } = await pushFile(
        token,
        repoFullName,
        'docs/PRD.md',
        prd.content,
        prd.github_file_sha ?? undefined,
        'docs: add PRD'
      )
      const { error: prdUpdateError } = await adminClient
        .from('prd')
        .update({ github_file_sha: sha })
        .eq('id', prd.id)
      if (prdUpdateError) throw prdUpdateError
      console.log(`${logPrefix} docs/PRD.md pushed sha=${sha}`)
    } else {
      console.log(`${logPrefix} skipping PRD — no content (prdRow=${!!prd})`)
    }

    console.log(`${logPrefix} syncing docs/epics/*.md and docs/stories/*.md`)
    await syncBacklogDocsToGitHub(id, token, repoFullName)
    console.log(`${logPrefix} backlog docs synced`)

    // Mark export complete
    const { error: exportUpdateError } = await adminClient
      .from('projects')
      .update({ github_exported_at: new Date().toISOString(), github_sync_error: null })
      .eq('id', id)
    if (exportUpdateError) throw exportUpdateError

    console.log(`${logPrefix} done repoUrl=${repoUrl}`)
    return NextResponse.json({ repoUrl })
  } catch (err) {
    let message: string
    let httpStatus: number

    if (err instanceof GitHubError) {
      if (err.status === 401) {
        message = 'GitHub token invalid or expired — update GITHUB_ACCESS_TOKEN'
        httpStatus = 401
      } else if (err.status === 404) {
        message = 'GitHub repo not found. Recreate from Project Settings.'
        httpStatus = 404
      } else if (err.status === 422) {
        message = 'A repository with this name already exists in your GitHub account'
        httpStatus = 422
      } else {
        message = err.message
        httpStatus = err.status
      }
      console.error(`${logPrefix} GitHubError status=${err.status} message=${err.message}`)
    } else {
      message = 'Failed to export to GitHub'
      httpStatus = 500
      console.error(`${logPrefix} unexpected error`, err)
    }

    await adminClient.from('projects').update({ github_sync_error: message }).eq('id', id)
    return NextResponse.json({ error: message }, { status: httpStatus })
  }
}
