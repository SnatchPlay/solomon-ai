// src/app/api/projects/[id]/github/sync/route.ts
import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import {
  GitHubError,
  pushFile,
} from '@/lib/github'
import { repoNameFromUrl, syncBacklogDocsToGitHub } from '@/lib/github-sync'

type Params = { params: Promise<{ id: string }> }

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const adminClient = await createAdminClient()

  // Owner or editor can trigger sync
  const { data: project } = await adminClient
    .from('projects')
    .select('id, user_id, github_repo_url')
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

  if (!project.github_repo_url) {
    return NextResponse.json({ error: 'Project not exported to GitHub yet' }, { status: 400 })
  }

  const repoFullName = repoNameFromUrl(project.github_repo_url)

  const token = process.env.GITHUB_ACCESS_TOKEN
  if (!token) {
    return NextResponse.json(
      { error: 'GitHub integration not configured. Contact your administrator.' },
      { status: 503 }
    )
  }

  try {
    // Sync Charter
    const { data: charter } = await adminClient
      .from('project_charter')
      .select('id, content, github_file_sha')
      .eq('project_id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (charter?.content) {
      const { sha } = await pushFile(
        token, repoFullName, 'docs/Charter.md', charter.content, charter.github_file_sha ?? undefined
      )
      await adminClient.from('project_charter').update({ github_file_sha: sha }).eq('id', charter.id)
    }

    // Sync PRD
    const { data: prd } = await adminClient
      .from('prd')
      .select('id, content, github_file_sha')
      .eq('project_id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (prd?.content) {
      const { sha } = await pushFile(
        token, repoFullName, 'docs/PRD.md', prd.content, prd.github_file_sha ?? undefined
      )
      await adminClient.from('prd').update({ github_file_sha: sha }).eq('id', prd.id)
    }

    await syncBacklogDocsToGitHub(id, token, repoFullName)

    await adminClient
      .from('projects')
      .update({ github_sync_error: null, github_exported_at: new Date().toISOString() })
      .eq('id', id)

    return NextResponse.json({ success: true })
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
      } else {
        message = err.message
        httpStatus = err.status
      }
    } else {
      message = 'Sync failed'
      httpStatus = 500
    }

    await adminClient.from('projects').update({ github_sync_error: message }).eq('id', id)
    return NextResponse.json({ error: message }, { status: httpStatus })
  }
}
