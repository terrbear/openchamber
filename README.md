# OpenChamber

Web UI for [OpenCode](https://github.com/nicepkg/opencode).

## Quick Start

```bash
bun install
make run
```

Open http://localhost:6969.

## TLS

TLS is needed for features like voice mode (Web Speech API) when accessing from a
remote device or a browser that requires a secure context (e.g. Safari).

OpenChamber automatically enables TLS when it finds certificates at
`~/.config/openchamber/certs/cert.pem` and `key.pem`.

### Generate certs with mkcert

[mkcert](https://github.com/FiloSottile/mkcert) creates locally-trusted
certificates. Install it, run `mkcert -install` once to set up the local CA,
then:

```bash
make certs
```

This generates a certificate covering `localhost`, `127.0.0.1`, your hostname,
and your local IPs. Restart the server and it will serve over HTTPS.

You can override the cert paths with environment variables:

```bash
OPENCHAMBER_TLS_CERT=/path/to/cert.pem OPENCHAMBER_TLS_KEY=/path/to/key.pem make run
```

## Packaging

```bash
make package
```
