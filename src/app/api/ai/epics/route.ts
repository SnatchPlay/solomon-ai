import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateText } from '@/lib/ai/providers'
import { getEffectiveAISettings } from '@/lib/ai/settings'

function maxEpicNumber(existingCodes: Array<{ code: string }>): number {
  return existingCodes.reduce((highest, row) => {
    const match = row.code.match(/^E-(\d+)$/)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { project_id, clarification } = await request.json()

  const { data: project } = await supabase
    .from('projects').select('name, mode').eq('id', project_id).eq('user_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const settings = await getEffectiveAISettings(user.id)

  const [{ data: projectPrompt }, { data: systemPrompt }, { data: prd }] = await Promise.all([
    supabase.from('project_prompts').select('content').eq('project_id', project_id).eq('stage', 'epics').single(),
    supabase.from('system_prompts').select('content').eq('stage', 'epics').single(),
    supabase.from('prd').select('content').eq('project_id', project_id).order('version', { ascending: false }).limit(1).single(),
  ])

  if (!prd?.content) return NextResponse.json({ error: 'PRD must be approved before generating Epics.' }, { status: 400 })

  const systemInstruction = projectPrompt?.content ?? systemPrompt?.content ?? ''

  // If clarifying, fetch existing epics to refine
  let existingEpics: Array<{ id: string; code: string; title: string; description: string; acceptance_criteria: string; priority: string }> = []
  if (clarification) {
    const { data } = await supabase
      .from('epics')
      .select('id, code, title, description, acceptance_criteria, priority')
      .eq('project_id', project_id)
      .order('order', { ascending: true })
    existingEpics = data ?? []
  }

  const userMessage = clarification && existingEpics.length > 0 ? `
Project: ${project.name}

PRD:
${prd.content}

---

CURRENT EPICS:
${JSON.stringify(existingEpics.map(e => ({ code: e.code, title: e.title, description: e.description, acceptance_criteria: e.acceptance_criteria, priority: e.priority })), null, 2)}

---

CLARIFICATION REQUEST:
${clarification}

Refine the epics above based on the clarification request. Return the complete updated list as a JSON array only — no markdown, no explanation.

Each epic must have:
{
  "title": "string",
  "description": "string",
  "acceptance_criteria": "string",
  "priority": "must" | "should" | "could" | "wont"
}

Return ALL epics (updated and unchanged). Output only the JSON array.
`.trim() : `
Project: ${project.name}

PRD:
${prd.content}

---

Generate Epics for this project. Output a JSON array only — no markdown, no explanation.

Each epic should have:
{
  "title": "string",
  "description": "string (2-3 sentences explaining the epic scope)",
  "acceptance_criteria": "string (bullet points of what 'done' means)",
  "priority": "must" | "should" | "could" | "wont"
}

Group related requirements into 4-8 logical epics. Each epic should be independently deliverable.
Output only the JSON array.
`.trim()

  try {
    const text = await generateText({
      model: settings.model,
      systemPrompt: systemInstruction,
      userPrompt: userMessage,
      maxTokens: 3000,
      apiKeys: {
        anthropic: settings.anthropic_api_key,
        openai: settings.openai_api_key,
        gemini: settings.gemini_api_key,
      },
    })
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 })

    const epicsData = JSON.parse(jsonMatch[0]) as Array<{
      title: string; description: string; acceptance_criteria: string; priority: string
    }>

    let inserted
    let error

    if (clarification && existingEpics.length > 0) {
      // Replace existing epics with refined version
      await supabase.from('epics').delete().eq('project_id', project_id)

      const epicsToInsert = epicsData.map((e, i) => ({
        project_id,
        code: `E-${String(i + 1).padStart(3, '0')}`,
        title: e.title,
        description: e.description,
        acceptance_criteria: e.acceptance_criteria,
        priority: e.priority ?? 'should',
        order: i,
        status: 'draft',
        version: 1,
      }))

      const result = await supabase.from('epics').insert(epicsToInsert).select()
      inserted = result.data
      error = result.error
    } else {
      // Append new epics
      const [{ count: existing }, { data: existingCodes }] = await Promise.all([
        supabase.from('epics').select('*', { count: 'exact', head: true }).eq('project_id', project_id),
        supabase.from('epics').select('code').eq('project_id', project_id),
      ])
      const nextNumber = maxEpicNumber(existingCodes ?? []) + 1

      const epicsToInsert = epicsData.map((e, i) => ({
        project_id,
        code: `E-${String(nextNumber + i).padStart(3, '0')}`,
        title: e.title,
        description: e.description,
        acceptance_criteria: e.acceptance_criteria,
        priority: e.priority ?? 'should',
        order: (existing ?? 0) + i,
        status: 'draft',
        version: 1,
      }))

      const result = await supabase.from('epics').insert(epicsToInsert).select()
      inserted = result.data
      error = result.error
    }

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await supabase.from('projects').update({ status: 'epics' })
      .eq('id', project_id).eq('user_id', user.id).eq('status', 'prd')

    return NextResponse.json(inserted, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI generation failed' }, { status: 400 })
  }
}
