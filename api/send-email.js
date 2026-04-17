export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Email service not configured' });
  }

  var { subject, html, to } = req.body;

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
