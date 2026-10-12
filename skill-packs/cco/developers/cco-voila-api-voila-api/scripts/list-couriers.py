import urllib.request
import json

API_TOKEN = 'vtkpuslqfrdhwbio'
API_USER = 'VoilaPlayground'
BASE_URL = 'https://app.heyvoila.io'

url = f"{BASE_URL}/api/couriers/v1/list-couriers"
headers = {
    'api-user': API_USER,
    'api-token': API_TOKEN,
    'Accept': 'application/json'
}

req = urllib.request.Request(url, headers=headers)

try:
    with urllib.request.urlopen(req) as response:
        data = response.read().decode('utf-8')
        couriers = json.loads(data)
        print(json.dumps(couriers, indent=2))
except Exception as e:
    print(f"Error: {e}")
