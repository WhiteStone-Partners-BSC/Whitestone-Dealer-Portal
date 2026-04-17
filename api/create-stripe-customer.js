export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  var { dealerName, email, paymentMethodId, dealerId } = req.body;

  if (!dealerName || !email || !paymentMethodId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    var customerRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        name: dealerName,
        email: email,
        'metadata[dealer_id]': dealerId || ''
      }).toString()
    });
    var customer = await customerRes.json();
    if (!customerRes.ok) return res.status(400).json({ error: customer });

    var attachRes = await fetch('https://api.stripe.com/v1/payment_methods/' + paymentMethodId + '/attach', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ customer: customer.id }).toString()
    });
    var attached = await attachRes.json();
    if (!attachRes.ok) return res.status(400).json({ error: attached });

    await fetch('https://api.stripe.com/v1/customers/' + customer.id, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'invoice_settings[default_payment_method]': paymentMethodId
      }).toString()
    });

    return res.status(200).json({
      success: true,
      customerId: customer.id,
      paymentMethodId: paymentMethodId
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
