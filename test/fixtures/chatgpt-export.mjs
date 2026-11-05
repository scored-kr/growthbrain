// Synthetic format fixtures, not a user's exported account data.
export function chatExport(id='conversation-one'){
  const node=(id,parent,role,text,extra={})=>({id,parent,children:[],message:{id:`message-${id}`,author:{role},create_time:1700000000,content:{content_type:'text',parts:[text]},...extra}});
  return {id,title:'Synthetic general chat',current_node:'a2',mapping:{
    root:{id:'root',parent:null,message:null},
    u1:node('u1','root','user','  한국어로 답변해주세요  '),
    a1:node('a1','u1','assistant','예산: 999억원'),
    u2:node('u2','a1','user','예산: 50만원'),
    analysis:node('analysis','u2','assistant','PRIVATE_REASONING',{channel:'analysis'}),
    tool:node('tool','analysis','tool','PRIVATE_TOOL_OUTPUT'),
    image:node('image','tool','user','',{content:{content_type:'multimodal_text',parts:[{asset_pointer:'private-attachment'}]}}),
    a2:node('a2','image','assistant','확인했습니다.'),
    abandoned:node('abandoned','u1','assistant','ABANDONED_BRANCH'),
  }};
}
