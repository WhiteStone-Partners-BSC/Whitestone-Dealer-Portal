export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  var { stripeCustomerId, amount, dealerName, customerName, contractType, contractId } = req.body;

  if (!stripeCustomerId || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    var custRes = await fetch(
      'https://api.stripe.com/v1/customers/' + encodeURIComponent(stripeCustomerId),
      { headers: { Authorization: 'Bearer ' + secretKey } }
    );
    var cust = await custRes.json();
    if (!custRes.ok) {
      return res.status(400).json({ error: cust.error ? cust.error.message : 'Invalid customer' });
    }
    var defaultPm = cust.invoice_settings && cust.invoice_settings.default_payment_method;
    var paymentMethodId = typeof defaultPm === 'string' ? defaultPm : defaultPm && defaultPm.id;
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'No default payment method on file for this customer.' });
    }

    var params = new URLSearchParams({
      amount: Math.round(Number(amount) * 100).toString(),
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      confirm: 'true',
      off_session: 'true',
      description: (dealerName || '') + ' — ' + (contractType || '') + ' contract for ' + (customerName || ''),
      'metadata[dealer]': dealerName || '',
      'metadata[customer]': customerName || '',
      'metadata[contract]': contractType || '',
      'metadata[contract_id]': contractId || ''
    });

    var piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    var pi = await piRes.json();

    if (!piRes.ok) {
      return res.status(400).json({ error: pi.error ? pi.error.message : 'Payment failed' });
    }

    if (pi.status === 'succeeded') {
      return res.status(200).json({
        success: true,
        paymentIntentId: pi.id,
        amount: amount
      });
    }
    return res.status(400).json({
      error: 'Payment not completed. Status: ' + pi.status
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
