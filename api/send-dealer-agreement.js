/**
 * /api/send-dealer-agreement.js
 *
 * Emails the pre-filled dealer agreement PDF to the dealer.
 * Triggered by admin clicking "Approve and Send Agreement" in the slide-in panel.
 *
 * Test mode: while TEST_MODE_ENABLED is true, ALL emails route to
 * TEST_EMAIL_RECIPIENT instead of the dealer's real email.
 * To go live with real dealers: set TEST_MODE_ENABLED = false.
 */

const SUPPORT_FROM_EMAIL = 'notifications@whitestone-partners.com';
const SUPPORT_REPLY_EMAIL = 'support@whitestone-partners.com';

// ============================================================
// TEST MODE — REMOVE/FLIP BEFORE SENDING TO REAL DEALERS
// ============================================================
// While TEST_MODE_ENABLED is true, ALL agreement emails route to
// TEST_EMAIL_RECIPIENT. The subject is prefixed with [TEST -> realEmail]
// so it is visually obvious which dealer the test was for.
//
// To go live: change TEST_MODE_ENABLED to false. Real dealer emails
// will then be used.
// ============================================================
const TEST_MODE_ENABLED = false;
const TEST_EMAIL_RECIPIENT = 'neblloydben@gmail.com';

// ============================================================
// DOCUSIGN ROUTING FLAG
// ============================================================
// When DOCUSIGN_ENABLED is true, this endpoint forwards the request
// to /api/send-dealer-agreement-boldsign and returns its response.
// When false, the legacy Resend-PDF flow below runs.
// This lets us swap implementations without changing the frontend.
// ============================================================
const DOCUSIGN_ENABLED = true; // flip to true to route through DocuSign

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ============================================================
  // FEATURE FLAG: proxy to DocuSign endpoint when enabled
  // ============================================================
  if (DOCUSIGN_ENABLED) {
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const targetUrl = protocol + '://' + host + '/api/send-dealer-agreement-boldsign';

      // Forward the body and the auth header verbatim
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      const proxyRes = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers.authorization || req.headers.Authorization || ''
        },
        body: rawBody
      });
      const proxyJson = await proxyRes.json();
      return res.status(proxyRes.status).json(proxyJson);
    } catch (e) {
      console.error('DocuSign proxy failed, falling back to Resend:', e);
      // Fall through to legacy Resend flow on proxy error -- defensive fallback
    }
  }

  // Parse body
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const dealerId = payload && payload.dealerId;
  if (!dealerId) {
    return res.status(400).json({ error: 'dealerId required' });
  }

  // Auth: require Bearer token from caller
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!authHeader || authHeader.indexOf('Bearer ') !== 0) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_KEY) {
    console.error('Missing required env vars');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabaseHeaders = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };

  // 1. Fetch dealer row
  let dealer;
  try {
    const dealerRes = await fetch(
      SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealerId)
        + '&select=*&limit=1',
      { headers: supabaseHeaders }
    );
    const rows = await dealerRes.json();
    if (!dealerRes.ok || !Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }
    dealer = rows[0];
  } catch (e) {
    console.error('Dealer fetch failed:', e);
    return res.status(500).json({ error: 'Failed to fetch dealer' });
  }

  // 2. Generate the PDF by calling the existing endpoint (server-to-server)
  let pdfBase64;
  try {
    // The existing endpoint is /api/generate-dealer-agreement-pdf
    // Call it via absolute URL so it works in serverless context
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const pdfUrl = protocol + '://' + host + '/api/generate-dealer-agreement-pdf';

    const pdfRes = await fetch(pdfUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,  // forward caller's Bearer
      },
      body: JSON.stringify({ dealerId: dealerId }),
    });

    if (!pdfRes.ok) {
      const errBody = await pdfRes.text();
      console.error('PDF generation failed:', pdfRes.status, errBody);
      return res.status(500).json({ error: 'PDF generation failed: ' + errBody.substring(0, 200) });
    }

    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    pdfBase64 = pdfBuf.toString('base64');
  } catch (e) {
    console.error('PDF generation threw:', e);
    return res.status(500).json({ error: 'PDF generation error' });
  }

  // 3. Determine recipient
  const realRecipient = dealer.email;
  if (!realRecipient) {
    return res.status(400).json({ error: 'Dealer has no email on file' });
  }

  const isTestMode = TEST_MODE_ENABLED;
  const recipient = isTestMode ? TEST_EMAIL_RECIPIENT : realRecipient;
  const subjectPrefix = isTestMode ? '[TEST → ' + realRecipient + '] ' : '';
  const subject = subjectPrefix + 'Welcome to Whitestone Partners — Please Sign Your Dealer Agreement';

  // 4. Compose email
  const contactName = [dealer.contact_first_name, dealer.contact_last_name]
    .filter(function(p) { return !!p; }).join(' ') || (dealer.dealership_name || 'Partner');
  const dealershipName = dealer.dealership_name || 'your dealership';
  const safeFileName = dealershipName.replace(/[^a-z0-9]+/gi, '_') + '_Agreement.pdf';

  const html = renderAgreementEmailHtml({
    contactName: contactName,
    dealershipName: dealershipName,
    isTestMode: isTestMode,
    realRecipient: realRecipient,
  });
  const text = renderAgreementEmailText({
    contactName: contactName,
    dealershipName: dealershipName,
    isTestMode: isTestMode,
    realRecipient: realRecipient,
  });

  // 5. Send via Resend (with PDF attachment)
  try {
    const resendBody = {
      from: 'Whitestone Partners <' + SUPPORT_FROM_EMAIL + '>',
      to: [recipient],
      reply_to: SUPPORT_REPLY_EMAIL,
      subject: subject,
      html: html,
      text: text,
      attachments: [
        {
          filename: safeFileName,
          content: pdfBase64,
        },
      ],
    };

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendBody),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend send failed:', resendRes.status, errBody);
      return res.status(500).json({ error: 'Email send failed: ' + errBody.substring(0, 200) });
    }

    // 6. Stamp dealer with agreement_sent_at timestamp
    try {
      await fetch(
        SUPABASE_URL + '/rest/v1/dealers?id=eq.' + encodeURIComponent(dealerId),
        {
          method: 'PATCH',
          headers: supabaseHeaders,
          body: JSON.stringify({ agreement_signed_at: null, /* not yet signed */ }),
        }
      );
      // Note: we leave the actual status flips to the frontend so it can
      // coordinate UI refresh atomically.
    } catch (e) {
      console.warn('Could not stamp dealer agreement timestamp:', e);
    }

    return res.status(200).json({
      ok: true,
      sent_to: recipient,
      real_recipient: realRecipient,
      test_mode: isTestMode,
    });
  } catch (e) {
    console.error('Resend request failed:', e);
    return res.status(500).json({ error: 'Email service error' });
  }
};

