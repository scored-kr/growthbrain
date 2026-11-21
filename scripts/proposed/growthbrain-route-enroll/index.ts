// Supabase Edge Function entry point, enabled only in an operator-approved environment.
import { enrollmentHandler } from './handler.mjs';

Deno.serve(enrollmentHandler({
  origin: Deno.env.get('SUPABASE_URL'),
  publicKey: Deno.env.get('SUPABASE_ANON_KEY'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  tenants: Deno.env.get('GROWTHBRAIN_ROUTE_TENANTS'),
}));
