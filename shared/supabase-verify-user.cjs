'use strict';

const { createClient } = require('@supabase/supabase-js');

/**
 * Valida o JWT do header Authorization: Bearer <access_token>
 * (usa a anon key só para consultar o usuário — não expõe service role).
 */
async function getUserFromBearer(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const jwt = m[1].trim();
  if (!jwt) return null;
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const supabase = createClient(url, anonKey);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data || !data.user) return null;
  return data.user;
}

module.exports = { getUserFromBearer };
