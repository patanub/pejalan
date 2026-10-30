export async function getGoogleAccessToken(serviceAccountJSON, scopes) {
  const credentials = typeof serviceAccountJSON === 'string'
    ? JSON.parse(serviceAccountJSON)
    : serviceAccountJSON;
  
const sekarang = Math.floor(Date.now()/1000);
const kadaluarsa = sekarang + 1800; // Berlaku selama 30 menit

const jwtHeader = {
    alg: 'RS256',
    typ: 'JWT'
};

const jwtclaimSet = {
    iss: credentials.client_email,
    scope: scopes.join(' '),
    aud: credentials.token_uri,
    exp: kadaluarsa,
    iat: sekarang,
};

const encodedHeader = btoa(JSON.stringify(jwtHeader))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const encodedClaimSet = btoa(JSON.stringify(jwtclaimSet))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const unsignedJWT = `${encodedHeader}.${encodedClaimSet}`;

// Sign using the private key
const pemHeader = '-----BEGIN PRIVATE KEY-----';
  const pemFooter = '-----END PRIVATE KEY-----';
  let pemContents = credentials.private_key;
  pemContents = pemContents
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .replace(/\s/g, '');

  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: { name: 'SHA-256' },
    },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedJWT)
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const jwt = `${unsignedJWT}.${encodedSignature}`;

// Switching JWT access token to Google OAuth 2.0 endpoint
const response = await fetch(credentials.token_uri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gagal mendapatkan Google Access Token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
};