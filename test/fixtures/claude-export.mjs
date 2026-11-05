// Synthetic flat export, plus optional branch fields in tests. No customer data.
export function claudeExport(id='claude-conversation'){
 return {uuid:id,name:'Synthetic Claude general chat',chat_messages:[
  {uuid:'claude-u1',sender:'human',text:'wrong fallback text',content:[{type:'text',text:'  한국어로 답변해주세요  '}],created_at:'2024-01-02T03:04:05.123456Z',attachments:[{file_name:'PRIVATE_ATTACHMENT'}]},
  {uuid:'claude-a1',sender:'assistant',text:'DO_NOT_IMPORT_FALLBACK',content:[{type:'thinking',thinking:'PRIVATE_CLAUDE_REASONING'},{type:'text',text:'확인했습니다.'},{type:'tool_use',input:{text:'PRIVATE_CLAUDE_TOOL'}}],created_at:'2024-01-02T03:04:06Z'},
  {uuid:'claude-u2',sender:'human',text:'예산: 50만원',created_at:'2024-01-02T03:04:07Z'},
 ]};
}
