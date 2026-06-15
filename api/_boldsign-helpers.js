// BoldSign helper — API key auth, send a document with base64 PDF + coordinate fields.
// CommonJS style to match other landing/API functions.

const BOLDSIGN_API_BASE = process.env.BOLDSIGN_API_BASE || 'https://api.boldsign.com';

function boldsignHeaders() {
  return {
    'X-API-KEY': process.env.BOLDSIGN_API_KEY || '',
    'Content-Type': 'application/json',
    'accept': 'application/json'
  };
}

// Send a document for signature.
// opts: { title, message, signerName, signerEmail, pdfBase64 (raw base64, no data: prefix),
//         formFields: [...], metadata: {key:value} }
async function sendDocument(opts) {
  const body = {
    Title: opts.title,
    Message: opts.message || 'Please review and sign.',
    Signers: [
      {
        name: opts.signerName,
        emailAddress: opts.signerEmail,
        signerType: 'Signer',
        formFields: opts.formFields || []
      }
    ],
    Files: ['data:application/pdf;base64,' + opts.pdfBase64]
  };
  // Attach metadata for webhook routing if supported (Label is a simple per-doc tag).
  if (opts.metadata) {
    body.Labels = Object.keys(opts.metadata).map(function (k) {
      return k + ':' + opts.metadata[k];
    });
  }
  const res = await fetch(BOLDSIGN_API_BASE + '/v1/document/send', {
    method: 'POST',
    headers: boldsignHeaders(),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error('BoldSign send failed (' + res.status + '): ' + (json.error || text));
  }
  return json; // contains documentId
}

module.exports = { boldsignHeaders, sendDocument, BOLDSIGN_API_BASE };