function renderAgreementEmailHtml(d) {
  const testBanner = d.isTestMode
    ? '<div style="background:#fdf9ed;border:1px solid #e8d99b;border-radius:6px;padding:14px 18px;margin-bottom:24px;color:#5a4810;font-size:13px;line-height:1.5;">'
      + '<strong>TEST MODE</strong> — In production this email would go to <strong>' + escapeHtml(d.realRecipient) + '</strong>. '
      + 'Test mode is active (TEST_MODE_ENABLED is true in send-dealer-agreement.js).'
      + '</div>'
    : '';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f8f9fb;margin:0;padding:32px 16px;color:#0c1e2e;}'
    + '.wrap{max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e4eaf0;}'
    + '.head{background:#0c1e2e;color:#ffffff;padding:32px 32px;border-bottom:3px solid #b8963e;}'
    + '.head h1{font-family:Cormorant Garamond,Georgia,serif;font-size:24px;font-weight:300;margin:0 0 8px 0;}'
    + '.body{padding:28px 32px;font-size:14.5px;line-height:1.7;}'
    + '.body p{margin:0 0 18px 0;}'
    + '.steps{background:#f8f9fb;border-left:3px solid #b8963e;padding:18px 22px;margin:24px 0;}'
    + '.steps ol{margin:0;padding-left:18px;}'
    + '.steps li{margin-bottom:8px;}'
    + '.foot{padding:18px 32px;background:#f8f9fb;font-size:11px;color:#6b8599;text-align:center;border-top:1px solid #e4eaf0;}'
    + '</style></head><body><div class="wrap">'
    + testBanner
    + '<div class="head"><h1>Welcome to Whitestone Partners</h1></div>'
    + '<div class="body">'
    + '<p>Hi ' + escapeHtml(d.contactName) + ',</p>'
    + '<p>Thank you for choosing to partner with Whitestone Partners. We\'re excited to have <strong>' + escapeHtml(d.dealershipName) + '</strong> join our network of premier marine service dealers.</p>'
    + '<p>Attached to this email is your Dealer Participation Agreement, pre-filled with the information you provided. Please review it carefully and sign where indicated.</p>'
    + '<div class="steps"><strong>Next steps:</strong><ol>'
    + '<li>Review the attached PDF agreement</li>'
    + '<li>Sign and date all required fields (Adobe Fill &amp; Sign or print/scan both work)</li>'
    + '<li>Email the signed copy back to <a href="mailto:' + escapeHtml(SUPPORT_REPLY_EMAIL) + '">' + escapeHtml(SUPPORT_REPLY_EMAIL) + '</a></li>'
    + '<li>Once we receive it, we\'ll activate your dealer portal access and send your login credentials</li>'
    + '</ol></div>'
    + '<p>If you have any questions, just reply to this email — we read every message.</p>'
    + '<p>Looking forward to working together.</p>'
    + '<p style="margin-top:24px;"><strong>The Whitestone Partners Team</strong></p>'
    + '</div>'
    + '<div class="foot">Whitestone Partners · Marine Maintenance Plans · whitestone-partners.com</div>'
    + '</div></body></html>';
}

function renderAgreementEmailText(d) {
  const testBanner = d.isTestMode
    ? '*** TEST MODE ***\nIn production this email would go to ' + d.realRecipient + '.\n\n'
    : '';

  return testBanner
    + 'Welcome to Whitestone Partners\n\n'
    + 'Hi ' + d.contactName + ',\n\n'
    + 'Thank you for choosing to partner with Whitestone Partners. We\'re excited to have ' + d.dealershipName + ' join our network of premier marine service dealers.\n\n'
    + 'Attached to this email is your Dealer Participation Agreement, pre-filled with the information you provided. Please review it carefully and sign where indicated.\n\n'
    + 'NEXT STEPS:\n'
    + '  1. Review the attached PDF agreement\n'
    + '  2. Sign and date all required fields (Adobe Fill & Sign or print/scan both work)\n'
    + '  3. Email the signed copy back to ' + SUPPORT_REPLY_EMAIL + '\n'
    + '  4. Once we receive it, we\'ll activate your dealer portal access and send your login credentials\n\n'
    + 'If you have any questions, just reply to this email — we read every message.\n\n'
    + 'Looking forward to working together.\n\n'
    + 'The Whitestone Partners Team\n\n'
    + '---\nWhitestone Partners · Marine Maintenance Plans · whitestone-partners.com';
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
