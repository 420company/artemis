const https = require('https');

const API_TOKEN = 'vtkpuslqfrdhwbio';
const API_USER = 'VoilaPlayground';
const BASE_URL = 'app.heyvoila.io';

const options = {
  hostname: BASE_URL,
  path: '/api/couriers/v1/list-couriers',
  method: 'GET',
  headers: {
    'api-user': API_USER,
    'api-token': API_TOKEN,
    'Accept': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const couriers = JSON.parse(data);
      console.log(JSON.stringify(couriers, null, 2));
    } catch (e) {
      console.error('Failed to parse response:', data);
    }
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.end();
