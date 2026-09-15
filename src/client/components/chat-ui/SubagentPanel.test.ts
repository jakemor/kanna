import {test,expect} from 'bun:test'
import {collectSubagents} from './SubagentPanel'
import type {TranscriptEntry} from '../../../shared/types'
test('subagents expose reported models and stop their timer on completion',()=>{
 const start:TranscriptEntry={_id:'a',kind:'tool_call',createdAt:1000,tool:{kind:'tool',toolKind:'subagent_task',toolName:'Task',toolId:'t',input:{subagentType:'review',model:'gpt-6-astra'}}}
 expect(collectSubagents([start],true)[0]).toMatchObject({name:'review',model:'gpt-6-astra',status:'Running'})
 const end:TranscriptEntry={_id:'b',kind:'tool_result',createdAt:4000,toolId:'t',content:'done',isError:false}
 expect(collectSubagents([start,end],false)[0]).toMatchObject({status:'Completed',endedAt:4000})
 expect(collectSubagents([start],false)[0]?.status).toBe('Unconfirmed')
})

test("a new turn does not revive unresolved old tasks and absent models stay unknown", () => {
  const entries: TranscriptEntry[] = [
    {_id: "a", kind: "tool_call", createdAt: 1000, tool: {kind: "tool", toolKind: "subagent_task", toolName: "Task", toolId: "old", input: {subagentType: "review"}}},
    {_id: "u", kind: "user_prompt", createdAt: 2000, content: "next"},
  ]
  expect(collectSubagents(entries, true)[0]).toMatchObject({status: "Unconfirmed", model: "Not reported"})
})
