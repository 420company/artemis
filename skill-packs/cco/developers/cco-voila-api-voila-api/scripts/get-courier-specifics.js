const https = require('https');

const API_TOKEN = 'vtkpuslqfrdhwbio';
const API_USER = 'VoilaPlayground';
const BASE_URL = 'app.heyvoila.io';

const courier = process.argv[2];

if (!courier) {
  console.error('Please provide a courier key (e.g., node get-courier-specifics.js UPSv2)');
  process.exit(1);
}

const options = {
  hostname: BASE_URL,
  path: `/api/couriers/v1/${courier}/courier-specifics`,
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
      const specifics = JSON.parse(data);
      console.log(JSON.stringify(specifics, null, 2));
    } catch (e) {
      console.error('Failed to parse response:', data);
    }
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.end();
