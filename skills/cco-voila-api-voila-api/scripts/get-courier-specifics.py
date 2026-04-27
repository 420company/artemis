import urllib.request
import json
import sys

API_TOKEN = 'vtkpuslqfrdhwbio'
API_USER = 'VoilaPlayground'
BASE_URL = 'https://app.heyvoila.io'

if len(sys.argv) < 2:
    print("Error: Please provide a courier key (e.g., python get-courier-specifics.py UPSv2)")
    sys.exit(1)

courier = sys.argv[1]
url = f"{BASE_URL}/api/couriers/v1/{courier}/courier-specifics"
headers = {
    'api-user': API_USER,
    'api-token': API_TOKEN,
    'Accept': 'application/json'
}

req = urllib.request.Request(url, headers=headers)

try:
    with urllib.request.urlopen(req) as response:
        data = response.read().decode('utf-8')
        specifics = json.loads(data)
        print(json.dumps(specifics, indent=2))
except Exception as e:
    print(f"Error: {e}")
