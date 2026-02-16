import time

import jwt  # PyJWT

key = open("/Users/mrw/.creds/sark-jwt-private.pem").read()
token = jwt.encode(
    {
        "sub": "claude",
        "iss": "sark.flatline.ai",
        "aud": "sark.flatline.ai",
        "exp": int(time.time()) + 86400 * 365,
    },
    key,
    algorithm="ES256",
    headers={"kid": "sark-1"},
)
print(token)
