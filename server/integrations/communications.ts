import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import { encryptSecret, decryptSecret, encryptionKey, IntegrationError } from './tenant-integrations'

type Middleware = (req: Request, res: Response, next: NextFunction) => any
const CALLBACK = '/api/communications/gmail/callback'
const COOKIE = 'ba_gmail_oauth'
const oauthStates = new Map<string, { token: string; userId: string; tenantId: string; verifier: string; cookie: string; revision: string; expires: number }>()
const gmailKind = 'gmail-refresh' as const
type GmailCredentials = { clientId: string; clientSecret: string; redirectUri: string }
const google = async (url: string, init: RequestInit) => {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) })
  const data: any = await response.json()
  if (!response.ok) throw new IntegrationError(data.error_description || data.error?.message || 'Gmail request failed.', 502)
  return data
}
function origin(req: Request) {
  const url = new URL(process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new IntegrationError('Use an HTTPS application URL for Gmail.',503)
  return url.origin
}
function validateCredentials(input: any, appOrigin: string): GmailCredentials {
  let source = input || {}
  if (input?.oauthJson) {
    if (JSON.stringify(input.oauthJson).length > 32768) throw new IntegrationError('Choose an OAuth JSON file under 32 KB.')
    try { source = (typeof input.oauthJson === 'string' ? JSON.parse(input.oauthJson) : input.oauthJson).web } catch { throw new IntegrationError('Choose a Google OAuth Web application JSON file.') }
    if (!source) throw new IntegrationError('Use a Web application OAuth client.')
  }
  const clientId = String(source.client_id ?? source.clientId ?? '').trim()
  const clientSecret = String(source.client_secret ?? source.clientSecret ?? '').trim()
  const redirectUri = `${appOrigin}${CALLBACK}`
  if (!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 256) throw new IntegrationError('Enter a valid Google OAuth Client ID.')
  if (clientSecret.length < 10 || clientSecret.length > 4096 || /\s/.test(clientSecret)) throw new IntegrationError('Enter the Google OAuth Client Secret.')
  return { clientId, clientSecret, redirectUri }
}
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
  db: any; requireAuth: Middleware; requireTenant: Middleware; requirePlatformAdmin: Middleware;
  sessionFromRequest: (req: Request) => { token: string; user: any };
  sessionByToken: (token: string) => any;
  organizationById: (id: string) => Promise<any>;
  load: (id: string) => Promise<any>; commit: (id: string, next: any, user: any, source: string, current: any) => Promise<any>;
  openStatus: (state: any) => string;
}) {
  const { db } = deps
  const auth = [deps.requireAuth, deps.requireTenant]
  const current = (req: Request) => (req as any).authUser
  const guard: Middleware = async (req, res, next) => {
    try { await liveUser(current(req)); res.setHeader('Cache-Control','no-store'); next() }
    catch(e) { res.status(e instanceof IntegrationError ? e.status : 503).json({error:e instanceof Error ? e.message : 'Communications unavailable.'}) }
  }
  const wrap = (fn: (req: Request, res: Response) => Promise<any>): Middleware => async (req,res) => {
    try { if (!db) throw new IntegrationError('Cloud storage is required for private communications.',503); await fn(req,res) }
    catch (error) { res.status(error instanceof IntegrationError ? error.status : 503).json({ error: error instanceof IntegrationError ? error.message : 'Communications are unavailable. Apply schema-v12-communications.sql and retry.' }) }
  }
  const account = async (tenantId: string) => {
    const { data, error } = await db.from('gmail_accounts').select('*').eq('tenant_id',tenantId).maybeSingle()
    if (error) throw new IntegrationError('Apply schema-v13-gmail-accounts.sql before configuring Gmail.',503)
    return data
  }
  const saveAccount = async (tenantId: string, patch: any) => {
    const previous = await account(tenantId)
    const record = { ...patch,updated_at:new Date().toISOString() }
    const { error } = previous ? await db.from('gmail_accounts').update(record).eq('tenant_id',tenantId) : await db.from('gmail_accounts').insert({tenant_id:tenantId,...record})
    if (error) throw new IntegrationError('Could not save account Gmail settings.',503)
  }
  const activeAccount = async (tenantId: string) => {
    const row = await account(tenantId)
    if (!row?.platform_enabled) throw new IntegrationError('Internal Admin has not enabled Gmail for this account.',403)
    if (!row.account_enabled || !row.encrypted_config) throw new IntegrationError('Ask your account administrator to configure Gmail in Settings.',409)
    const credentials = JSON.parse(decryptSecret(row.encrypted_config,tenantId,'gmail-oauth')) as GmailCredentials
    return {row,credentials}
  }
  const liveUser = async (user: any, settingsAccess = false) => {
    const org = await deps.organizationById(user.organizationId)
    if (!org || org.status !== 'Active' || !org.enabledModules.includes('inbox')) throw new IntegrationError('Communications is disabled for this account.',403)
    const {data,error}=await db.from('app_users').select('id,role,status,modules').eq('organization_id',user.organizationId).eq('id',user.id).is('deleted_at',null).maybeSingle()
    if (error || !data || data.status !== 'Active') throw new IntegrationError('This user is unavailable.',403)
    if (settingsAccess ? data.role !== 'Administrator' || !org.enabledModules.includes('settings') : data.role !== 'Administrator' && !data.modules?.includes('inbox')) throw new IntegrationError(settingsAccess ? 'Account Administrator with Settings access is required.' : 'Communications access is required.',403)
    return user.organizationId as string
  }
  const gmailGate: Middleware = async (req,res,next) => { try { await liveUser(current(req)); next() } catch(e) { res.status(e instanceof IntegrationError ? e.status : 503).json({error:e instanceof Error ? e.message : 'Gmail access unavailable.'}) } }
  const accountGate: Middleware = async (req,res,next) => { try { await liveUser(current(req),true); next() } catch(e) { res.status(e instanceof IntegrationError ? e.status : 503).json({error:e instanceof Error ? e.message : 'Gmail settings unavailable.'}) } }
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
  app.get('/api/internal-admin/organizations/:organizationId/gmail', deps.requireAuth, deps.requirePlatformAdmin, wrap(async (req,res) => {
    const id=String(req.params.organizationId)
    if (!await deps.organizationById(id)) throw new IntegrationError('Account not found.',404)
    const row=await account(id)
    res.json({enabled:Boolean(row?.platform_enabled),configured:Boolean(row?.encrypted_config)})
  }))
  app.put('/api/internal-admin/organizations/:organizationId/gmail', deps.requireAuth, deps.requirePlatformAdmin, wrap(async (req,res) => {
    const id=String(req.params.organizationId)
    if (!await deps.organizationById(id)) throw new IntegrationError('Account not found.',404)
    if (typeof req.body?.enabled !== 'boolean') throw new IntegrationError('Specify whether Gmail is enabled.')
    await saveAccount(id,{platform_enabled:req.body.enabled})
    res.json({ok:true})
  }))
  app.get('/api/account/gmail', ...auth, accountGate, wrap(async (req,res) => {
    const user=current(req),row=await account(user.organizationId)
    let encryptionReady=true;try{encryptionKey()}catch{encryptionReady=false}
    const credentials=row?.encrypted_config && encryptionReady ? JSON.parse(decryptSecret(row.encrypted_config,user.organizationId,'gmail-oauth')) as GmailCredentials : null
    res.json({platformEnabled:Boolean(row?.platform_enabled),configured:Boolean(row?.encrypted_config),enabled:Boolean(row?.account_enabled),encryptionReady,
      clientId:credentials?.clientId || '',redirectUri:credentials?.redirectUri || '',expectedRedirectUri:`${origin(req)}${CALLBACK}`})
  }))
  app.put('/api/account/gmail', ...auth, accountGate, wrap(async (req,res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new IntegrationError('Specify whether Gmail is enabled for this account.')
    const user=current(req),previous=await account(user.organizationId)
    if (!previous?.platform_enabled) throw new IntegrationError('Internal Admin must enable Gmail for this account first.',403)
    const replacing=Boolean(req.body?.oauthJson || req.body?.clientId || req.body?.clientSecret)
    if (!replacing && !previous.encrypted_config) throw new IntegrationError('Upload a Google Web OAuth JSON file or enter both credentials.')
    const patch:any={account_enabled:req.body.enabled}
    if (replacing) {
      const credentials=validateCredentials(req.body,origin(req))
      patch.encrypted_config=encryptSecret(JSON.stringify(credentials),user.organizationId,'gmail-oauth')
      patch.revision=randomUUID()
    }
    await saveAccount(user.organizationId,patch)
    res.json({ok:true,reconnectRequired:replacing})
  }))
  app.delete('/api/account/gmail', ...auth, accountGate, wrap(async (req,res) => {
    const user=current(req)
    await saveAccount(user.organizationId,{encrypted_config:null,account_enabled:false,revision:randomUUID()})
    res.json({ok:true})
  }))
  app.get('/api/communications', ...auth, guard, wrap(async (req,res) => {
    const user = current(req)
    // Keep the old response for older clients while the new Hub uses bounded pages.
    const paginated = req.query.page !== undefined || req.query.pageSize !== undefined
    const page = Number(req.query.page ?? 1), pageSize = Number(req.query.pageSize ?? 10)
    const tab = String(req.query.tab ?? 'All'), label = String(req.query.label ?? '')
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || ![5,10,15].includes(pageSize) || !['All','Gmail','Discord','Manual','Archived'].includes(tab) || label.length > 128) throw new IntegrationError('Choose a valid communication view and page.')
    const filtered = (head=false) => {
      let query = db.from('user_communications').select('*', paginated ? {count:'exact',head} : {}).eq('tenant_id',user.organizationId).eq('owner_user_id',user.id)
      if (paginated) {
        query = tab === 'Archived' ? query.eq('status','Archived') : query.neq('status','Archived')
        if (['Gmail','Discord','Manual'].includes(tab)) query = query.eq('source',tab)
        if (tab === 'Gmail' && label) query = query.eq('source_label',label)
      }
      return query
    }
    const query = filtered().order('received_at',{ascending:false}).order('id',{ascending:false})
    const { data, count, error } = await (paginated ? query.range((page-1)*pageSize,page*pageSize-1) : query.limit(200))
    // PostgREST can return 416 when the last item on a page was archived.
    if (paginated && error?.code === 'PGRST103') {
      const latest = await filtered(true)
      if (latest.error) throw latest.error
      res.json({items:[],total:latest.count || 0,page,pageSize}); return
    }
    if (error) throw error
    res.json({ items:data || [], ...(paginated ? {total:count || 0,page,pageSize} : {}) })
  }))
  app.get('/api/communications/:id/thread', ...auth, guard, wrap(async (req,res) => {
    const selected = await own(req,String(req.params.id)), user = current(req)
    const page = Number(req.query.page ?? 1), pageSize = 50
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new IntegrationError('Choose a valid thread page.')
    if (!selected.thread_id) { res.json({items:[selected],total:1}); return }
    const {data,count,error} = await db.from('user_communications').select('*',{count:'exact'})
      .eq('tenant_id',user.organizationId).eq('owner_user_id',user.id).eq('source',selected.source).eq('thread_id',selected.thread_id)
      .order('received_at',{ascending:true}).order('id',{ascending:true}).range((page-1)*pageSize,page*pageSize-1)
    if (error) throw error
    res.json({items:data || [],total:count || 0})
  }))
  app.get('/api/communications/settings', ...auth, guard, wrap(async (req,res) => {
    const user=current(req),row = await settings(user.organizationId,user.id),config=await account(user.organizationId)
    const enabled=Boolean(config?.platform_enabled && config?.account_enabled && config?.encrypted_config)
    const connected=Boolean(row?.gmail_refresh_token && row.gmail_config_revision===config?.revision)
    res.json({ discordUserId:row?.discord_user_id || '', captureMentions:row?.discord_capture_mentions ?? true,
      gmailEmail:connected ? row.gmail_email || '' : '', gmailLabels:row?.gmail_labels || [], gmailConnected:connected,
      gmailReconnectRequired:Boolean(row?.gmail_refresh_token && !connected),gmailAvailable:enabled,
      gmailPlatformEnabled:Boolean(config?.platform_enabled), callbackUrl:`${origin(req)}${CALLBACK}` })
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
      gmail_config_revision:previous?.gmail_config_revision || null,
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
  app.get('/api/communications/gmail/connect', ...auth, guard, gmailGate, wrap(async (req,res) => {
    const user=current(req),session=deps.sessionFromRequest(req),config=await activeAccount(user.organizationId)
    if (!session.token || config.credentials.redirectUri!==`${origin(req)}${CALLBACK}`) throw new IntegrationError('Gmail callback or session changed. Ask your account administrator to update the OAuth client.',409)
    const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('hex'),cookie=randomBytes(32).toString('hex')
    for(const [key,value] of oauthStates) if(value.userId===user.id && value.tenantId===user.organizationId) oauthStates.delete(key)
    if(oauthStates.size>1000) throw new IntegrationError('Too many pending Gmail connections. Try again shortly.',429)
    oauthStates.set(state,{token:session.token,userId:user.id,tenantId:user.organizationId,verifier,cookie,revision:config.row.revision,expires:Date.now()+600000})
    res.cookie(COOKIE,cookie,{httpOnly:true,secure:origin(req).startsWith('https:'),sameSite:'lax',path:CALLBACK,maxAge:600000})
    const query=new URLSearchParams({client_id:config.credentials.clientId,redirect_uri:config.credentials.redirectUri,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',access_type:'offline',prompt:'consent select_account',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'})
    res.json({url:`https://accounts.google.com/o/oauth2/v2/auth?${query}`})
  }))
  app.get(CALLBACK, async (req,res) => {
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer')
    let result='error'
    try {
      const state=typeof req.query.state==='string' ? req.query.state : '',saved=oauthStates.get(state)
      const cookie=(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1) || ''
      if(!saved || saved.expires<Date.now() || !/^[a-f0-9]{64}$/.test(cookie) || !timingSafeEqual(Buffer.from(cookie),Buffer.from(saved.cookie))) throw new Error('Invalid state')
      oauthStates.delete(state)
      const user=deps.sessionByToken(saved.token)
      if(!user || user.id!==saved.userId || user.organizationId!==saved.tenantId) throw new Error('Session expired')
      await liveUser(user)
      const config=await activeAccount(saved.tenantId)
      if(config.row.revision!==saved.revision || config.credentials.redirectUri!==`${origin(req)}${CALLBACK}`) throw new Error('Account OAuth settings changed')
      if(req.query.error) {result='denied';throw new Error('Denied')}
      if(typeof req.query.code!=='string' || req.query.code.length>4096) throw new Error('Missing code')
      const grant=await google('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:req.query.code,client_id:config.credentials.clientId,client_secret:config.credentials.clientSecret,redirect_uri:config.credentials.redirectUri,code_verifier:saved.verifier,grant_type:'authorization_code'})})
      if(!grant.access_token || !grant.refresh_token || !String(grant.scope || '').split(' ').includes('https://www.googleapis.com/auth/gmail.readonly')) throw new Error('Gmail did not grant offline read access')
      const identity=await google('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${grant.access_token}`}})
      if(!identity.email || identity.email_verified!==true) throw new Error('Google identity is unverified')
      const stillSignedIn=deps.sessionByToken(saved.token)
      if(!stillSignedIn || stillSignedIn.id!==saved.userId || stillSignedIn.organizationId!==saved.tenantId) throw new Error('Session expired')
      await liveUser(stillSignedIn)
      if((await activeAccount(saved.tenantId)).row.revision!==saved.revision) throw new Error('Account OAuth settings changed')
      const previous=await settings(saved.tenantId,saved.userId)
      const {error}=await db.from('user_communication_settings').upsert({tenant_id:saved.tenantId,user_id:saved.userId,
        discord_user_id:previous?.discord_user_id || null,discord_capture_mentions:previous?.discord_capture_mentions ?? true,
        gmail_email:String(identity.email),gmail_refresh_token:encryptSecret(grant.refresh_token,`${saved.tenantId}:${saved.userId}`,gmailKind),
        gmail_config_revision:saved.revision,gmail_labels:previous?.gmail_labels || [],updated_at:new Date().toISOString()},{onConflict:'tenant_id,user_id'})
      if(error) throw error
      result='connected'
    } catch { /* Never log authorization codes, tokens, or provider details. */ }
    res.clearCookie(COOKIE,{path:CALLBACK,httpOnly:true,sameSite:'lax'})
    res.redirect(303,`/#gmail=${result}`)
  })
  app.get('/api/communications/gmail/labels', ...auth, guard, gmailGate, wrap(async (req,res) => {
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
  app.post('/api/communications/gmail/sync', ...auth, guard, gmailGate, wrap(async (req,res) => {
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
    const config=await activeAccount(user.organizationId)
    if(!row?.gmail_refresh_token || row.gmail_config_revision!==config.row.revision) throw new IntegrationError('Connect your Gmail account again. The account OAuth configuration changed.',409)
    const refresh=decryptSecret(row.gmail_refresh_token,`${user.organizationId}:${user.id}`,gmailKind)
    const grant=await google('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.credentials.clientId,client_secret:config.credentials.clientSecret,refresh_token:refresh,grant_type:'refresh_token'})})
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
