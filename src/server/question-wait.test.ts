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

for (const scenario of [
  { name: "scalar answer", questions: [{ id: "a", question: "First?" }], answers: { a: "Custom" }, valid: true },
  { name: "question text fallback", questions: [{ id: "a", question: "First?" }], answers: { "First?": "Custom" }, valid: true },
  { name: "duplicate IDs", questions: [{ id: "a", question: "First?" }, { id: "a", question: "Second?" }], answers: { a: "Yes" }, valid: false },
  { name: "duplicate text", questions: [{ question: "Same?" }, { question: "Same?" }], answers: { "Same?": "Yes" }, valid: false },
  { name: "duplicate fallback text with distinct IDs", questions: [{ id: "a", question: "Same?" }, { id: "b", question: "Same?" }], answers: { "Same?": "Yes" }, valid: false },
  { name: "distinct IDs with duplicate text", questions: [{ id: "a", question: "Same?" }, { id: "b", question: "Same?" }], answers: { a: "Yes", b: ["No"] }, valid: true },
  { name: "ID and text collision", questions: [{ id: "a", question: "First?" }, { question: "a" }], answers: { a: "Yes" }, valid: false },
]) {
  test(scenario.name, async () => {
    const coordinator = Object.create(AgentCoordinator.prototype) as any
    let resolved = false
    const messages: unknown[] = []
    const active = { status: "waiting_for_user", provider: "codex", pendingTool: {
      toolUseId: "q", tool: { toolKind: "ask_user_question", input: { questions: scenario.questions } },
      resolve: () => { resolved = true },
    } }
    coordinator.activeTurns = new Map([["chat", active]])
    coordinator.store = { appendMessage: async (_: string, entry: unknown) => { messages.push(entry) } }
    coordinator.emitStateChange = () => {}
    const result = coordinator.respondTool({ type: "chat.respondTool", chatId: "chat", toolUseId: "q", result: { answers: scenario.answers } })
    if (scenario.valid) await result
    else await expect(result).rejects.toThrow("Answer all questions")
    expect(resolved).toBe(scenario.valid)
    expect(active.status).toBe(scenario.valid ? "running" : "waiting_for_user")
    expect(messages).toHaveLength(scenario.valid ? 1 : 0)
    expect(active.pendingTool === null).toBe(scenario.valid)
  })
}
