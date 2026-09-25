import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import { encryptSecret, decryptSecret, IntegrationError } from './tenant-integrations'

type Middleware = (req: Request, res: Response, next: NextFunction) => any
const CALLBACK = '/api/communications/gmail/callback'
const oauthStates = new Map<string, { token: string; userId: string; tenantId: string; verifier: string; expires: number }>()
const gmailKind = 'gmail-refresh' as const
const google = async (url: string, init: RequestInit) => {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) })
  const data: any = await response.json()
  if (!response.ok) throw new IntegrationError(data.error_description || data.error?.message || 'Gmail request failed.', 502)
  return data
}
function credentials() {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID || ''
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET || ''
  if (!clientId || !clientSecret) throw new IntegrationError('Gmail OAuth is not configured on the server.', 503)
  return { clientId, clientSecret }
}
function origin(req: Request) { return `${req.protocol}://${req.get('host')}` }
function requireText(input: unknown, field: string, max = 4000) {
  if (typeof input !== 'string' || input.trim().length > max) throw new IntegrationError(`${field} is invalid.`)
  return input.trim()
}
function attachmentNames(payload:any): string[] {
  const names:string[]=[]
  function visit(part:any) { if(part?.filename) names.push(String(part.filename).slice(0,255));for(const child of part?.parts || []) visit(child) }
  visit(payload);return names.slice(0,50)
}
function decodeBody(payload: any): string {
  const parts: any[] = []
  function visit(part: any) { if (part?.mimeType === 'text/plain' && part?.body?.data) parts.push(part.body.data); for (const child of part?.parts || []) visit(child) }
  visit(payload)
  const encoded = parts[0] || (payload?.mimeType === 'text/plain' ? payload?.body?.data : '')
  return encoded ? Buffer.from(encoded, 'base64url').toString('utf8').slice(0, 30000) : ''
}
export function registerCommunications(app: Express, deps: {
  db: any; requireAuth: Middleware; requireTenant: Middleware;
  sessionFromRequest: (req: Request) => { token: string; user: any };
  load: (id: string) => Promise<any>; commit: (id: string, next: any, user: any, source: string, current: any) => Promise<any>;
  openStatus: (state: any) => string;
}) {
  const { db } = deps
  const auth = [deps.requireAuth, deps.requireTenant]
  const current = (req: Request) => (req as any).authUser
  const allowed = (user: any) => user.role === 'Administrator' || user.modules?.includes('inbox')
  const guard: Middleware = (req, res, next) => { if (!allowed(current(req))) return void res.status(403).json({ error: 'Communications access is required.' }); res.setHeader('Cache-Control','no-store'); next() }
  const wrap = (fn: (req: Request, res: Response) => Promise<any>): Middleware => async (req,res) => {
    try { if (!db) throw new IntegrationError('Cloud storage is required for private communications.',503); await fn(req,res) }
    catch (error) { res.status(error instanceof IntegrationError ? error.status : 503).json({ error: error instanceof IntegrationError ? error.message : 'Communications are unavailable. Apply schema-v12-communications.sql and retry.' }) }
  }
  const scoped = (req: Request) => ({ tenant_id: current(req).organizationId as string, owner_user_id: current(req).id as string })
  const settings = async (tenant: string, user: string) => {
    const { data, error } = await db.from('user_communication_settings').select('*').eq('tenant_id',tenant).eq('user_id',user).maybeSingle()
    if (error) throw error
    return data
  }
  const own = async (req: Request, id: string) => {
    const { data, error } = await db.from('user_communications').select('*').eq('tenant_id', current(req).organizationId).eq('owner_user_id',current(req).id).eq('id',id).maybeSingle()
    if (error) throw error
    if (!data) throw new IntegrationError('Communication not found.',404)
    return data
  }
  app.get('/api/communications', ...auth, guard, wrap(async (req,res) => {
    const user = current(req)
    const { data, error } = await db.from('user_communications').select('*').eq('tenant_id',user.organizationId).eq('owner_user_id',user.id).order('received_at',{ ascending:false }).limit(200)
    if (error) throw error
    res.json({ items:data || [] })
  }))
  app.get('/api/communications/settings', ...auth, guard, wrap(async (req,res) => {
    const row = await settings(current(req).organizationId,current(req).id)
    res.json({ discordUserId:row?.discord_user_id || '', captureMentions:row?.discord_capture_mentions ?? true,
      gmailEmail:row?.gmail_email || '', gmailLabels:row?.gmail_labels || [], gmailConnected:Boolean(row?.gmail_refresh_token),
      gmailAvailable:Boolean(process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET), callbackUrl:`${origin(req)}${CALLBACK}` })
  }))
  app.put('/api/communications/settings', ...auth, guard, wrap(async (req,res) => {
    const user=current(req), id=String(req.body?.discordUserId || '').trim()
    if (id && !/^\d{15,22}$/.test(id)) throw new IntegrationError('Enter a valid Discord user ID.')
    const labels=req.body?.gmailLabels
    if (!Array.isArray(labels) || labels.length > 30 || labels.some((x:any)=>typeof x !== 'string' || x.length > 128)) throw new IntegrationError('Choose up to 30 Gmail labels.')
    const previous=await settings(user.organizationId,user.id)
    const { error }=await db.from('user_communication_settings').upsert({ tenant_id:user.organizationId,user_id:user.id,
      discord_user_id:id || null,discord_capture_mentions:req.body?.captureMentions !== false,
      gmail_labels:[...new Set(labels)],gmail_email:previous?.gmail_email || null,gmail_refresh_token:previous?.gmail_refresh_token || null,
      updated_at:new Date().toISOString() },{ onConflict:'tenant_id,user_id' })
    if (error) throw new IntegrationError(error.code === '23505' ? 'This Discord account is already linked to another user in this workspace.' : 'Could not save communication settings.',error.code === '23505' ? 409 : 503)
    res.json({ saved:true })
  }))
  app.post('/api/communications', ...auth, guard, wrap(async (req,res) => {
    if (current(req).role === 'Viewer') throw new IntegrationError('Viewer accounts cannot create communications.',403)
    const subject=requireText(req.body?.subject,'Subject',200),body=requireText(req.body?.body,'Message',30000)
    if (!subject && !body) throw new IntegrationError('Enter a subject or message.')
    const { data,error }=await db.from('user_communications').insert({ tenant_id:current(req).organizationId,owner_user_id:current(req).id,source:'Manual',subject,body,sender:current(req).name }).select('*').single()
    if (error) throw error
    res.status(201).json({ item:data })
  }))
  app.patch('/api/communications/:id', ...auth, guard, wrap(async (req,res) => {
    await own(req,req.params.id)
    const status=String(req.body?.status || '')
    if (!['New','Open','Resolved','Archived'].includes(status)) throw new IntegrationError('Invalid status.')
    const { data,error }=await db.from('user_communications').update({status}).eq('id',req.params.id).eq('tenant_id',current(req).organizationId).eq('owner_user_id',current(req).id).select('*').single()
    if(error) throw error
    res.json({item:data})
  }))
  app.post('/api/communications/:id/create-task', ...auth, guard, wrap(async (req,res) => {
    const user=current(req)
    if(user.role === 'Viewer' || (!user.modules?.includes('items') && user.role !== 'Administrator')) throw new IntegrationError('Task write access is required.',403)
    const communication=await own(req,req.params.id)
    if(communication.linked_task_id) throw new IntegrationError('This communication already has a linked task.',409)
    const stateResult=await deps.load(user.organizationId),state=stateResult.data
    if(!state) throw new IntegrationError('Workspace data is unavailable.',503)
    const clientId=requireText(req.body?.clientId,'Client',100),projectId=requireText(req.body?.projectId,'Project',100)
    if (!clientId || !projectId || !state.clients?.some((x:any)=>x.id===clientId && !x.archived) || !state.projects?.some((x:any)=>x.id===projectId && !x.archived)) throw new IntegrationError('Select an active client and project.')
    const assignee=requireText(req.body?.assignedToUserId,'Assignee',100)
    const account=(state.accounts || []).find((x:any)=>x.id===assignee && x.status!=='Disabled' && ['Administrator','Contributor'].includes(x.role))
    if (!account) throw new IntegrationError('Select an active team member.')
    const title=requireText(req.body?.title,'Task title',200),description=requireText(req.body?.description,'Task description',5000)
    if(!title) throw new IntegrationError('Enter a task title.')
    const item={ id:randomUUID(),clientId,projectId,title,type:'Task',priority:'Medium',status:deps.openStatus(state),waitingOn:'Me',owner:account.name || account.username,
      assignedToUserId:assignee,dateRaised:new Date().toISOString().slice(0,10),dueDate:'',followUpDate:'',description,resolution:'',source:'Internal' }
    // Shared task contains only the fields explicitly submitted here; never a private source ID or thread.
    await deps.commit(user.organizationId,{ ...state,items:[item,...(state.items || [])] },user,'communication-task',state)
    const {error}=await db.from('user_communications').update({linked_task_id:item.id}).eq('id',communication.id).eq('tenant_id',user.organizationId).eq('owner_user_id',user.id)
    if(error) throw error
    res.status(201).json({ task:item })
  }))
  app.get('/api/communications/gmail/connect', ...auth, guard, wrap(async (req,res) => {
    const {clientId}=credentials(),user=current(req),session=deps.sessionFromRequest(req),verifier=randomBytes(32).toString('base64url'),state=randomBytes(24).toString('base64url')
    oauthStates.set(state,{token:session.token,userId:user.id,tenantId:user.organizationId,verifier,expires:Date.now()+600000})
    const redirectUri=`${origin(req)}${CALLBACK}`
    const query=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',access_type:'offline',prompt:'consent select_account',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'})
    res.json({url:`https://accounts.google.com/o/oauth2/v2/auth?${query}`})
  }))
  app.get(CALLBACK, async (req,res) => {
    const state=String(req.query.state || ''),saved=oauthStates.get(state); oauthStates.delete(state)
    const session=deps.sessionFromRequest(req)
    if(!saved || saved.expires<Date.now() || !session.user || session.token!==saved.token || session.user.id!==saved.userId || session.user.organizationId!==saved.tenantId || typeof req.query.code !== 'string') return void res.status(403).send('Gmail connection expired. Return to settings and try again.')
    try {
      const {clientId,clientSecret}=credentials(),redirectUri=`${origin(req)}${CALLBACK}`
      const grant=await google('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:req.query.code,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,code_verifier:saved.verifier,grant_type:'authorization_code'})})
      if(!grant.refresh_token || !String(grant.scope || '').includes('gmail.readonly')) throw new Error('Gmail did not grant offline read access.')
      const identity=await google('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${grant.access_token}`}})
      const previous=await settings(saved.tenantId,saved.userId)
      const {error}=await db.from('user_communication_settings').upsert({tenant_id:saved.tenantId,user_id:saved.userId,
        discord_user_id:previous?.discord_user_id || null,discord_capture_mentions:previous?.discord_capture_mentions ?? true,
        gmail_email:String(identity.email || ''),gmail_refresh_token:encryptSecret(grant.refresh_token,`${saved.tenantId}:${saved.userId}`,gmailKind),gmail_labels:previous?.gmail_labels || [],updated_at:new Date().toISOString()},{onConflict:'tenant_id,user_id'})
      if(error) throw error
      res.redirect(303,'/?gmail=connected')
    } catch { res.redirect(303,'/?gmail=error') }
  })
  app.get('/api/communications/gmail/labels', ...auth, guard, wrap(async (req,res) => {
    const token=await accessToken(req),result=await google('https://gmail.googleapis.com/gmail/v1/users/me/labels',{headers:{Authorization:`Bearer ${token}`}})
    res.json({labels:(result.labels || []).filter((x:any)=>x.type==='user').map((x:any)=>({id:x.id,name:x.name}))})
  }))
  app.delete('/api/communications/gmail', ...auth, guard, wrap(async (req,res) => {
    const user=current(req),previous=await settings(user.organizationId,user.id)
    if(previous?.gmail_refresh_token) {
      try {
        const token=decryptSecret(previous.gmail_refresh_token,`${user.organizationId}:${user.id}`,gmailKind)
        await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),signal:AbortSignal.timeout(10000),redirect:'error'})
      } catch { /* Disconnect locally even if revocation is temporarily unavailable. */ }
    }
    const {error}=await db.from('user_communication_settings').update({gmail_email:null,gmail_refresh_token:null,gmail_labels:[],updated_at:new Date().toISOString()}).eq('tenant_id',user.organizationId).eq('user_id',user.id)
    if(error) throw error
    res.json({disconnected:true})
  }))
  app.post('/api/communications/gmail/sync', ...auth, guard, wrap(async (req,res) => {
    const user=current(req),row=await settings(user.organizationId,user.id),labels=Array.isArray(row?.gmail_labels) ? row.gmail_labels : []
    if(!labels.length) throw new IntegrationError('Select monitored Gmail labels in settings first.')
    const token=await accessToken(req)
    let imported=0
    for(const label of labels.slice(0,30)) {
      const list=await google(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({labelIds:String(label),maxResults:'30'})}`,{headers:{Authorization:`Bearer ${token}`}})
      for(const message of list.messages || []) {
        const externalId=String(message.id)
        const {data:found,error:lookupError}=await db.from('user_communications').select('id').eq('tenant_id',user.organizationId).eq('owner_user_id',user.id).eq('source','Gmail').eq('external_id',externalId).maybeSingle()
        if(lookupError) throw lookupError
        if(found) continue
        const detail=await google(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(externalId)}?format=full`,{headers:{Authorization:`Bearer ${token}`}})
        const headers=detail.payload?.headers || [],head=(name:string)=>String(headers.find((x:any)=>x.name?.toLowerCase()===name)?.value || '')
        const {error}=await db.from('user_communications').insert({tenant_id:user.organizationId,owner_user_id:user.id,source:'Gmail',external_id:externalId,thread_id:String(detail.threadId || ''),subject:head('subject').slice(0,500),sender:head('from').slice(0,500),body:decodeBody(detail.payload) || String(detail.snippet || ''),attachments:attachmentNames(detail.payload),source_label:String(label),received_at:new Date(Number(detail.internalDate || Date.now())).toISOString()})
        if(error && error.code!=='23505') throw error
        if(!error) imported++
      }
    }
    res.json({imported})
  }))
  async function accessToken(req: Request) {
    const user=current(req),row=await settings(user.organizationId,user.id)
    if(!row?.gmail_refresh_token) throw new IntegrationError('Connect your Gmail account first.',409)
    const {clientId,clientSecret}=credentials(),refresh=decryptSecret(row.gmail_refresh_token,`${user.organizationId}:${user.id}`,gmailKind)
    const grant=await google('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refresh,grant_type:'refresh_token'})})
    return String(grant.access_token)
  }
  const timer=setInterval(()=>{const now=Date.now();for(const [key,value] of oauthStates) if(value.expires<now) oauthStates.delete(key)},60000);timer.unref()
  return {
    async captureDiscord(message:any,tenantId:string) {
      const ids=[...new Set((message.mentions?.users ? [...message.mentions.users.keys()] : []) as string[])]
      const {data:linked,error}=await db.from('user_communication_settings').select('user_id,discord_user_id,discord_capture_mentions').eq('tenant_id',tenantId).in('discord_user_id',ids.length ? ids : ['0'])
      if(error) throw error
      const recipients=(linked || []).filter((x:any)=>x.discord_capture_mentions && ids.includes(x.discord_user_id))
      // A bot DM routes only when the sender has linked their Discord identity.
      if(!message.guildId) {
        const {data:sender,error:dmError}=await db.from('user_communication_settings').select('user_id').eq('tenant_id',tenantId).eq('discord_user_id',String(message.author.id))
        if(dmError) throw dmError
        recipients.push(...(sender || []))
      }
      let count=0
      for(const recipient of new Map<string,any>(recipients.map((x:any)=>[String(x.user_id),x])).values()) {
        const {error:writeError}=await db.from('user_communications').insert({tenant_id:tenantId,owner_user_id:recipient.user_id,source:'Discord',external_id:String(message.id),thread_id:String(message.guildId ? (message.channel?.isThread?.() ? message.channelId : message.reference?.messageId || message.id) : message.channelId || ''),subject:message.guildId ? `Mention in #${message.channel?.name || 'channel'}` : 'Bot direct message',body:String(message.content || '').slice(0,30000),sender:String(message.author?.globalName || message.author?.username || 'Discord user'),received_at:new Date(message.createdTimestamp || Date.now()).toISOString()})
        if(writeError && writeError.code!=='23505') throw writeError
        if(!writeError) count++
      }
      return count
    },
  }
}
