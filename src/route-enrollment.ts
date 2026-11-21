import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readPrivateJSON, writePrivateJSON } from './secure-files.js';
import { accountOrigin } from './desktop-account.js';

export type RouteAccount = { accessToken(): Promise<string>; publishableKey: string };
const device = z.object({id:z.uuid()}).strict();
const grant = z.object({authKey:z.string().regex(/^tskey-auth-[a-zA-Z0-9_-]{12,256}$/)}).strict();

export async function routeDeviceId(directory:string):Promise<string> {
  const file=join(directory,'device.json');
  try {await lstat(file);}
  catch(error) {
    if(!(error instanceof Error && 'code' in error && error.code==='ENOENT')) throw error;
    // Concurrent requests may race to install one ID. Never replace an existing ID.
    try {await writePrivateJSON(file,{id:randomUUID()},true);}
    catch(writeError) {if(!(writeError instanceof Error && 'code' in writeError && writeError.code==='EEXIST'))throw writeError;}
  }
  return device.parse(await readPrivateJSON(file,512)).id;
}

export async function enrollRouteDevice(account:RouteAccount,deviceId:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<string> {
  let token:string;
  try {token=await account.accessToken();} catch {throw Error('ROUTE_AUTH_REQUIRED');}
  let response:Response;
  try {
    response=await fetcher(accountOrigin+'/functions/v1/growthbrain-route-enroll',{
      method:'POST', redirect:'error', cache:'no-store', signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),
      headers:{Authorization:'Bearer '+token, apikey:account.publishableKey, 'Content-Type':'application/json'},
      body:JSON.stringify({deviceId:z.uuid().parse(deviceId),requestId:randomUUID()}),
    });
  }catch {throw Error(signal.aborted?'ROUTE_CANCELLED':'ROUTE_ENROLLMENT_UNAVAILABLE');}
  if(response.status===401)throw Error('ROUTE_AUTH_REQUIRED');
  if(response.status===429)throw Error('ROUTE_ENROLLMENT_LIMIT');
  if(!response.ok)throw Error('ROUTE_ENROLLMENT_UNAVAILABLE');
  const value=grant.safeParse(await response.json().catch(()=>null));
  if(!value.success)throw Error('ROUTE_ENROLLMENT_UNAVAILABLE');
  return value.data.authKey;
}
