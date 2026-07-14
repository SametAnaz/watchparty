import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be configured.");
}

// A publishable/anon key is intentionally safe here: database and Realtime RLS
// remain the authorization boundary. Never put a service-role/secret key in an extension.
export const supabase = createClient(supabaseUrl, supabasePublishableKey);
