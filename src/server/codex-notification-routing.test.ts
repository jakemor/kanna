import {test,expect} from 'bun:test';
import {CodexAppServerManager} from './codex-app-server';
test('child lifecycle and text do not terminate or overwrite parent; parent completion still works',async()=>{
 const manager:any=new CodexAppServerManager();const events:any[]=[];let finished=0;
 const pending:any={turnId:'parent-turn',queue:{push:(e:any)=>events.push(e),finish:()=>finished++},planMode:false};
 const context:any={sessionToken:'parent-thread',pendingTurn:pending};
 await manager.handleNotification(context,{method:'thread/started',params:{thread:{id:'child-thread'}}});
 expect(context.sessionToken).toBe('parent-thread');
 await manager.handleNotification(context,{method:'item/completed',params:{threadId:'child-thread',turnId:'child-turn',item:{type:'agentMessage',id:'child-message',text:'Child done'}}});
 await manager.handleNotification(context,{method:'turn/completed',params:{threadId:'child-thread',turn:{id:'child-turn',status:'completed'}}});
 await manager.handleNotification(context,{method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'stale-turn',status:'completed'}}});
 expect(events).toHaveLength(0);expect(finished).toBe(0);expect(context.pendingTurn).toBe(pending);
 await manager.handleNotification(context,{method:'item/completed',params:{threadId:'parent-thread',turnId:'parent-turn',item:{type:'agentMessage',id:'parent-message',text:'Parent done'}}});
 expect(events.length).toBeGreaterThan(0);
 await manager.handleNotification(context,{method:'turn/completed',params:{threadId:'parent-thread',turn:{id:'parent-turn',status:'completed'}}});
 expect(finished).toBe(1);expect(context.pendingTurn).toBeNull();
});
