'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Users, Sliders, Github, ExternalLink, RefreshCw, AlertCircle } from 'lucide-react'
import ProjectMembersPanel from '@/components/project/ProjectMembersPanel'
import type { PromptStage } from '@/types'

const STAGES: { value: PromptStage; label: string; description: string }[] = [
  { value: 'charter', label: 'Charter', description: 'Prompt used when generating the Project Charter' },
  { value: 'prd', label: 'PRD', description: 'Prompt used when generating the PRD' },
  { value: 'epics', label: 'Epics', description: 'Prompt used when generating Epics' },
  { value: 'stories', label: 'Stories', description: 'Prompt used when generating User Stories' },
  { value: 'domain_research', label: 'Domain Research', description: 'Prompt used by the Domain Research Agent' },
]

export default function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>()
  const [prompts, setPrompts] = useState<Record<PromptStage, string>>({
    charter: '', prd: '', epics: '', stories: '', domain_research: '',
  })
  const [systemDefaults, setSystemDefaults] = useState<Record<PromptStage, string>>({
    charter: '', prd: '', epics: '', stories: '', domain_research: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<PromptStage | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [canManageGitHub, setCanManageGitHub] = useState(false)
  const [githubRepoUrl, setGithubRepoUrl] = useState<string | null>(null)
  const [githubExportedAt, setGithubExportedAt] = useState<string | null>(null)
  const [githubSyncError, setGithubSyncError] = useState<string | null>(null)
  const [showInitModal, setShowInitModal] = useState(false)
  const [initRepoName, setInitRepoName] = useState('')
  const [initIsPrivate, setInitIsPrivate] = useState(false)
  const [initLoading, setInitLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch(`/api/project-prompts?project_id=${id}`).then(r => r.json()),
      fetch('/api/system-prompts').then(r => r.json()),
      fetch(`/api/projects/${id}`).then(r => r.ok ? r.json() : null),
    ]).then(([projectPrompts, sysPrompts, project]) => {
      if (Array.isArray(projectPrompts)) {
        const map: Record<string, string> = {}
        projectPrompts.forEach((p: { stage: string; content: string }) => { map[p.stage] = p.content })
        setPrompts(prev => ({ ...prev, ...map }))
      }
      if (Array.isArray(sysPrompts)) {
        const map: Record<string, string> = {}
        sysPrompts.forEach((p: { stage: string; content: string }) => { map[p.stage] = p.content })
        setSystemDefaults(prev => ({ ...prev, ...map }))
      }
      if (project) {
        setIsOwner(project.isOwner ?? false)
        setCanManageGitHub(true) // API returns 200 for owners and editors, 403 for viewers
        setGithubRepoUrl(project.github_repo_url ?? null)
        setGithubExportedAt(project.github_exported_at ?? null)
        setGithubSyncError(project.github_sync_error ?? null)
        setInitRepoName(project.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ?? '')
      }
    }).catch(() => {
      // silently ignore — individual fetch guards already handle non-2xx
    }).finally(() => setLoading(false))
  }, [id])

  async function handleSave(stage: PromptStage) {
    setSaving(stage)
    try {
      const res = await fetch('/api/project-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: id, stage, content: prompts[stage] }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success(`${stage} prompt saved`)
    } catch { toast.error('Failed to save prompt') }
    finally { setSaving(null) }
  }

  async function handleReset(stage: PromptStage) {
    setPrompts(prev => ({ ...prev, [stage]: '' }))
    await fetch('/api/project-prompts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: id, stage }),
    })
    toast.success('Reset to system default')
  }

  async function handleInitGitHub() {
    setInitLoading(true)
    try {
      const res = await fetch(`/api/projects/${id}/github/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoName: initRepoName, isPrivate: initIsPrivate }),
      })
      const data = await res.json()
      if (!res.ok) {
        const message = data.error ?? 'Export failed'
        if (res.status === 422) {
          setInitError(message)
        } else {
          toast.error(message)
        }
        return
      }
      setGithubRepoUrl(data.repoUrl)
      setGithubExportedAt(new Date().toISOString())
      setGithubSyncError(null)
      setShowInitModal(false)
      toast.success('Exported to GitHub')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setInitLoading(false)
    }
  }

  async function handleSyncGitHub() {
    setSyncing(true)
    try {
      const res = await fetch(`/api/projects/${id}/github/sync`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setGithubExportedAt(new Date().toISOString())
      setGithubSyncError(null)
      toast.success('Synced to GitHub')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed'
      setGithubSyncError(message)
      toast.error(`GitHub sync failed: ${message}`)
    } finally {
      setSyncing(false)
    }
  }

  if (loading) return <div className="p-8 text-muted-foreground text-sm">Loading...</div>

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Project Settings</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Manage collaborators and AI prompt overrides for this project.
        </p>
      </div>

      <Tabs defaultValue="members">
        <TabsList className="mb-6">
          <TabsTrigger value="members" className="gap-1.5">
            <Users className="h-3.5 w-3.5" />Members
          </TabsTrigger>
          <TabsTrigger value="prompts" className="gap-1.5">
            <Sliders className="h-3.5 w-3.5" />Prompts
          </TabsTrigger>
          <TabsTrigger value="github" className="gap-1.5">
            <Github className="h-3.5 w-3.5" />GitHub
          </TabsTrigger>
        </TabsList>

        <TabsContent value="members">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Team Members</CardTitle>
              <CardDescription>
                Invite collaborators to view or edit this project. Editors have full access; viewers can only read.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProjectMembersPanel />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="prompts">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Prompt Overrides</CardTitle>
              <CardDescription>
                These prompts override the system defaults for this project only.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="charter">
                <TabsList className="w-full mb-4">
                  {STAGES.map(s => (
                    <TabsTrigger key={s.value} value={s.value} className="flex-1 text-xs">{s.label}</TabsTrigger>
                  ))}
                </TabsList>
                {STAGES.map(stage => (
                  <TabsContent key={stage.value} value={stage.value} className="space-y-3">
                    <p className="text-sm text-muted-foreground">{stage.description}</p>

                    {systemDefaults[stage.value] && (
                      <div className="rounded-lg bg-muted/40 p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-1">System default:</p>
                        <p className="text-xs text-muted-foreground">{systemDefaults[stage.value]}</p>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <Label>Project override</Label>
                      <Textarea
                        placeholder="Leave blank to use system default. Override for this project..."
                        value={prompts[stage.value]}
                        onChange={e => setPrompts(prev => ({ ...prev, [stage.value]: e.target.value }))}
                        rows={6}
                      />
                    </div>

                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleSave(stage.value)} disabled={saving === stage.value}>
                        {saving === stage.value ? 'Saving...' : 'Save override'}
                      </Button>
                      {prompts[stage.value] && (
                        <Button size="sm" variant="ghost" onClick={() => handleReset(stage.value)}>
                          Reset to default
                        </Button>
                      )}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="github">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">GitHub Repository</CardTitle>
              <CardDescription>
                Export this project's requirements to a GitHub repository. Syncs automatically on every save.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!canManageGitHub ? (
                <p className="text-sm text-muted-foreground">
                  GitHub settings are only visible to project editors and owners.
                </p>
              ) : (
              <>
              {githubSyncError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="font-medium">GitHub sync failed</p>
                    <p className="mt-0.5 text-xs">{githubSyncError}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={handleSyncGitHub} disabled={syncing}>
                    {syncing ? 'Retrying...' : 'Retry'}
                  </Button>
                </div>
              )}
              {githubRepoUrl ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <a
                        href={githubRepoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-sm font-medium hover:underline"
                      >
                        <Github className="h-4 w-4" />
                        {githubRepoUrl.replace('https://github.com/', '')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      {githubExportedAt && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Last synced: {new Date(githubExportedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSyncGitHub}
                      disabled={syncing}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                      {syncing ? 'Syncing...' : 'Sync now'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {showInitModal ? (
                    <div className="space-y-3 rounded-lg border p-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="repo-name">Repository name</Label>
                        <Input
                          id="repo-name"
                          value={initRepoName}
                          onChange={e => { setInitRepoName(e.target.value); setInitError(null) }}
                          placeholder="my-project"
                        />
                        {initError && (
                          <p className="text-xs text-destructive">{initError}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="repo-private"
                          checked={initIsPrivate}
                          onChange={e => setInitIsPrivate(e.target.checked)}
                          className="h-4 w-4"
                        />
                        <Label htmlFor="repo-private" className="font-normal">Private repository</Label>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={handleInitGitHub}
                          disabled={initLoading || !initRepoName.trim()}
                        >
                          {initLoading ? 'Creating...' : 'Create repository'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setShowInitModal(false); setInitError(null) }}
                          disabled={initLoading}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" onClick={() => { setShowInitModal(true); setInitError(null) }}>
                      <Github className="h-4 w-4 mr-2" />
                      Create GitHub Repository
                    </Button>
                  )}
                </div>
              )}
              </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
