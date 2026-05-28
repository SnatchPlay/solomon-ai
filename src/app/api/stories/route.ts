import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

function nextStoryCode(existingCodes: Array<{ code: string }>): string {
  const max = existingCodes.reduce((highest, row) => {
    const match = row.code.match(/^US-(\d+)$/)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0)
  return `US-${String(max + 1).padStart(3, '0')}`
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get('project_id')
  if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('user_stories')
    .select('*')
    .eq('project_id', projectId)
    .order('order', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { project_id, epic_id, title, as_a, i_want, so_that, acceptance_criteria, priority, effort_estimate } = body

  const [{ data: existingCodes }, { count }] = await Promise.all([
    supabase.from('user_stories').select('code').eq('project_id', project_id),
    supabase.from('user_stories').select('*', { count: 'exact', head: true }).eq('project_id', project_id),
  ])
  const code = nextStoryCode(existingCodes ?? [])

  const { data, error } = await supabase
    .from('user_stories')
    .insert({
      project_id, epic_id: epic_id ?? null, code, title,
      as_a: as_a ?? '', i_want: i_want ?? '', so_that: so_that ?? '',
      acceptance_criteria: acceptance_criteria ?? [],
      priority: priority ?? 'should',
      effort_estimate: effort_estimate ?? null,
      order: count ?? 0, status: 'draft', version: 1,
    })
    .select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
