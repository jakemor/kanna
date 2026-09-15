import {test,expect} from 'bun:test'
import {applyChatOrder} from './SortableChatList'
test('saved order survives changed activity and appends new tasks without losing them',()=>{
 const rows=[{chatId:'a'},{chatId:'b'},{chatId:'c'}]
 expect(applyChatOrder(rows,['b','a','deleted']).map(x=>x.chatId)).toEqual(['b','a','c'])
 expect(rows.map(x=>x.chatId)).toEqual(['a','b','c'])
 expect(applyChatOrder([...rows].reverse(),['b','a','deleted']).map(x=>x.chatId)).toEqual(['b','a','c'])
 expect(applyChatOrder(rows)).toBe(rows)
})
