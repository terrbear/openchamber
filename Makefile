.PHONY: package certs

CERT_DIR := $(HOME)/.config/openchamber/certs

certs:
	@command -v mkcert >/dev/null 2>&1 || { echo "mkcert not found. Install: https://github.com/FiloSottile/mkcert"; exit 1; }
	@mkdir -p $(CERT_DIR)
	mkcert -cert-file $(CERT_DIR)/cert.pem -key-file $(CERT_DIR)/key.pem \
		localhost 127.0.0.1 $$(hostname) $$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$$' | head -5 | tr '\n' ' ')
	@echo "Certs written to $(CERT_DIR)"

run:
	(kill $(shell (lsof -ti:6969)) && sleep 3) || true
	OPENCHAMBER_BACKEND=opencode bun run dev
	#OPENCHAMBER_BACKEND=claudecode bun run dev

run-cc:
	(kill $(shell (lsof -ti:6969)) && sleep 3) || true
	OPENCHAMBER_BACKEND=claudecode bun run dev

# Detect platform and set appropriate bundle types
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
	BUNDLES := app
else ifeq ($(UNAME_S),Linux)
	BUNDLES := deb,rpm
else
	BUNDLES := msi,nsis
endif

package:
	bun install
	bun run --cwd packages/desktop build:sidecar
	bun run --cwd packages/desktop tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' --bundles $(BUNDLES)
