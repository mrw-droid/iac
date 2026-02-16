"""Generate JWKS JSON from an EC P-256 private key PEM.

Usage:
    openssl ecparam -genkey -name prime256v1 -noout -out sark-jwt-private.pem
    uv run --with PyJWT --with cryptography scripts/gen_jwks.py sark-jwt-private.pem > sark-jwt-public.jwks
    cat sark-jwt-public.jwks | pulumi config set --secret sark-infra:jwtJwks
"""

import json
import sys

from jwt.algorithms import ECAlgorithm

if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <private-key.pem>", file=sys.stderr)
    sys.exit(1)

key_pem = open(sys.argv[1]).read()
alg = ECAlgorithm(ECAlgorithm.SHA256)
jwk = json.loads(ECAlgorithm.to_jwk(alg.prepare_key(key_pem), as_dict=False))
jwk["use"] = "sig"
jwk["alg"] = "ES256"
jwk["kid"] = "sark-1"
jwk.pop("d", None)  # strip private component
print(json.dumps({"keys": [jwk]}))
