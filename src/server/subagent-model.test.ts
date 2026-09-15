import {test,expect} from 'bun:test'
import {CodexAppServerManager} from './codex-app-server'
test('looks up the child model, never substitutes parent model, and caches successful reads',async()=>{
 const manager=new CodexAppServerManager() as any
 let reads=0
 manager.sessions.set('parent',{closed:false})
 manager.sendRequest=async (_:unknown,method:string,params:any)=>{reads++;expect(method).toBe('thread/read');expect(params.includeTurns).toBe(false);return {thread:{id:params.threadId,model:params.threadId==='child'?'gpt-5.6-sol':null}}}
 expect(await manager.getSubagentModels('parent',['child','unknown'])).toEqual({child:'gpt-5.6-sol'})
 expect(await manager.getSubagentModels('parent',['child'])).toEqual({child:'gpt-5.6-sol'})
 expect(reads).toBe(2)
})
