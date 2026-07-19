#!/usr/bin/env node
/**
 * Grok External Auth Provider (аналог Claude apiKeyHelper).
 *
 * Grok вызывает: sh -c "<auth_provider_command>"
 *   stdout → только токен (bare или JSON)
 *   stderr → статус для человека
 *   GROK_AUTH_EXPIRED=1 → silent refresh path
 *
 * Источник аккаунта:
 *   ~/.grok/dashboard-active-session.json  → { name, mode, email, ... }
 *   ~/.grok-<name>/auth.json               → OIDC entry с key + refresh_token
 *
 * При истечении токена автоматически делает OIDC refresh через auth.x.ai,
 * обновляет auth.json на диске и отдаёт свежий access_token.
 *
 * Env override: GROK_DASHBOARD_ACTIVE=<name>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const GROK_HOME = process.env.GROK_HOME || path.join(HOME, '.grok');
const PTR_PATH = path.join(GROK_HOME, 'dashboard-active-session.json');
const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const REFRESH_MARGIN_SEC = 300; // обновляем за 5 минут до истечения

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

function fail(msg, code = 1) {
  log('[grok-auth-helper]', msg);
  process.exit(code);
}

function sanitize(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

function readPtr() {
  const envName = process.env.GROK_DASHBOARD_ACTIVE;
  if (envName && sanitize(envName)) {
    return { name: sanitize(envName), mode: 'helper', source: 'env' };
  }
  try {
    const raw = fs.readFileSync(PTR_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (j && j.name) return { ...j, name: sanitize(j.name), source: 'ptr' };
  } catch {}
  return null;
}

function readProfileAuth(name) {
  const authPath = path.join(HOME, `.grok-${name}`, 'auth.json');
  if (!fs.existsSync(authPath)) {
    fail(`нет auth.json: ${authPath} — сначала device-auth для «${name}»`);
  }
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch (e) {
    fail(`битый auth.json (${authPath}): ${e.message}`);
  }
  const keys = Object.keys(auth || {});
  if (!keys.length) fail(`пустой auth.json: ${authPath}`);
  const entryKey = keys[0];
  const entry = auth[entryKey] || {};
  const access = entry.key || entry.access_token || entry.token;
  if (!access || typeof access !== 'string') {
    fail(`нет access token (key) в ${authPath}`);
  }
  return { authPath, auth, entryKey, entry, access };
}

function secondsUntilExpiry(entry) {
  if (!entry?.expires_at) return 3600;
  const t = Date.parse(entry.expires_at);
  if (!Number.isFinite(t)) return 3600;
  return Math.floor((t - Date.now()) / 1000);
}

function needsRefresh(entry) {
  return secondsUntilExpiry(entry) <= REFRESH_MARGIN_SEC;
}

async function oidcRefresh(refreshToken, clientId) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OIDC refresh failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  return resp.json();
}

function updateAuthFile(authPath, auth, entryKey, newKey, newExpiresAt, newRefreshToken) {
  auth[entryKey].key = newKey;
  auth[entryKey].expires_at = newExpiresAt;
  if (newRefreshToken) auth[entryKey].refresh_token = newRefreshToken;
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf8');
}

async function main() {
  const expired = process.env.GROK_AUTH_EXPIRED === '1';
  if (expired) log('[grok-auth-helper] refresh (GROK_AUTH_EXPIRED=1)');

  const ptr = readPtr();
  if (!ptr?.name) {
    fail(
      `нет активного профиля. Activate (Helper) в дашборде или:\n` +
      `  echo {"name":"malGtok1"} > ${PTR_PATH}`
    );
  }

  const { authPath, auth, entryKey, entry, access } = readProfileAuth(ptr.name);
  const email = entry.email || ptr.email || '?';
  log(`[grok-auth-helper] ${expired ? 'refresh' : 'login'} → ${ptr.name} · ${email}`);
  log(`[grok-auth-helper] source ${authPath}`);

  let finalAccess = access;
  let expiresIn = secondsUntilExpiry(entry);
  let refreshToken = entry.refresh_token;

  // OIDC refresh если токен протух / вот-вот протухнет
  if (needsRefresh(entry) && entry.refresh_token && entry.oidc_client_id) {
    log('[grok-auth-helper] OIDC refresh → token_endpoint');
    try {
      const tokens = await oidcRefresh(entry.refresh_token, entry.oidc_client_id);
      const newAccess = tokens.access_token;
      const newRT = tokens.refresh_token || entry.refresh_token;
      const newExpiresIn = tokens.expires_in || 3600;
      const newExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();

      if (newAccess) {
        updateAuthFile(authPath, auth, entryKey, newAccess, newExpiresAt, newRT);
        finalAccess = newAccess;
        expiresIn = newExpiresIn;
        refreshToken = newRT;
        log(`[grok-auth-helper] OIDC refresh OK → expires_in=${newExpiresIn}s`);
      }
    } catch (e) {
      log(`[grok-auth-helper] OIDC refresh failed: ${e.message} — falling back to cached key`);
    }
  }

  const payload = {
    access_token: finalAccess,
    expires_in: Math.max(60, expiresIn),
  };
  if (refreshToken) payload.refresh_token = refreshToken;

  process.stdout.write(JSON.stringify(payload));
}

try {
  main();
} catch (e) {
  fail(e.message || String(e));
}
