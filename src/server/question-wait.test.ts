import { test, expect } from "bun:test"
import { AgentCoordinator } from "./agent"
test("empty answers leave the task waiting; custom answers explicitly resume it", async () => {
  const coordinator = Object.create(AgentCoordinator.prototype) as any
  let resolved = false
  const messages: unknown[] = []
  const active = {status:"waiting_for_user",pendingTool:{toolUseId:"q",tool:{toolKind:"ask_user_question",input:{questions:[{id:"choice",question:"Choose?"}]}},resolve:()=>{resolved=true}},provider:"codex"}
  coordinator.activeTurns = new Map([["chat",active]])
  coordinator.store = {appendMessage:async (_: string, entry: unknown)=>{messages.push(entry)}}
  coordinator.emitStateChange = () => {}
  const command = {type:"chat.respondTool",chatId:"chat",toolUseId:"q",result:{answers:{choice:[]}}}
  await expect(coordinator.respondTool(command)).rejects.toThrow("Answer all questions")
  await expect(coordinator.respondTool({...command,result:{answers:{choice:["   "]}}})).rejects.toThrow("Answer all questions")
  await expect(coordinator.respondTool({...command,result:{answers:{other:["wrong question"]}}})).rejects.toThrow("Answer all questions")
  expect(active.status).toBe("waiting_for_user")
  expect(resolved).toBe(false)
  expect(messages).toHaveLength(0)
  await coordinator.respondTool({...command,result:{answers:{choice:["My custom answer"]}}})
  expect(resolved).toBe(true)
  expect(active.status).toBe("running")
  expect(messages).toHaveLength(1)
})
