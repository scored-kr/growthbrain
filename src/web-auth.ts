import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { identifier } from './model.js';

const digest=(s:string)=>createHash('sha256').update(s).digest('base64url');
const secret=()=>randomBytes(32).toString('base64url');
const scope='memory:read';
const equals=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
type Client=OAuthClientInformationFull;
type Grant={id:string;clientId:string;projectId:string|null;expires:number};
type Pending={id:string;clientId:string;params:AuthorizationParams;cookieHash:string;expires:number;grantId?:string;denied?:boolean};
type Code={clientId:string;params:AuthorizationParams;grantId:string;expires:number};
type Token={clientId:string;grantId:string;expires:number;used?:boolean};

/** Device-local OAuth provider. Approval is a local terminal operation, never an HTTP/MCP tool. */
export class DeviceAuthorization implements OAuthServerProvider {
  // SDK forwards the verifier to this provider; exchangeAuthorizationCode verifies S256 itself.
  readonly skipLocalPkceValidation=true;
  private clients=new Map<string,Client>();
  private pending=new Map<string,Pending>();
  private codes=new Map<string,Code>();
  private grants=new Map<string,Grant>();
  private access=new Map<string,Token>();
  private refresh=new Map<string,Token>();
  private stopped=false;
  readonly clientsStore:OAuthRegisteredClientsStore;
  constructor(readonly resource:URL, private requireOpen:()=>void, private requireProject:(id:string)=>void, private now=()=>Date.now()) {
    if(resource.protocol!=='https:'||resource.username||resource.password||resource.search||resource.hash||resource.pathname!=='/mcp')throw Error('HTTPS_ORIGIN_REQUIRED');
    this.clientsStore={
      getClient:(id)=>{this.sweep();return this.clients.get(id)},
      registerClient:(client)=>{
        this.check();this.sweep();
        if(this.clients.size>=128)throw new TooManyRequestsError('Too many registered clients');
        if(!client.redirect_uris.length||client.redirect_uris.length>5||client.redirect_uris.some(uri=>{
          try{const u=new URL(uri);return u.protocol!=='https:'||!!u.username||!!u.password||!!u.hash||uri.length>2048}catch{return true}
        })||!['none','client_secret_post','client_secret_basic'].includes(client.token_endpoint_auth_method??'client_secret_basic')||
          (client.client_name!==undefined&&!/^[^\x00-\x1f\x7f]{1,160}$/u.test(client.client_name)))throw new InvalidClientMetadataError('Use HTTPS callbacks and a plain client name');
        const value={...client,client_id:randomUUID(),client_id_issued_at:Math.floor(this.now()/1000)};
        this.clients.set(value.client_id,value);return value;
      },
    };
  }
  private check(){if(this.stopped)throw new InvalidTokenError('Connection closed');try{this.requireOpen()}catch{throw new InvalidTokenError('VAULT_LOCKED')}}
  private sweep(){
    const now=this.now();
    for(const map of [this.pending,this.codes,this.access,this.refresh])for(const [id,item] of map)if(item.expires<=now)map.delete(id);
    for(const [id,item] of this.grants)if(item.expires<=now)this.revoke(id);
    for(const [id,client] of this.clients)if((client.client_id_issued_at??0)*1000+86400000<=now)this.clients.delete(id);
  }
  private validateResource(resource?:URL){if(resource?.href!==this.resource.href)throw new InvalidRequestError('Exact resource is required')}
  private validateScopes(scopes?:string[]){if(scopes?.some(s=>s!==scope))throw new InvalidScopeError('Only memory:read is supported')}
  async authorize(client:Client,params:AuthorizationParams,res:Response){
    this.check();this.sweep();this.validateResource(params.resource);this.validateScopes(params.scopes);
    if(!client.redirect_uris.includes(params.redirectUri)||!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)||(params.state?.length??0)>512)throw new InvalidRequestError('Invalid authorization request');
    if(this.pending.size>=32)throw new TooManyRequestsError('Too many pending connections');
    const id=randomUUID(),cookie=secret();
    this.pending.set(id,{id,clientId:client.client_id,params,cookieHash:digest(cookie),expires:this.now()+300000});
    res.cookie('__Host-gb-consent',cookie,{secure:true,httpOnly:true,sameSite:'lax',path:'/',maxAge:300000});
    res.redirect(303,`/consent?request=${id}`);
  }
  requests(){this.check();this.sweep();return [...this.pending.values()].filter(p=>!p.grantId&&!p.denied).map(p=>({id:p.id,clientName:this.clients.get(p.clientId)?.client_name??'Unnamed client',redirectUri:p.params.redirectUri,expiresAt:new Date(p.expires).toISOString()}))}
  approve(id:string,projectId:string|null){
    this.check();this.sweep();const p=this.pending.get(id);
    if(!p||p.grantId||p.denied)throw Error('CONNECTION_REQUEST_NOT_FOUND');
    if(projectId!==null){identifier.parse(projectId);this.requireProject(projectId)}
    if(this.grants.size>=64)throw Error('CONNECTION_LIMIT');
    const grant:Grant={id:randomUUID(),clientId:p.clientId,projectId,expires:this.now()+86400000};
    this.grants.set(grant.id,grant);p.grantId=grant.id;return {id:grant.id,projectId,expiresAt:new Date(grant.expires).toISOString()};
  }
  deny(id:string){this.check();const p=this.pending.get(id);if(!p||p.grantId)throw Error('CONNECTION_REQUEST_NOT_FOUND');p.denied=true}
  connections(){this.check();this.sweep();return [...this.grants.values()].map(g=>({id:g.id,projectId:g.projectId,clientName:this.clients.get(g.clientId)?.client_name??'Unnamed client',expiresAt:new Date(g.expires).toISOString()}))}
  consent(id:string,cookie:string){
    this.check();this.sweep();const p=this.pending.get(id);
    if(!p||!equals(p.cookieHash,digest(cookie)))throw new InvalidRequestError('Connection request expired or browser changed');
    if(!p.grantId&&!p.denied)return {waiting:true as const,id:p.id};
    const url=new URL(p.params.redirectUri);
    if(p.params.state!==undefined)url.searchParams.set('state',p.params.state);
    if(p.denied)url.searchParams.set('error','access_denied');
    else{
      if(!this.grants.has(p.grantId!))throw new InvalidGrantError('Connection revoked');
      const code=secret();this.codes.set(digest(code),{clientId:p.clientId,params:p.params,grantId:p.grantId!,expires:this.now()+60000});url.searchParams.set('code',code);
    }
    this.pending.delete(id);return {waiting:false as const,url:url.href};
  }
  private code(client:Client,code:string){
    this.check();this.sweep();const value=this.codes.get(digest(code));
    if(!value||value.clientId!==client.client_id||!this.grants.has(value.grantId))throw new InvalidGrantError('Invalid authorization code');return value;
  }
  async challengeForAuthorizationCode(client:Client,code:string){return this.code(client,code).params.codeChallenge}
  async exchangeAuthorizationCode(client:Client,code:string,verifier?:string,redirectUri?:string,resource?:URL):Promise<OAuthTokens>{
    const value=this.code(client,code);this.validateResource(resource);
    // Also validate here so direct provider callers cannot bypass the SDK's PKCE check.
    if(!verifier||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||!equals(digest(verifier),value.params.codeChallenge)||redirectUri!==value.params.redirectUri)throw new InvalidGrantError('Code binding failed');
    this.codes.delete(digest(code));return this.issue(value.grantId);
  }
  private issue(grantId:string):OAuthTokens{
    this.sweep();const grant=this.grants.get(grantId);
    if(!grant)throw new InvalidGrantError('Connection expired');
    if(this.access.size>=256||this.refresh.size>=2048)throw new TooManyRequestsError('Reconnect after token expiry');
    const access=secret(),refresh=secret(),expires=Math.min(grant.expires,this.now()+900000);
    this.access.set(digest(access),{clientId:grant.clientId,grantId,expires});
    this.refresh.set(digest(refresh),{clientId:grant.clientId,grantId,expires:grant.expires});
    return {access_token:access,token_type:'Bearer',expires_in:Math.floor((expires-this.now())/1000),refresh_token:refresh,scope};
  }
  async exchangeRefreshToken(client:Client,token:string,scopes?:string[],resource?:URL){
    this.check();this.sweep();this.validateResource(resource);this.validateScopes(scopes);
    const value=this.refresh.get(digest(token));
    if(!value||value.clientId!==client.client_id)throw new InvalidGrantError('Invalid refresh token');
    if(value.used){this.revoke(value.grantId);throw new InvalidGrantError('Refresh replay revoked connection')}
    value.used=true;return this.issue(value.grantId);
  }
  async verifyAccessToken(token:string){
    this.check();this.sweep();const value=this.access.get(digest(token)),grant=value&&this.grants.get(value.grantId);
    if(!value||!grant)throw new InvalidTokenError('Expired or revoked token');
    return {token,clientId:value.clientId,scopes:[scope],expiresAt:Math.floor(value.expires/1000),resource:this.resource,extra:{grantId:grant.id,projectId:grant.projectId}};
  }
  async revokeToken(client:Client,request:OAuthTokenRevocationRequest){
    const value=this.access.get(digest(request.token))??this.refresh.get(digest(request.token));
    if(value?.clientId===client.client_id)this.revoke(value.grantId);
  }
  revoke(id:string){
    this.grants.delete(id);
    for(const map of [this.codes,this.access,this.refresh])for(const [key,value] of map)if(value.grantId===id)map.delete(key);
    for(const [key,value] of this.pending)if(value.grantId===id)this.pending.delete(key);
  }
  close(){this.stopped=true;this.clients.clear();this.pending.clear();this.codes.clear();this.grants.clear();this.access.clear();this.refresh.clear()}
}
