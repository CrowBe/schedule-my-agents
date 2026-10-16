import { googleConnection, GoogleAuthorization } from './google-connection.ts';
import { readGoogleChange, newerGoogleChange } from './google.ts';
import { AppError, type CalendarProvider, type Environment, type CalendarChange } from './types.ts';
import type { CalendarConnection, Store } from './store.ts';

export type ProviderFactory = (connection: CalendarConnection) => Promise<CalendarProvider & {readonly providerId:string}>;
export type ProviderAuthorization = {readonly configured:boolean;start:(owner:string)=>Promise<Response>;complete:(owner:string,request:Request)=>Promise<Response>};
export type AuthorizationContext = {env:Environment;store:Store;http:typeof fetch;now:()=>number;origin:()=>string};
export type ProviderAdapter = {connect:ProviderFactory;readChange:(request:Request)=>CalendarChange|Promise<CalendarChange>;isNewer:(cursor:string,previous:string|null)=>boolean;ingressVerified:boolean;authorization?:(context:AuthorizationContext)=>ProviderAuthorization};
export type ProviderAdapters = Readonly<Record<string, ProviderAdapter>>;
export function registeredAdapter(env:Environment,store:Store,http:typeof fetch,id:string,adapters:ProviderAdapters = {}):ProviderAdapter|undefined {
 if(Object.hasOwn(adapters,id)) return adapters[id];
 return id==='google' ? {connect:googleConnection(env,http,store),readChange:readGoogleChange,isNewer:newerGoogleChange,ingressVerified:env.GOOGLE_WEBHOOK_VERIFIED==='true',authorization:context=>new GoogleAuthorization(context.env,context.store,context.http,context.now,context.origin)} : undefined;
}

/** Resolve one owner's saved connection; callers receive only the calendar interface. */
export async function resolveConnectedProvider(env:Environment,store:Store,owner:string,http:typeof fetch,adapters:ProviderAdapters = {}) {
 const connection = await store.connection(owner);
 if (!connection) throw new AppError(409,'Connect a calendar provider first.');
 const factory = registeredAdapter(env,store,http,connection.providerId,adapters)?.connect;
 if (!factory) throw new AppError(503,'The connected calendar provider is unavailable.');
 const provider = await factory(connection);
 if (provider.providerId !== connection.providerId) throw new AppError(503,'Calendar provider identity does not match its connection.');
 const current = await store.connection(owner);
 if (!current || current.id !== connection.id || current.providerId !== connection.providerId) throw new AppError(403,'Calendar connection changed during authorization.');
 return provider;
}
