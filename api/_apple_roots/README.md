# Apple Root CA certificates

Place Apple's root CA certificates here (DER format, `.cer`), used by
`api/activate-iap.js` to verify the StoreKit 2 JWS signature offline.

Download from https://www.apple.com/certificateauthority/ :
- AppleRootCA-G3.cer   (current, used for App Store Server signing)
- AppleRootCA-G2.cer   (include for completeness)

These are PUBLIC certificates (not secrets) and are safe to commit.
Until they are present, `api/activate-iap.js` returns "Apple root certs no configurados".
