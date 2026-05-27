/**
 * /api/_docusign-helpers.js
 *
 * Shared helpers for DocuSign integration. Used by:
 *   - api/send-dealer-agreement-docusign.js (envelope creation)
 *   - api/docusign-webhook.js              (signed PDF retrieval)
 *
 * NOT a routable endpoint - the leading underscore tells Vercel to skip it.
 */

const crypto = require('crypto');

// ============================================================
// JWT auth: build assertion -> exchange for access token
// ============================================================
async function getDocuSignAccessToken(opts) {
  const userId = opts.userId;
  const integrationKey = opts.integrationKey;
  const privateKey = opts.privateKey;
  const authHost = opts.authHost; // e.g. 'account-d.docusign.com'

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: integrationKey,
    sub: userId,
    aud: authHost,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation'
  };

  const headerB64 = base64url(JSON.stringify(header));
  const claimB64 = base64url(JSON.stringify(claim));
  const signingInput = headerB64 + '.' + claimB64;

  let signatureB64;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const sig = signer.sign(privateKey);
    signatureB64 = base64url(sig);
  } catch (e) {
    throw new Error('RSA sign failed: ' + (e && e.message));
  }

  const assertion = signingInput + '.' + signatureB64;
  const tokenRes = await fetch('https://' + authHost + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(assertion)
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error('DocuSign token exchange failed: ' + JSON.stringify(tokenJson));
  }
  return tokenJson.access_token;
}

// ============================================================
// Download the signed PDF for a completed envelope.
// Returns a Buffer.
// ============================================================
async function fetchSignedEnvelopePdf(opts) {
  const accessToken = opts.accessToken;
  const baseUri = opts.baseUri;       // e.g. 'https://demo.docusign.net/restapi'
  const accountId = opts.accountId;
  const envelopeId = opts.envelopeId;

  // 'combined' returns a single PDF with all docs + the cert of completion
  const url = baseUri + '/v2.1/accounts/' + encodeURIComponent(accountId)
    + '/envelopes/' + encodeURIComponent(envelopeId) + '/documents/combined';

  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/pdf'
    }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('PDF download failed (' + res.status + '): ' + errText.substring(0, 200));
  }
  return Buffer.from(await res.arrayBuffer());
}

// ============================================================
// Derive auth host from base URI
// ============================================================
function deriveAuthHost(baseUri) {
  return (baseUri && baseUri.indexOf('demo.docusign') >= 0)
    ? 'account-d.docusign.com'
    : 'account.docusign.com';
}

// ============================================================
// base64url helper
// ============================================================
function base64url(input) {
  let b;
  if (Buffer.isBuffer(input)) {
    b = input;
  } else {
    b = Buffer.from(input, 'utf8');
  }
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

module.exports = {
  getDocuSignAccessToken: getDocuSignAccessToken,
  fetchSignedEnvelopePdf: fetchSignedEnvelopePdf,
  deriveAuthHost: deriveAuthHost,
  base64url: base64url
};
