export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Email service not configured' });
  }

  var {
    subject,
    html,
    to,
    type,
    dealerName,
    customerName,
    amount,
    portalUrl
  } = req.body || {};

  if (type === 'overdue_day10') {
    subject = 'Action Required - Unpaid Contracts in Your Whitestone Partners Cart';
    html = ''
      + '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">'
      +   '<div style="background:#0c1e2e;padding:2rem;text-align:center;">'
      +     '<h1 style="color:#b8963e;font-size:24px;margin:0;">Whitestone Partners</h1>'
      +   '</div>'
      +   '<div style="padding:2rem;background:#fff8e0;border-left:4px solid #f59e0b;">'
      +     '<h2 style="color:#7a5c00;margin-top:0;">⚠️ Payment Due - Contract Not Yet Active</h2>'
      +     '<p style="color:#5a4000;">Hi ' + (dealerName || 'Dealer') + ',</p>'
      +     '<p style="color:#5a4000;">You have an unpaid contract for <strong>' + (customerName || 'a customer') + '</strong> that is now past its 10-day due date.</p>'
      +     '<p style="color:#5a4000;"><strong>Amount owed: $' + Number(amount || 0).toLocaleString() + '</strong></p>'
      +     '<p style="color:#5a4000;">⚠️ This customer\'s coverage is <strong>NOT active</strong> until payment is received. Please log in to your dealer portal and pay at your earliest convenience.</p>'
      +     '<a href="' + (portalUrl || 'https://whitestone-dealer-portal.vercel.app') + '" style="display:inline-block;background:#b8963e;color:#0c1e2e;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;margin-top:1rem;">Pay Now →</a>'
      +   '</div>'
      +   '<div style="padding:1rem;background:#f5f5f5;text-align:center;font-size:12px;color:#666;">'
      +     'Whitestone Partners LLC · St. George, Utah · support@whitestone-partners.com'
      +   '</div>'
      + '</div>';
  }

  if (type === 'overdue_day20') {
    subject = 'URGENT - Whitestone Partners: Contracts 20+ Days Overdue';
    html = ''
      + '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">'
      +   '<div style="background:#0c1e2e;padding:2rem;text-align:center;">'
      +     '<h1 style="color:#b8963e;font-size:24px;margin:0;">Whitestone Partners</h1>'
      +   '</div>'
      +   '<div style="padding:2rem;background:#fff0f0;border-left:4px solid #c0392b;">'
      +     '<h2 style="color:#8b0000;margin-top:0;">🔴 URGENT - Seriously Overdue Payment</h2>'
      +     '<p style="color:#5a0000;">Hi ' + (dealerName || 'Dealer') + ',</p>'
      +     '<p style="color:#5a0000;">Your contract for <strong>' + (customerName || 'a customer') + '</strong> is now <strong>20+ days past due</strong>.</p>'
      +     '<p style="color:#5a0000;"><strong>Amount owed: $' + Number(amount || 0).toLocaleString() + '</strong></p>'
      +     '<p style="color:#5a0000;">Continued non-payment may affect your dealer status with Whitestone Partners. Please log in and pay immediately.</p>'
      +     '<a href="' + (portalUrl || 'https://whitestone-dealer-portal.vercel.app') + '" style="display:inline-block;background:#c0392b;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;margin-top:1rem;">Pay Immediately →</a>'
      +   '</div>'
      +   '<div style="padding:1rem;background:#f5f5f5;text-align:center;font-size:12px;color:#666;">'
      +     'Whitestone Partners LLC · St. George, Utah · support@whitestone-partners.com'
      +   '</div>'
      + '</div>';
  }

  if (!subject || !html) {
    return res.status(400).json({ error: 'Missing subject or html' });
  }

  // Default to support inbox — allow override for customer emails
  var recipient = to || 'support@whitestone-partners.com';

  var toArray = Array.isArray(recipient) ? recipient : [recipient];

  try {
    var response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    'Whitestone Partners <support@whitestone-partners.com>',
        to:      toArray,
        subject: subject,
        html:    html
      })
    });

    var data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    return res.status(200).json({ success: true, id: data.id });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
