import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

function nextEpicCode(existingCodes: Array<{ code: string }>): string {
  const max = existingCodes.reduce((highest, row) => {
    const match = row.code.match(/^E-(\d+)$/)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0)
  return `E-${String(max + 1).padStart(3, '0')}`
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get('project_id')
  if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('epics')
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
  const { project_id, title, description, acceptance_criteria, priority } = body

  // Generate code
  const [{ data: existingCodes }, { count }] = await Promise.all([
    supabase.from('epics').select('code').eq('project_id', project_id),
    supabase.from('epics').select('*', { count: 'exact', head: true }).eq('project_id', project_id),
  ])
  const code = nextEpicCode(existingCodes ?? [])

  const { data, error } = await supabase
    .from('epics')
    .insert({ project_id, code, title, description, acceptance_criteria, priority: priority ?? 'should', order: count ?? 0, status: 'draft', version: 1 })
    .select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
