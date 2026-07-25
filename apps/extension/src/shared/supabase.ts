import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be configured.");
}

const extensionAuthStorage = {
  async getItem(key: string) {
    const stored = await chrome.storage.local.get(key);
    if (typeof stored[key] === "string") return stored[key] as string;

    // Migrate an existing side-panel session from the previous localStorage
    // implementation without forcing the user to sign in again.
    try {
      const legacyValue = globalThis.localStorage?.getItem(key);
      if (legacyValue) {
        await chrome.storage.local.set({ [key]: legacyValue });
        globalThis.localStorage.removeItem(key);
        return legacyValue;
      }
    } catch {
      // localStorage may be unavailable in some extension contexts.
    }
    return null;
  },
  async setItem(key: string, value: string) {
    await chrome.storage.local.set({ [key]: value });
    try { globalThis.localStorage?.removeItem(key); } catch { /* Ignore unavailable legacy storage. */ }
  },
  async removeItem(key: string) {
    await chrome.storage.local.remove(key);
    try { globalThis.localStorage?.removeItem(key); } catch { /* Ignore unavailable legacy storage. */ }
  },
};

// A publishable/anon key is intentionally safe here: database and Realtime RLS
// remain the authorization boundary. Never put a service-role/secret key in an extension.
export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    storage: extensionAuthStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
