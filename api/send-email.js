export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get API key from environment variable — never exposed to client
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Email service not configured' });
  }

  var { subject, html } = req.body;

  if (!subject || !html) {
    return res.status(400).json({ error: 'Missing subject or html' });
  }

  try {
    var response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Whitestone Partners <support@whitestone-partners.com>',
        to:   ['support@whitestone-partners.com'],
        subject: subject,
        html: html
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
