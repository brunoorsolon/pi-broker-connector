export function cardEnvelope(text = 'A revisão terminou. Os testes passaram.\nPode continuar com a próxima etapa.') {
  return {protocol_version:'1',message_id:'11111111-1111-4111-8111-111111111111',recipient_id:'22222222-2222-4222-8222-222222222222',recipient_sequence:1,
    sender:{client_id:'33333333-3333-4333-8333-333333333333',client_type:'pi',name:'Revisor',model:{provider:'fixture-provider',id:'fixture-model',source:'observed'},project:'example-project',metadata_revision:1},
    origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text},accepted_at:'2026-11-01T12:00:00.000Z',expires_at:'2026-11-02T12:00:00.000Z',correlation_id:null,reply_to_message_id:null};
}
